#!/usr/bin/env node

// ============================================================================
// PV Digest — Central Feed Generator
// ============================================================================
// Runs on GitHub Actions (daily) to fetch content and publish
// feed-x.json and feed-podcasts.json.
//
// Uses Apify (apidojo/tweet-scraper) instead of the official X API.
//
// Usage: node generate-feed.js [--tweets-only | --podcasts-only]
// Env vars needed: APIFY_API_TOKEN, SUPADATA_API_KEY (optional, for podcasts)
// ============================================================================

import { readFile, writeFile } from 'fs/promises';
import { existsSync } from 'fs';
import { join } from 'path';

// -- Constants ---------------------------------------------------------------

const APIFY_BASE = 'https://api.apify.com/v2';
const APIFY_ACTOR = 'apidojo~tweet-scraper';
const SUPADATA_BASE = 'https://api.supadata.ai/v1';

const TWEET_LOOKBACK_HOURS = 24;
const PODCAST_LOOKBACK_HOURS = 72;
const MAX_TWEETS_PER_USER = 3;
const APIFY_POLL_INTERVAL_MS = 5000;
const APIFY_TIMEOUT_MS = 120000;

const SCRIPT_DIR = decodeURIComponent(new URL('.', import.meta.url).pathname);
const STATE_PATH = join(SCRIPT_DIR, '..', 'state-feed.json');

// -- State Management --------------------------------------------------------

async function loadState() {
  if (!existsSync(STATE_PATH)) return { seenTweets: {}, seenVideos: {} };
  try {
    return JSON.parse(await readFile(STATE_PATH, 'utf-8'));
  } catch {
    return { seenTweets: {}, seenVideos: {} };
  }
}

async function saveState(state) {
  const cutoff = Date.now() - 7 * 24 * 60 * 60 * 1000;
  for (const [id, ts] of Object.entries(state.seenTweets)) {
    if (ts < cutoff) delete state.seenTweets[id];
  }
  for (const [id, ts] of Object.entries(state.seenVideos)) {
    if (ts < cutoff) delete state.seenVideos[id];
  }
  await writeFile(STATE_PATH, JSON.stringify(state, null, 2));
}

// -- Load Sources ------------------------------------------------------------

async function loadSources() {
  const sourcesPath = join(SCRIPT_DIR, '..', 'config', 'default-sources.json');
  return JSON.parse(await readFile(sourcesPath, 'utf-8'));
}

// -- Apify Twitter Fetching --------------------------------------------------

