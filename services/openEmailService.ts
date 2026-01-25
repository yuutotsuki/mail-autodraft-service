import OpenAI from 'openai';
import { SayFn } from '@slack/bolt';
import { fetchConnectToken } from './tokenService';
import { getMcpTool } from '../getMcpTool';
import { getDefaultResponsesModel } from '../config/models';

function sanitizeHtml(input: string): string {
  let s = input || '';
  // remove tags
  s = s.replace(/<\/?[^>]+>/g, '');
  // decode minimal entities
  s = s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'");
  return s;
}

function truncateBody(s: string, limit = 4000): { text: string; truncated: boolean } {
  if (!s) return { text: '', truncated: false };
  if (s.length <= limit) return { text: s, truncated: false };
  const head = s.slice(0, limit);
  return { text: head + '\n…（※長文のため一部省略）', truncated: true };
}

function buildBodyNudgeById(messageId: string): string {
  return [
    `読み取り専用のGmail MCP検索ツール（gmail-find-email）を優先して、本文を1通だけ取得してください。`,
    `可能なら q="rfc822msgid:${messageId}" を使って対象メールを特定し、本文テキストのみを出力してください。`,
    'もし検索が利用できない場合は、messageIdを直接指定できる読み取りツールを使用してください。',
    '注意:',
    '- 送信/削除/アーカイブ/下書き作成など書き込み操作は禁止です。',
    '- 出力は本文のみ（接頭辞や説明のないプレーンテキスト）。',
  ].join('\n');
}

function buildBodyNudgeByMeta(subject?: string, from?: string, date?: string): string {
  const subj = (subject || '').slice(0, 120);
  const frm = (from || '').slice(0, 120);
  const d = (date || '').slice(0, 32);
  return [
    '読み取り専用のGmail MCP検索ツール（gmail-find-email）で、次の条件に最も一致する受信メール1通の本文を取得してください。',
    `- 件名に含む: "${subj}"`,
    frm ? `- 送信者に含む: "${frm}"` : undefined,
    d ? `- 受信日付を優先: ${d}（±1日まで許容）` : undefined,
    '注意:',
    '- 送信/削除/アーカイブ/下書き作成など書き込み操作は禁止です。',
    '- 出力は本文のみ（接頭辞や説明のないプレーンテキスト）。',
  ].filter(Boolean).join('\n');
}

function isPseudoMessageId(s?: string): boolean {
  return !!s && /^email_\d+_\d+/.test(s);
}

function detectViolation(resp: any): string[] {
  const out = resp?.output || [];
  const names: string[] = [];
  for (const e of out) {
    const t = e?.type || '';
    if (typeof t === 'string' && t && t !== 'message' && t !== 'mcp_list_tools') {
      const name = t.toString();
      if (/(send|draft|create|delete|trash|archive|modify)/i.test(name)) {
        names.push(name);
      }
    }
  }
  return Array.from(new Set(names));
}

export async function openEmailBodyFromCache(opts: { say: SayFn; index: number; item: any; cacheKey: string }) {
  const { say, index, item, cacheKey } = opts;
  const subject = (item.subject || '(件名なし)').toString();
  // from末尾の括弧日付は除去して表示・検索の両方で扱いやすく
  const from = (item.from || '(送信者不明)').toString().replace(/[（(].*?[）)]\s*$/, '').trim();
  const date = item.date ? `（${item.date}）` : '';
  const header = `#${index} ${subject} — ${from}${date}`;

  let token: string;
  try {
    token = await fetchConnectToken();
  } catch (e) {
    console.error('[open_index] token error', e);
    await say(`${header}\n⚠️ 本文の取得に失敗しました（認証エラー）`);
    return;
  }

  const gmailTool = getMcpTool('gmail', token);
  const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  try {
    const byId = !isPseudoMessageId(item.messageId);
    const prompt = byId
      ? buildBodyNudgeById(item.messageId)
      : buildBodyNudgeByMeta(item.subject, item.from, item.date);
    const resp = await client.responses.create({
      model: getDefaultResponsesModel(),
      input: prompt,
      tools: [gmailTool],
      temperature: 0,
    });
    const vio = detectViolation(resp);
    if (vio.length > 0) {
      console.warn('[violation] write-like tool attempt (open_index):', vio.join(','));
    }
    let bodyRaw = (resp as any).output_text || '';
    // Fallback: if ID指定で取得できなかった（または短すぎる）場合、メタ条件で再試行
    if (byId && (!bodyRaw || bodyRaw.length < 10)) {
      try {
        const resp2 = await client.responses.create({
          model: getDefaultResponsesModel(),
          input: buildBodyNudgeByMeta(item.subject, item.from, item.date),
          tools: [gmailTool],
          temperature: 0,
        });
        const vio2 = detectViolation(resp2);
        if (vio2.length > 0) console.warn('[violation] write-like tool attempt (open_index, retry-meta):', vio2.join(','));
        bodyRaw = (resp2 as any).output_text || '';
      } catch (e2) {
        // ignore, fall back to original
      }
    }
    const body = sanitizeHtml(bodyRaw);
    const { text, truncated } = truncateBody(body);
    console.info(`[open_index] index=${index} messageId=${item.messageId} body_len_shown=${text.length} truncated=${truncated}`);
    await say(`${header}\n${text}`);
  } catch (e) {
    console.error('[open_index] OpenAI error', e);
    await say(`${header}\n⚠️ 本文の取得に失敗しました。`);
  }
}
