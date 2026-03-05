import { appendFile } from 'fs/promises';

const LOG_FILE = process.env.WECHAT_AGENT_LOG_FILE || '/tmp/wechat-agent.log';

export async function writeAgentLog(event: string, payload: Record<string, unknown>): Promise<void> {
  const line = JSON.stringify({
    ts: new Date().toISOString(),
    event,
    ...payload,
  });

  try {
    await appendFile(LOG_FILE, `${line}\n`, 'utf8');
  } catch (error) {
    console.error('[agent-log] failed to write log', error);
  }
}

export function getAgentLogPath(): string {
  return LOG_FILE;
}
