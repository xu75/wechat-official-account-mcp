#!/usr/bin/env node
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  collectImageSources,
  isSubmissionConfirmed,
  stripImageTags,
  validateEditorContentSnapshot,
} from './publish-validation.mjs';

const DEFAULT_HOME_URL = 'https://mp.weixin.qq.com/';
const DEFAULT_EDIT_URL = 'https://mp.weixin.qq.com/cgi-bin/appmsg?t=media/appmsg_edit_v2&action=edit&isNew=1';

class BrowserLoginRequiredError extends Error {
  constructor(message, loginUrl = '') {
    super(message);
    this.name = 'BrowserLoginRequiredError';
    this.loginUrl = loginUrl;
  }
}

class BrowserPublishValidationError extends Error {
  constructor(code, message, metadata = {}) {
    super(message);
    this.name = 'BrowserPublishValidationError';
    this.code = String(code || 'BROWSER_CONTENT_INJECTION_FAILED');
    this.metadata = metadata || {};
  }
}

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
  if (!inputPath) return inputPath;
  if (inputPath.startsWith('~/')) return path.join(os.homedir(), inputPath.slice(2));
  return inputPath;
}

function readPayload(payloadPathArg) {
  if (!payloadPathArg) fail('BROWSER_PAYLOAD_MISSING', 'payload file path argument is required');

  const payloadPath = path.resolve(process.cwd(), payloadPathArg);
  if (!fs.existsSync(payloadPath)) fail('BROWSER_PAYLOAD_NOT_FOUND', `payload file not found: ${payloadPath}`);

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
  const cdpUrl = process.env.WECHAT_BROWSER_CDP_URL || `http://127.0.0.1:${process.env.WECHAT_BROWSER_CDP_PORT || '9222'}`;
  const humanDelayBaseMs = Number(process.env.WECHAT_BROWSER_HUMAN_DELAY_BASE_MS || '700');
  const humanDelayJitterMs = Number(process.env.WECHAT_BROWSER_HUMAN_DELAY_JITTER_MS || '500');
  const typeDelayMinMs = Number(process.env.WECHAT_BROWSER_TYPE_DELAY_MIN_MS || '45');
  const typeDelayMaxMs = Number(process.env.WECHAT_BROWSER_TYPE_DELAY_MAX_MS || '120');
  const normalizedTypeMin = Number.isFinite(typeDelayMinMs) && typeDelayMinMs >= 0 ? typeDelayMinMs : 45;
  const normalizedTypeMax =
    Number.isFinite(typeDelayMaxMs) && typeDelayMaxMs >= normalizedTypeMin ? typeDelayMaxMs : Math.max(normalizedTypeMin, 120);

  return {
    cdpUrl,
    submitMode: (process.env.WECHAT_BROWSER_SUBMIT_MODE || 'draft').toLowerCase(),
    loginOnly: process.env.WECHAT_BROWSER_LOGIN_ONLY === 'true',
    loginTimeoutMs: Number(process.env.WECHAT_BROWSER_LOGIN_TIMEOUT_MS || '180000'),
    publishLoginTimeoutMs: Number(process.env.WECHAT_BROWSER_PUBLISH_LOGIN_TIMEOUT_MS || '30000'),
    returnLoginQr: process.env.WECHAT_BROWSER_RETURN_LOGIN_QR !== 'false',
    actionTimeoutMs: Number(process.env.WECHAT_BROWSER_ACTION_TIMEOUT_MS || '30000'),
    navTimeoutMs: Number(process.env.WECHAT_BROWSER_NAV_TIMEOUT_MS || '60000'),
    debugDir: path.resolve(expandHome(process.env.WECHAT_BROWSER_DEBUG_DIR || '/tmp/wechat-agent-browser-debug')),
    editUrl: process.env.WECHAT_BROWSER_EDIT_URL || DEFAULT_EDIT_URL,
    dryRun: process.env.WECHAT_BROWSER_DRY_RUN === 'true',
    loginOnlyHoldMs: Number(process.env.WECHAT_BROWSER_LOGIN_ONLY_HOLD_MS || '8000'),
    imageMode: (process.env.WECHAT_BROWSER_IMAGE_MODE || 'skip').toLowerCase() === 'strict' ? 'strict' : 'skip',
    verbose: process.env.WECHAT_BROWSER_VERBOSE === 'true',
    humanDelayBaseMs: Number.isFinite(humanDelayBaseMs) && humanDelayBaseMs >= 0 ? humanDelayBaseMs : 700,
    humanDelayJitterMs: Number.isFinite(humanDelayJitterMs) && humanDelayJitterMs >= 0 ? humanDelayJitterMs : 500,
    typeDelayMinMs: normalizedTypeMin,
    typeDelayMaxMs: normalizedTypeMax,
  };
}

