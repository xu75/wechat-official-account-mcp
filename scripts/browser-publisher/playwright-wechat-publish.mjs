#!/usr/bin/env node
import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';

const DEFAULT_EDIT_URL = 'https://mp.weixin.qq.com/cgi-bin/appmsg?t=media/appmsg_edit_v2&action=edit&isNew=1';
const execFileAsync = promisify(execFile);

function output(payload) {
  process.stdout.write(JSON.stringify(payload));
}

function fail(errorCode, errorMessage, extra = {}) {
  output({
    ok: false,
    error_code: errorCode,
    error_message: errorMessage,
    ...extra,
  });
  process.exit(0);
}

function expandHome(inputPath) {
  if (!inputPath) {
    return inputPath;
  }
  if (inputPath.startsWith('~/')) {
    return path.join(os.homedir(), inputPath.slice(2));
  }
  return inputPath;
}

function readPayload(payloadPathArg) {
  if (!payloadPathArg) {
    fail('BROWSER_PAYLOAD_MISSING', 'payload file path argument is required');
  }

  const payloadPath = path.resolve(process.cwd(), payloadPathArg);
  if (!fs.existsSync(payloadPath)) {
    fail('BROWSER_PAYLOAD_NOT_FOUND', `payload file not found: ${payloadPath}`);
  }

  try {
    return {
      payloadPath,
      payload: JSON.parse(fs.readFileSync(payloadPath, 'utf8')),
    };
  } catch (error) {
    fail('BROWSER_PAYLOAD_INVALID_JSON', error instanceof Error ? error.message : 'invalid payload json');
  }
}

function getEnvConfig() {
  const humanDelayBaseMs = Number(process.env.WECHAT_BROWSER_HUMAN_DELAY_BASE_MS || '700');
  const humanDelayJitterMs = Number(process.env.WECHAT_BROWSER_HUMAN_DELAY_JITTER_MS || '500');
  const typeDelayMinMs = Number(process.env.WECHAT_BROWSER_TYPE_DELAY_MIN_MS || '45');
  const typeDelayMaxMs = Number(process.env.WECHAT_BROWSER_TYPE_DELAY_MAX_MS || '120');
  const normalizedTypeMin = Number.isFinite(typeDelayMinMs) && typeDelayMinMs >= 0 ? typeDelayMinMs : 45;
  const normalizedTypeMax =
    Number.isFinite(typeDelayMaxMs) && typeDelayMaxMs >= normalizedTypeMin ? typeDelayMaxMs : Math.max(normalizedTypeMin, 120);
  const loginOnlyHoldMs = Number(process.env.WECHAT_BROWSER_LOGIN_ONLY_HOLD_MS || '8000');
  const loginStableRounds = Number(process.env.WECHAT_BROWSER_LOGIN_STABLE_ROUNDS || '1');

  return {
    channel: process.env.WECHAT_BROWSER_CHANNEL || 'chrome',
    headless: process.env.WECHAT_BROWSER_HEADLESS === 'true',
    submitMode: (process.env.WECHAT_BROWSER_SUBMIT_MODE || 'draft').toLowerCase(),
    loginOnly: process.env.WECHAT_BROWSER_LOGIN_ONLY === 'true',
    userDataDir: path.resolve(expandHome(process.env.WECHAT_BROWSER_USER_DATA_DIR || '~/.wechat-agent/pw-profile')),
    actionTimeoutMs: Number(process.env.WECHAT_BROWSER_ACTION_TIMEOUT_MS || '30000'),
    navTimeoutMs: Number(process.env.WECHAT_BROWSER_NAV_TIMEOUT_MS || '60000'),
    loginTimeoutMs: Number(process.env.WECHAT_BROWSER_LOGIN_TIMEOUT_MS || '180000'),
    debugDir: path.resolve(expandHome(process.env.WECHAT_BROWSER_DEBUG_DIR || '/tmp/wechat-agent-browser-debug')),
    editUrl: process.env.WECHAT_BROWSER_EDIT_URL || DEFAULT_EDIT_URL,
    dryRun: process.env.WECHAT_BROWSER_DRY_RUN === 'true',
    humanDelayBaseMs: Number.isFinite(humanDelayBaseMs) && humanDelayBaseMs >= 0 ? humanDelayBaseMs : 700,
    humanDelayJitterMs: Number.isFinite(humanDelayJitterMs) && humanDelayJitterMs >= 0 ? humanDelayJitterMs : 500,
    typeDelayMinMs: normalizedTypeMin,
    typeDelayMaxMs: normalizedTypeMax,
    loginOnlyHoldMs: Number.isFinite(loginOnlyHoldMs) && loginOnlyHoldMs >= 0 ? loginOnlyHoldMs : 8000,
    loginStableRounds: Number.isFinite(loginStableRounds) && loginStableRounds >= 1 ? loginStableRounds : 1,
    verbose: process.env.WECHAT_BROWSER_VERBOSE === 'true',
  };
}

