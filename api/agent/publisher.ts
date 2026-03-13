import { mkdir, writeFile } from 'fs/promises';
import path from 'path';
import { spawn } from 'child_process';
import { writeAgentLog } from './audit-log.js';
import { PublishRequest, PublishResponse } from './types.js';
import { getAuthManager, getWechatApiClient, initializeWechatContext } from './wechat-context.js';
import { verifyReviewApproval } from './review-approval.js';
import { upsertLoginSession } from './login-session-store.js';

type BrowserPublishMode = 'command' | 'manual';

type BrowserPublishResult = {
  publishUrl?: string;
  detail: string;
  stage?: string;
  status?: string;
  beforeSubmitUrl?: string;
  currentUrl?: string;
  titleSanitized?: boolean;
  titleOriginalLength?: number;
  titleLength?: number;
  submitBlockExcerpt?: string;
  contentLength?: number;
  expectedImageCount?: number;
  actualImageCount?: number;
  expectedLinkCount?: number;
  actualLinkCount?: number;
  missingLinkCountByQuantity?: number;
  inputImageCount?: number;
  imageSkippedCount?: number;
  imageMode?: string;
  imageSrcRewritten?: boolean;
  missingImageCountByQuantity?: number;
  submitConfirmed?: boolean;
  successHintMatched?: boolean;
  contentImageFound?: boolean;
  coverFromContentAttempted?: boolean;
  coverFromContentApplied?: boolean;
  coverFromContentReason?: string;
  postSubmitExpectedLinkCount?: number;
  postSubmitActualLinkCount?: number;
  postSubmitMissingLinkCountByQuantity?: number;
  postSubmitLinkDegraded?: boolean;
  postSubmitLinkTextFallbackApplied?: boolean;
  postSubmitLinkTextFallbackError?: string;
};

class AgentPublishError extends Error {
  code: string;
  metadata?: Record<string, unknown>;

  constructor(code: string, message: string, metadata?: Record<string, unknown>) {
    super(message);
    this.code = code;
    this.metadata = metadata;
  }
}

class OfficialPublisher {
  async initialize(): Promise<void> {
    await initializeWechatContext();
  }

  async publish(input: PublishRequest): Promise<{ publishId: string; draftMediaId: string }> {
    if (!input.thumb_media_id) {
      throw new AgentPublishError(
        'OFFICIAL_MISSING_THUMB_MEDIA_ID',
        'thumb_media_id is required for official publish channel',
      );
    }

    if (!getAuthManager().isConfigured()) {
      throw new AgentPublishError(
        'OFFICIAL_NOT_CONFIGURED',
        'wechat app credentials are not configured in local storage',
      );
    }

    const draft = await getWechatApiClient().post('/cgi-bin/draft/add', {
      articles: [
        {
          title: input.title,
          author: input.author || '',
          digest: input.digest || '',
          content: input.content,
          content_source_url: input.content_source_url || '',
          thumb_media_id: input.thumb_media_id,
          show_cover_pic: 1,
          need_open_comment: 0,
          only_fans_can_comment: 0,
        },
      ],
    }) as { media_id: string };

    const submit = await getWechatApiClient().post('/cgi-bin/freepublish/submit', {
      media_id: draft.media_id,
    }) as { publish_id: string };

    return {
      publishId: submit.publish_id,
      draftMediaId: draft.media_id,
    };
  }
}

function shellQuote(input: string): string {
  return `'${input.replace(/'/g, `'"'"'`)}'`;
}

function sanitizeTaskId(input: string): string {
  return input.replace(/[^a-zA-Z0-9._-]/g, '_');
}

