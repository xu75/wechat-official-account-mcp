#!/usr/bin/env node
import fs from 'fs';
import os from 'os';
import path from 'path';
import readline from 'readline';
import { spawn } from 'child_process';

const DEFAULT_LOGIN_URL = 'https://mp.weixin.qq.com/';

function expandHome(inputPath) {
  if (!inputPath) return inputPath;
  if (inputPath.startsWith('~/')) return path.join(os.homedir(), inputPath.slice(2));
  return inputPath;
}

async function ensureDir(dirPath) {
  await fs.promises.mkdir(dirPath, { recursive: true });
}

function askLine(prompt) {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  return new Promise(resolve => {
    rl.question(prompt, answer => {
      rl.close();
      resolve(String(answer || '').trim());
    });
  });
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
      ];

  for (const p of candidates) {
    if (fs.existsSync(p)) return p;
  }
  return '';
}

async function fetchJson(url) {
  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok) throw new Error(`request failed: ${res.status}`);
  return await res.json();
}

async function waitForDebugPort(cdpUrl, timeoutMs) {
  const versionUrl = `${cdpUrl.replace(/\/$/, '')}/json/version`;
  const start = Date.now();
  let lastError = '';

  while (Date.now() - start < timeoutMs) {
    try {
      const version = await fetchJson(versionUrl);
      if (version.webSocketDebuggerUrl) return;
      lastError = 'webSocketDebuggerUrl missing';
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    await new Promise(resolve => setTimeout(resolve, 300));
  }

  throw new Error(`cdp port is not ready: ${lastError}`);
}

async function fetchWechatTabUrl(cdpUrl) {
  const listUrl = `${cdpUrl.replace(/\/$/, '')}/json/list`;
  try {
    const tabs = await fetchJson(listUrl);
    if (!Array.isArray(tabs)) return '';
    const wechatTab = tabs.find(tab => typeof tab?.url === 'string' && tab.url.includes('mp.weixin.qq.com'));
    return wechatTab?.url || '';
  } catch {
    return '';
  }
}

async function launchChromeIfNeeded(config) {
  const versionUrl = `${config.cdpUrl.replace(/\/$/, '')}/json/version`;
  try {
    const data = await fetchJson(versionUrl);
    if (data.webSocketDebuggerUrl) {
      return { launched: false, pid: null };
    }
  } catch {}

  const chromePath = findChromeExecutable();
  if (!chromePath) {
    throw new Error('Chrome not found. Set WECHAT_BROWSER_CHROME_PATH or install Chrome.');
  }

  const child = spawn(chromePath, [
    `--remote-debugging-port=${config.cdpPort}`,
    `--user-data-dir=${config.userDataDir}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-blink-features=AutomationControlled',
    '--start-maximized',
    config.loginUrl,
  ], {
    detached: true,
    stdio: 'ignore',
  });
  child.unref();

  await waitForDebugPort(config.cdpUrl, config.startTimeoutMs);
  return { launched: true, pid: child.pid || null };
}

async function main() {
  if (!process.stdin.isTTY) {
    process.stderr.write('This command requires an interactive terminal (TTY).\n');
    process.exit(1);
  }

  const cdpPort = Number(process.env.WECHAT_BROWSER_CDP_PORT || '9222');
  const cdpUrl = process.env.WECHAT_BROWSER_CDP_URL || `http://127.0.0.1:${cdpPort}`;
  const userDataDir = path.resolve(expandHome(process.env.WECHAT_BROWSER_USER_DATA_DIR || '~/.wechat-agent/pw-profile'));
  const loginUrl = process.env.WECHAT_BROWSER_LOGIN_URL || DEFAULT_LOGIN_URL;
  const startTimeoutMs = Number(process.env.WECHAT_BROWSER_CDP_START_TIMEOUT_MS || '30000');

  await ensureDir(userDataDir);
  const launchInfo = await launchChromeIfNeeded({
    cdpPort,
    cdpUrl,
    userDataDir,
    loginUrl,
    startTimeoutMs,
  });

  process.stdout.write('\n');
  process.stdout.write('Chrome CDP login session is ready.\n');
  process.stdout.write(`CDP URL: ${cdpUrl}\n`);
  process.stdout.write(`Profile: ${userDataDir}\n`);
  process.stdout.write('1) Complete login in Chrome (if needed).\n');
  process.stdout.write('2) Type STATUS to check current WeChat tab URL.\n');
  process.stdout.write('3) Type OK to finish; Chrome stays open for publish attach.\n');
  process.stdout.write('\n');

  while (true) {
    const answer = (await askLine('Type OK to finish (or STATUS): ')).toLowerCase();
    if (answer === 'ok') break;
    if (answer === 'status') {
      const url = await fetchWechatTabUrl(cdpUrl);
      process.stdout.write(`Current WeChat URL: ${url || '(not found)'}\n`);
      continue;
    }
    process.stdout.write('Input not accepted. Please type OK or STATUS.\n');
  }

  const finalUrl = await fetchWechatTabUrl(cdpUrl);
  process.stdout.write(
    `${JSON.stringify({
      ok: true,
      message: 'manual login confirmed (cdp)',
      cdp_url: cdpUrl,
      cdp_port: cdpPort,
      profile_dir: userDataDir,
      final_url: finalUrl || '',
      launched_new_chrome: launchInfo.launched,
      launched_pid: launchInfo.pid,
    }, null, 2)}\n`
  );
}

main().catch(error => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});

