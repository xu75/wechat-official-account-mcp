export type PublishChannel = 'official' | 'browser';

export interface PublishRequest {
  task_id: string;
  idempotency_key: string;
  title: string;
  content: string;
  review_approved: boolean;
  review_approval_token?: string;
  preferred_channel?: PublishChannel;
  thumb_media_id?: string;
  author?: string;
  digest?: string;
  content_source_url?: string;
}

export interface PublishResponse {
  task_id: string;
  idempotency_key: string;
  status: 'accepted' | 'publish_failed' | 'waiting_login';
  channel: PublishChannel;
  dedup_hit: boolean;
  publish_id?: string;
  draft_media_id?: string;
  publish_url?: string;
  login_url?: string;
  login_session_id?: string;
  login_session_expires_at?: string;
  login_qr_available?: boolean;
  login_qr_mime?: string;
  login_qr_png_base64?: string;
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

export interface AgentConfigInitRequest {
  app_id: string;
  app_secret: string;
  token?: string;
  encoding_aes_key?: string;
}

export interface AgentConfigCheckRequest {
  check_token?: boolean;
  publish_preview?: {
    task_id: string;
    idempotency_key: string;
    title: string;
    content: string;
    review_approved: boolean;
    review_approval_token?: string;
    preferred_channel?: PublishChannel;
    thumb_media_id?: string;
    author?: string;
    digest?: string;
    content_source_url?: string;
  };
}

export interface LastPublishSummary {
  task_id: string;
  status: PublishResponse['status'];
  channel: PublishChannel;
  at: string;
  error_code?: string;
}