function prepareContentForPublish(inputHtml, cfg) {
  const html = String(inputHtml || '');
  const inputImages = collectImageSources(html);
  if (cfg.imageMode !== 'strict') {
    const stripped = stripImageTags(html);
    return {
      html: stripped,
      image_mode: 'skip',
      input_image_count: inputImages.length,
      image_skipped_count: inputImages.length,
    };
  }

  return {
    html,
    image_mode: 'strict',
    input_image_count: inputImages.length,
    image_skipped_count: 0,
  };
}

function trace(cfg, message, data = {}) {
  if (!cfg.verbose) return;
  process.stderr.write(`[wechat-cdp] ${JSON.stringify({ ts: new Date().toISOString(), message, ...data })}\n`);
}

function randomBetween(min, max) {
  if (max <= min) return min;
  return Math.floor(min + Math.random() * (max - min));
}

function randomTypeDelayMs(cfg) {
  return randomBetween(cfg.typeDelayMinMs, cfg.typeDelayMaxMs + 1);
}

async function sleep(ms) {
  if (ms <= 0) return;
  await new Promise(resolve => setTimeout(resolve, ms));
}

async function humanPause(cfg, multiplier = 1) {
  const scaledBase = Math.max(0, Math.floor(cfg.humanDelayBaseMs * multiplier));
  const jitter = cfg.humanDelayJitterMs > 0 ? randomBetween(0, cfg.humanDelayJitterMs + 1) : 0;
  await sleep(scaledBase + jitter);
}

async function ensureDir(dirPath) {
  await fs.promises.mkdir(dirPath, { recursive: true });
}

function extractTokenFromUrl(input) {
  try {
    return new URL(input).searchParams.get('token') || '';
  } catch {
    return '';
  }
}

function isLoginRelatedUrl(input) {
  return input.includes('/cgi-bin/loginpage') || input.includes('/cgi-bin/bizlogin');
}

function buildEditUrlWithToken(editUrl, token) {
  try {
    const obj = new URL(editUrl);
    if (token) obj.searchParams.set('token', token);
    return obj.toString();
  } catch {
    return editUrl;
  }
}

