import crypto from 'crypto';
import dotenv from 'dotenv';
import fs from 'fs';
import jwt from 'jsonwebtoken';
import path from 'path';

export function loadEnvConfig() {
  const candidates = [];
  if (process.env.AGENT_ENV_FILE) {
    candidates.push(process.env.AGENT_ENV_FILE);
  }
  candidates.push('.env.agent', '.env.local', '.env');

  for (const candidate of candidates) {
    const resolved = path.resolve(process.cwd(), candidate);
    if (!fs.existsSync(resolved) || !fs.statSync(resolved).isFile()) {
      continue;
    }
    dotenv.config({ path: resolved, override: false, quiet: true });
  }
}

function getReviewTokenSecret() {
  return (process.env.WECHAT_AGENT_REVIEW_TOKEN_SECRET || process.env.WECHAT_AGENT_SIGNING_SECRET || '').trim();
}

function getReviewTokenIssuer() {
  return process.env.WECHAT_AGENT_REVIEW_TOKEN_ISSUER || 'ecs-review';
}

function getReviewTokenTtlSeconds() {
  return Number(process.env.WECHAT_AGENT_REVIEW_TOKEN_TTL_SECONDS || '600');
}

function buildContentHashPayload(input) {
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

export function computePublishContentHash(input) {
  return crypto.createHash('sha256').update(buildContentHashPayload(input), 'utf8').digest('hex');
}

export function signReviewApprovalToken(input, options = {}) {
  const secret = getReviewTokenSecret();
  if (!secret) {
    throw new Error('review token secret is not configured (set WECHAT_AGENT_REVIEW_TOKEN_SECRET or WECHAT_AGENT_SIGNING_SECRET)');
  }

  const reviewer = options.reviewer || process.env.WECHAT_AGENT_REVIEWER || 'reviewer';
  const expiresInSeconds = Number(options.expiresInSeconds || getReviewTokenTtlSeconds());

  return jwt.sign(
    {
      task_id: input.task_id,
      content_hash: computePublishContentHash(input),
      review_approved: true,
      reviewer,
    },
    secret,
    {
      algorithm: 'HS256',
      expiresIn: expiresInSeconds,
      issuer: getReviewTokenIssuer(),
    }
  );
}

export function appendTimestampToTitle(title) {
  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  const hh = String(now.getHours()).padStart(2, '0');
  const mm = String(now.getMinutes()).padStart(2, '0');
  const ss = String(now.getSeconds()).padStart(2, '0');
  return `${title} [${y}${m}${d}-${hh}${mm}${ss}]`;
}
