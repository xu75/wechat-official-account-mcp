#!/usr/bin/env node
import fs from 'fs';
import os from 'os';
import path from 'path';

const DEFAULT_EDIT_URL = 'https://mp.weixin.qq.com/cgi-bin/appmsg?t=media/appmsg_edit_v2&action=edit&isNew=1';

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
  return {
    channel: process.env.WECHAT_BROWSER_CHANNEL || 'chrome',
    headless: process.env.WECHAT_BROWSER_HEADLESS === 'true',
    submitMode: (process.env.WECHAT_BROWSER_SUBMIT_MODE || 'draft').toLowerCase(),
    userDataDir: path.resolve(expandHome(process.env.WECHAT_BROWSER_USER_DATA_DIR || '~/.wechat-agent/browser-profile')),
    actionTimeoutMs: Number(process.env.WECHAT_BROWSER_ACTION_TIMEOUT_MS || '30000'),
    navTimeoutMs: Number(process.env.WECHAT_BROWSER_NAV_TIMEOUT_MS || '60000'),
    loginTimeoutMs: Number(process.env.WECHAT_BROWSER_LOGIN_TIMEOUT_MS || '180000'),
    debugDir: path.resolve(expandHome(process.env.WECHAT_BROWSER_DEBUG_DIR || '/tmp/wechat-agent-browser-debug')),
    editUrl: process.env.WECHAT_BROWSER_EDIT_URL || DEFAULT_EDIT_URL,
    dryRun: process.env.WECHAT_BROWSER_DRY_RUN === 'true',
  };
}

async function ensureDir(dirPath) {
  await fs.promises.mkdir(dirPath, { recursive: true });
}

async function takeDebugArtifacts(page, debugDir, taskId) {
  try {
    await ensureDir(debugDir);
    const stamp = Date.now();
    const safeTask = String(taskId || 'task').replace(/[^a-zA-Z0-9._-]/g, '_');
    const screenshotPath = path.join(debugDir, `${safeTask}-${stamp}.png`);
    const htmlPath = path.join(debugDir, `${safeTask}-${stamp}.html`);

    await page.screenshot({ path: screenshotPath, fullPage: true }).catch(() => {});
    const html = await page.content().catch(() => '');
    if (html) {
      await fs.promises.writeFile(htmlPath, html, 'utf8').catch(() => {});
    }

    return {
      screenshot_path: screenshotPath,
      html_path: htmlPath,
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

async function waitForLogin(page, loginTimeoutMs) {
  const start = Date.now();

  while (Date.now() - start < loginTimeoutMs) {
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

    if (!hasLoginUi && !currentUrl.includes('login')) {
      return;
    }

    await page.waitForTimeout(1500);
  }

  throw new Error(`login timeout after ${loginTimeoutMs}ms; please scan QR code and complete login`);
}

async function gotoEditor(page, editUrl) {
  await page.goto('https://mp.weixin.qq.com/', { waitUntil: 'domcontentloaded' });
  await page.waitForLoadState('networkidle').catch(() => {});
  await page.goto(editUrl, { waitUntil: 'domcontentloaded' });
  await page.waitForLoadState('networkidle').catch(() => {});
}

async function fillTitle(page, title) {
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
      await locator.fill('');
      await locator.type(title, { delay: 10 });
      return;
    }

    await locator.click();
    await page.keyboard.press('ControlOrMeta+A').catch(() => {});
    await page.keyboard.type(title, { delay: 10 });
    return;
  }

  throw new Error('failed to locate article title input in editor page');
}

async function fillContent(page, htmlContent) {
  const directEditable = page.locator('[contenteditable="true"][role="textbox"]').first();
  if (await directEditable.isVisible().catch(() => false)) {
    await directEditable.click();
    await page.keyboard.press('ControlOrMeta+A').catch(() => {});
    await directEditable.evaluate((el, html) => {
      el.innerHTML = html;
    }, htmlContent);
    return;
  }

  for (const frame of page.frames()) {
    const editable = frame.locator('body[contenteditable="true"], #tinymce, [contenteditable="true"]').first();
    const visible = await editable.isVisible().catch(() => false);
    if (!visible) {
      continue;
    }

    await editable.click();
    await editable.evaluate((el, html) => {
      el.innerHTML = html;
    }, htmlContent);
    return;
  }

  throw new Error('failed to locate article content editor iframe/element');
}

async function clickButtonByText(page, labels) {
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

      await locator.click({ force: true }).catch(async () => {
        await locator.click();
      });
      return true;
    }
  }

  return false;
}

async function submitArticle(page, submitMode) {
  if (submitMode === 'publish') {
    const clickedPublish = await clickButtonByText(page, ['发表', '发布', '群发']);
    if (!clickedPublish) {
      throw new Error('failed to find publish button');
    }

    await page.waitForTimeout(800);
    await clickButtonByText(page, ['确定', '确认', '继续发表']).catch(() => {});

    return {
      mode: 'publish',
      successHints: ['发布成功', '发表成功', '群发成功'],
    };
  }

  const clickedDraft = await clickButtonByText(page, ['保存为草稿', '保存草稿', '保存']);
  if (!clickedDraft) {
    throw new Error('failed to find save draft button');
  }

  return {
    mode: 'draft',
    successHints: ['保存成功', '已保存'],
  };
}

async function waitForSuccessHint(page, successHints) {
  const start = Date.now();

  while (Date.now() - start < 20000) {
    const bodyText = await page.locator('body').innerText().catch(() => '');
    if (successHints.some(hint => bodyText.includes(hint))) {
      return;
    }

    await page.waitForTimeout(1000);
  }
}

async function main() {
  const { payloadPath, payload } = readPayload(process.argv[2] || '');
  const cfg = getEnvConfig();

  if (!['draft', 'publish'].includes(cfg.submitMode)) {
    fail('BROWSER_INVALID_SUBMIT_MODE', `unsupported WECHAT_BROWSER_SUBMIT_MODE: ${cfg.submitMode}`);
  }

  const taskId = payload.task_id || 'task';
  const title = normalizeTitle(payload);
  const content = normalizeContent(payload);

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
    context = await chromium.launchPersistentContext(cfg.userDataDir, {
      headless: cfg.headless,
      channel: cfg.channel,
      viewport: { width: 1440, height: 900 },
      args: ['--disable-blink-features=AutomationControlled'],
    });

    context.setDefaultTimeout(cfg.actionTimeoutMs);
    context.setDefaultNavigationTimeout(cfg.navTimeoutMs);

    page = context.pages()[0] || await context.newPage();

    await gotoEditor(page, cfg.editUrl);
    await waitForLogin(page, cfg.loginTimeoutMs);
    await gotoEditor(page, cfg.editUrl);

    await fillTitle(page, title);
    await fillContent(page, content);

    const submitResult = await submitArticle(page, cfg.submitMode);
    await waitForSuccessHint(page, submitResult.successHints).catch(() => {});

    output({
      ok: true,
      publish_url: page.url(),
      message: `wechat browser ${submitResult.mode} success`,
      mode: submitResult.mode,
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