async function pickWechatPage(context) {
  const pages = context.pages();
  return pages.find(p => p.url().includes('mp.weixin.qq.com')) || pages[0] || await context.newPage();
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

async function captureLoginQrBase64(page) {
  const selectors = [
    'img.js_qrcode',
    '#js_login_container img',
    '#login_container img',
    '.login__type__container img',
    '.js_login_qrcode img',
    '.scan_login_qrcode img',
    '.qrcode_login img',
    'img[src*="qrcode"]',
    'img[src*="qr"]',
    'canvas',
  ];

  for (const selector of selectors) {
    const locator = page.locator(selector).first();
    const visible = await locator.isVisible().catch(() => false);
    if (!visible) continue;
    const imageBuffer = await locator.screenshot({ type: 'png' }).catch(() => null);
    if (imageBuffer && imageBuffer.length > 0) {
      return imageBuffer.toString('base64');
    }
  }

  for (const frame of page.frames()) {
    for (const selector of selectors) {
      const locator = frame.locator(selector).first();
      const visible = await locator.isVisible().catch(() => false);
      if (!visible) continue;
      const imageBuffer = await locator.screenshot({ type: 'png' }).catch(() => null);
      if (imageBuffer && imageBuffer.length > 0) {
        return imageBuffer.toString('base64');
      }
    }
  }

  return '';
}

async function collectLoginQr(context, preferredPage, cfg) {
  const pages = context?.pages?.() || [];
  const scanOrder = preferredPage ? [preferredPage, ...pages.filter(p => p !== preferredPage)] : pages;

  for (const candidate of scanOrder) {
    const qr = await captureLoginQrBase64(candidate).catch(() => '');
    if (qr) {
      return {
        pngBase64: qr,
        loginUrl: candidate.url() || DEFAULT_HOME_URL,
      };
    }
  }

  if (preferredPage && !preferredPage.isClosed()) {
    // Fallback: force open the canonical login page once and retry for a short window.
    await preferredPage.goto(DEFAULT_HOME_URL, { waitUntil: 'domcontentloaded' }).catch(() => {});
    const start = Date.now();
    while (Date.now() - start < 8000) {
      const qr = await captureLoginQrBase64(preferredPage).catch(() => '');
      if (qr) {
        return {
          pngBase64: qr,
          loginUrl: preferredPage.url() || DEFAULT_HOME_URL,
        };
      }
      await humanPause(cfg, 0.6);
    }
    return {
      pngBase64: '',
      loginUrl: preferredPage.url() || DEFAULT_HOME_URL,
    };
  }

  return {
    pngBase64: '',
    loginUrl: DEFAULT_HOME_URL,
  };
}

function normalizeTitle(payload) {
  const raw = String(payload.title || '').trim();
  if (!raw) fail('BROWSER_TITLE_EMPTY', 'title is required');

  const withoutInvisible = raw
    .replace(/[\u200B-\u200D\u2060\uFEFF]/g, '')
    .replace(/[\u0000-\u001F\u007F-\u009F]/g, ' ');
  const normalizedSpace = withoutInvisible.replace(/\s+/g, ' ').trim();
  const maxLength = 64;
  const sliced = Array.from(normalizedSpace).slice(0, maxLength).join('');
  const value = sliced.trim();

  if (!value) fail('BROWSER_TITLE_INVALID', 'title is invalid after sanitization');

  return {
    value,
    sanitized: value !== raw,
    original_length: Array.from(raw).length,
    normalized_length: Array.from(value).length,
  };
}

function normalizeContent(payload) {
  const raw = String(payload.content || '').trim();
  if (!raw) fail('BROWSER_CONTENT_EMPTY', 'content is required');
  return raw;
}

async function isShopMessageEditor(page) {
  const byDom = await page.locator('.shopmsg_edit_wrp, .weui-desktop-shopmsg').first().isVisible().catch(() => false);
  const byUrl = /shopmsg|type=11/i.test(page.url());
  return byDom || byUrl;
}

function isArticleEditorUrl(input) {
  const url = String(input || '');
  return /\/cgi-bin\/appmsg/i.test(url) || /appmsg_edit_v2|media\/appmsg_edit|action=edit|appmsgid=/i.test(url);
}

async function isArticleEditor(page) {
  if (await isShopMessageEditor(page)) return false;
  const url = page.url();
  if (!isArticleEditorUrl(url)) return false;
  const hasRichEditor = await page
    .locator('.ProseMirror, .ql-editor[contenteditable="true"], #tinymce, [contenteditable="true"][role="textbox"], iframe[id*="ueditor"]')
    .first()
    .isVisible()
    .catch(() => false);

  const hasTitleInput = await page
    .locator('input#title, input[name="title"], textarea#title, input[placeholder*="标题"], [contenteditable="true"][data-placeholder*="标题"], #js_title')
    .first()
    .isVisible()
    .catch(() => false);

  const hasArticleRoot = await page
    .locator('#js_appmsg_editor, #appmsg_editor, .appmsg_editor, .rich_media_title')
    .first()
    .isVisible()
    .catch(() => false);

  const hasSaveButton = await page
    .locator('button:has-text("保存为草稿"), button:has-text("保存草稿"), .weui-desktop-btn:has-text("保存为草稿"), .weui-desktop-btn:has-text("保存草稿")')
    .first()
    .isVisible()
    .catch(() => false);

  return hasArticleRoot || ((hasTitleInput || hasSaveButton) && hasRichEditor) || (hasTitleInput && hasSaveButton);
}

async function clickHomeArticleEntry(page, cfg) {
  const info = await page.evaluate(() => {
    const items = Array.from(document.querySelectorAll('.new-creation__menu .new-creation__menu-item'));
    if (items.length === 0) {
      return { ok: false, reason: 'creation_menu_not_found', entries: [] };
    }
    const labels = items.map(item => {
      const title = item.querySelector('.new-creation__menu-title');
      return (title?.textContent || item.textContent || '').trim();
    });
    const hasArticleEntry = labels.some(text => text === '文章' || text === '图文');
    if (!hasArticleEntry) {
      return { ok: false, reason: 'article_entry_not_found', entries: labels };
    }
    return { ok: true, reason: '', entries: labels };
  });

  trace(cfg, 'click_home_article_entry_scan', info);
  if (!info.ok) return info;

  const titleLocator = page
    .locator('.new-creation__menu .new-creation__menu-item .new-creation__menu-title')
    .filter({ hasText: /^(文章|图文)$/ })
    .first();
  const titleVisible = await titleLocator.isVisible().catch(() => false);
  if (!titleVisible) {
    return { ok: false, reason: 'article_entry_not_visible', entries: info.entries || [] };
  }

  const targetItem = titleLocator.locator('xpath=ancestor::div[contains(@class,"new-creation__menu-item")]').first();
  await targetItem.scrollIntoViewIfNeeded().catch(() => {});
  await humanPause(cfg, 0.5);
  await targetItem.click({ timeout: 10000 }).catch(async () => {
    await humanPause(cfg, 0.3);
    await targetItem.click({ timeout: 10000, force: true });
  });
  await humanPause(cfg, 0.8);

  return { ok: true, reason: '', entries: info.entries || [] };
}

async function ensureLoggedIn(page, cfg, options = {}) {
  const interactiveLogin = options.interactiveLogin !== false;
  const timeoutMs = interactiveLogin
    ? cfg.loginTimeoutMs
    : Math.max(5000, Math.min(cfg.loginTimeoutMs, cfg.publishLoginTimeoutMs));
  const start = Date.now();
  const initialUrl = page.url();
  if (!initialUrl.includes('mp.weixin.qq.com')) {
    await page.goto(DEFAULT_HOME_URL, { waitUntil: 'domcontentloaded' }).catch(() => {});
  }

  while (Date.now() - start < timeoutMs) {
    const currentUrl = page.url();
    const token = extractTokenFromUrl(currentUrl);
    const hasLoginUi = await page.locator('img.js_qrcode, #js_login_container, .login__type__container').first().isVisible().catch(() => false);
    const hasHomeUi = await page.locator('#js_sideBar, .weui-desktop-layout, .weui-desktop-menu').first().isVisible().catch(() => false);

    trace(cfg, 'login_poll', {
      current_url: currentUrl,
      token_present: Boolean(token),
      has_login_ui: hasLoginUi,
      has_home_ui: hasHomeUi,
    });

    if (!interactiveLogin && (hasLoginUi || isLoginRelatedUrl(currentUrl))) {
      throw new BrowserLoginRequiredError(
        'wechat login required; manual scan is needed',
        currentUrl || DEFAULT_HOME_URL,
      );
    }

    if (token && currentUrl.includes('/cgi-bin/') && !isLoginRelatedUrl(currentUrl)) {
      return token;
    }

    if (hasHomeUi && !hasLoginUi) {
      await page.goto('https://mp.weixin.qq.com/cgi-bin/home?t=home/index', { waitUntil: 'domcontentloaded' }).catch(() => {});
      await humanPause(cfg, 0.8);
      const homeToken = extractTokenFromUrl(page.url());
      if (homeToken) return homeToken;
      if (!interactiveLogin) {
        throw new BrowserLoginRequiredError(
          'wechat login required; manual scan is needed',
          page.url() || DEFAULT_HOME_URL,
        );
      }
    }

    if (currentUrl.includes('/cgi-bin/home') && !token && !hasHomeUi) {
      await page.goto(DEFAULT_HOME_URL, { waitUntil: 'domcontentloaded' }).catch(() => {});
    }

    await humanPause(cfg, 1.2);
  }

  if (!interactiveLogin) {
    throw new BrowserLoginRequiredError(
      `login timeout after ${timeoutMs}ms; manual scan is still required`,
      page.url() || DEFAULT_HOME_URL,
    );
  }
  throw new Error(`login timeout after ${timeoutMs}ms; if this is publish mode, run npm run agent:browser:login:confirm first`);
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
      if (!visible) continue;

      await humanPause(cfg, 0.8);
      await locator.click({ force: true }).catch(async () => {
        await humanPause(cfg, 0.3);
        await locator.click();
      });
      await humanPause(cfg, 1.0);
      return true;
    }
  }
  return false;
}