function parseBrowserCommandResult(stdout: string): {
  ok: boolean;
  publish_url?: string;
  login_url?: string;
  login_qr_mime?: string;
  login_qr_png_base64?: string;
  stage?: string;
  status?: string;
  before_submit_url?: string;
  current_url?: string;
  title_sanitized?: boolean;
  title_original_length?: number;
  title_length?: number;
  submit_block_excerpt?: string;
  content_length?: number;
  expected_image_count?: number;
  actual_image_count?: number;
  expected_link_count?: number;
  actual_link_count?: number;
  missing_link_count_by_quantity?: number;
  input_image_count?: number;
  image_skipped_count?: number;
  image_mode?: string;
  image_src_rewritten?: boolean;
  missing_image_count_by_quantity?: number;
  submit_confirmed?: boolean;
  success_hint_matched?: boolean;
  content_image_found?: boolean;
  cover_from_content_attempted?: boolean;
  cover_from_content_applied?: boolean;
  cover_from_content_reason?: string;
  post_submit_expected_link_count?: number;
  post_submit_actual_link_count?: number;
  post_submit_missing_link_count_by_quantity?: number;
  post_submit_link_degraded?: boolean;
  post_submit_link_text_fallback_applied?: boolean;
  post_submit_link_text_fallback_error?: string;
  message?: string;
  error_code?: string;
  error_message?: string;
} {
  const raw = stdout.trim();
  if (!raw) {
    throw new Error('browser command returned empty stdout');
  }

  try {
    return JSON.parse(raw);
  } catch {
    const lines = raw.split('\n').map(line => line.trim()).filter(Boolean);
    const lastLine = lines.at(-1) || '';
    return JSON.parse(lastLine);
  }
}

