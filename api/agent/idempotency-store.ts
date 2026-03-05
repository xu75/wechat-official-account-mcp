import crypto from 'crypto';
import { PublishRequest, PublishResponse } from './types.js';

type IdempotentRecord = {
  payloadHash: string;
  response: PublishResponse;
  createdAt: number;
};

const IDEMPOTENCY_TTL_MS = Number(process.env.WECHAT_AGENT_IDEMPOTENCY_TTL_MS || `${24 * 60 * 60 * 1000}`);

const records = new Map<string, IdempotentRecord>();

function toPayloadHash(payload: PublishRequest): string {
  const canonical = JSON.stringify({
    task_id: payload.task_id,
    title: payload.title,
    content: payload.content,
    review_approved: payload.review_approved,
    preferred_channel: payload.preferred_channel || 'official',
    thumb_media_id: payload.thumb_media_id || '',
    author: payload.author || '',
    digest: payload.digest || '',
    content_source_url: payload.content_source_url || '',
  });

  return crypto.createHash('sha256').update(canonical, 'utf8').digest('hex');
}

function prune(nowMs: number): void {
  for (const [key, value] of records.entries()) {
    if (nowMs - value.createdAt > IDEMPOTENCY_TTL_MS) {
      records.delete(key);
    }
  }
}

export function getIdempotentResult(payload: PublishRequest): {
  found: boolean;
  conflict: boolean;
  response?: PublishResponse;
} {
  const nowMs = Date.now();
  prune(nowMs);

  const existing = records.get(payload.idempotency_key);
  if (!existing) {
    return { found: false, conflict: false };
  }

  const incomingHash = toPayloadHash(payload);
  if (existing.payloadHash !== incomingHash) {
    return { found: true, conflict: true };
  }

  return {
    found: true,
    conflict: false,
    response: {
      ...existing.response,
      dedup_hit: true,
    },
  };
}

export function saveIdempotentResult(payload: PublishRequest, response: PublishResponse): void {
  records.set(payload.idempotency_key, {
    payloadHash: toPayloadHash(payload),
    response,
    createdAt: Date.now(),
  });
}

export function getIdempotencyTtlMs(): number {
  return IDEMPOTENCY_TTL_MS;
}
