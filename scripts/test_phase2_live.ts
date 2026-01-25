/* Live test for Phase2 list via OpenAI+MCP
   - Requires network and valid OPENAI_API_KEY + CONNECT_TOKEN_URL env.
   - Logs: params, violation, fetched count, save/skip, and then tries open_index cache hit.
*/

process.env.ENV = process.env.ENV || 'company';
process.env.FEATURE_PHASE1_ROUTER = 'true';
process.env.FEATURE_PHASE2_LIST = 'true';
process.env.LOG_LEVEL = 'DEBUG';

import { initDb } from '../db/sqlite';
import { initializeEnvironment } from '../config/environment';
import { runPhase2List } from '../services/listEmailsService';
import { NumberedReplyHandler } from '../handlers/numberedReplyHandler';

function makeSay(label: string) {
  const say = async (arg: any) => {
    const text = typeof arg === 'string' ? arg : arg?.text || '';
    console.log(`[say:${label}]`, text);
    return { ts: `${Date.now()}` } as any;
  };
  return say as any;
}

async function run() {
  initializeEnvironment();
  initDb();
  const userId = 'U_LIVE';
  const message = { text: '7/29の受信一覧', user: userId, channel: 'C_LIVE', ts: '777.777', team: 'T_LIVE' } as any;
  const say = makeSay('live');

  // Phase2 live list
  await runPhase2List(message.text, userId, message, say);

  // Immediately try open_index from cache
  const hit1 = await NumberedReplyHandler.tryOpenFromCache({ ...message, text: '1番を開いて' }, say);
  console.log(`[live] open_index #1 cache-hit=${hit1}`);
  const hit2 = await NumberedReplyHandler.tryOpenFromCache({ ...message, text: '2番を開いて' }, say);
  console.log(`[live] open_index #2 cache-hit=${hit2}`);
}

run().catch((e) => { console.error('live test failed:', e); process.exit(1); });
