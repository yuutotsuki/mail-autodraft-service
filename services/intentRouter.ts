import OpenAI from 'openai';

export type Phase1Action = 'open_index' | 'list_emails' | 'compose' | 'other';

export interface Phase1Result {
  action: Phase1Action;
  params: any;
  raw_text?: string;
  violation?: boolean;
}

function getOpenAI(): OpenAI | null {
  const key = process.env.OPENAI_API_KEY;
  if (!key) return null;
  return new OpenAI({ apiKey: key });
}

function buildIntentPrompt(userText: string): string {
  return [
    'あなたはGmail操作の意図だけを判定するフィルターです。',
    '厳守: 出力は次のJSONのみ（説明や余計な文字は一切禁止）。',
    '許可アクション:',
    '- open_index: { index: number, date?: "YYYY-MM-DD", mailbox?: "inbox" }',
    '- list_emails: { date?: "YYYY-MM-DD", mailbox?: "inbox", query?: string }',
    '- compose: { }',
    '- other: {}',
    'ルール:',
    '- ツール呼び出しは禁止（toolは使わない）。',
    '- JSON以外の出力は禁止。',
    '- 「3番を開いて」「3を開く」などは open_index で index を数値で返す。',
    '- 「7/29の受信一覧」「今日のINBOX」などは list_emails を返す。',
    '- 「新規メール作成」「新規メール」「メール作成」「メール作って」「メール書いて」「新しいメール」などは compose を返す。',
    '- それ以外は other を返す。',
    '',
    'ユーザー入力:',
    userText,
  ].join('\n');
}

export async function routePhase1Intent(userText: string): Promise<Phase1Result | null> {
  // 早期: 明確な数字+開く系はローカルでopen_index判定（LLM未使用）
  const m = userText.match(/(\d+)\s*(?:番)?\s*(?:を)?\s*(?:に)?\s*(開いて|開く|open)/i);
  if (m) {
    const idx = Number(m[1]);
    if (!Number.isNaN(idx)) {
      return { action: 'open_index', params: { index: idx } };
    }
  }

  // 早期: compose系（LLM未使用）
  if (/^(?:新規メール(?:作成)?|メール(?:を)?(?:作成|作って|書いて)|新しいメール)$/.test((userText || '').trim())) {
    return { action: 'compose', params: {} };
  }
  const s = (userText || '').toLowerCase();
  const dateLike = /(\d{1,2})\/(\d{1,2})|\d{4}-\d{1,2}-\d{1,2}|\d{1,2}\s*月\s*\d{1,2}\s*日?/.test(s);
  const relativeDate = /(今日|きょう|昨日|きのう|一昨日|おととい)/.test(s);
  if (/一覧|受信|inbox|list/.test(s) || dateLike || relativeDate) {
    return { action: 'list_emails', params: {} };
  }

  try {
    const client = getOpenAI();
    if (!client) {
      // No API key; fall back to legacy flow
      return null;
    }
    const prompt = buildIntentPrompt(userText);
    const { getPhase1Model } = await import('../config/models.js');
    const resp = await client.responses.create({
      model: getPhase1Model(),
      input: prompt,
      temperature: 0,
    });

    const violation = Array.isArray((resp as any).output)
      ? (resp as any).output.some((e: any) => e?.type && e.type !== 'message')
      : false;

    const txt = (resp as any).output_text || '';
    const parsed = safeParseJson(txt);
    if (parsed) {
      const result: Phase1Result = { action: normalizeAction(parsed.action), params: parsed.params || {}, raw_text: txt, violation };
      console.info(`[intent] action=${result.action} params=${JSON.stringify(result.params)}`);
      if (violation) console.warn('[violation] intent-phase tool call detected');
      return result;
    }

    // 1回だけ強制リマインドで再試行
    const { getPhase1Model: _getPhase1Model } = await import('../config/models.js');
    const retry = await client.responses.create({
      model: _getPhase1Model(),
      input: prompt + '\n\n出力は上記スキーマのJSONのみ。説明文は絶対に書かない。',
      temperature: 0,
    });
    const v2 = Array.isArray((retry as any).output)
      ? (retry as any).output.some((e: any) => e?.type && e.type !== 'message')
      : false;
    const txt2 = (retry as any).output_text || '';
    const parsed2 = safeParseJson(txt2);
    if (parsed2) {
      const result: Phase1Result = { action: normalizeAction(parsed2.action), params: parsed2.params || {}, raw_text: txt2, violation: v2 };
      console.info(`[intent] action=${result.action} params=${JSON.stringify(result.params)} (retry)`);
      if (v2) console.warn('[violation] intent-phase tool call detected (retry)');
      return result;
    }
    console.warn('[intent] JSON parse failed. Falling back to legacy flow. text=', sanitize(txt2 || txt));
    return null;
  } catch (e) {
    console.warn('[intent] Phase1 classify failed:', e);
    return null;
  }
}

function normalizeAction(a: any): Phase1Action {
  const s = String(a || '').toLowerCase();
  if (s === 'open_index' || /open/.test(s)) return 'open_index';
  if (s === 'list_emails' || /list|inbox|search/.test(s)) return 'list_emails';
  if (s === 'compose' || /compose|new\s*mail|draft/.test(s)) return 'compose';
  return 'other';
}

function safeParseJson(text: string): any | null {
  try {
    const trimmed = (text || '').trim();
    if (!trimmed.startsWith('{')) return null;
    return JSON.parse(trimmed);
  } catch {
    return null;
  }
}

function sanitize(s: string): string {
  return (s || '').slice(0, 500);
}