async function openEditorPage(context, page, cfg, sessionToken) {
  const baselineUrls = new Map(context.pages().map((p) => [p, p.url()]));
  const isCandidateEditorPage = (p) => {
    if (p === page) return true;
    if (!baselineUrls.has(p)) return true;
    const before = String(baselineUrls.get(p) || '');
    const now = String(p.url() || '');
    // Reject stale editor tabs that existed before this run.
    if (isArticleEditorUrl(before) && isArticleEditorUrl(now)) return false;
    return true;
  };

  const homeUrl = buildEditUrlWithToken('https://mp.weixin.qq.com/cgi-bin/home?t=home/index', sessionToken);
  await page.goto(homeUrl, { waitUntil: 'domcontentloaded' }).catch(() => {});
  await humanPause(cfg, 0.8);
  await page.waitForLoadState('networkidle').catch(() => {});

  const clickResult = await clickHomeArticleEntry(page, cfg);
  if (!clickResult.ok) {
    throw new Error(
      `failed to find 首页>新的创作>文章 entry; reason=${clickResult.reason || 'unknown'} entries=${(clickResult.entries || []).join(',')}`
    );
  }

  const start = Date.now();
  let sawShopMessage = false;
  let lastTraceAt = 0;
  const scanForArticleEditor = async () => {
    for (const p of context.pages()) {
      if (!isCandidateEditorPage(p)) continue;
      const u = p.url();
      if (!u.includes('/cgi-bin/')) continue;
      if (isLoginRelatedUrl(u)) continue;
      if (await isShopMessageEditor(p)) {
        sawShopMessage = true;
        continue;
      }
      if (await isArticleEditor(p)) return p;
    }
    return null;
  };

  while (Date.now() - start < 30000) {
    if (Date.now() - lastTraceAt > 2500) {
      const urls = context.pages().map(p => p.url());
      trace(cfg, 'open_editor_poll', { urls });
      lastTraceAt = Date.now();
    }
    const editorPage = await scanForArticleEditor();
    if (editorPage) return editorPage;
    await humanPause(cfg, 0.7);
  }

  // Fallback: some account home pages don't open editor from "新的创作" reliably.
  // Try direct article-editor URL once with token to avoid false "home page as editor".
  const fallbackPage = page && !page.isClosed() ? page : await pickWechatPage(context);
  const editUrlWithToken = buildEditUrlWithToken(cfg.editUrl || DEFAULT_EDIT_URL, sessionToken);
  trace(cfg, 'open_editor_fallback_direct_url', { url: editUrlWithToken });
  await fallbackPage.goto(editUrlWithToken, { waitUntil: 'domcontentloaded' }).catch(() => {});
  await humanPause(cfg, 0.8);
  await fallbackPage.waitForLoadState('networkidle').catch(() => {});

  const fallbackStart = Date.now();
  while (Date.now() - fallbackStart < 15000) {
    const editorPage = await scanForArticleEditor();
    if (editorPage) return editorPage;
    await humanPause(cfg, 0.6);
  }

  if (sawShopMessage) {
    throw new Error('首页创作入口跳转到了商品消息(shopmsg)而非文章编辑器，请在后台确认“文章创作”入口权限');
  }
  throw new Error('首页创作后未进入文章编辑器，请检查公众号后台页面结构是否变更');
}

