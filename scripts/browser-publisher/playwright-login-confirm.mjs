#!/usr/bin/env node
import fs from 'fs';
import os from 'os';
import path from 'path';
import readline from 'readline';

const DEFAULT_LOGIN_URL = 'https://mp.weixin.qq.com/';

function expandHome(inputPath) {
  if (!inputPath) {
    return inputPath;
  }
  if (inputPath.startsWith('~/')) {
    return path.join(os.homedir(), inputPath.slice(2));
  }
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

async function waitForUserConfirm(page) {
  process.stdout.write('\n');
  process.stdout.write('Chrome has opened for WeChat login.\n');
  process.stdout.write('1) Scan QR code and complete login in browser.\n');
  process.stdout.write('2) Confirm page is logged in.\n');
  process.stdout.write('3) Return here and type OK to finish.\n');
  process.stdout.write('\n');

  while (true) {
    const answer = (await askLine('Type OK to finish (or STATUS to print current URL): ')).toLowerCase();
    if (answer === 'ok') {
      return;
    }
    if (answer === 'status') {
      process.stdout.write(`Current URL: ${page.url()}\n`);
      continue;
    }
    process.stdout.write('Input not accepted. Please type OK or STATUS.\n');
  }
}

async function main() {
  if (!process.stdin.isTTY) {
    process.stderr.write('This command requires an interactive terminal (TTY).\n');
    process.exit(1);
  }

  let chromium;
  try {
    ({ chromium } = await import('playwright'));
  } catch (error) {
    process.stderr.write('Playwright is not installed. Run: npm install -D playwright\n');
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  }

  const channel = process.env.WECHAT_BROWSER_CHANNEL || 'chrome';
  const userDataDir = path.resolve(expandHome(process.env.WECHAT_BROWSER_USER_DATA_DIR || '~/.wechat-agent/pw-profile'));
  const loginUrl = process.env.WECHAT_BROWSER_LOGIN_URL || DEFAULT_LOGIN_URL;

  await ensureDir(userDataDir);

  let context;
  try {
    context = await chromium.launchPersistentContext(userDataDir, {
      headless: false,
      channel,
      viewport: { width: 1440, height: 900 },
      args: ['--disable-blink-features=AutomationControlled'],
    });

    const page = context.pages()[0] || await context.newPage();
    await page.goto(loginUrl, { waitUntil: 'domcontentloaded' });

    await waitForUserConfirm(page);

    process.stdout.write(
      `${JSON.stringify({
        ok: true,
        message: 'manual login confirmed',
        profile_dir: userDataDir,
        final_url: page.url(),
      }, null, 2)}\n`
    );
  } finally {
    await context?.close().catch(() => {});
  }
}

main().catch(error => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});

