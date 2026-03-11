import { Router, Request, Response } from 'express';
import { ZodError } from 'zod';
import {
  callbackRequestSchema,
  configCheckRequestSchema,
  configInitRequestSchema,
  publishRequestSchema,
  type CallbackRequestInput,
  type ConfigCheckRequestInput,
  type ConfigInitRequestInput,
  type PublishRequestInput,
} from '../agent/schemas.js';
import { getAgentLogPath, writeAgentLog } from '../agent/audit-log.js';
import { getIdempotencyTtlMs, getIdempotentResult, saveIdempotentResult } from '../agent/idempotency-store.js';
import { getLoginSession, getLoginSessionByRequest, getLoginSessionTtlMs } from '../agent/login-session-store.js';
import {
  getBrowserManualTaskDir,
  getBrowserPublishMode,
  isBrowserCommandConfigured,
  isBrowserFallbackEnabled,
  publishArticle,
} from '../agent/publisher.js';
import { getLastPublishSummary, updateLastPublishSummary } from '../agent/state.js';
import { getReplayWindowSeconds, verifyAgentSignature } from '../agent/signature.js';
import { type AgentConfigCheckRequest, type AgentConfigInitRequest, type PublishRequest } from '../agent/types.js';
import { checkAgentConfig, initializeAgentConfig } from '../agent/config-service.js';
import { getReviewApprovalPolicy } from '../agent/review-approval.js';

const router = Router();
const AGENT_MODE = 'assist';
const AGENT_VERSION = process.env.WECHAT_AGENT_VERSION || process.env.npm_package_version || '2.0.0';

function normalizeHeaderValue(header: string | string[] | undefined): string {
  if (!header) return '';
  if (Array.isArray(header)) {
    return header.join(',');
  }
  return String(header);
}

function getRequestMeta(req: Request): {
  source_ip: string;
  x_forwarded_for: string;
  forwarded: string;
  remote_ip: string;
} {
  const xForwardedFor = normalizeHeaderValue(req.headers['x-forwarded-for'] as string | string[] | undefined);
  const forwarded = normalizeHeaderValue(req.headers.forwarded as string | string[] | undefined);
  const forwardedFirstIp = xForwardedFor
    .split(',')
    .map((item) => item.trim())
    .find(Boolean) || '';
  const remoteIp = req.socket?.remoteAddress || '';
  const sourceIp = forwardedFirstIp || req.ip || remoteIp || '';

  return {
    source_ip: sourceIp,
    x_forwarded_for: xForwardedFor,
    forwarded,
    remote_ip: remoteIp,
  };
}

router.get('/health', (_req: Request, res: Response) => {
  res.status(200).json({
    success: true,
    service: 'wechat-publisher-agent',
    mode: AGENT_MODE,
    version: AGENT_VERSION,
    browser_fallback_enabled: isBrowserFallbackEnabled(),
    browser_publish_mode: getBrowserPublishMode(),
    browser_command_configured: isBrowserCommandConfigured(),
    login_session_ttl_ms: getLoginSessionTtlMs(),
    browser_manual_task_dir: getBrowserManualTaskDir(),
    review_check: getReviewApprovalPolicy(),
    replay_window_seconds: getReplayWindowSeconds(),
    idempotency_ttl_ms: getIdempotencyTtlMs(),
    log_file: getAgentLogPath(),
    last_publish: getLastPublishSummary(),
    now: new Date().toISOString(),
  });
});

router.post('/publish', verifyAgentSignature, async (req: Request, res: Response) => {
  try {
    const requestMeta = getRequestMeta(req);
    const payload: PublishRequest = publishRequestSchema.parse(req.body) as PublishRequestInput as PublishRequest;

    const dedup = getIdempotentResult(payload);
    if (dedup.conflict) {
      await writeAgentLog('publish_idempotency_conflict', {
        ...requestMeta,
        task_id: payload.task_id,
        idempotency_key: payload.idempotency_key,
      });

      res.status(409).json({
        success: false,
        error: 'idempotency_key was used with different payload',
      });
      return;
    }

    if (dedup.found && dedup.response) {
      await writeAgentLog('publish_idempotency_hit', {
        ...requestMeta,
        task_id: payload.task_id,
        idempotency_key: payload.idempotency_key,
      });

      updateLastPublishSummary(dedup.response);
      res.status(200).json(dedup.response);
      return;
    }

    await writeAgentLog('publish_received', {
      ...requestMeta,
      task_id: payload.task_id,
      idempotency_key: payload.idempotency_key,
      preferred_channel: payload.preferred_channel || 'official',
    });

    const result = await publishArticle(payload);

    if (result.status !== 'waiting_login') {
      saveIdempotentResult(payload, result);
    }
    updateLastPublishSummary(result);

    const statusCode = (result.status === 'accepted' || result.status === 'waiting_login') ? 202 : 200;
    res.status(statusCode).json(result);
  } catch (error) {
    if (error instanceof ZodError) {
      res.status(400).json({
        success: false,
        error: 'invalid publish payload',
        details: error.errors,
      });
      return;
    }

    await writeAgentLog('publish_internal_error', {
      ...getRequestMeta(req),
      error: error instanceof Error ? error.message : 'unknown error',
    });

    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : 'internal error',
    });
  }
});

