import { Router, Request, Response } from 'express';
import { ZodError } from 'zod';
import {
  callbackRequestSchema,
  publishRequestSchema,
  type CallbackRequestInput,
  type PublishRequestInput,
} from '../agent/schemas.js';
import { getAgentLogPath, writeAgentLog } from '../agent/audit-log.js';
import { getIdempotencyTtlMs, getIdempotentResult, saveIdempotentResult } from '../agent/idempotency-store.js';
import { isBrowserFallbackEnabled, publishArticle } from '../agent/publisher.js';
import { getLastPublishSummary, updateLastPublishSummary } from '../agent/state.js';
import { getReplayWindowSeconds, verifyAgentSignature } from '../agent/signature.js';
import { type PublishRequest } from '../agent/types.js';

const router = Router();
const AGENT_MODE = 'assist';
const AGENT_VERSION = process.env.WECHAT_AGENT_VERSION || process.env.npm_package_version || '2.0.0';

router.get('/health', (_req: Request, res: Response) => {
  res.status(200).json({
    success: true,
    service: 'wechat-publisher-agent',
    mode: AGENT_MODE,
    version: AGENT_VERSION,
    browser_fallback_enabled: isBrowserFallbackEnabled(),
    replay_window_seconds: getReplayWindowSeconds(),
    idempotency_ttl_ms: getIdempotencyTtlMs(),
    log_file: getAgentLogPath(),
    last_publish: getLastPublishSummary(),
    now: new Date().toISOString(),
  });
});

router.post('/publish', verifyAgentSignature, async (req: Request, res: Response) => {
  try {
    const payload: PublishRequest = publishRequestSchema.parse(req.body) as PublishRequestInput as PublishRequest;

    const dedup = getIdempotentResult(payload);
    if (dedup.conflict) {
      await writeAgentLog('publish_idempotency_conflict', {
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
        task_id: payload.task_id,
        idempotency_key: payload.idempotency_key,
      });

      updateLastPublishSummary(dedup.response);
      res.status(200).json(dedup.response);
      return;
    }

    await writeAgentLog('publish_received', {
      task_id: payload.task_id,
      idempotency_key: payload.idempotency_key,
      preferred_channel: payload.preferred_channel || 'official',
    });

    const result = await publishArticle(payload);

    saveIdempotentResult(payload, result);
    updateLastPublishSummary(result);

    const statusCode = result.status === 'accepted' ? 202 : 200;
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
    const payload: CallbackRequestInput = callbackRequestSchema.parse(req.body);

    await writeAgentLog('callback_received', {
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

export default router;
