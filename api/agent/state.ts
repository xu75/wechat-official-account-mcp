import { LastPublishSummary, PublishResponse } from './types.js';

let lastPublishSummary: LastPublishSummary | null = null;

export function updateLastPublishSummary(response: PublishResponse): void {
  lastPublishSummary = {
    task_id: response.task_id,
    status: response.status,
    channel: response.channel,
    at: new Date().toISOString(),
    error_code: response.error_code,
  };
}

export function getLastPublishSummary(): LastPublishSummary | null {
  return lastPublishSummary;
}
