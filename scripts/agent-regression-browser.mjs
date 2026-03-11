#!/usr/bin/env node
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { appendTimestampToTitle, loadEnvConfig, signReviewApprovalToken } from './review-token-utils.mjs';

const DEFAULT_TEMPLATE = 'scripts/agent-templates/publish-browser.json';

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

function parseArgs() {
  const args = process.argv.slice(2);
  let templateFile = DEFAULT_TEMPLATE;
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] === '--template') {
      templateFile = args[i + 1] || templateFile;
      i += 1;
    }
  }
  return { templateFile };
}

async function requestJson({ baseUrl, secret, method, requestPath, bodyObj }) {
  const bodyText = bodyObj ? JSON.stringify(bodyObj) : '';
  const headers = {
    'Content-Type': 'application/json',
    ...signHeaders(secret, method, requestPath, bodyText),
  };
  const url = new URL(requestPath, baseUrl).toString();

  let response;
  try {
    response = await fetch(url, {
      method,
      headers,
      body: method === 'GET' ? undefined : bodyText,
    });
  } catch (error) {
    const causeText = error instanceof Error && error.cause
      ? ` cause=${String(error.cause)}`
      : '';
    throw new Error(`request failed: ${method} ${url}${causeText}`);
  }

  const text = await response.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    body = text;
  }

  return {
    status: response.status,
    ok: response.ok,
    body,
  };
}

async function main() {
  loadEnvConfig();
  const { templateFile } = parseArgs();

  const baseUrl = process.env.AGENT_BASE_URL || 'http://127.0.0.1:4273';
  const signingSecret = (process.env.WECHAT_AGENT_SIGNING_SECRET || '').trim();
  if (!signingSecret) {
    throw new Error('WECHAT_AGENT_SIGNING_SECRET is required');
  }

  const resolvedTemplate = path.resolve(process.cwd(), templateFile);
  if (!fs.existsSync(resolvedTemplate)) {
    throw new Error(`template file not found: ${resolvedTemplate}`);
  }

  const payload = JSON.parse(fs.readFileSync(resolvedTemplate, 'utf8'));
  const suffix = Date.now();
  payload.task_id = `${payload.task_id || 'regression_browser'}_${suffix}`;
  payload.idempotency_key = `${payload.idempotency_key || 'regression_browser_idem'}_${suffix}`;
  payload.preferred_channel = 'browser';
  payload.review_approved = true;
  payload.title = appendTimestampToTitle(payload.title || '回归测试（Browser）');
  payload.review_approval_token = signReviewApprovalToken(payload, {
    reviewer: process.env.WECHAT_AGENT_REVIEWER || 'regression-smoke',
  });

  const health = await requestJson({
    baseUrl,
    secret: signingSecret,
    method: 'GET',
    requestPath: '/health',
  });
  if (!health.ok) {
    throw new Error(`health check failed: status=${health.status}`);
  }

  const firstPublish = await requestJson({
    baseUrl,
    secret: signingSecret,
    method: 'POST',
    requestPath: '/publish',
    bodyObj: payload,
  });
  if (!firstPublish.ok) {
    throw new Error(`first publish failed: status=${firstPublish.status}`);
  }

  const firstStatus = String(firstPublish.body?.status || '');
  if (firstStatus === 'waiting_login') {
    throw new Error('first publish returned waiting_login; please login first, then rerun regression');
  }
  if (!['accepted', 'publish_failed'].includes(firstStatus)) {
    throw new Error(`unexpected first publish status: ${firstStatus || 'unknown'}`);
  }

  const secondPublish = await requestJson({
    baseUrl,
    secret: signingSecret,
    method: 'POST',
    requestPath: '/publish',
    bodyObj: payload,
  });
  if (!secondPublish.ok) {
    throw new Error(`second publish failed: status=${secondPublish.status}`);
  }

  const secondStatus = String(secondPublish.body?.status || '');
  const dedupHit = secondPublish.body?.dedup_hit === true;
  if (!dedupHit) {
    throw new Error('idempotency replay failed: dedup_hit is false');
  }
  if (secondStatus !== firstStatus) {
    throw new Error(`idempotency replay status mismatch: first=${firstStatus}, second=${secondStatus}`);
  }
  if (String(secondPublish.body?.idempotency_key || '') !== payload.idempotency_key) {
    throw new Error('idempotency key mismatch in replay response');
  }

  process.stdout.write(`${JSON.stringify({
    ok: true,
    base_url: baseUrl,
    template_file: resolvedTemplate,
    checks: {
      health_status: health.status,
      first_publish_status: firstStatus,
      first_http_status: firstPublish.status,
      second_publish_status: secondStatus,
      second_http_status: secondPublish.status,
      dedup_hit: dedupHit,
    },
    task: {
      task_id: payload.task_id,
      idempotency_key: payload.idempotency_key,
      title: payload.title,
    },
  }, null, 2)}\n`);
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