function randomBetween(min, max) {
  if (max <= min) {
    return min;
  }
  const raw = Math.random() * (max - min);
  return Math.floor(min + raw);
}

function randomTypeDelayMs(cfg) {
  return randomBetween(cfg.typeDelayMinMs, cfg.typeDelayMaxMs + 1);
}

async function sleep(ms) {
  if (ms <= 0) {
    return;
  }
  await new Promise(resolve => setTimeout(resolve, ms));
}

async function humanPause(page, cfg, multiplier = 1) {
  const scaledBase = Math.max(0, Math.floor(cfg.humanDelayBaseMs * multiplier));
  const jitter = cfg.humanDelayJitterMs > 0 ? randomBetween(0, cfg.humanDelayJitterMs + 1) : 0;
  const total = scaledBase + jitter;
  await sleep(total);
}

async function ensureDir(dirPath) {
  await fs.promises.mkdir(dirPath, { recursive: true });
}

function trace(cfg, message, data = {}) {
  if (!cfg.verbose) {
    return;
  }
  const record = {
    ts: new Date().toISOString(),
    message,
    ...data,
  };
  process.stderr.write(`[wechat-browser] ${JSON.stringify(record)}\n`);
}

function isProcessSingletonErrorMessage(raw) {
  const msg = String(raw || '');
  return msg.includes('Failed to create a ProcessSingleton') || msg.includes('SingletonLock: File exists');
}

async function findProfileChromeProcesses(userDataDir) {
  const normalized = path.resolve(userDataDir);
  try {
    const { stdout } = await execFileAsync('ps', ['-axo', 'pid=,args=']);
    const lines = stdout.split('\n').map(line => line.trim()).filter(Boolean);
    const matches = [];
    for (const line of lines) {
      if (!line.includes(normalized)) {
        continue;
      }
      if (!/chrome|chromium|Google Chrome/i.test(line)) {
        continue;
      }
      const firstSpace = line.indexOf(' ');
      if (firstSpace <= 0) {
        continue;
      }
      const pid = line.slice(0, firstSpace).trim();
      const cmd = line.slice(firstSpace + 1).trim();
      matches.push({ pid, cmd });
    }
    return matches;
  } catch {
    return [];
  }
}

async function clearStaleSingletonLocks(userDataDir) {
  const lockFiles = [
    'SingletonLock',
    'SingletonCookie',
    'SingletonSocket',
  ];
  for (const name of lockFiles) {
    const target = path.join(userDataDir, name);
    await fs.promises.rm(target, { force: true }).catch(() => {});
  }
}

async function launchContextWithProfileRetry(chromium, cfg, effectiveHeadless) {
  const launchOptions = {
    headless: effectiveHeadless,
    channel: cfg.channel,
    viewport: { width: 1440, height: 900 },
    args: ['--disable-blink-features=AutomationControlled'],
  };

  try {
    return await chromium.launchPersistentContext(cfg.userDataDir, launchOptions);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!isProcessSingletonErrorMessage(message)) {
      throw error;
    }

    const running = await findProfileChromeProcesses(cfg.userDataDir);
    if (running.length > 0) {
      throw new Error([
        `browser profile is already in use: ${cfg.userDataDir}`,
        'close all Chrome windows using this profile, then retry.',
        `detected_pids=${running.map(item => item.pid).join(',')}`,
      ].join(' '));
    }

    await clearStaleSingletonLocks(cfg.userDataDir);
    await sleep(600);

    return await chromium.launchPersistentContext(cfg.userDataDir, launchOptions);
  }
}

