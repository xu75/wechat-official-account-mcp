#!/usr/bin/env node
import fs from 'fs';
import path from 'path';
import { appendTimestampToTitle, loadEnvConfig, signReviewApprovalToken } from './review-token-utils.mjs';

function parseArgs() {
  const args = process.argv.slice(2);
  const payloadFile = args[0] || '';
  let reviewer = process.env.WECHAT_AGENT_REVIEWER || 'local-reviewer';
  let writeBack = false;
  let addTimestamp = false;

  for (let i = 1; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === '--reviewer') {
      reviewer = args[i + 1] || reviewer;
      i += 1;
      continue;
    }

    if (arg === '--write') {
      writeBack = true;
      continue;
    }

    if (arg === '--timestamp-title') {
      addTimestamp = true;
    }
  }

  if (!payloadFile) {
    throw new Error('usage: node scripts/generate-review-token.mjs <publish-json-file> [--write] [--reviewer <name>] [--timestamp-title]');
  }

  return { payloadFile, reviewer, writeBack, addTimestamp };
}

function main() {
  loadEnvConfig();
  const { payloadFile, reviewer, writeBack, addTimestamp } = parseArgs();
  const resolved = path.resolve(process.cwd(), payloadFile);

  if (!fs.existsSync(resolved)) {
    throw new Error(`payload file not found: ${resolved}`);
  }

  const payload = JSON.parse(fs.readFileSync(resolved, 'utf8'));
  payload.review_approved = true;

  if (addTimestamp) {
    payload.title = appendTimestampToTitle(payload.title || 'Review test');
  }

  payload.review_approval_token = signReviewApprovalToken(payload, { reviewer });

  if (writeBack) {
    fs.writeFileSync(resolved, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  }

  process.stdout.write(`${JSON.stringify({
    payload_file: resolved,
    reviewer,
    write_back: writeBack,
    review_approval_token: payload.review_approval_token,
    title: payload.title,
  }, null, 2)}\n`);
}

try {
  main();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
