import { AuthManager } from '../../src/auth/auth-manager.js';
import { WechatApiClient } from '../../src/wechat/api-client.js';

const authManager = new AuthManager();
const apiClient = new WechatApiClient(authManager);

let initialized = false;
let initializePromise: Promise<void> | null = null;

export async function initializeWechatContext(): Promise<void> {
  if (initialized) {
    return;
  }

  if (!initializePromise) {
    initializePromise = authManager.initialize().then(() => {
      initialized = true;
    });
  }

  await initializePromise;
}

export function getAuthManager(): AuthManager {
  return authManager;
}

export function getWechatApiClient(): WechatApiClient {
  return apiClient;
}