async function fillTitle(page, title, cfg) {
  if (!isArticleEditorUrl(page.url()) || await isShopMessageEditor(page)) {
    throw new Error(`article editor page is not ready before title fill; current_url=${page.url()}`);
  }

  const selectors = [
    'input[placeholder*="标题"]',
    '#title',
    'input[name="title"]',
    '#js_title',
    '[contenteditable="true"][data-placeholder*="标题"]',
  ];

  for (const selector of selectors) {
    const locator = page.locator(selector).first();
    const visible = await locator.isVisible().catch(() => false);
    if (!visible) continue;

    const tagName = await locator.evaluate(el => el.tagName.toLowerCase()).catch(() => '');
    if (tagName === 'input' || tagName === 'textarea') {
      await humanPause(cfg, 0.6);
      await locator.fill('');
      await humanPause(cfg, 0.4);
      await locator.type(title, { delay: randomTypeDelayMs(cfg) });
      await humanPause(cfg, 0.6);
      return;
    }

    await humanPause(cfg, 0.6);
    await locator.click();
    await page.keyboard.press('ControlOrMeta+A').catch(() => {});
    await humanPause(cfg, 0.4);
    await page.keyboard.type(title, { delay: randomTypeDelayMs(cfg) });
    await humanPause(cfg, 0.6);
    return;
  }

  throw new Error('failed to locate article title input in editor page');
}

async function findEditorSurface(page) {
  const directEditable = page
    .locator('.ProseMirror, .ql-editor[contenteditable="true"], #tinymce, [contenteditable="true"][role="textbox"], .rich_media_content[contenteditable="true"]')
    .first();
  if (await directEditable.isVisible().catch(() => false)) {
    return {
      kind: 'direct',
      locator: directEditable,
      frameUrl: page.mainFrame().url(),
    };
  }

  for (const frame of page.frames()) {
    const editable = frame.locator('body[contenteditable="true"], #tinymce, .ProseMirror, .ql-editor[contenteditable="true"], [contenteditable="true"][role="textbox"]').first();
    const visible = await editable.isVisible().catch(() => false);
    if (!visible) continue;

    return {
      kind: 'frame',
      locator: editable,
      frameUrl: frame.url(),
    };
  }

  return null;
}

async function getEditorSnapshot(page, preferredSurface) {
  const surface = preferredSurface || await findEditorSurface(page);
  if (!surface) {
    return {
      surface: null,
      found: false,
      html: '',
      text: '',
    };
  }

  const snap = await surface.locator.evaluate((el) => {
    const html = typeof el?.innerHTML === 'string' ? el.innerHTML : '';
    const text = typeof el?.innerText === 'string'
      ? el.innerText
      : (typeof el?.textContent === 'string' ? el.textContent : '');
    return {
      html,
      text,
    };
  }).catch(() => ({ html: '', text: '' }));

  return {
    surface,
    found: true,
    html: String(snap?.html || ''),
    text: String(snap?.text || ''),
  };
}