async function runApifyActor(apiToken, input) {
  // Start the run
  const startRes = await fetch(
    `${APIFY_BASE}/acts/${APIFY_ACTOR}/runs?token=${apiToken}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(input)
    }
  );

  if (!startRes.ok) {
    const err = await startRes.text();
    throw new Error(`Apify run failed to start: HTTP ${startRes.status} — ${err}`);
  }

  const { data: runData } = await startRes.json();
  const runId = runData.id;
  const datasetId = runData.defaultDatasetId;

  // Poll until finished or timed out
  const deadline = Date.now() + APIFY_TIMEOUT_MS;
  while (Date.now() < deadline) {
    await new Promise(r => setTimeout(r, APIFY_POLL_INTERVAL_MS));

    const statusRes = await fetch(
      `${APIFY_BASE}/actor-runs/${runId}?token=${apiToken}`
    );
    if (!statusRes.ok) continue;

    const { data: status } = await statusRes.json();
    if (status.status === 'SUCCEEDED') break;
    if (['FAILED', 'ABORTED', 'TIMED-OUT'].includes(status.status)) {
      throw new Error(`Apify run ${status.status}`);
    }
  }

  // Fetch dataset items
  const itemsRes = await fetch(
    `${APIFY_BASE}/datasets/${datasetId}/items?token=${apiToken}&clean=true`
  );
  if (!itemsRes.ok) {
    throw new Error(`Failed to fetch Apify dataset: HTTP ${itemsRes.status}`);
  }

  return itemsRes.json();
}

async function fetchXContent(xAccounts, apiToken, state, errors) {
  const cutoff = new Date(Date.now() - TWEET_LOOKBACK_HOURS * 60 * 60 * 1000);

  // Run a single Apify job for all accounts (cheaper than one job per account)
  const startUrls = xAccounts.map(a => ({
    url: `https://twitter.com/${a.handle}`
  }));

  let items = [];
  try {
    items = await runApifyActor(apiToken, {
      startUrls,
      maxItems: xAccounts.length * (MAX_TWEETS_PER_USER + 2), // fetch a few extra for filtering
      addUserInfo: true,
      excludeReplies: true,
      excludeRetweets: true
    });
  } catch (err) {
    errors.push(`Apify: ${err.message}`);
    return [];
  }

  // Group items by author handle
  const byHandle = {};
  for (const item of items) {
    const handle = (item.author?.userName || item.user?.screen_name || '').toLowerCase();
    if (!handle) continue;
    if (!byHandle[handle]) byHandle[handle] = [];
    byHandle[handle].push(item);
  }

  const results = [];

  for (const account of xAccounts) {
    const handle = account.handle.toLowerCase();
    const rawTweets = byHandle[handle] || [];

    // Filter to time window, deduplicate, cap at MAX
    const newTweets = [];
    for (const t of rawTweets) {
      const tweetId = t.id || t.id_str;
      const createdAt = t.createdAt || t.created_at;
      if (!tweetId || !createdAt) continue;
      if (new Date(createdAt) < cutoff) continue;
      if (state.seenTweets[tweetId]) continue;
      if (newTweets.length >= MAX_TWEETS_PER_USER) break;

      newTweets.push({
        id: tweetId,
        text: t.fullText || t.text || '',
        createdAt,
        url: t.url || `https://x.com/${account.handle}/status/${tweetId}`,
        likes: t.likeCount ?? t.favorite_count ?? 0,
        retweets: t.retweetCount ?? t.retweet_count ?? 0,
        replies: t.replyCount ?? t.reply_count ?? 0
      });

      state.seenTweets[tweetId] = Date.now();
    }

    if (newTweets.length === 0) continue;

    // Get bio from first item's author info
    const firstItem = rawTweets[0];
    const bio = firstItem?.author?.description
      || firstItem?.user?.description
      || '';

    results.push({
      source: 'x',
      name: account.name,
      handle: account.handle,
      bio,
      tweets: newTweets
    });
  }

  return results;
}

// -- YouTube Fetching (Supadata API) -----------------------------------------

async function fetchYouTubeContent(podcasts, apiKey, state, errors) {
  if (!podcasts || podcasts.length === 0) return [];

  const cutoff = new Date(Date.now() - PODCAST_LOOKBACK_HOURS * 60 * 60 * 1000);
  const allCandidates = [];

  for (const podcast of podcasts) {
    try {
      let videosUrl;
      if (podcast.type === 'youtube_playlist') {
        videosUrl = `${SUPADATA_BASE}/youtube/playlist/videos?id=${podcast.playlistId}`;
      } else {
        videosUrl = `${SUPADATA_BASE}/youtube/channel/videos?id=${podcast.channelHandle}&type=video`;
      }

      const videosRes = await fetch(videosUrl, {
        headers: { 'x-api-key': apiKey }
      });

      if (!videosRes.ok) {
        errors.push(`YouTube: Failed to fetch videos for ${podcast.name}: HTTP ${videosRes.status}`);
        continue;
      }

      const videosData = await videosRes.json();
      const videoIds = videosData.videoIds || videosData.video_ids || [];

      for (const videoId of videoIds.slice(0, 2)) {
        if (state.seenVideos[videoId]) continue;

        try {
          const metaRes = await fetch(
            `${SUPADATA_BASE}/youtube/video?id=${videoId}`,
            { headers: { 'x-api-key': apiKey } }
          );
          if (!metaRes.ok) continue;
          const meta = await metaRes.json();
          const publishedAt = meta.uploadDate || meta.publishedAt || meta.date || null;

          allCandidates.push({ podcast, videoId, title: meta.title || 'Untitled', publishedAt });
          await new Promise(r => setTimeout(r, 300));
        } catch (err) {
          errors.push(`YouTube: Error fetching metadata for ${videoId}: ${err.message}`);
        }
      }
    } catch (err) {
      errors.push(`YouTube: Error processing ${podcast.name}: ${err.message}`);
    }
  }

  const withinWindow = allCandidates
    .filter(v => v.publishedAt && new Date(v.publishedAt) >= cutoff)
    .sort((a, b) => new Date(a.publishedAt) - new Date(b.publishedAt));

  const selected = withinWindow[0];
  if (!selected) return [];

  try {
    const videoUrl = `https://www.youtube.com/watch?v=${selected.videoId}`;
    const transcriptRes = await fetch(
      `${SUPADATA_BASE}/youtube/transcript?url=${encodeURIComponent(videoUrl)}&text=true`,
      { headers: { 'x-api-key': apiKey } }
    );

    if (!transcriptRes.ok) {
      errors.push(`YouTube: Failed to get transcript for ${selected.videoId}: HTTP ${transcriptRes.status}`);
      return [];
    }

    const transcriptData = await transcriptRes.json();
    state.seenVideos[selected.videoId] = Date.now();

    return [{
      source: 'podcast',
      name: selected.podcast.name,
      title: selected.title,
      videoId: selected.videoId,
      url: `https://youtube.com/watch?v=${selected.videoId}`,
      publishedAt: selected.publishedAt,
      transcript: transcriptData.content || ''
    }];
  } catch (err) {
    errors.push(`YouTube: Error fetching transcript for ${selected.videoId}: ${err.message}`);
    return [];
  }
}