async function takeDebugArtifacts(page, debugDir, taskId) {
  try {
    await ensureDir(debugDir);
    const stamp = Date.now();
    const safeTask = String(taskId || 'task').replace(/[^a-zA-Z0-9._-]/g, '_');
    const screenshotPath = path.join(debugDir, `${safeTask}-${stamp}.png`);
    const htmlPath = path.join(debugDir, `${safeTask}-${stamp}.html`);
    const metaPath = path.join(debugDir, `${safeTask}-${stamp}.meta.json`);

    await page.screenshot({ path: screenshotPath, fullPage: true }).catch(() => {});
    const html = await page.content().catch(() => '');
    if (html) {
      await fs.promises.writeFile(htmlPath, html, 'utf8').catch(() => {});
    }
    const frameUrls = page.frames().map(frame => frame.url()).filter(Boolean).slice(0, 30);
    const meta = {
      captured_at: new Date().toISOString(),
      page_url: page.url(),
      page_title: await page.title().catch(() => ''),
      main_frame_url: page.mainFrame().url(),
      frame_urls: frameUrls,
      page_is_closed: page.isClosed(),
    };
    await fs.promises.writeFile(metaPath, JSON.stringify(meta, null, 2), 'utf8').catch(() => {});

    return {
      screenshot_path: screenshotPath,
      html_path: htmlPath,
      meta_path: metaPath,
      current_url: meta.page_url,
    };
  } catch {
    return {};
  }
}

function normalizeTitle(payload) {
  const raw = String(payload.title || '').trim();
  if (!raw) {
    fail('BROWSER_TITLE_EMPTY', 'title is required');
  }
  return raw;
}

function normalizeContent(payload) {
  const raw = String(payload.content || '').trim();
  if (!raw) {
    fail('BROWSER_CONTENT_EMPTY', 'content is required');
  }
  return raw;
}

function isLoginRelatedUrl(input) {
  return input.includes('/cgi-bin/loginpage') || input.includes('/cgi-bin/bizlogin');
}

function extractTokenFromUrl(input) {
  try {
    const value = new URL(input).searchParams.get('token');
    return value || '';
  } catch {
    return '';
  }
}

function buildEditUrlWithToken(editUrl, token) {
  try {
    const urlObj = new URL(editUrl);
    if (token) {
      urlObj.searchParams.set('token', token);
    }
    return urlObj.toString();
  } catch {
    return editUrl;
  }
}

async function verifySessionReady(page, cfg, requireEditor) {
  try {
    await page.goto('https://mp.weixin.qq.com/cgi-bin/home?t=home/index', { waitUntil: 'domcontentloaded' });
    await humanPause(page, cfg, 0.4);
    await page.waitForLoadState('networkidle').catch(() => {});

    const homeUrl = page.url();
    const homeToken = extractTokenFromUrl(homeUrl);
    const homeReady = homeUrl.includes('/cgi-bin/home') && Boolean(homeToken) && !isLoginRelatedUrl(homeUrl);
    if (!homeReady) {
      return { ok: false, token: '' };
    }

    if (!requireEditor) {
      return { ok: true, token: homeToken };
    }

    const editorWithTokenUrl = buildEditUrlWithToken(cfg.editUrl, homeToken);
    await page.goto(editorWithTokenUrl, { waitUntil: 'domcontentloaded' });
    await humanPause(page, cfg, 0.4);
    await page.waitForLoadState('networkidle').catch(() => {});

    const editUrl = page.url();
    const editToken = extractTokenFromUrl(editUrl);
    const editReady = editUrl.includes('/cgi-bin/appmsg') && Boolean(editToken) && !isLoginRelatedUrl(editUrl);

    return { ok: editReady, token: editToken || homeToken };
  } catch {
    return { ok: false, token: '' };
  }
}

