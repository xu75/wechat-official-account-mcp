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
    if (!fs.existsSync(resolved)) {
      continue;
    }
    if (!fs.statSync(resolved).isFile()) {
      continue;
    }
    dotenv.config({ path: resolved, override: false, quiet: true });
  }
}

function usage() {
  console.error('Usage: node scripts/agent-request.mjs <METHOD> <PATH> [BODY_JSON_OR_FILE]');
  console.error('Env files (auto load): .env.agent -> .env.local -> .env');
  console.error('Optional: AGENT_ENV_FILE=/path/to/file');
  console.error('Example:');
  console.error('  node scripts/agent-request.mjs GET /health');
  console.error('  node scripts/agent-request.mjs POST /agent/config-check scripts/agent-templates/config-check.json');
}

function sha256Hex(input) {
  return crypto.createHash('sha256').update(input, 'utf8').digest('hex');
}

function hmacHex(secret, input) {
  return crypto.createHmac('sha256', secret).update(input, 'utf8').digest('hex');
}

function loadBody(raw) {
  if (!raw) {
    return '';
  }

  const resolvedPath = path.resolve(process.cwd(), raw);
  if (fs.existsSync(resolvedPath) && fs.statSync(resolvedPath).isFile()) {
    return fs.readFileSync(resolvedPath, 'utf8');
  }

  return raw;
}

async function main() {
  loadEnvConfig();

  const method = (process.argv[2] || '').toUpperCase();
  const requestPath = process.argv[3] || '';
  const rawBodyArg = process.argv[4] || '';

  if (!method || !requestPath) {
    usage();
    process.exit(1);
  }

  const baseUrl = process.env.AGENT_BASE_URL || 'http://127.0.0.1:4273';
  const secret = process.env.WECHAT_AGENT_SIGNING_SECRET || '';
  const timestamp = Math.floor(Date.now() / 1000).toString();

  const body = loadBody(rawBodyArg);
  const bodyHash = sha256Hex(body);

  const headers = {
    'Content-Type': 'application/json',
  };

  if (secret) {
    const payload = `${method}\n${requestPath}\n${timestamp}\n${bodyHash}`;
    const signature = hmacHex(secret, payload);
    headers['X-Timestamp'] = timestamp;
    headers['X-Signature'] = signature;
  } else if (method !== 'GET') {
    console.error('WECHAT_AGENT_SIGNING_SECRET is required for non-GET requests');
    process.exit(1);
  }

  const url = new URL(requestPath, baseUrl).toString();

  const response = await fetch(url, {
    method,
    headers,
    body: method === 'GET' ? undefined : body || '{}',
  });

  const responseText = await response.text();

  console.log(JSON.stringify({
    request: {
      method,
      url,
      signed: Boolean(headers['X-Signature']),
      timestamp: headers['X-Timestamp'] || null,
    },
    response: {
      status: response.status,
      ok: response.ok,
      body: (() => {
        try {
          return JSON.parse(responseText);
        } catch {
          return responseText;
        }
      })(),
    },
  }, null, 2));

  if (!response.ok) {
    process.exit(2);
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
