#!/usr/bin/env node

// ============================================================================
// PV Digest — Prepare Digest
// ============================================================================
// Gathers everything the LLM needs to produce a digest:
// - Fetches the central feeds (tweets + podcasts) from GitHub
// - Fetches the latest prompts from GitHub
// - Reads the user's config
// - Outputs a single JSON blob to stdout
// ============================================================================

import { readFile, mkdir } from 'fs/promises';
import { existsSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';

const USER_DIR = join(homedir(), '.pv-digest');
const CONFIG_PATH = join(USER_DIR, 'config.json');

const GITHUB_RAW = 'https://raw.githubusercontent.com/billj2006/pv-digest/main';
const FEED_X_URL = `${GITHUB_RAW}/feed-x.json`;
const FEED_PODCASTS_URL = `${GITHUB_RAW}/feed-podcasts.json`;
const PROMPTS_BASE = `${GITHUB_RAW}/prompts`;

const PROMPT_FILES = [
  'summarize-podcast.md',
  'summarize-tweets.md',
  'digest-intro.md',
  'translate.md'
];

async function fetchJSON(url) {
  const res = await fetch(url);
  if (!res.ok) return null;
  return res.json();
}

async function fetchText(url) {
  const res = await fetch(url);
  if (!res.ok) return null;
  return res.text();
}

async function main() {
  const errors = [];

  // 1. Read user config
  let config = {
    language: 'bilingual',
    frequency: 'daily',
    delivery: { method: 'stdout' }
  };
  if (existsSync(CONFIG_PATH)) {
    try {
      config = JSON.parse(await readFile(CONFIG_PATH, 'utf-8'));
    } catch (err) {
      errors.push(`Could not read config: ${err.message}`);
    }
  }

  // 2. Fetch both feeds
  const [feedX, feedPodcasts] = await Promise.all([
    fetchJSON(FEED_X_URL),
    fetchJSON(FEED_PODCASTS_URL)
  ]);

  if (!feedX) errors.push('Could not fetch tweet feed');
  if (!feedPodcasts) errors.push('Could not fetch podcast feed');

  // 3. Load prompts: user custom > remote GitHub > local default
  const prompts = {};
  const scriptDir = decodeURIComponent(new URL('.', import.meta.url).pathname);
  const localPromptsDir = join(scriptDir, '..', 'prompts');
  const userPromptsDir = join(USER_DIR, 'prompts');

  for (const filename of PROMPT_FILES) {
    const key = filename.replace('.md', '').replace(/-/g, '_');
    const userPath = join(userPromptsDir, filename);
    const localPath = join(localPromptsDir, filename);

    if (existsSync(userPath)) {
      prompts[key] = await readFile(userPath, 'utf-8');
      continue;
    }

    const remote = await fetchText(`${PROMPTS_BASE}/${filename}`);
    if (remote) {
      prompts[key] = remote;
      continue;
    }

    if (existsSync(localPath)) {
      prompts[key] = await readFile(localPath, 'utf-8');
    } else {
      errors.push(`Could not load prompt: ${filename}`);
    }
  }

  // 4. Output everything the LLM needs
  const output = {
    status: 'ok',
    generatedAt: new Date().toISOString(),
    config: {
      language: config.language || 'bilingual',
      frequency: config.frequency || 'daily',
      delivery: config.delivery || { method: 'stdout' }
    },
    podcasts: feedPodcasts?.podcasts || [],
    x: feedX?.x || [],
    stats: {
      podcastEpisodes: feedPodcasts?.podcasts?.length || 0,
      xBuilders: feedX?.x?.length || 0,
      totalTweets: (feedX?.x || []).reduce((sum, a) => sum + a.tweets.length, 0),
      feedGeneratedAt: feedX?.generatedAt || feedPodcasts?.generatedAt || null
    },
    prompts,
    errors: errors.length > 0 ? errors : undefined
  };

  console.log(JSON.stringify(output, null, 2));
}

main().catch(err => {
  console.error(JSON.stringify({ status: 'error', message: err.message }));
  process.exit(1);
});