async function waitForLogin(page, cfg, options = {}) {
  const requireEditor = options.requireEditor === true;
  const start = Date.now();
  let stableLoggedInCount = 0;
  let lastToken = '';
  let lastVerifyAt = 0;
  const verifyMinIntervalMs = 3500;
  const states = [];

  while (Date.now() - start < cfg.loginTimeoutMs) {
    const currentUrl = page.url();

    const loginIndicators = [
      'img.js_qrcode',
      '.login__type__container',
      '#js_login_container',
      '#accountLogin',
    ];

    let hasLoginUi = false;
    for (const selector of loginIndicators) {
      const visible = await page.locator(selector).first().isVisible().catch(() => false);
      if (visible) {
        hasLoginUi = true;
        break;
      }
    }

    const loggedInIndicators = [
      '#js_sideBar',
      '.weui-desktop-layout',
      '.weui-desktop-menu',
      '.weui-desktop-account',
    ];

    let hasLoggedInUi = false;
    for (const selector of loggedInIndicators) {
      const visible = await page.locator(selector).first().isVisible().catch(() => false);
      if (visible) {
        hasLoggedInUi = true;
        break;
      }
    }

    const maybeLoggedInByUrl = currentUrl.includes('/cgi-bin/') && Boolean(extractTokenFromUrl(currentUrl)) && !isLoginRelatedUrl(currentUrl);
    const homeWithoutToken = currentUrl.includes('/cgi-bin/home') && !extractTokenFromUrl(currentUrl);
    const state = {
      current_url: currentUrl,
      has_login_ui: hasLoginUi,
      has_logged_in_ui: hasLoggedInUi,
      maybe_logged_in_by_url: maybeLoggedInByUrl,
      home_without_token: homeWithoutToken,
      require_editor: requireEditor,
      stable_count: stableLoggedInCount,
    };
    states.push(state);
    if (states.length > 6) {
      states.shift();
    }
    trace(cfg, 'login_poll', state);

    if (!requireEditor && hasLoggedInUi && !hasLoginUi) {
      const quickToken = extractTokenFromUrl(currentUrl);
      trace(cfg, 'login_quick_accept', {
        token_present: Boolean(quickToken),
        current_url: currentUrl,
      });
      return quickToken;
    }

    if (homeWithoutToken && !hasLoggedInUi) {
      trace(cfg, 'login_home_without_token_redirect', { current_url: currentUrl });
      await page.goto('https://mp.weixin.qq.com/', { waitUntil: 'domcontentloaded' }).catch(() => {});
      await humanPause(page, cfg, 1.0);
      continue;
    }

    if (maybeLoggedInByUrl || (hasLoggedInUi && !hasLoginUi)) {
      if (Date.now() - lastVerifyAt < verifyMinIntervalMs) {
        await humanPause(page, cfg, 0.8);
        continue;
      }
      lastVerifyAt = Date.now();
      const ready = await verifySessionReady(page, cfg, requireEditor);
      if (ready.ok) {
        stableLoggedInCount += 1;
        lastToken = ready.token || lastToken;
        trace(cfg, 'login_verified', {
          stable_count: stableLoggedInCount,
          required_rounds: cfg.loginStableRounds,
          token_present: Boolean(lastToken),
        });
        if (stableLoggedInCount >= cfg.loginStableRounds) {
          return lastToken;
        }
      } else {
        stableLoggedInCount = 0;
        trace(cfg, 'login_verify_failed', { require_editor: requireEditor });
      }
    } else {
      stableLoggedInCount = 0;
    }

    if (!hasLoginUi && (!currentUrl.includes('mp.weixin.qq.com') || isLoginRelatedUrl(currentUrl))) {
      await page.goto('https://mp.weixin.qq.com/', { waitUntil: 'domcontentloaded' }).catch(() => {});
    }

    await humanPause(page, cfg, 1.4);
  }

  throw new Error(
    `login timeout after ${cfg.loginTimeoutMs}ms; please scan QR code and complete login; last_states=${JSON.stringify(states)}`
  );
}

