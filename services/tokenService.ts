import axios from 'axios';
import { Mutex } from 'async-mutex';
import { getEnvironmentVariable } from '../config/environment';
import { logger } from '../utils/logger';

let cachedToken: string = '';
let tokenExpiry: number = 0; // トークンの有効期限（UNIXタイムスタンプ）
const tokenMutex = new Mutex();

export async function fetchConnectToken(): Promise<string> {
  return await tokenMutex.runExclusive(async () => {
    const now = Date.now();
    if (cachedToken && now < tokenExpiry) {
      logger.debug('🔄 [tokenService] キャッシュされたトークンを使用');
      return cachedToken;
    }
    if (cachedToken) {
      logger.debug('🔄 [tokenService] トークンが期限切れのため更新します');
      cachedToken = '';
      tokenExpiry = 0;
    }
    const connectTokenUrl = getEnvironmentVariable('CONNECT_TOKEN_URL', 'http://localhost:3001/connect-token');
    let redactedUrl = connectTokenUrl;
    try {
      const parsed = new URL(connectTokenUrl);
      redactedUrl = `${parsed.origin}${parsed.pathname}`;
    } catch {
      const [base] = connectTokenUrl.split('?');
      redactedUrl = base || 'invalid_url';
    }
    logger.debug('🔗 [tokenService] Token server endpoint (redacted):', redactedUrl);
    try {
      const res = await axios.get(connectTokenUrl);
      cachedToken = res.data.token;
      const expiresIn = res.data.expires_in || 1800;
      tokenExpiry = now + (expiresIn * 1000);
      const kind = /^ctok_/.test(cachedToken) ? 'connect_token' : 'unknown_token_type';
      const tail = cachedToken.slice(-6);
      logger.debug(`✅ [tokenService] トークン取得成功 kind=${kind} suffix=***${tail}`);
      logger.debug(`⏰ [tokenService] トークン有効期限: ${new Date(tokenExpiry).toLocaleString()}`);
      return cachedToken;
    } catch (error: any) {
      logger.error('❌ [tokenService] トークン取得エラー:', error.message);
      cachedToken = '';
      tokenExpiry = 0;
      throw error;
    }
  });
}

export function clearTokenCache() {
  cachedToken = '';
  tokenExpiry = 0;
} 