async function runShellCommand(command: string, timeoutMs: number): Promise<{ stdout: string; stderr: string; exitCode: number | null }> {
  return await new Promise((resolve, reject) => {
    const child = spawn(command, {
      shell: true,
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];

    child.stdout.on('data', chunk => stdoutChunks.push(Buffer.from(chunk)));
    child.stderr.on('data', chunk => stderrChunks.push(Buffer.from(chunk)));

    const timeout = setTimeout(() => {
      child.kill('SIGTERM');
      reject(new Error(`browser command timeout after ${timeoutMs}ms`));
    }, timeoutMs);

    child.on('error', (error) => {
      clearTimeout(timeout);
      reject(error);
    });

    child.on('close', (exitCode) => {
      clearTimeout(timeout);
      resolve({
        stdout: Buffer.concat(stdoutChunks).toString('utf8'),
        stderr: Buffer.concat(stderrChunks).toString('utf8'),
        exitCode,
      });
    });
  });
}

const browserFallbackEnabled = process.env.WECHAT_AGENT_ENABLE_BROWSER_FALLBACK === 'true';
const browserPublishCmd = process.env.WECHAT_AGENT_BROWSER_PUBLISH_CMD || '';
const browserCommandTimeoutMs = Number(process.env.WECHAT_AGENT_BROWSER_COMMAND_TIMEOUT_MS || '180000');
const browserManualTaskDir = process.env.WECHAT_AGENT_MANUAL_TASK_DIR || '/tmp/wechat-agent-manual-tasks';
const browserPublishMode = (
  process.env.WECHAT_AGENT_BROWSER_PUBLISH_MODE
  || (browserPublishCmd ? 'command' : 'manual')
).toLowerCase() === 'command' ? 'command' : 'manual';

class BrowserPublisher {
  async publish(input: PublishRequest): Promise<BrowserPublishResult> {
    if (browserPublishMode === 'command') {
      return await this.publishByCommand(input);
    }

    return await this.publishByManualTask(input);
  }

  private async publishByCommand(input: PublishRequest): Promise<BrowserPublishResult> {
    if (!browserPublishCmd.trim()) {
      throw new AgentPublishError(
        'BROWSER_CMD_NOT_CONFIGURED',
        'WECHAT_AGENT_BROWSER_PUBLISH_CMD is required when browser publish mode is command',
      );
    }

    await mkdir(browserManualTaskDir, { recursive: true });
    const safeTaskId = sanitizeTaskId(input.task_id || 'task');
    const payloadPath = path.join(browserManualTaskDir, `${safeTaskId}-${Date.now()}.browser-payload.json`);

    await writeFile(payloadPath, JSON.stringify(input, null, 2), 'utf8');

    const command = `${browserPublishCmd} ${shellQuote(payloadPath)}`;
    const { stdout, stderr, exitCode } = await runShellCommand(command, browserCommandTimeoutMs);

    if (exitCode !== 0) {
      throw new AgentPublishError(
        'BROWSER_CMD_EXIT_NON_ZERO',
        `browser publish command failed with exit code ${String(exitCode)}: ${stderr || stdout}`,
      );
    }

    const result = parseBrowserCommandResult(stdout);
    if (!result.ok) {
      const stderrTail = stderr.trim().split('\n').slice(-8).join(' | ');
      const mergedMessage = [
        result.error_message || result.message || 'browser publish command returned not ok',
        stderrTail ? `stderr_tail=${stderrTail}` : '',
      ].filter(Boolean).join(' ; ');
      throw new AgentPublishError(
        result.error_code || 'BROWSER_CMD_REPORTED_FAILURE',
        mergedMessage,
        {
          login_url: result.login_url || '',
          login_qr_mime: result.login_qr_mime || '',
          login_qr_png_base64: result.login_qr_png_base64 || '',
          stage: result.stage || '',
          status: result.status || '',
          before_submit_url: String(result.before_submit_url || ''),
          current_url: String(result.current_url || ''),
          title_sanitized: result.title_sanitized === true,
          title_original_length: Number(result.title_original_length || 0),
          title_length: Number(result.title_length || 0),
          submit_block_excerpt: String(result.submit_block_excerpt || ''),
          content_length: Number(result.content_length || 0),
          expected_image_count: Number(result.expected_image_count || 0),
          actual_image_count: Number(result.actual_image_count || 0),
          expected_link_count: Number(result.expected_link_count || 0),
          actual_link_count: Number(result.actual_link_count || 0),
          missing_link_count_by_quantity: Number(result.missing_link_count_by_quantity || 0),
          input_image_count: Number(result.input_image_count || 0),
          image_skipped_count: Number(result.image_skipped_count || 0),
          image_mode: result.image_mode || '',
          image_src_rewritten: result.image_src_rewritten === true,
          missing_image_count_by_quantity: Number(result.missing_image_count_by_quantity || 0),
          content_image_found: result.content_image_found === true,
          cover_from_content_attempted: result.cover_from_content_attempted === true,
          cover_from_content_applied: result.cover_from_content_applied === true,
          cover_from_content_reason: String(result.cover_from_content_reason || ''),
          post_submit_expected_link_count: Number(result.post_submit_expected_link_count || 0),
          post_submit_actual_link_count: Number(result.post_submit_actual_link_count || 0),
          post_submit_missing_link_count_by_quantity: Number(result.post_submit_missing_link_count_by_quantity || 0),
          post_submit_link_degraded: result.post_submit_link_degraded === true,
          post_submit_link_text_fallback_applied: result.post_submit_link_text_fallback_applied === true,
          post_submit_link_text_fallback_error: String(result.post_submit_link_text_fallback_error || ''),
        },
      );
    }

    return {
      publishUrl: result.publish_url,
      detail: `browser command publish succeeded via ${browserPublishCmd}`,
      stage: result.stage || '',
      status: result.status || '',
      beforeSubmitUrl: String(result.before_submit_url || ''),
      currentUrl: String(result.current_url || ''),
      titleSanitized: result.title_sanitized === true,
      titleOriginalLength: Number(result.title_original_length || 0),
      titleLength: Number(result.title_length || 0),
      submitBlockExcerpt: String(result.submit_block_excerpt || ''),
      contentLength: Number(result.content_length || 0),
      expectedImageCount: Number(result.expected_image_count || 0),
      actualImageCount: Number(result.actual_image_count || 0),
      expectedLinkCount: Number(result.expected_link_count || 0),
      actualLinkCount: Number(result.actual_link_count || 0),
      missingLinkCountByQuantity: Number(result.missing_link_count_by_quantity || 0),
      inputImageCount: Number(result.input_image_count || 0),
      imageSkippedCount: Number(result.image_skipped_count || 0),
      imageMode: result.image_mode || '',
      imageSrcRewritten: result.image_src_rewritten === true,
      missingImageCountByQuantity: Number(result.missing_image_count_by_quantity || 0),
      submitConfirmed: result.submit_confirmed === true,
      successHintMatched: result.success_hint_matched === true,
      contentImageFound: result.content_image_found === true,
      coverFromContentAttempted: result.cover_from_content_attempted === true,
      coverFromContentApplied: result.cover_from_content_applied === true,
      coverFromContentReason: String(result.cover_from_content_reason || ''),
      postSubmitExpectedLinkCount: Number(result.post_submit_expected_link_count || 0),
      postSubmitActualLinkCount: Number(result.post_submit_actual_link_count || 0),
      postSubmitMissingLinkCountByQuantity: Number(result.post_submit_missing_link_count_by_quantity || 0),
      postSubmitLinkDegraded: result.post_submit_link_degraded === true,
      postSubmitLinkTextFallbackApplied: result.post_submit_link_text_fallback_applied === true,
      postSubmitLinkTextFallbackError: String(result.post_submit_link_text_fallback_error || ''),
    };
  }

  private async publishByManualTask(input: PublishRequest): Promise<BrowserPublishResult> {
    await mkdir(browserManualTaskDir, { recursive: true });

    const safeTaskId = sanitizeTaskId(input.task_id || 'task');
    const taskDir = path.join(browserManualTaskDir, `${safeTaskId}-${Date.now()}`);
    await mkdir(taskDir, { recursive: true });

    const metaPath = path.join(taskDir, 'publish-task.json');
    const htmlPath = path.join(taskDir, 'article-content.html');
    const readmePath = path.join(taskDir, 'README.txt');

    await writeFile(metaPath, JSON.stringify(input, null, 2), 'utf8');
    await writeFile(htmlPath, input.content, 'utf8');
    await writeFile(readmePath, [
      'WeChat Browser Publish Manual Task',
      '',
      `task_id: ${input.task_id}`,
      `idempotency_key: ${input.idempotency_key}`,
      '',
      '1) Open mp.weixin.qq.com and create a new article',
      `2) Title: ${input.title}`,
      `3) Content file: ${htmlPath}`,
      '4) Publish manually, then report publish_url via ECS callback flow',
    ].join('\n'), 'utf8');

    throw new AgentPublishError(
      'BROWSER_MANUAL_REQUIRED',
      `browser manual publish task generated at ${taskDir}`,
    );
  }
}

const officialPublisher = new OfficialPublisher();
const browserPublisher = new BrowserPublisher();

function normalizeError(error: unknown): { code: string; message: string; metadata?: Record<string, unknown> } {
  if (error instanceof AgentPublishError) {
    return {
      code: error.code,
      message: error.message,
      metadata: error.metadata,
    };
  }

  if (error instanceof Error) {
    return {
      code: 'PUBLISH_FAILED',
      message: error.message,
    };
  }

  return {
    code: 'UNKNOWN_ERROR',
    message: 'unknown publish error',
  };
}

async function runBrowserPublish(input: PublishRequest, startedAt: number, reason: string): Promise<PublishResponse> {
  try {
    const browserResult = await browserPublisher.publish(input);

    const response: PublishResponse = {
      task_id: input.task_id,
      idempotency_key: input.idempotency_key,
      status: 'accepted',
      channel: 'browser',
      dedup_hit: false,
      publish_url: browserResult.publishUrl,
      duration_ms: Date.now() - startedAt,
    };

    await writeAgentLog('publish_browser_success', {
      task_id: input.task_id,
      stage: browserResult.stage || 'post_submit_check',
      status: browserResult.status || 'published',
      before_submit_url: browserResult.beforeSubmitUrl || '',
      current_url: browserResult.currentUrl || '',
      title_sanitized: browserResult.titleSanitized === true,
      title_original_length: Number(browserResult.titleOriginalLength || 0),
      title_length: Number(browserResult.titleLength || 0),
      submit_block_excerpt: browserResult.submitBlockExcerpt || '',
      channel: 'browser',
      reason,
      detail: browserResult.detail,
      publish_url: browserResult.publishUrl || '',
      error_code: '',
      content_length: Number(browserResult.contentLength || 0),
      expected_image_count: Number(browserResult.expectedImageCount || 0),
      actual_image_count: Number(browserResult.actualImageCount || 0),
      expected_link_count: Number(browserResult.expectedLinkCount || 0),
      actual_link_count: Number(browserResult.actualLinkCount || 0),
      missing_link_count_by_quantity: Number(browserResult.missingLinkCountByQuantity || 0),
      input_image_count: Number(browserResult.inputImageCount || 0),
      image_skipped_count: Number(browserResult.imageSkippedCount || 0),
      image_mode: browserResult.imageMode || '',
      image_src_rewritten: browserResult.imageSrcRewritten === true,
      missing_image_count_by_quantity: Number(browserResult.missingImageCountByQuantity || 0),
      submit_confirmed: browserResult.submitConfirmed === true,
      success_hint_matched: browserResult.successHintMatched === true,
      content_image_found: browserResult.contentImageFound === true,
      cover_from_content_attempted: browserResult.coverFromContentAttempted === true,
      cover_from_content_applied: browserResult.coverFromContentApplied === true,
      cover_from_content_reason: browserResult.coverFromContentReason || '',
      post_submit_expected_link_count: Number(browserResult.postSubmitExpectedLinkCount || 0),
      post_submit_actual_link_count: Number(browserResult.postSubmitActualLinkCount || 0),
      post_submit_missing_link_count_by_quantity: Number(browserResult.postSubmitMissingLinkCountByQuantity || 0),
      post_submit_link_degraded: browserResult.postSubmitLinkDegraded === true,
      post_submit_link_text_fallback_applied: browserResult.postSubmitLinkTextFallbackApplied === true,
      post_submit_link_text_fallback_error: browserResult.postSubmitLinkTextFallbackError || '',
      duration_ms: response.duration_ms,
    });

    return response;
  } catch (browserError) {
    const browserErr = normalizeError(browserError);
    const loginUrlFromMeta = String(browserErr.metadata?.login_url || '').trim();
    const loginQrMime = String(browserErr.metadata?.login_qr_mime || '').trim();
    const loginQrPngBase64 = String(browserErr.metadata?.login_qr_png_base64 || '').trim();
    const loginRequired = browserErr.code === 'BROWSER_LOGIN_REQUIRED';

    if (loginRequired) {
      const loginSession = upsertLoginSession({
        task_id: input.task_id,
        idempotency_key: input.idempotency_key,
        login_url: loginUrlFromMeta || 'https://mp.weixin.qq.com/',
        qr_mime: loginQrMime || '',
        qr_png_base64: loginQrPngBase64 || '',
        error_code: browserErr.code,
        error_message: browserErr.message,
      });

      const response: PublishResponse = {
        task_id: input.task_id,
        idempotency_key: input.idempotency_key,
        status: 'waiting_login',
        channel: 'browser',
        dedup_hit: false,
        login_url: loginSession.login_url,
        login_session_id: loginSession.session_id,
        login_session_expires_at: loginSession.expires_at,
        login_qr_available: Boolean(loginSession.qr_png_base64),
        login_qr_mime: loginSession.qr_mime || undefined,
        login_qr_png_base64: loginSession.qr_png_base64 || undefined,
        error_code: browserErr.code,
        error_message: browserErr.message,
        duration_ms: Date.now() - startedAt,
      };

      await writeAgentLog('publish_browser_waiting_login', {
        task_id: input.task_id,
        stage: String(browserErr.metadata?.stage || 'login'),
        status: String(browserErr.metadata?.status || 'waiting_login'),
        before_submit_url: String(browserErr.metadata?.before_submit_url || ''),
        current_url: String(browserErr.metadata?.current_url || ''),
        title_sanitized: Boolean(browserErr.metadata?.title_sanitized || false),
        title_original_length: Number(browserErr.metadata?.title_original_length || 0),
        title_length: Number(browserErr.metadata?.title_length || 0),
        submit_block_excerpt: String(browserErr.metadata?.submit_block_excerpt || ''),
        channel: 'browser',
        reason,
        error_code: browserErr.code,
        error_message: browserErr.message,
        content_length: Number(browserErr.metadata?.content_length || 0),
        input_image_count: Number(browserErr.metadata?.input_image_count || 0),
        image_skipped_count: Number(browserErr.metadata?.image_skipped_count || 0),
        image_mode: String(browserErr.metadata?.image_mode || ''),
        image_src_rewritten: Boolean(browserErr.metadata?.image_src_rewritten || false),
        missing_image_count_by_quantity: Number(browserErr.metadata?.missing_image_count_by_quantity || 0),
        content_image_found: Boolean(browserErr.metadata?.content_image_found || false),
        cover_from_content_attempted: Boolean(browserErr.metadata?.cover_from_content_attempted || false),
        cover_from_content_applied: Boolean(browserErr.metadata?.cover_from_content_applied || false),
        cover_from_content_reason: String(browserErr.metadata?.cover_from_content_reason || ''),
        login_url: response.login_url || '',
        login_session_id: response.login_session_id || '',
        login_qr_available: response.login_qr_available === true,
      });

      return response;
    }

    await writeAgentLog('publish_browser_failed', {
      task_id: input.task_id,
      stage: String(browserErr.metadata?.stage || 'runtime'),
      status: String(browserErr.metadata?.status || 'failed'),
      before_submit_url: String(browserErr.metadata?.before_submit_url || ''),
      current_url: String(browserErr.metadata?.current_url || ''),
      title_sanitized: Boolean(browserErr.metadata?.title_sanitized || false),
      title_original_length: Number(browserErr.metadata?.title_original_length || 0),
      title_length: Number(browserErr.metadata?.title_length || 0),
      submit_block_excerpt: String(browserErr.metadata?.submit_block_excerpt || ''),
      channel: 'browser',
      reason,
      error_code: browserErr.code,
      error_message: browserErr.message,
      content_length: Number(browserErr.metadata?.content_length || 0),
        expected_image_count: Number(browserErr.metadata?.expected_image_count || 0),
        actual_image_count: Number(browserErr.metadata?.actual_image_count || 0),
        expected_link_count: Number(browserErr.metadata?.expected_link_count || 0),
        actual_link_count: Number(browserErr.metadata?.actual_link_count || 0),
        missing_link_count_by_quantity: Number(browserErr.metadata?.missing_link_count_by_quantity || 0),
        input_image_count: Number(browserErr.metadata?.input_image_count || 0),
      image_skipped_count: Number(browserErr.metadata?.image_skipped_count || 0),
      image_mode: String(browserErr.metadata?.image_mode || ''),
      image_src_rewritten: Boolean(browserErr.metadata?.image_src_rewritten || false),
      missing_image_count_by_quantity: Number(browserErr.metadata?.missing_image_count_by_quantity || 0),
      content_image_found: Boolean(browserErr.metadata?.content_image_found || false),
      cover_from_content_attempted: Boolean(browserErr.metadata?.cover_from_content_attempted || false),
      cover_from_content_applied: Boolean(browserErr.metadata?.cover_from_content_applied || false),
      cover_from_content_reason: String(browserErr.metadata?.cover_from_content_reason || ''),
    });

    return {
      task_id: input.task_id,
      idempotency_key: input.idempotency_key,
      status: 'publish_failed',
      channel: 'browser',
      dedup_hit: false,
      error_code: browserErr.code,
      error_message: browserErr.message,
      duration_ms: Date.now() - startedAt,
    };
  }
}

export async function publishArticle(input: PublishRequest): Promise<PublishResponse> {
  const startedAt = Date.now();

  await officialPublisher.initialize();

  const reviewCheck = verifyReviewApproval(input);
  if (!reviewCheck.ok) {
    await writeAgentLog('publish_review_rejected', {
      task_id: input.task_id,
      error_code: reviewCheck.error_code || 'REVIEW_REJECTED',
      error_message: reviewCheck.error_message || 'review check failed',
    });

    return {
      task_id: input.task_id,
      idempotency_key: input.idempotency_key,
      status: 'publish_failed',
      channel: input.preferred_channel || 'official',
      dedup_hit: false,
      error_code: reviewCheck.error_code || 'REVIEW_REJECTED',
      error_message: reviewCheck.error_message || 'review check failed',
      duration_ms: Date.now() - startedAt,
    };
  }

  const preferredChannel = input.preferred_channel || 'official';
  if (preferredChannel === 'browser') {
    return await runBrowserPublish(input, startedAt, 'preferred_browser');
  }

  try {
    const result = await officialPublisher.publish(input);
    const response: PublishResponse = {
      task_id: input.task_id,
      idempotency_key: input.idempotency_key,
      status: 'accepted',
      channel: 'official',
      dedup_hit: false,
      publish_id: result.publishId,
      draft_media_id: result.draftMediaId,
      duration_ms: Date.now() - startedAt,
    };

    await writeAgentLog('publish_success', {
      task_id: input.task_id,
      channel: 'official',
      publish_id: result.publishId,
      draft_media_id: result.draftMediaId,
      duration_ms: response.duration_ms,
    });

    return response;
  } catch (officialError) {
    const officialErr = normalizeError(officialError);

    await writeAgentLog('publish_official_failed', {
      task_id: input.task_id,
      channel: 'official',
      error_code: officialErr.code,
      error_message: officialErr.message,
    });

    if (!browserFallbackEnabled) {
      return {
        task_id: input.task_id,
        idempotency_key: input.idempotency_key,
        status: 'publish_failed',
        channel: 'official',
        dedup_hit: false,
        error_code: officialErr.code,
        error_message: officialErr.message,
        duration_ms: Date.now() - startedAt,
      };
    }

    return await runBrowserPublish(input, startedAt, 'official_failed');
  }
}

export function isBrowserFallbackEnabled(): boolean {
  return browserFallbackEnabled;
}

export function getBrowserPublishMode(): BrowserPublishMode {
  return browserPublishMode;
}

export function isBrowserCommandConfigured(): boolean {
  return Boolean(browserPublishCmd.trim());
}

export function getBrowserManualTaskDir(): string {
  return browserManualTaskDir;
}