async function gotoEditor(page, editUrl, cfg, sessionToken = '') {
  const targetUrl = buildEditUrlWithToken(editUrl, sessionToken);
  await page.goto(targetUrl, { waitUntil: 'domcontentloaded' });
  await humanPause(page, cfg, 0.6);
  await page.waitForLoadState('networkidle').catch(() => {});
  await humanPause(page, cfg, 0.6);
}

async function fillTitle(page, title, cfg) {
  const selectors = [
    'input[placeholder*="标题"]',
    'input.weui-desktop-form__input',
    '.weui-desktop-form__input',
    '[contenteditable="true"][data-placeholder*="标题"]',
  ];

  for (const selector of selectors) {
    const locator = page.locator(selector).first();
    const visible = await locator.isVisible().catch(() => false);
    if (!visible) {
      continue;
    }

    const tagName = await locator.evaluate(el => el.tagName.toLowerCase()).catch(() => '');
    if (tagName === 'input' || tagName === 'textarea') {
      await humanPause(page, cfg, 0.8);
      await locator.fill('');
      await humanPause(page, cfg, 0.5);
      await locator.type(title, { delay: randomTypeDelayMs(cfg) });
      await humanPause(page, cfg, 0.7);
      return;
    }

    await humanPause(page, cfg, 0.8);
    await locator.click();
    await page.keyboard.press('ControlOrMeta+A').catch(() => {});
    await humanPause(page, cfg, 0.4);
    await page.keyboard.type(title, { delay: randomTypeDelayMs(cfg) });
    await humanPause(page, cfg, 0.7);
    return;
  }

  throw new Error('failed to locate article title input in editor page');
}

async function fillContent(page, htmlContent, cfg) {
  const directEditable = page.locator('[contenteditable="true"][role="textbox"]').first();
  if (await directEditable.isVisible().catch(() => false)) {
    await humanPause(page, cfg, 0.8);
    await directEditable.click();
    await page.keyboard.press('ControlOrMeta+A').catch(() => {});
    await humanPause(page, cfg, 0.5);
    await directEditable.evaluate((el, html) => {
      el.innerHTML = html;
    }, htmlContent);
    await humanPause(page, cfg, 0.8);
    return;
  }

  for (const frame of page.frames()) {
    const editable = frame.locator('body[contenteditable="true"], #tinymce, [contenteditable="true"]').first();
    const visible = await editable.isVisible().catch(() => false);
    if (!visible) {
      continue;
    }

    await humanPause(page, cfg, 0.8);
    await editable.click();
    await humanPause(page, cfg, 0.5);
    await editable.evaluate((el, html) => {
      el.innerHTML = html;
    }, htmlContent);
    await humanPause(page, cfg, 0.8);
    return;
  }

  throw new Error('failed to locate article content editor iframe/element');
}

async function clickButtonByText(page, labels, cfg) {
  for (const label of labels) {
    const selectorCandidates = [
      `button:has-text("${label}")`,
      `a:has-text("${label}")`,
      `[role="button"]:has-text("${label}")`,
      `span:has-text("${label}")`,
    ];

    for (const selector of selectorCandidates) {
      const locator = page.locator(selector).first();
      const visible = await locator.isVisible().catch(() => false);
      if (!visible) {
        continue;
      }

      await humanPause(page, cfg, 0.9);
      await locator.click({ force: true }).catch(async () => {
        await locator.click();
      });
      await humanPause(page, cfg, 1.1);
      return true;
    }
  }

  return false;
}

async function submitArticle(page, submitMode, cfg) {
  if (submitMode === 'publish') {
    const clickedPublish = await clickButtonByText(page, ['发表', '发布', '群发'], cfg);
    if (!clickedPublish) {
      throw new Error('failed to find publish button');
    }

    await humanPause(page, cfg, 1.2);
    await clickButtonByText(page, ['确定', '确认', '继续发表'], cfg).catch(() => {});

    return {
      mode: 'publish',
      successHints: ['发布成功', '发表成功', '群发成功'],
    };
  }

  const clickedDraft = await clickButtonByText(page, ['保存为草稿', '保存草稿', '保存'], cfg);
  if (!clickedDraft) {
    throw new Error('failed to find save draft button');
  }

  return {
    mode: 'draft',
    successHints: ['保存成功', '已保存'],
  };
}

