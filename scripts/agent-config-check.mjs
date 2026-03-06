#!/usr/bin/env node
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { appendTimestampToTitle, loadEnvConfig, signReviewApprovalToken } from './review-token-utils.mjs';

function parseArgs() {
  const args = process.argv.slice(2);
  const checkFile = args[0] || '';
  if (!checkFile) {
    throw new Error('usage: node scripts/agent-config-check.mjs <config-check-json-file> [--preview-from <publish-json-file>]');
  }

  let previewFrom = '';
  for (let i = 1; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === '--preview-from') {
      previewFrom = args[i + 1] || '';
      i += 1;
    }
  }

  return { checkFile, previewFrom };
}

function readJson(filePath) {
  const resolved = path.resolve(process.cwd(), filePath);
  if (!fs.existsSync(resolved)) {
    throw new Error(`file not found: ${resolved}`);
  }
  return JSON.parse(fs.readFileSync(resolved, 'utf8'));
}

function sha256Hex(input) {
  return crypto.createHash('sha256').update(input, 'utf8').digest('hex');
}

function hmacHex(secret, input) {
  return crypto.createHmac('sha256', secret).update(input, 'utf8').digest('hex');
}

function signHeaders(secret, method, requestPath, bodyText) {
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const payload = `${method}\n${requestPath}\n${timestamp}\n${sha256Hex(bodyText)}`;

  return {
    'X-Timestamp': timestamp,
    'X-Signature': hmacHex(secret, payload),
  };
}

function buildPreviewFromPublishTemplate(publishTemplate) {
  const suffix = Date.now();
  const publishPayload = {
    ...publishTemplate,
    task_id: `${publishTemplate.task_id || 'wx_preview'}_${suffix}`,
    idempotency_key: `${publishTemplate.idempotency_key || 'idem_preview'}_${suffix}`,
    title: appendTimestampToTitle(publishTemplate.title || 'Config check preview'),
    review_approved: true,
  };

  publishPayload.review_approval_token = signReviewApprovalToken(publishPayload, { reviewer: 'config-check' });

  return {
    task_id: publishPayload.task_id,
    idempotency_key: publishPayload.idempotency_key,
    title: publishPayload.title,
    content: publishPayload.content,
    review_approved: publishPayload.review_approved,
    review_approval_token: publishPayload.review_approval_token,
    preferred_channel: publishPayload.preferred_channel,
    thumb_media_id: publishPayload.thumb_media_id,
    author: publishPayload.author,
    digest: publishPayload.digest,
    content_source_url: publishPayload.content_source_url,
  };
}

async function main() {
  loadEnvConfig();
  const { checkFile, previewFrom } = parseArgs();

  const baseUrl = process.env.AGENT_BASE_URL || 'http://127.0.0.1:4273';
  const signingSecret = process.env.WECHAT_AGENT_SIGNING_SECRET || '';
  if (!signingSecret) {
    throw new Error('WECHAT_AGENT_SIGNING_SECRET is required');
  }

  const payload = readJson(checkFile);
  if (previewFrom) {
    payload.publish_preview = buildPreviewFromPublishTemplate(readJson(previewFrom));
  }

  const bodyText = JSON.stringify(payload);
  const headers = {
    'Content-Type': 'application/json',
    ...signHeaders(signingSecret, 'POST', '/agent/config-check', bodyText),
  };

  const response = await fetch(new URL('/agent/config-check', baseUrl).toString(), {
    method: 'POST',
    headers,
    body: bodyText,
  });

  const text = await response.text();
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = text;
  }

  process.stdout.write(`${JSON.stringify({
    request: {
      url: new URL('/agent/config-check', baseUrl).toString(),
      preview_from: previewFrom || null,
    },
    response: {
      status: response.status,
      ok: response.ok,
      body: parsed,
    },
  }, null, 2)}\n`);

  if (!response.ok) {
    process.exit(2);
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
