/*
 Phase1 Router Test (offline)
 - Verifies:
   1) "3番を開いて" with valid cache → cache-hit, no API call needed
   2) "3番を開いて" with expired cache → expiry short notice
   3) "7/29の受信一覧" → list_emails handoff short message
*/

process.env.ENV = process.env.ENV || 'company';
process.env.FEATURE_PHASE1_ROUTER = 'true';
process.env.LOG_LEVEL = 'DEBUG';

import { initDb, upsertEmailListCache } from '../db/sqlite';
import { handleSlackMessage } from '../handlers/slackMessageHandler';

function makeSay(label: string) {
  const outputs: string[] = [];
  const say = async (arg: any) => {
    const text = typeof arg === 'string' ? arg : arg?.text || '';
    outputs.push(text);
    console.log(`[say:${label}]`, text);
    return { ts: `${Date.now()}` } as any;
  };
  return { say, outputs } as const;
}

async function seedCache(channel: string, thread_ts: string, fresh: boolean) {
  const key = `gmail|user=U1|ws=T1|mailbox=inbox|page=1`;
  const items = { items: [
    { index: 1, messageId: 'msg-1', subject: '件名1', from: 'a@example.com', date: '2024-07-29' },
    { index: 2, messageId: 'msg-2', subject: '件名2', from: 'b@example.com', date: '2024-07-29' },
    { index: 3, messageId: 'msg-3', subject: '件名3', from: 'c@example.com', date: '2024-07-29' },
  ]};
  const nowSec = Math.floor(Date.now() / 1000);
  const exp = fresh ? nowSec + 300 : nowSec - 10;
  await upsertEmailListCache(key, JSON.stringify(items), exp, { channel, thread_ts, createdAt: nowSec });
}

async function run() {
  initDb();

  // Case1: cache valid
  await seedCache('C1', '111.111', true);
  const { say: say1 } = makeSay('case1');
  await handleSlackMessage({ text: '3番を開いて', user: 'U1', channel: 'C1', ts: '111.111', team: 'T1' }, say1);

  // Case2: cache expired
  await seedCache('C2', '222.222', false);
  const { say: say2 } = makeSay('case2');
  await handleSlackMessage({ text: '3番を開いて', user: 'U1', channel: 'C2', ts: '222.222', team: 'T1' }, say2);

  // Case3: list intent → Phase2 handoff
  const { say: say3 } = makeSay('case3');
  await handleSlackMessage({ text: '7/29の受信一覧', user: 'U1', channel: 'C3', ts: '333.333', team: 'T1' }, say3);

  console.log('\nDone. Inspect the logs above for [intent]/[cache-hit]/[cache-expired].');
}

run().catch((e) => {
  console.error('Test failed:', e);
  process.exit(1);
});