// -- Main --------------------------------------------------------------------

async function main() {
  const args = process.argv.slice(2);
  const tweetsOnly = args.includes('--tweets-only');
  const podcastsOnly = args.includes('--podcasts-only');

  const apifyToken = process.env.APIFY_API_TOKEN;
  const supadataKey = process.env.SUPADATA_API_KEY;

  if (!podcastsOnly && !apifyToken) {
    console.error('APIFY_API_TOKEN not set');
    process.exit(1);
  }

  const sources = await loadSources();
  const state = await loadState();
  const errors = [];

  // Fetch tweets
  let xContent = [];
  if (!podcastsOnly) {
    console.error('Fetching X/Twitter content via Apify...');
    xContent = await fetchXContent(sources.x_accounts, apifyToken, state, errors);
    console.error(`  Found ${xContent.length} builders with new tweets`);

    const totalTweets = xContent.reduce((sum, a) => sum + a.tweets.length, 0);
    const xFeed = {
      generatedAt: new Date().toISOString(),
      lookbackHours: TWEET_LOOKBACK_HOURS,
      x: xContent,
      stats: { xBuilders: xContent.length, totalTweets },
      errors: errors.filter(e => e.startsWith('Apify')).length > 0
        ? errors.filter(e => e.startsWith('Apify')) : undefined
    };
    await writeFile(join(SCRIPT_DIR, '..', 'feed-x.json'), JSON.stringify(xFeed, null, 2));
    console.error(`  feed-x.json written: ${xContent.length} builders, ${totalTweets} tweets`);
  }

  // Fetch podcasts (only if sources exist and key is available)
  let podcasts = [];
  if (!tweetsOnly && supadataKey && sources.podcasts.length > 0) {
    console.error('Fetching YouTube content...');
    podcasts = await fetchYouTubeContent(sources.podcasts, supadataKey, state, errors);
    console.error(`  Found ${podcasts.length} new episodes`);
  }

  const podcastFeed = {
    generatedAt: new Date().toISOString(),
    lookbackHours: PODCAST_LOOKBACK_HOURS,
    podcasts,
    stats: { podcastEpisodes: podcasts.length },
    errors: errors.filter(e => e.startsWith('YouTube')).length > 0
      ? errors.filter(e => e.startsWith('YouTube')) : undefined
  };
  await writeFile(join(SCRIPT_DIR, '..', 'feed-podcasts.json'), JSON.stringify(podcastFeed, null, 2));

  await saveState(state);

  if (errors.length > 0) {
    console.error(`  ${errors.length} non-fatal errors:`, errors);
  }
}

main().catch(err => {
  console.error('Feed generation failed:', err.message);
  process.exit(1);
});
