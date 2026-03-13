#!/usr/bin/env node
import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawn } from 'child_process';
import dotenv from 'dotenv';

const DEFAULT_LOGIN_URL = 'https://mp.weixin.qq.com/';
const ROOT_DIR = process.cwd();
const ENV_FILE = path.join(ROOT_DIR, '.env.agent');

dotenv.config({ path: ENV_FILE });

function expandHome(inputPath) {
  if (!inputPath) return inputPath;
  if (inputPath.startsWith('~/')) return path.join(os.homedir(), inputPath.slice(2));
  return inputPath;
}

async function ensureDir(dirPath) {
  await fs.promises.mkdir(dirPath, { recursive: true });
}

function parseBool(input, fallback) {
  const raw = String(input ?? '').trim().toLowerCase();
  if (!raw) return fallback;
  return raw === '1' || raw === 'true' || raw === 'yes' || raw === 'on';
}

function findChromeExecutable() {
  const override = (process.env.WECHAT_BROWSER_CHROME_PATH || '').trim();
  if (override && fs.existsSync(override)) return override;

  const candidates = process.platform === 'darwin'
    ? [
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      '/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary',
      '/Applications/Chromium.app/Contents/MacOS/Chromium',
    ]
    : process.platform === 'win32'
      ? [
        'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
        'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
      ]
      : [
        '/usr/bin/google-chrome',
        '/usr/bin/chromium',
        '/usr/bin/chromium-browser',
      ];

  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate;
  }
  return '';
}

async function fetchJson(url, timeoutMs = 1500) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { redirect: 'follow', signal: controller.signal });
    if (!res.ok) throw new Error(`request failed: ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

async function isCdpReady(cdpUrl) {
  try {
    const data = await fetchJson(`${cdpUrl.replace(/\/$/, '')}/json/version`, 1200);
    return Boolean(data?.webSocketDebuggerUrl);
  } catch {
    return false;
  }
}

async function waitForCdp(cdpUrl, timeoutMs) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (await isCdpReady(cdpUrl)) return true;
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
  return false;
}

async function ensureCdpSession() {
  const autoStartCdp = parseBool(process.env.WECHAT_AGENT_AUTO_START_CDP, true);
  const browserPublishMode = String(process.env.WECHAT_AGENT_BROWSER_PUBLISH_MODE || '').toLowerCase();
  const browserPublishCmd = String(process.env.WECHAT_AGENT_BROWSER_PUBLISH_CMD || '');
  const browserCommandMode = browserPublishMode === 'command' || (!!browserPublishCmd && browserPublishMode !== 'manual');
  const dryRun = parseBool(process.env.WECHAT_BROWSER_DRY_RUN, false);
  const requireCdp = autoStartCdp && browserCommandMode && !dryRun;

  if (!requireCdp) {
    process.stdout.write('[agent:start:prod] Skip CDP auto-start (disabled or not needed).\n');
    return;
  }

  const cdpPort = Number(process.env.WECHAT_BROWSER_CDP_PORT || '9222');
  const cdpUrl = process.env.WECHAT_BROWSER_CDP_URL || `http://127.0.0.1:${cdpPort}`;
  const startTimeoutMs = Number(process.env.WECHAT_BROWSER_CDP_START_TIMEOUT_MS || '30000');
  const loginUrl = process.env.WECHAT_BROWSER_LOGIN_URL || DEFAULT_LOGIN_URL;
  const userDataDir = path.resolve(expandHome(process.env.WECHAT_BROWSER_USER_DATA_DIR || '~/.wechat-agent/pw-profile'));

  if (await isCdpReady(cdpUrl)) {
    process.stdout.write(`[agent:start:prod] CDP already ready at ${cdpUrl}\n`);
    return;
  }

  const chromePath = findChromeExecutable();
  if (!chromePath) {
    throw new Error('CDP is not listening and Chrome is not found. Set WECHAT_BROWSER_CHROME_PATH.');
  }

  await ensureDir(userDataDir);
  const child = spawn(chromePath, [
    `--remote-debugging-port=${cdpPort}`,
    `--user-data-dir=${userDataDir}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-blink-features=AutomationControlled',
    '--start-maximized',
    loginUrl,
  ], {
    detached: true,
    stdio: 'ignore',
  });
  child.unref();

  const ready = await waitForCdp(cdpUrl, startTimeoutMs);
  if (!ready) {
    throw new Error(`CDP auto-start failed: ${cdpUrl} not ready within ${startTimeoutMs}ms`);
  }

  process.stdout.write(`[agent:start:prod] CDP started at ${cdpUrl}, pid=${String(child.pid || '')}\n`);
}

function startAgentServer() {
  const server = spawn(process.execPath, ['--env-file=.env.agent', 'dist/api/server.js'], {
    cwd: ROOT_DIR,
    env: process.env,
    stdio: 'inherit',
  });

  const relaySignal = (signal) => {
    if (!server.killed) {
      server.kill(signal);
    }
  };

  process.on('SIGINT', () => relaySignal('SIGINT'));
  process.on('SIGTERM', () => relaySignal('SIGTERM'));

  server.on('exit', (code, signal) => {
    if (signal) {
      process.kill(process.pid, signal);
      return;
    }
    process.exit(code ?? 0);
  });
}

async function main() {
  await ensureCdpSession();
  startAgentServer();
}

main().catch((error) => {
  process.stderr.write(`[agent:start:prod] ${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