async function waitForSuccessHint(page, successHints, cfg) {
  const start = Date.now();

  while (Date.now() - start < 20000) {
    const bodyText = await page.locator('body').innerText().catch(() => '');
    if (successHints.some(hint => bodyText.includes(hint))) {
      return;
    }

    await humanPause(page, cfg, 0.9);
  }
}

async function main() {
  const { payloadPath, payload } = readPayload(process.argv[2] || '');
  const cfg = getEnvConfig();
  const loginOnlyRequested = cfg.loginOnly || payload.browser_login_only === true;
  const effectiveHeadless = loginOnlyRequested ? false : cfg.headless;

  if (!['draft', 'publish'].includes(cfg.submitMode)) {
    fail('BROWSER_INVALID_SUBMIT_MODE', `unsupported WECHAT_BROWSER_SUBMIT_MODE: ${cfg.submitMode}`);
  }

  const taskId = payload.task_id || 'task';
  const title = loginOnlyRequested ? '' : normalizeTitle(payload);
  const content = loginOnlyRequested ? '' : normalizeContent(payload);

  if (cfg.dryRun) {
    output({
      ok: true,
      publish_url: `https://mp.weixin.qq.com/s/dry-run-${encodeURIComponent(String(taskId))}-${Date.now()}`,
      message: 'dry run success; playwright actions skipped',
      mode: cfg.submitMode,
      payload_path: payloadPath,
    });
    return;
  }

  let chromium;
  try {
    ({ chromium } = await import('playwright'));
  } catch (error) {
    fail(
      'BROWSER_PLAYWRIGHT_NOT_INSTALLED',
      'playwright is not installed. Run: npm install -D playwright',
      { detail: error instanceof Error ? error.message : String(error) }
    );
  }

  await ensureDir(cfg.userDataDir);

  let context;
  let page;
  try {
    context = await launchContextWithProfileRetry(chromium, cfg, effectiveHeadless);

    context.setDefaultTimeout(cfg.actionTimeoutMs);
    context.setDefaultNavigationTimeout(cfg.navTimeoutMs);

    page = context.pages()[0] || await context.newPage();
    await page.goto('https://mp.weixin.qq.com/', { waitUntil: 'domcontentloaded' });
    const sessionToken = await waitForLogin(page, cfg, { requireEditor: !loginOnlyRequested });

    if (loginOnlyRequested) {
      if (cfg.loginOnlyHoldMs > 0) {
        await sleep(cfg.loginOnlyHoldMs);
      }
      output({
        ok: true,
        publish_url: page.url(),
        message: 'wechat browser login success',
        mode: 'login-only',
        headless: effectiveHeadless,
        session_token_present: Boolean(sessionToken),
        task_id: taskId,
        payload_path: payloadPath,
      });
      return;
    }

    await gotoEditor(page, cfg.editUrl, cfg, sessionToken);

    await fillTitle(page, title, cfg);
    await fillContent(page, content, cfg);

    const submitResult = await submitArticle(page, cfg.submitMode, cfg);
    await waitForSuccessHint(page, submitResult.successHints, cfg).catch(() => {});

    output({
      ok: true,
      publish_url: page.url(),
      message: `wechat browser ${submitResult.mode} success`,
      mode: submitResult.mode,
      headless: effectiveHeadless,
      task_id: taskId,
      payload_path: payloadPath,
    });
  } catch (error) {
    const artifacts = page ? await takeDebugArtifacts(page, cfg.debugDir, taskId) : {};

    fail(
      'BROWSER_PLAYWRIGHT_FAILED',
      error instanceof Error ? error.message : 'unknown playwright error',
      {
        mode: cfg.submitMode,
        task_id: taskId,
        payload_path: payloadPath,
        ...artifacts,
      }
    );
  } finally {
    await context?.close().catch(() => {});
  }
}

main().catch((error) => {
  fail('BROWSER_FATAL', error instanceof Error ? error.message : String(error));
});
