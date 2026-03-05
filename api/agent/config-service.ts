import { WechatConfig } from '../../src/mcp-tool/types.js';
import { getAuthManager, initializeWechatContext } from './wechat-context.js';
import { AgentConfigCheckRequest, AgentConfigInitRequest } from './types.js';

function mask(value: string): string {
  if (value.length <= 8) {
    return '***';
  }
  return `${value.slice(0, 4)}***${value.slice(-4)}`;
}

export async function initializeAgentConfig(input: AgentConfigInitRequest): Promise<{
  configured: boolean;
  app_id: string;
  token_present: boolean;
  encoding_aes_key_present: boolean;
}> {
  await initializeWechatContext();

  const config: WechatConfig = {
    appId: input.app_id,
    appSecret: input.app_secret,
    token: input.token,
    encodingAESKey: input.encoding_aes_key,
  };

  await getAuthManager().setConfig(config);

  return {
    configured: true,
    app_id: mask(input.app_id),
    token_present: Boolean(input.token),
    encoding_aes_key_present: Boolean(input.encoding_aes_key),
  };
}

export async function checkAgentConfig(input: AgentConfigCheckRequest): Promise<{
  configured: boolean;
  app_id?: string;
  token_check: {
    enabled: boolean;
    ok: boolean;
    error?: string;
    expires_at?: string;
  };
  publish_check: {
    ok: boolean;
    errors: string[];
  };
}> {
  await initializeWechatContext();

  const authManager = getAuthManager();
  const config = await authManager.getConfig();
  const configured = Boolean(config?.appId && config?.appSecret);

  const tokenCheckEnabled = input.check_token !== false;
  const tokenCheck = {
    enabled: tokenCheckEnabled,
    ok: false,
    error: undefined as string | undefined,
    expires_at: undefined as string | undefined,
  };

  if (!tokenCheckEnabled) {
    tokenCheck.ok = configured;
  } else if (!configured) {
    tokenCheck.ok = false;
    tokenCheck.error = 'wechat credentials are not configured';
  } else {
    try {
      const tokenInfo = await authManager.getAccessToken();
      tokenCheck.ok = true;
      tokenCheck.expires_at = new Date(tokenInfo.expiresAt).toISOString();
    } catch (error) {
      tokenCheck.ok = false;
      tokenCheck.error = error instanceof Error ? error.message : 'token check failed';
    }
  }

  const publishErrors: string[] = [];
  const preview = input.publish_preview;
  if (preview) {
    if (!preview.review_approved) {
      publishErrors.push('review_approved must be true in assist mode');
    }

    const channel = preview.preferred_channel || 'official';
    if (channel === 'official' && !preview.thumb_media_id) {
      publishErrors.push('thumb_media_id is required for official channel');
    }
  }

  return {
    configured,
    app_id: config?.appId ? mask(config.appId) : undefined,
    token_check: tokenCheck,
    publish_check: {
      ok: publishErrors.length === 0,
      errors: publishErrors,
    },
  };
}