async function fillContent(page, htmlContent, cfg) {
  const surface = await findEditorSurface(page);
  if (!surface) {
    throw new BrowserPublishValidationError(
      'BROWSER_CONTENT_INJECTION_FAILED',
      'failed to locate article content editor iframe/element',
      {
        stage: 'precheck',
        status: 'failed',
        content_length: 0,
      },
    );
  }

  const before = await getEditorSnapshot(page, surface);
  await humanPause(cfg, 0.6);
  await surface.locator.click();
  await page.keyboard.press('ControlOrMeta+A').catch(() => {});
  await humanPause(cfg, 0.4);

  try {
    await surface.locator.evaluate((el, html) => {
      el.innerHTML = html;
    }, htmlContent);
  } catch (error) {
    throw new BrowserPublishValidationError(
      'BROWSER_CONTENT_INJECTION_FAILED',
      error instanceof Error ? error.message : 'failed to inject article content',
      {
        stage: 'inject',
        status: 'failed',
        content_length: 0,
      },
    );
  }

  await humanPause(cfg, 0.8);
  const after = await getEditorSnapshot(page, surface);
  const validation = validateEditorContentSnapshot({
    inputHtml: htmlContent,
    editorHtml: after.html,
    editorText: after.text,
  });

  if (!validation.ok) {
    const msg = validation.error_code === 'BROWSER_EDITOR_EMPTY'
      ? 'editor content is empty after injection'
      : validation.error_code === 'BROWSER_IMAGE_INSERT_FAILED'
        ? 'image insertion failed after content injection'
        : 'content injection validation failed';
    throw new BrowserPublishValidationError(
      validation.error_code || 'BROWSER_CONTENT_INJECTION_FAILED',
      msg,
      {
        stage: 'postcheck',
        status: 'failed',
        content_length: validation.content_length,
        expected_image_count: validation.expected_image_count,
        actual_image_count: validation.actual_image_count,
        missing_images: validation.missing_images,
        fragment_matched: validation.fragment_matched,
      },
    );
  }

  return {
    surface,
    before_content_length: validateEditorContentSnapshot({
      inputHtml: htmlContent,
      editorHtml: before.html,
      editorText: before.text,
    }).content_length,
    content_length: validation.content_length,
    expected_image_count: validation.expected_image_count,
    actual_image_count: validation.actual_image_count,
    fragment_matched: validation.fragment_matched,
    input_text_hash: validation.input_text_hash,
    editor_text_hash: validation.editor_text_hash,
  };
}

async function submitArticle(page, submitMode, cfg) {
  if (submitMode === 'publish') {
    const clickedPublish = await clickButtonByText(page, ['发表', '发布', '群发'], cfg);
    if (!clickedPublish) throw new Error('failed to find publish button');
    await humanPause(cfg, 1.2);
    await clickButtonByText(page, ['确定', '确认', '继续发表'], cfg).catch(() => {});
    return { mode: 'publish', successHints: ['发布成功', '发表成功', '群发成功'] };
  }

  const clickedDraft = await clickButtonByText(page, ['保存为草稿', '保存草稿', '保存'], cfg);
  if (!clickedDraft) throw new Error('failed to find save draft button');
  return { mode: 'draft', successHints: ['保存成功', '已保存'] };
}

async function waitForSuccessHint(page, hints, cfg) {
  const start = Date.now();
  while (Date.now() - start < 20000) {
    const bodyText = await page.locator('body').innerText().catch(() => '');
    if (hints.some(h => bodyText.includes(h))) return true;
    await humanPause(cfg, 0.8);
  }
  return false;
}

async function detectSubmitBlockingError(page) {
  const bodyText = await page.locator('body').innerText().catch(() => '');
  const oneLine = String(bodyText || '').replace(/\s+/g, ' ').trim();
  if (!oneLine) return null;

  const titleInvalidPattern = /标题.{0,12}(不能|不支持|非法|违规|过长|为空|请填写|请修改)|请输入(标题|文章标题)/;
  if (titleInvalidPattern.test(oneLine)) {
    return {
      code: 'BROWSER_TITLE_INVALID',
      message: 'submit blocked by title validation in wechat editor',
      excerpt: oneLine.slice(0, 180),
    };
  }

  return null;
}

