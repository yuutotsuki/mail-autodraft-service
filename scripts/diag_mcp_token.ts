import { initializeEnvironment } from '../config/environment';
import axios from 'axios';

initializeEnvironment();

async function main() {
  const url = process.env.CONNECT_TOKEN_URL || 'http://localhost:3001/connect-token';
  console.log('[diag_mcp_token] CONNECT_TOKEN_URL =', url);
  const r = await axios.get(url);
  const t: string = r.data?.token || '';
  const kind = /^ctok_/.test(t) ? 'connect_token' : 'unknown';
  const tail = t ? t.slice(-6) : 'none';
  console.log(`[diag_mcp_token] kind=${kind} suffix=***${tail} expires_in=${r.data?.expires_in}`);
}

main().catch((e) => {
  console.error('[diag_mcp_token] error', e?.response?.status || e?.message);
  process.exit(1);
});

