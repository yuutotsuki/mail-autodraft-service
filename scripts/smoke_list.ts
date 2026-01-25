import { initializeEnvironment } from '../config/environment';
import { runPhase2List } from '../services/listEmailsService';
import { initDb } from '../db/sqlite';
import type { SayFn } from '@slack/bolt';
import type { ChatPostMessageResponse } from '@slack/web-api';

async function main() {
  initializeEnvironment();
  // Initialize SQLite for cache/hooks when running outside Slack app
  try { initDb(); } catch {}
  const userText = process.argv[2] || '9月5日の受信一覧見せて';
  const userId = 'U_SMOKE';
  const message = { user: userId, channel: 'C_SMOKE', ts: String(Date.now()), team: 'T_SMOKE' } as any;
  const say: SayFn = (msg: any) => {
    if (typeof msg === 'string') console.log('[say]', msg);
    else console.log('[say]', JSON.stringify(msg));
    return Promise.resolve({ ok: true } as ChatPostMessageResponse);
  };
  await runPhase2List(userText, userId, message, say);
}

main().catch((e) => {
  console.error('[smoke_list] failed:', e);
  process.exit(1);
});
