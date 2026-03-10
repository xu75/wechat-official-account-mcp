#!/usr/bin/env node
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { loadEnvConfig } from './review-token-utils.mjs';

function usage() {
  process.stderr.write('Usage:\n');
  process.stderr.write('  node scripts/agent-login-session.mjs by-session <session_id> [--qr-file <png-path>]\n');
  process.stderr.write('  node scripts/agent-login-session.mjs by-request <task_id> <idempotency_key> [--qr-file <png-path>]\n');
  process.stderr.write('\n');
  process.stderr.write('Env:\n');
  process.stderr.write('  AGENT_BASE_URL (default http://127.0.0.1:4273)\n');
  process.stderr.write('  WECHAT_AGENT_SIGNING_SECRET (required)\n');
}

function sha256Hex(input) {
  return crypto.createHash('sha256').update(input, 'utf8').digest('hex');
}

function hmacHex(secret, input) {
  return crypto.createHmac('sha256', secret).update(input, 'utf8').digest('hex');
}

function signHeaders(secret, method, requestPath) {
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const payload = `${method}\n${requestPath}\n${timestamp}\n${sha256Hex('')}`;
  return {
    'X-Timestamp': timestamp,
    'X-Signature': hmacHex(secret, payload),
  };
}

function parseArgs() {
  const args = process.argv.slice(2);
  const mode = (args[0] || '').trim();
  if (!mode) {
    usage();
    process.exit(1);
  }

  let index = 1;
  let requestPath = '';
  if (mode === 'by-session') {
    const sessionId = (args[index] || '').trim();
    if (!sessionId) {
      usage();
      process.exit(1);
    }
    requestPath = `/agent/login-session/${encodeURIComponent(sessionId)}`;
    index += 1;
  } else if (mode === 'by-request') {
    const taskId = (args[index] || '').trim();
    const idempotencyKey = (args[index + 1] || '').trim();
    if (!taskId || !idempotencyKey) {
      usage();
      process.exit(1);
    }
    requestPath = `/agent/login-session/by-request/${encodeURIComponent(taskId)}/${encodeURIComponent(idempotencyKey)}`;
    index += 2;
  } else {
    usage();
    process.exit(1);
  }

  let qrFilePath = '';
  while (index < args.length) {
    const arg = args[index];
    if (arg === '--qr-file') {
      qrFilePath = (args[index + 1] || '').trim();
      index += 2;
      continue;
    }
    index += 1;
  }

  return {
    requestPath,
    qrFilePath,
  };
}

async function requestJson(baseUrl, secret, requestPath) {
  const headers = signHeaders(secret, 'GET', requestPath);
  const response = await fetch(new URL(requestPath, baseUrl).toString(), {
    method: 'GET',
    headers,
  });
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

function resolveQrPath(inputPath, sessionId) {
  if (inputPath) return path.resolve(process.cwd(), inputPath);
  return path.resolve(process.cwd(), `tmp-login-qr-${sessionId}.png`);
}

async function main() {
  loadEnvConfig();
  const secret = (process.env.WECHAT_AGENT_SIGNING_SECRET || '').trim();
  if (!secret) {
    throw new Error('WECHAT_AGENT_SIGNING_SECRET is required');
  }

  const baseUrl = process.env.AGENT_BASE_URL || 'http://127.0.0.1:4273';
  const options = parseArgs();

  const sessionRes = await requestJson(baseUrl, secret, options.requestPath);
  if (!sessionRes.ok) {
    process.stdout.write(`${JSON.stringify({ request_path: options.requestPath, response: sessionRes }, null, 2)}\n`);
    process.exit(2);
  }

  const session = sessionRes.body?.session;
  const sessionId = String(session?.session_id || '').trim();
  if (!sessionId) {
    process.stdout.write(`${JSON.stringify({ request_path: options.requestPath, response: sessionRes }, null, 2)}\n`);
    process.exit(3);
  }

  const qrPath = `/agent/login-session/${encodeURIComponent(sessionId)}/qr`;
  const qrRes = await requestJson(baseUrl, secret, qrPath);
  let qrFile = '';
  if (qrRes.ok && qrRes.body?.png_base64) {
    qrFile = resolveQrPath(options.qrFilePath, sessionId);
    const dir = path.dirname(qrFile);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(qrFile, Buffer.from(String(qrRes.body.png_base64), 'base64'));
  }

  process.stdout.write(`${JSON.stringify({
    session: sessionRes.body,
    qr: {
      status: qrRes.status,
      ok: qrRes.ok,
      expires_at: qrRes.body?.expires_at || null,
      file: qrFile || null,
      data_url_present: Boolean(qrRes.body?.data_url),
    },
  }, null, 2)}\n`);
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
