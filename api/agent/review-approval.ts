import crypto from 'crypto';
import jwt, { JwtPayload } from 'jsonwebtoken';
import { PublishRequest } from './types.js';

export interface ReviewApprovalClaims {
  task_id: string;
  content_hash: string;
  review_approved: boolean;
  reviewer?: string;
  iss?: string;
  iat?: number;
  exp?: number;
}

function getReviewTokenSecret(): string {
  return (process.env.WECHAT_AGENT_REVIEW_TOKEN_SECRET || process.env.WECHAT_AGENT_SIGNING_SECRET || '').trim();
}

function getReviewTokenIssuer(): string {
  return process.env.WECHAT_AGENT_REVIEW_TOKEN_ISSUER || 'ecs-review';
}

function getReviewTokenTtlSeconds(): number {
  return Number(process.env.WECHAT_AGENT_REVIEW_TOKEN_TTL_SECONDS || '600');
}

export function isReviewTokenRequired(): boolean {
  return process.env.WECHAT_AGENT_REQUIRE_REVIEW_TOKEN !== 'false';
}

export function isReviewTokenSecretConfigured(): boolean {
  return Boolean(getReviewTokenSecret());
}

export function getReviewApprovalPolicy(): {
  required: boolean;
  secret_configured: boolean;
  issuer: string;
  ttl_seconds: number;
} {
  return {
    required: isReviewTokenRequired(),
    secret_configured: isReviewTokenSecretConfigured(),
    issuer: getReviewTokenIssuer(),
    ttl_seconds: getReviewTokenTtlSeconds(),
  };
}

function buildContentHashPayload(input: Pick<PublishRequest, 'task_id' | 'title' | 'content' | 'preferred_channel' | 'thumb_media_id' | 'author' | 'digest' | 'content_source_url'>): string {
  return JSON.stringify({
    task_id: input.task_id,
    title: input.title,
    content: input.content,
    preferred_channel: input.preferred_channel || 'official',
    thumb_media_id: input.thumb_media_id || '',
    author: input.author || '',
    digest: input.digest || '',
    content_source_url: input.content_source_url || '',
  });
}

export function computePublishContentHash(input: Pick<PublishRequest, 'task_id' | 'title' | 'content' | 'preferred_channel' | 'thumb_media_id' | 'author' | 'digest' | 'content_source_url'>): string {
  return crypto.createHash('sha256').update(buildContentHashPayload(input), 'utf8').digest('hex');
}

export function createReviewApprovalToken(
  input: Pick<PublishRequest, 'task_id' | 'title' | 'content' | 'preferred_channel' | 'thumb_media_id' | 'author' | 'digest' | 'content_source_url'>,
  options?: { reviewer?: string; expiresInSeconds?: number }
): string {
  const secret = getReviewTokenSecret();
  if (!secret) {
    throw new Error('review token secret is not configured');
  }

  const payload: ReviewApprovalClaims = {
    task_id: input.task_id,
    content_hash: computePublishContentHash(input),
    review_approved: true,
    reviewer: options?.reviewer || process.env.WECHAT_AGENT_REVIEWER || 'reviewer',
  };

  return jwt.sign(payload, secret, {
    algorithm: 'HS256',
    expiresIn: options?.expiresInSeconds || getReviewTokenTtlSeconds(),
    issuer: getReviewTokenIssuer(),
  });
}

export function verifyReviewApproval(input: PublishRequest): {
  ok: boolean;
  error_code?: string;
  error_message?: string;
  reviewer?: string;
} {
  if (!input.review_approved) {
    return {
      ok: false,
      error_code: 'REVIEW_NOT_APPROVED',
      error_message: 'review_approved must be true in assist mode',
    };
  }

  if (!isReviewTokenRequired()) {
    return { ok: true };
  }

  const secret = getReviewTokenSecret();
  if (!secret) {
    return {
      ok: false,
      error_code: 'REVIEW_TOKEN_SECRET_NOT_CONFIGURED',
      error_message: 'review token is required but WECHAT_AGENT_REVIEW_TOKEN_SECRET is not configured',
    };
  }

  if (!input.review_approval_token) {
    return {
      ok: false,
      error_code: 'REVIEW_TOKEN_MISSING',
      error_message: 'review_approval_token is required',
    };
  }

  let decoded: JwtPayload | string;
  try {
    decoded = jwt.verify(input.review_approval_token, secret, {
      algorithms: ['HS256'],
      issuer: getReviewTokenIssuer(),
    });
  } catch (error) {
    return {
      ok: false,
      error_code: 'REVIEW_TOKEN_INVALID',
      error_message: error instanceof Error ? error.message : 'invalid review token',
    };
  }

  if (!decoded || typeof decoded === 'string') {
    return {
      ok: false,
      error_code: 'REVIEW_TOKEN_INVALID',
      error_message: 'invalid token payload',
    };
  }

  const claims = decoded as ReviewApprovalClaims;

  if (!claims.review_approved) {
    return {
      ok: false,
      error_code: 'REVIEW_TOKEN_NOT_APPROVED',
      error_message: 'review token does not contain approved state',
    };
  }

  if (claims.task_id !== input.task_id) {
    return {
      ok: false,
      error_code: 'REVIEW_TOKEN_TASK_MISMATCH',
      error_message: 'review token task_id does not match publish request',
    };
  }

  const expectedContentHash = computePublishContentHash(input);
  if (claims.content_hash !== expectedContentHash) {
    return {
      ok: false,
      error_code: 'REVIEW_TOKEN_CONTENT_MISMATCH',
      error_message: 'review token content hash does not match publish request content',
    };
  }

  return {
    ok: true,
    reviewer: claims.reviewer,
  };
}
