import crypto from 'crypto';

export type LoginSessionRecord = {
  session_id: string;
  task_id: string;
  idempotency_key: string;
  channel: 'browser';
  login_url: string;
  qr_mime: string;
  qr_png_base64: string;
  error_code: string;
  error_message: string;
  created_at: string;
  expires_at: string;
  created_at_ms: number;
  expires_at_ms: number;
};

type UpsertLoginSessionInput = {
  task_id: string;
  idempotency_key: string;
  login_url: string;
  qr_mime?: string;
  qr_png_base64?: string;
  error_code: string;
  error_message: string;
};

const LOGIN_SESSION_TTL_MS = Number(process.env.WECHAT_AGENT_LOGIN_SESSION_TTL_MS || '600000');
const sessions = new Map<string, LoginSessionRecord>();
const requestKeyToSessionId = new Map<string, string>();

function requestKey(taskId: string, idempotencyKey: string): string {
  return `${taskId}::${idempotencyKey}`;
}

function prune(nowMs: number): void {
  for (const [sessionId, session] of sessions.entries()) {
    if (session.expires_at_ms <= nowMs) {
      sessions.delete(sessionId);
    }
  }

  for (const [key, sessionId] of requestKeyToSessionId.entries()) {
    if (!sessions.has(sessionId)) {
      requestKeyToSessionId.delete(key);
    }
  }
}

function newSessionId(): string {
  if (typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID().replace(/-/g, '');
  }
  return crypto.randomBytes(16).toString('hex');
}

export function upsertLoginSession(input: UpsertLoginSessionInput): LoginSessionRecord {
  const nowMs = Date.now();
  prune(nowMs);

  const key = requestKey(input.task_id, input.idempotency_key);
  const existingId = requestKeyToSessionId.get(key);
  const createdAtMs = nowMs;
  const expiresAtMs = nowMs + LOGIN_SESSION_TTL_MS;

  if (existingId) {
    const existing = sessions.get(existingId);
    if (existing) {
      const updated: LoginSessionRecord = {
        ...existing,
        login_url: input.login_url || existing.login_url,
        qr_mime: input.qr_mime || existing.qr_mime || '',
        qr_png_base64: input.qr_png_base64 || existing.qr_png_base64 || '',
        error_code: input.error_code,
        error_message: input.error_message,
        expires_at: new Date(expiresAtMs).toISOString(),
        expires_at_ms: expiresAtMs,
      };
      sessions.set(existingId, updated);
      return updated;
    }
  }

  const session: LoginSessionRecord = {
    session_id: newSessionId(),
    task_id: input.task_id,
    idempotency_key: input.idempotency_key,
    channel: 'browser',
    login_url: input.login_url,
    qr_mime: input.qr_mime || '',
    qr_png_base64: input.qr_png_base64 || '',
    error_code: input.error_code,
    error_message: input.error_message,
    created_at: new Date(createdAtMs).toISOString(),
    expires_at: new Date(expiresAtMs).toISOString(),
    created_at_ms: createdAtMs,
    expires_at_ms: expiresAtMs,
  };

  sessions.set(session.session_id, session);
  requestKeyToSessionId.set(key, session.session_id);
  return session;
}

export function getLoginSession(sessionId: string): LoginSessionRecord | null {
  prune(Date.now());
  return sessions.get(sessionId) || null;
}

export function getLoginSessionByRequest(taskId: string, idempotencyKey: string): LoginSessionRecord | null {
  prune(Date.now());
  const sessionId = requestKeyToSessionId.get(requestKey(taskId, idempotencyKey));
  if (!sessionId) return null;
  return sessions.get(sessionId) || null;
}

export function getLoginSessionTtlMs(): number {
  return LOGIN_SESSION_TTL_MS;
}

