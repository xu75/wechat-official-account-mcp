import { writeAgentLog } from './audit-log.js';
import { PublishRequest, PublishResponse } from './types.js';
import { getAuthManager, getWechatApiClient, initializeWechatContext } from './wechat-context.js';

class AgentPublishError extends Error {
  code: string;

  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

class OfficialPublisher {
  async initialize(): Promise<void> {
    await initializeWechatContext();
  }

  async publish(input: PublishRequest): Promise<{ publishId: string; draftMediaId: string }> {
    if (!input.thumb_media_id) {
      throw new AgentPublishError(
        'OFFICIAL_MISSING_THUMB_MEDIA_ID',
        'thumb_media_id is required for official publish channel',
      );
    }

    if (!getAuthManager().isConfigured()) {
      throw new AgentPublishError(
        'OFFICIAL_NOT_CONFIGURED',
        'wechat app credentials are not configured in local storage',
      );
    }

    const draft = await getWechatApiClient().post('/cgi-bin/draft/add', {
      articles: [
        {
          title: input.title,
          author: input.author || '',
          digest: input.digest || '',
          content: input.content,
          content_source_url: input.content_source_url || '',
          thumb_media_id: input.thumb_media_id,
          show_cover_pic: 1,
          need_open_comment: 0,
          only_fans_can_comment: 0,
        },
      ],
    }) as { media_id: string };

    const submit = await getWechatApiClient().post('/cgi-bin/freepublish/submit', {
      media_id: draft.media_id,
    }) as { publish_id: string };

    return {
      publishId: submit.publish_id,
      draftMediaId: draft.media_id,
    };
  }
}

class BrowserPublisher {
  async publish(): Promise<never> {
    throw new AgentPublishError(
      'BROWSER_NOT_IMPLEMENTED',
      'browser fallback adapter is not implemented in Phase A',
    );
  }
}

const officialPublisher = new OfficialPublisher();
const browserPublisher = new BrowserPublisher();
const browserFallbackEnabled = process.env.WECHAT_AGENT_ENABLE_BROWSER_FALLBACK === 'true';

function normalizeError(error: unknown): { code: string; message: string } {
  if (error instanceof AgentPublishError) {
    return {
      code: error.code,
      message: error.message,
    };
  }

  if (error instanceof Error) {
    return {
      code: 'OFFICIAL_PUBLISH_FAILED',
      message: error.message,
    };
  }

  return {
    code: 'UNKNOWN_ERROR',
    message: 'unknown publish error',
  };
}

export async function publishArticle(input: PublishRequest): Promise<PublishResponse> {
  const startedAt = Date.now();

  await officialPublisher.initialize();

  if (!input.review_approved) {
    return {
      task_id: input.task_id,
      idempotency_key: input.idempotency_key,
      status: 'publish_failed',
      channel: 'official',
      dedup_hit: false,
      error_code: 'REVIEW_NOT_APPROVED',
      error_message: 'review_approved must be true in assist mode',
      duration_ms: Date.now() - startedAt,
    };
  }

  try {
    const result = await officialPublisher.publish(input);
    const response: PublishResponse = {
      task_id: input.task_id,
      idempotency_key: input.idempotency_key,
      status: 'accepted',
      channel: 'official',
      dedup_hit: false,
      publish_id: result.publishId,
      draft_media_id: result.draftMediaId,
      duration_ms: Date.now() - startedAt,
    };

    await writeAgentLog('publish_success', {
      task_id: input.task_id,
      channel: 'official',
      publish_id: result.publishId,
      draft_media_id: result.draftMediaId,
      duration_ms: response.duration_ms,
    });

    return response;
  } catch (officialError) {
    const officialErr = normalizeError(officialError);

    await writeAgentLog('publish_official_failed', {
      task_id: input.task_id,
      channel: 'official',
      error_code: officialErr.code,
      error_message: officialErr.message,
    });

    if (!browserFallbackEnabled || input.preferred_channel === 'browser') {
      return {
        task_id: input.task_id,
        idempotency_key: input.idempotency_key,
        status: 'publish_failed',
        channel: 'official',
        dedup_hit: false,
        error_code: officialErr.code,
        error_message: officialErr.message,
        duration_ms: Date.now() - startedAt,
      };
    }

    try {
      await browserPublisher.publish();
      return {
        task_id: input.task_id,
        idempotency_key: input.idempotency_key,
        status: 'accepted',
        channel: 'browser',
        dedup_hit: false,
        duration_ms: Date.now() - startedAt,
      };
    } catch (browserError) {
      const browserErr = normalizeError(browserError);
      await writeAgentLog('publish_browser_failed', {
        task_id: input.task_id,
        channel: 'browser',
        error_code: browserErr.code,
        error_message: browserErr.message,
      });

      return {
        task_id: input.task_id,
        idempotency_key: input.idempotency_key,
        status: 'publish_failed',
        channel: 'browser',
        dedup_hit: false,
        error_code: browserErr.code,
        error_message: browserErr.message,
        duration_ms: Date.now() - startedAt,
      };
    }
  }
}

export function isBrowserFallbackEnabled(): boolean {
  return browserFallbackEnabled;
}