router.post('/agent/config/init', verifyAgentSignature, async (req: Request, res: Response) => {
  try {
    const requestMeta = getRequestMeta(req);
    const payload: AgentConfigInitRequest = configInitRequestSchema.parse(req.body) as ConfigInitRequestInput as AgentConfigInitRequest;
    const result = await initializeAgentConfig(payload);

    await writeAgentLog('config_initialized', {
      ...requestMeta,
      app_id: result.app_id,
      token_present: result.token_present,
      encoding_aes_key_present: result.encoding_aes_key_present,
    });

    res.status(200).json({
      success: true,
      ...result,
    });
  } catch (error) {
    if (error instanceof ZodError) {
      res.status(400).json({
        success: false,
        error: 'invalid config init payload',
        details: error.errors,
      });
      return;
    }

    await writeAgentLog('config_init_failed', {
      ...getRequestMeta(req),
      error: error instanceof Error ? error.message : 'unknown error',
    });

    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : 'internal error',
    });
  }
});

router.post('/agent/config-check', verifyAgentSignature, async (req: Request, res: Response) => {
  try {
    const requestMeta = getRequestMeta(req);
    const payload: AgentConfigCheckRequest = configCheckRequestSchema.parse(req.body || {}) as ConfigCheckRequestInput as AgentConfigCheckRequest;
    const result = await checkAgentConfig(payload);

    await writeAgentLog('config_checked', {
      ...requestMeta,
      configured: result.configured,
      token_ok: result.token_check.ok,
      publish_check_ok: result.publish_check.ok,
    });

    res.status(200).json({
      success: true,
      ...result,
    });
  } catch (error) {
    if (error instanceof ZodError) {
      res.status(400).json({
        success: false,
        error: 'invalid config check payload',
        details: error.errors,
      });
      return;
    }

    await writeAgentLog('config_check_failed', {
      ...getRequestMeta(req),
      error: error instanceof Error ? error.message : 'unknown error',
    });

    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : 'internal error',
    });
  }
});

router.post('/callback', verifyAgentSignature, async (req: Request, res: Response) => {
  try {
    const requestMeta = getRequestMeta(req);
    const payload: CallbackRequestInput = callbackRequestSchema.parse(req.body);

    await writeAgentLog('callback_received', {
      ...requestMeta,
      task_id: payload.task_id,
      status: payload.status,
      message: payload.message || '',
      metadata: payload.metadata || {},
    });

    res.status(200).json({
      success: true,
      message: 'callback accepted',
    });
  } catch (error) {
    if (error instanceof ZodError) {
      res.status(400).json({
        success: false,
        error: 'invalid callback payload',
        details: error.errors,
      });
      return;
    }

    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : 'internal error',
    });
  }
});

router.get('/agent/login-session/:sessionId', verifyAgentSignature, async (req: Request, res: Response) => {
  const sessionId = String(req.params.sessionId || '').trim();
  if (!sessionId) {
    res.status(400).json({ success: false, error: 'sessionId is required' });
    return;
  }

  const session = getLoginSession(sessionId);
  if (!session) {
    res.status(404).json({ success: false, error: 'login session not found or expired' });
    return;
  }

  res.status(200).json({
    success: true,
    session: {
      session_id: session.session_id,
      task_id: session.task_id,
      idempotency_key: session.idempotency_key,
      channel: session.channel,
      login_url: session.login_url,
      qr_available: Boolean(session.qr_png_base64),
      error_code: session.error_code,
      error_message: session.error_message,
      created_at: session.created_at,
      expires_at: session.expires_at,
    },
  });
});

router.get('/agent/login-session/:sessionId/qr', verifyAgentSignature, async (req: Request, res: Response) => {
  const sessionId = String(req.params.sessionId || '').trim();
  if (!sessionId) {
    res.status(400).json({ success: false, error: 'sessionId is required' });
    return;
  }

  const session = getLoginSession(sessionId);
  if (!session) {
    res.status(404).json({ success: false, error: 'login session not found or expired' });
    return;
  }

  if (!session.qr_png_base64) {
    res.status(404).json({ success: false, error: 'login qr is not available for this session' });
    return;
  }

  const mime = session.qr_mime || 'image/png';
  res.status(200).json({
    success: true,
    session_id: session.session_id,
    mime,
    png_base64: session.qr_png_base64,
    data_url: `data:${mime};base64,${session.qr_png_base64}`,
    expires_at: session.expires_at,
  });
});

router.get('/agent/login-session/by-request/:taskId/:idempotencyKey', verifyAgentSignature, async (req: Request, res: Response) => {
  const taskId = String(req.params.taskId || '').trim();
  const idempotencyKey = String(req.params.idempotencyKey || '').trim();
  if (!taskId || !idempotencyKey) {
    res.status(400).json({ success: false, error: 'taskId and idempotencyKey are required' });
    return;
  }

  const session = getLoginSessionByRequest(taskId, idempotencyKey);
  if (!session) {
    res.status(404).json({ success: false, error: 'login session not found or expired' });
    return;
  }

  res.status(200).json({
    success: true,
    session: {
      session_id: session.session_id,
      task_id: session.task_id,
      idempotency_key: session.idempotency_key,
      channel: session.channel,
      login_url: session.login_url,
      qr_available: Boolean(session.qr_png_base64),
      error_code: session.error_code,
      error_message: session.error_message,
      created_at: session.created_at,
      expires_at: session.expires_at,
    },
  });
});

export default router;
