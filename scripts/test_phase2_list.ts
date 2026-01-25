/* Offline test for Phase2 behaviors without hitting OpenAI/MCP.
   Simulates list outputs and verifies:
   - >=2 items: saved to SQLite, then open_index fast-path hits
   - 1 item: skip save
*/

process.env.ENV = process.env.ENV || 'company';
process.env.FEATURE_PHASE1_ROUTER = 'true';
process.env.FEATURE_PHASE2_LIST = 'true';

import { initDb } from '../db/sqlite';
import { EmailDetectionService } from '../services/emailDetectionService';
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
  initDb();

  const userId = 'U2';
  const channel = 'C9';
  const thread = '999.999';
  const team = 'T9';
  const say = makeSay('phase2');

  // Case A: 2件以上 → 保存
  const list2 = `1.\n- 件名: A\n- 送信者: a@example.com\n- 受信日時: 2024/07/29\n\n2.\n- 件名: B\n- 送信者: b@example.com\n- 受信日時: 2024/07/29`;
  const savedA = await EmailDetectionService.detectAndSaveEmailList(list2, userId, { channel, thread_ts: thread, workspaceId: team, mailbox: 'inbox' });
  console.log(`[test] caseA fetched=${savedA?.emails.length} (expect>=2)`);

  // 直後の open_index → キャッシュhit
  const hit = await NumberedReplyHandler.tryOpenFromCache({ text: '2番を開いて', user: userId, channel, ts: thread, team }, say);
  console.log(`[test] caseA open_index cache-hit=${hit}`);

  // Case B: 1件 → 保存スキップ
  const list1 = `1.\n- 件名: Only\n- 送信者: x@example.com\n- 受信日時: 2024/07/29`;
  const savedB = await EmailDetectionService.detectAndSaveEmailList(list1, userId, { channel: 'C10', thread_ts: '1010.1010', workspaceId: team, mailbox: 'inbox' });
  console.log(`[test] caseB fetched=${savedB?.emails.length} (expect=1)`);

  console.log('\nDone. Check logs for: save YES/NO and cache-hit.');
}

run().catch((e) => { console.error(e); process.exit(1); });

