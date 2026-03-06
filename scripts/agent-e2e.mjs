#!/usr/bin/env node
import crypto from 'crypto';
import dotenv from 'dotenv';
import fs from 'fs';
import path from 'path';

function loadEnvConfig() {
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

function parseArgs() {
  const args = process.argv.slice(2);
  let channel = 'browser';
  let keepKeys = false;

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === '--channel') {
      channel = args[i + 1] || channel;
      i += 1;
      continue;
    }

    if (arg === '--keep-keys') {
      keepKeys = true;
    }
  }

  if (!['browser', 'official'].includes(channel)) {
    throw new Error(`unsupported channel: ${channel}`);
  }

  return { channel, keepKeys };
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

async function requestJson(baseUrl, secret, method, requestPath, body) {
  const bodyText = body ? JSON.stringify(body) : '';
  const headers = {
    'Content-Type': 'application/json',
  };

  if (method !== 'GET') {
    if (!secret) {
      throw new Error('WECHAT_AGENT_SIGNING_SECRET is required for non-GET requests');
    }
    Object.assign(headers, signHeaders(secret, method, requestPath, bodyText));
  }

  const response = await fetch(new URL(requestPath, baseUrl).toString(), {
    method,
    headers,
    body: method === 'GET' ? undefined : bodyText || '{}',
  });

  const text = await response.text();
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = text;
  }

  return {
    status: response.status,
    ok: response.ok,
    body: parsed,
  };
}

function readJson(filePath) {
  const resolved = path.resolve(process.cwd(), filePath);
  return JSON.parse(fs.readFileSync(resolved, 'utf8'));
}

function buildPayload(template, channel, keepKeys) {
  if (keepKeys) {
    return template;
  }

  const suffix = Date.now();
  return {
    ...template,
    task_id: `${template.task_id || `wx_${channel}`}_${suffix}`,
    idempotency_key: `${template.idempotency_key || `idem_${channel}`}_${suffix}`,
  };
}

async function main() {
  loadEnvConfig();
  const { channel, keepKeys } = parseArgs();

  const baseUrl = process.env.AGENT_BASE_URL || 'http://127.0.0.1:4273';
  const secret = process.env.WECHAT_AGENT_SIGNING_SECRET || '';

  const configCheckTemplate = channel === 'browser'
    ? 'scripts/agent-templates/config-check-browser.json'
    : 'scripts/agent-templates/config-check.json';
  const publishTemplate = channel === 'browser'
    ? 'scripts/agent-templates/publish-browser.json'
    : 'scripts/agent-templates/publish-official.json';

  const health = await requestJson(baseUrl, secret, 'GET', '/health');
  const configCheckPayload = readJson(configCheckTemplate);
  const configCheck = await requestJson(baseUrl, secret, 'POST', '/agent/config-check', configCheckPayload);

  const publishPayloadTemplate = readJson(publishTemplate);
  const publishPayload = buildPayload(publishPayloadTemplate, channel, keepKeys);
  const publish = await requestJson(baseUrl, secret, 'POST', '/publish', publishPayload);

  const summary = {
    channel,
    base_url: baseUrl,
    keep_keys: keepKeys,
    health,
    config_check: configCheck,
    publish: {
      request: {
        task_id: publishPayload.task_id,
        idempotency_key: publishPayload.idempotency_key,
        preferred_channel: publishPayload.preferred_channel,
      },
      response: publish,
    },
  };

  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);

  if (!health.ok || !configCheck.ok || !publish.ok) {
    process.exit(2);
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
