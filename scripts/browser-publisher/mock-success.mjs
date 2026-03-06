#!/usr/bin/env node
import fs from 'fs';
import path from 'path';

function fail(errorCode, errorMessage) {
  process.stdout.write(JSON.stringify({
    ok: false,
    error_code: errorCode,
    error_message: errorMessage,
  }));
  process.exit(0);
}

function main() {
  const payloadPathArg = process.argv[2] || '';
  if (!payloadPathArg) {
    fail('BROWSER_PAYLOAD_MISSING', 'payload file path argument is required');
  }

  const payloadPath = path.resolve(process.cwd(), payloadPathArg);
  if (!fs.existsSync(payloadPath)) {
    fail('BROWSER_PAYLOAD_NOT_FOUND', `payload file not found: ${payloadPath}`);
  }

  let payload;
  try {
    payload = JSON.parse(fs.readFileSync(payloadPath, 'utf8'));
  } catch (error) {
    fail('BROWSER_PAYLOAD_INVALID_JSON', error instanceof Error ? error.message : 'invalid payload json');
  }

  if (process.env.MOCK_BROWSER_PUBLISH_FORCE_FAIL === 'true') {
    fail('BROWSER_PUBLISH_FORCED_FAIL', 'mock publisher forced to fail by env MOCK_BROWSER_PUBLISH_FORCE_FAIL=true');
  }

  const taskId = String(payload.task_id || 'task');
  const publishUrl = `https://mp.weixin.qq.com/s/mock-${encodeURIComponent(taskId)}-${Date.now()}`;

  process.stdout.write(JSON.stringify({
    ok: true,
    publish_url: publishUrl,
    message: 'mock browser publisher success',
  }));
}

main();
