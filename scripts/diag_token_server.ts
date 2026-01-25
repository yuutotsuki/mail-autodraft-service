import { initializeEnvironment } from '../config/environment';
import { getGoogleAccessToken, clearGoogleTokenCache, getLastGoogleTokenSource } from '../services/googleTokenProvider';

async function main() {
  try {
    // Load .env.<ENV>
    initializeEnvironment();
    clearGoogleTokenCache();
    const t0 = Date.now();
    const token = await getGoogleAccessToken();
    const ms = Date.now() - t0;
    const src = getLastGoogleTokenSource();
    console.log(`[diag:token-server] ok in ${ms}ms; source=${src}; token_len=${token?.length ?? 0}`);
    if (process.env.TOKEN_SERVER_URL) {
      console.log(`[diag:token-server] TOKEN_SERVER_URL=${process.env.TOKEN_SERVER_URL}`);
      console.log(`[diag:token-server] SCOPE=${process.env.TOKEN_SERVER_SCOPE || 'https://www.googleapis.com/auth/gmail.readonly'}`);
    } else {
      console.log('[diag:token-server] TOKEN_SERVER_URL is not set; using refresh-token flow if configured.');
    }
  } catch (e) {
    console.error('[diag:token-server] failed', e);
    process.exitCode = 1;
  }
}

main();
