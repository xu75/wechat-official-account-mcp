export type PublishChannel = 'official' | 'browser';

export interface PublishRequest {
  task_id: string;
  idempotency_key: string;
  title: string;
  content: string;
  review_approved: boolean;
  preferred_channel?: PublishChannel;
  thumb_media_id?: string;
  author?: string;
  digest?: string;
  content_source_url?: string;
}

export interface PublishResponse {
  task_id: string;
  idempotency_key: string;
  status: 'accepted' | 'publish_failed';
  channel: PublishChannel;
  dedup_hit: boolean;
  publish_id?: string;
  draft_media_id?: string;
  publish_url?: string;
  error_code?: string;
  error_message?: string;
  duration_ms?: number;
}

export interface CallbackRequest {
  task_id: string;
  status: 'published' | 'publish_failed' | 'manual_intervention' | 'publishing';
  message?: string;
  metadata?: Record<string, unknown>;
}

export interface LastPublishSummary {
  task_id: string;
  status: PublishResponse['status'];
  channel: PublishChannel;
  at: string;
  error_code?: string;
}
