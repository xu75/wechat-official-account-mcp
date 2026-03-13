#!/usr/bin/env node
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { appendTimestampToTitle, loadEnvConfig, signReviewApprovalToken } from './review-token-utils.mjs';

function parseArgs() {
  const args = process.argv.slice(2);
  const payloadFile = args[0] || '';

  if (!payloadFile) {
    throw new Error('usage: node scripts/agent-publish.mjs <publish-json-file> [--no-timestamp-title] [--no-refresh-keys] [--no-review-token] [--reviewer <name>]');
  }

  let timestampTitle = true;
  let refreshKeys = true;
  let autoReviewToken = true;
  let reviewer = process.env.WECHAT_AGENT_REVIEWER || 'local-reviewer';

  for (let i = 1; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === '--no-timestamp-title') {
      timestampTitle = false;
      continue;
    }
    if (arg === '--no-refresh-keys') {
      refreshKeys = false;
      continue;
    }
    if (arg === '--no-review-token') {
      autoReviewToken = false;
      continue;
    }
    if (arg === '--reviewer') {
      reviewer = args[i + 1] || reviewer;
      i += 1;
    }
  }

  return {
    payloadFile,
    timestampTitle,
    refreshKeys,
    autoReviewToken,
    reviewer,
  };
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

async function main() {
  loadEnvConfig();

  const options = parseArgs();
  const resolved = path.resolve(process.cwd(), options.payloadFile);
  if (!fs.existsSync(resolved)) {
    throw new Error(`payload file not found: ${resolved}`);
  }

  const baseUrl = process.env.AGENT_BASE_URL || 'http://127.0.0.1:4273';
  const signingSecret = process.env.WECHAT_AGENT_SIGNING_SECRET || '';
  if (!signingSecret) {
    throw new Error('WECHAT_AGENT_SIGNING_SECRET is required');
  }

  const payload = JSON.parse(fs.readFileSync(resolved, 'utf8'));
  payload.review_approved = true;

  if (options.timestampTitle) {
    payload.title = appendTimestampToTitle(payload.title || 'Publish test');
  }

  if (options.refreshKeys) {
    const suffix = Date.now();
    payload.task_id = `${payload.task_id || 'wx_task'}_${suffix}`;
    payload.idempotency_key = `${payload.idempotency_key || 'wx_idem'}_${suffix}`;
  }

  if (options.autoReviewToken) {
    payload.review_approval_token = signReviewApprovalToken(payload, { reviewer: options.reviewer });
  }

  const bodyText = JSON.stringify(payload);
  const headers = {
    'Content-Type': 'application/json',
    ...signHeaders(signingSecret, 'POST', '/publish', bodyText),
  };

  const response = await fetch(new URL('/publish', baseUrl).toString(), {
    method: 'POST',
    headers,
    body: bodyText,
  });

  const responseText = await response.text();
  let responseBody;
  try {
    responseBody = JSON.parse(responseText);
  } catch {
    responseBody = responseText;
  }

  process.stdout.write(`${JSON.stringify({
    request: {
      url: new URL('/publish', baseUrl).toString(),
      task_id: payload.task_id,
      idempotency_key: payload.idempotency_key,
      preferred_channel: payload.preferred_channel,
      title: payload.title,
      reviewer: options.reviewer,
      auto_review_token: options.autoReviewToken,
    },
    response: {
      status: response.status,
      ok: response.ok,
      body: responseBody,
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
