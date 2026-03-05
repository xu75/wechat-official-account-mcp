import crypto from 'crypto';
import { Request, Response, NextFunction } from 'express';

const REPLAY_WINDOW_SECONDS = Number(process.env.WECHAT_AGENT_REPLAY_WINDOW_SECONDS || '300');

type ReplayEntry = {
  expireAt: number;
};

const replayCache = new Map<string, ReplayEntry>();

function getSigningSecret(): string {
  const secret = process.env.WECHAT_AGENT_SIGNING_SECRET;
  if (!secret || !secret.trim()) {
    throw new Error('WECHAT_AGENT_SIGNING_SECRET is not configured');
  }
  return secret;
}

function sha256Hex(input: string): string {
  return crypto.createHash('sha256').update(input, 'utf8').digest('hex');
}

function signPayload(secret: string, input: string): string {
  return crypto.createHmac('sha256', secret).update(input, 'utf8').digest('hex');
}

function safeEqualHex(left: string, right: string): boolean {
  const a = Buffer.from(left, 'hex');
  const b = Buffer.from(right, 'hex');
  if (a.length !== b.length) {
    return false;
  }
  return crypto.timingSafeEqual(a, b);
}

function pruneReplayCache(nowMs: number): void {
  for (const [key, entry] of replayCache.entries()) {
    if (entry.expireAt <= nowMs) {
      replayCache.delete(key);
    }
  }
}

function validateTimestamp(raw: string | undefined): { ok: boolean; timestamp?: number; reason?: string } {
  if (!raw) {
    return { ok: false, reason: 'missing X-Timestamp' };
  }

  const timestamp = Number(raw);
  if (!Number.isFinite(timestamp)) {
    return { ok: false, reason: 'invalid X-Timestamp' };
  }

  const now = Math.floor(Date.now() / 1000);
  if (Math.abs(now - timestamp) > REPLAY_WINDOW_SECONDS) {
    return { ok: false, reason: 'timestamp outside replay window' };
  }

  return { ok: true, timestamp };
}

export function verifyAgentSignature(req: Request, res: Response, next: NextFunction): void {
  let secret: string;
  try {
    secret = getSigningSecret();
  } catch (error) {
    res.status(500).json({
      success: false,
      error: 'agent signing secret is not configured',
    });
    return;
  }

  const timestampRaw = req.header('X-Timestamp') || undefined;
  const signature = req.header('X-Signature') || '';
  const tsCheck = validateTimestamp(timestampRaw);
  if (!tsCheck.ok || !tsCheck.timestamp) {
    res.status(401).json({ success: false, error: tsCheck.reason || 'invalid timestamp' });
    return;
  }

  if (!/^[a-fA-F0-9]{64}$/.test(signature)) {
    res.status(401).json({ success: false, error: 'invalid signature format' });
    return;
  }

  const rawBody = (req as Request & { rawBody?: string }).rawBody || '';
  const bodyHash = sha256Hex(rawBody);
  const normalizedPath = req.originalUrl.split('?')[0] || req.path;
  const payload = `${req.method.toUpperCase()}\n${normalizedPath}\n${tsCheck.timestamp}\n${bodyHash}`;
  const expected = signPayload(secret, payload);

  if (!safeEqualHex(signature.toLowerCase(), expected.toLowerCase())) {
    res.status(401).json({ success: false, error: 'signature mismatch' });
    return;
  }

  const nowMs = Date.now();
  pruneReplayCache(nowMs);

  const replayKey = `${signature.toLowerCase()}:${tsCheck.timestamp}`;
  if (replayCache.has(replayKey)) {
    res.status(409).json({ success: false, error: 'replay detected' });
    return;
  }

  replayCache.set(replayKey, {
    expireAt: nowMs + REPLAY_WINDOW_SECONDS * 1000,
  });

  next();
}

export function getReplayWindowSeconds(): number {
  return REPLAY_WINDOW_SECONDS;
}