async function main() {
  const { payloadPath, payload } = readPayload(process.argv[2] || '');
  const cfg = getEnvConfig();
  const loginOnlyRequested = cfg.loginOnly || payload.browser_login_only === true;
  const interactiveLogin = loginOnlyRequested;

  if (!['draft', 'publish'].includes(cfg.submitMode)) {
    fail('BROWSER_INVALID_SUBMIT_MODE', `unsupported WECHAT_BROWSER_SUBMIT_MODE: ${cfg.submitMode}`);
  }

  const taskId = payload.task_id || 'task';
  const titlePlan = loginOnlyRequested
    ? { value: '', sanitized: false, original_length: 0, normalized_length: 0 }
    : normalizeTitle(payload);
  const content = loginOnlyRequested ? '' : normalizeContent(payload);
  const contentPlan = loginOnlyRequested
    ? { html: '', image_mode: cfg.imageMode, input_image_count: 0, image_skipped_count: 0 }
    : prepareContentForPublish(content, cfg);

  if (cfg.dryRun) {
    output({
      ok: true,
      publish_url: `https://mp.weixin.qq.com/s/dry-run-${encodeURIComponent(String(taskId))}-${Date.now()}`,
      message: 'dry run success; cdp actions skipped',
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

  let browser;
  let context;
  let page;

  try {
    trace(cfg, 'connect_cdp', { cdp_url: cfg.cdpUrl });
    browser = await chromium.connectOverCDP(cfg.cdpUrl);
    const contexts = browser.contexts();
    if (contexts.length === 0) {
      throw new Error('no browser context found via CDP; ensure Chrome is launched with --remote-debugging-port');
    }

    context = contexts[0];
    context.setDefaultTimeout(cfg.actionTimeoutMs);
    context.setDefaultNavigationTimeout(cfg.navTimeoutMs);
    page = await pickWechatPage(context);
    const sessionToken = await ensureLoggedIn(page, cfg, {
      interactiveLogin,
    });

    if (loginOnlyRequested) {
      if (cfg.loginOnlyHoldMs > 0) await sleep(cfg.loginOnlyHoldMs);
      output({
        ok: true,
        publish_url: page.url(),
        message: 'wechat browser login confirmed via cdp',
        mode: 'login-only',
        task_id: taskId,
        payload_path: payloadPath,
        session_token_present: Boolean(sessionToken),
      });
      return;
    }

    const editorPage = await openEditorPage(context, page, cfg, sessionToken);
    await fillTitle(editorPage, titlePlan.value, cfg);
    const contentCheck = await fillContent(editorPage, contentPlan.html, cfg);
    const beforeSubmitUrl = editorPage.url();
    const submitResult = await submitArticle(editorPage, cfg.submitMode, cfg);
    const successHintMatched = await waitForSuccessHint(editorPage, submitResult.successHints, cfg).catch(() => false);
    const submitConfirmed = isSubmissionConfirmed({
      mode: submitResult.mode,
      successHintMatched,
      beforeUrl: beforeSubmitUrl,
      url: editorPage.url(),
    });
    if (!submitConfirmed) {
      const submitBlock = await detectSubmitBlockingError(editorPage);
      throw new BrowserPublishValidationError(
        submitBlock?.code || 'BROWSER_SUBMIT_NOT_CONFIRMED',
        submitBlock?.message || 'submit action is not confirmed by page state',
        {
          stage: 'post_submit_check',
          status: 'failed',
          content_length: contentCheck.content_length,
          before_submit_url: beforeSubmitUrl,
          current_url: editorPage.url(),
          title_sanitized: titlePlan.sanitized,
          title_original_length: titlePlan.original_length,
          title_length: titlePlan.normalized_length,
          submit_block_excerpt: submitBlock?.excerpt || '',
        },
      );
    }

    const postSubmitSnapshot = await getEditorSnapshot(editorPage, contentCheck.surface);
    if (!postSubmitSnapshot.found && submitResult.mode === 'draft') {
      throw new BrowserPublishValidationError(
        'BROWSER_CONTENT_INJECTION_FAILED',
        'editor container is missing after submit',
        {
          stage: 'post_submit_check',
          status: 'failed',
          content_length: contentCheck.content_length,
        },
      );
    }
    if (postSubmitSnapshot.found) {
      const postSubmitValidation = validateEditorContentSnapshot({
        inputHtml: contentPlan.html,
        editorHtml: postSubmitSnapshot.html,
        editorText: postSubmitSnapshot.text,
      });
      if (!postSubmitValidation.ok && postSubmitValidation.error_code === 'BROWSER_EDITOR_EMPTY') {
        throw new BrowserPublishValidationError(
          'BROWSER_EDITOR_EMPTY',
          'editor content is empty after submit',
          {
            stage: 'post_submit_check',
            status: 'failed',
            content_length: postSubmitValidation.content_length,
          },
        );
      }
    }

    output({
      ok: true,
      publish_url: editorPage.url(),
      message: `wechat browser ${submitResult.mode} success via cdp`,
      mode: submitResult.mode,
      task_id: taskId,
      payload_path: payloadPath,
      cdp_url: cfg.cdpUrl,
      title_sanitized: titlePlan.sanitized,
      title_original_length: titlePlan.original_length,
      title_length: titlePlan.normalized_length,
      before_submit_url: beforeSubmitUrl,
      stage: 'post_submit_check',
      status: 'published',
      content_length: contentCheck.content_length,
      expected_image_count: contentCheck.expected_image_count,
      actual_image_count: contentCheck.actual_image_count,
      input_image_count: contentPlan.input_image_count,
      image_skipped_count: contentPlan.image_skipped_count,
      image_mode: contentPlan.image_mode,
      submit_confirmed: submitConfirmed,
      success_hint_matched: successHintMatched,
      input_text_hash: contentCheck.input_text_hash,
      editor_text_hash: contentCheck.editor_text_hash,
    });
  } catch (error) {
    if (error instanceof BrowserLoginRequiredError) {
      const artifacts = page ? await takeDebugArtifacts(page, cfg.debugDir, taskId) : {};
      const loginQr = (cfg.returnLoginQr && context)
        ? await collectLoginQr(context, page, cfg)
        : { pngBase64: '', loginUrl: page?.url() || DEFAULT_HOME_URL };
      fail(
        'BROWSER_LOGIN_REQUIRED',
        error.message,
        {
          mode: cfg.submitMode,
          task_id: taskId,
          payload_path: payloadPath,
          cdp_url: cfg.cdpUrl,
          login_url: loginQr.loginUrl || error.loginUrl || page?.url() || DEFAULT_HOME_URL,
          login_qr_mime: loginQr.pngBase64 ? 'image/png' : '',
          login_qr_png_base64: loginQr.pngBase64,
          stage: 'login',
          status: 'waiting_login',
          content_length: 0,
          error_code: 'BROWSER_LOGIN_REQUIRED',
          ...artifacts,
        }
      );
    }
    if (error instanceof BrowserPublishValidationError) {
      const artifacts = page ? await takeDebugArtifacts(page, cfg.debugDir, taskId) : {};
      fail(
        error.code,
        error.message,
        {
          mode: cfg.submitMode,
          task_id: taskId,
          payload_path: payloadPath,
          cdp_url: cfg.cdpUrl,
          stage: String(error.metadata?.stage || 'validation'),
          status: String(error.metadata?.status || 'failed'),
          title_sanitized: Boolean(error.metadata?.title_sanitized || titlePlan.sanitized),
          title_original_length: Number(error.metadata?.title_original_length || titlePlan.original_length || 0),
          title_length: Number(error.metadata?.title_length || titlePlan.normalized_length || 0),
          before_submit_url: String(error.metadata?.before_submit_url || ''),
          current_url: String(error.metadata?.current_url || ''),
          submit_block_excerpt: String(error.metadata?.submit_block_excerpt || ''),
          content_length: Number(error.metadata?.content_length || 0),
          expected_image_count: Number(error.metadata?.expected_image_count || 0),
          actual_image_count: Number(error.metadata?.actual_image_count || 0),
          input_image_count: Number(contentPlan.input_image_count || 0),
          image_skipped_count: Number(contentPlan.image_skipped_count || 0),
          image_mode: contentPlan.image_mode,
          error_code: error.code,
          ...artifacts,
        },
      );
    }
    const artifacts = page ? await takeDebugArtifacts(page, cfg.debugDir, taskId) : {};
    fail(
      'BROWSER_CDP_FAILED',
      error instanceof Error ? error.message : 'unknown cdp error',
      {
        mode: cfg.submitMode,
        task_id: taskId,
        payload_path: payloadPath,
        cdp_url: cfg.cdpUrl,
        stage: 'runtime',
        status: 'failed',
        title_sanitized: titlePlan.sanitized,
        title_original_length: titlePlan.original_length,
        title_length: titlePlan.normalized_length,
        content_length: 0,
        input_image_count: Number(contentPlan.input_image_count || 0),
        image_skipped_count: Number(contentPlan.image_skipped_count || 0),
        image_mode: contentPlan.image_mode,
        error_code: 'BROWSER_CDP_FAILED',
        ...artifacts,
      }
    );
  } finally {
    await browser?.close().catch(() => {});
  }
}

main().catch((error) => {
  fail('BROWSER_FATAL', error instanceof Error ? error.message : String(error));
});
