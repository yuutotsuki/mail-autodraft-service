import util from 'util';
import OpenAI from 'openai';
import { SayFn } from '@slack/bolt';
import { fetchConnectToken, clearTokenCache } from './tokenService';
import { getMcpTool } from '../getMcpTool';
import { EmailDetectionService } from './emailDetectionService';
import { logAction, hashUserId } from '../utils/actionLogger';
import { generateTraceId } from '../utils/ids';
import { listMessagesDirect } from './gmailReadDirectService';
import { listGmailMessages } from './gmailApiList';
import { getGmailListActionPath, setGmailListActionPath } from '../utils/actionPathStore';
import { buildGmailListCacheKey } from '../utils/cacheKey';
import { getEmailListCache } from '../db/sqlite';

type ListParams = { date?: string; mailbox?: string; query?: string; unread?: boolean };

function pad(n: number): string { return n < 10 ? '0' + n : String(n); }

function buildListNudge(p: ListParams): string {
  const mailbox = (p.mailbox || 'inbox').toLowerCase();
  const q: string[] = [];
  if (mailbox === 'inbox') q.push('label:inbox');
  if (p.unread) q.push('is:unread');
  if (p.date) {
    try {
      const [y, m, d] = p.date.split('-').map((v) => parseInt(v, 10));
      const base = new Date(y, m - 1, d, 0, 0, 0);
      const next = new Date(base.getTime() + 24 * 60 * 60 * 1000);
      const s1 = `${base.getFullYear()}/${pad(base.getMonth() + 1)}/${pad(base.getDate())}`;
      const s2 = `${next.getFullYear()}/${pad(next.getMonth() + 1)}/${pad(next.getDate())}`;
      q.push(`after:${s1}`);
      q.push(`before:${s2}`);
    } catch {}
  }
  if (p.query) q.push(p.query);
  const qStr = q.join(' ').trim();
  const datePart = p.date ? `${p.date} の` : '';
  const keywordPart = p.query ? `（キーワード: ${p.query}）` : '';
  return [
    `読み取り専用のGmail MCPツールで${datePart}${mailbox.toUpperCase()}の受信メール一覧（上位10件）を取得してください${keywordPart}。`,
    `クエリ例: q="${qStr || 'label:inbox'}" withTextPayload=true maxResults=20 includeSpamTrash=false`,
    '出力は説明なし・フォーマット厳守。コードブロックやJSONは禁止。次の1行形式のみで番号付きで出力してください（最大10行）:',
    'N. 件名 — 送信者（YYYY-MM-DD HH:mm） [id:<messageId>]',
    '注意: 送信/削除/アーカイブ/下書き作成など書き込み操作は禁止です。',
    '重要: 各行の末尾に実メッセージID（RFC822 Message-ID）を [id:<messageId>] として必ず付与してください（本文取得に使用）。',
  ].join('\n');
}

function getOpenAIClient(): OpenAI {
  return new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
}

function extractViolationTools(resp: any): string[] {
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

function pickGmailListToolsFromOutput(resp: any): string[] {
  try {
    const out = resp?.output || [];
    const names: string[] = [];
    for (const entry of out) {
      if (entry?.type === 'mcp_list_tools' && /gmail/i.test(entry?.server_label || '')) {
        const tools = entry?.tools || [];
        for (const t of tools) {
          const name = t?.name || '';
          if (typeof name === 'string' && /(list|search|messages|threads|get_?thread|get_?message|find)/i.test(name)) {
            names.push(name);
          }
        }
      }
    }
    return Array.from(new Set(names));
  } catch {
    return [];
  }
}

function parseParamsFromText(userText: string): ListParams {
  const s = userText || '';
  const m1 = s.match(/(\d{4})[\/-](\d{1,2})[\/-](\d{1,2})/);
  const m2 = s.match(/(\d{1,2})[\/-](\d{1,2})/);
  const m3 = s.match(/(\d{1,2})\s*月\s*(\d{1,2})\s*日?/);
  let date: string | undefined;
  if (m1) {
    date = `${m1[1]}-${m1[2].padStart(2, '0')}-${m1[3].padStart(2, '0')}`;
  } else if (m2) {
    const year = new Date().getFullYear();
    date = `${year}-${m2[1].padStart(2, '0')}-${m2[2].padStart(2, '0')}`;
  } else if (m3) {
    const year = new Date().getFullYear();
    date = `${year}-${m3[1].padStart(2, '0')}-${m3[2].padStart(2, '0')}`;
  } else {
    // Relative dates: 今日/昨日/一昨日
    const now = new Date();
    const base = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    let offsetDays = 0;
    if (/(今日|きょう)/.test(s)) offsetDays = 0;
    else if (/(昨日|きのう)/.test(s)) offsetDays = -1;
    else if (/(一昨日|おととい)/.test(s)) offsetDays = -2;
    if (offsetDays !== 0) {
      const d = new Date(base.getTime() + offsetDays * 86400000);
      const y = d.getFullYear();
      const mo = String(d.getMonth() + 1).padStart(2, '0');
      const da = String(d.getDate()).padStart(2, '0');
      date = `${y}-${mo}-${da}`;
    }
  }
  const mailbox = /inbox|受信/.test(s.toLowerCase()) ? 'inbox' : 'inbox';
  const unread = /(未読|unread)/i.test(s);
  return { date, mailbox, unread };
}

export async function runPhase2List(userText: string, userId: string, message: any, say: SayFn): Promise<void> {
  const params = parseParamsFromText(userText);
  console.info(`[phase2-list] params=${JSON.stringify(params)}`);

  // Immediate UX feedback
  try {
    const when = params.date ? `（${params.date}）` : '';
    const hint = params.date ? '' : '\n💡 ヒント: 日付を指定すると早く正確です（例: 2025-09-05）';
    await say(`⏳ 受信一覧を取得中${when} …（最大10件）${hint}`);
  } catch {}

  // Quick cache preview (if available and fresh)
  try {
    const cacheKey = buildGmailListCacheKey({
      userId,
      workspaceId: (message as any).team,
      mailbox: params.mailbox,
      query: params.date,
      page: 1,
    });
    const cached = await getEmailListCache(cacheKey);
    const nowSec = Math.floor(Date.now() / 1000);
    if (cached && cached.expires_at > nowSec) {
      const obj = JSON.parse(cached.items_json || '{}');
      const items = Array.isArray(obj?.items) ? obj.items : [];
      if (items.length >= 2) {
        const lines = items.slice(0, 10).map((e: any, i: number) => formatOneLine(i + 1, e.subject, e.from, e.date));
        await say(`⚡ 直近の結果（キャッシュ）\n${lines.join('\n')}\n（最新を確認中です…）`);
      }
    }
  } catch {}

  // Direct Gmail API path (read-only), guarded by feature flag
  if (process.env.FEATURE_LIST_DIRECT_GMAIL === 'true') {
    try {
      // Build Gmail-style query from date if provided
      let qPrimary = params.query || '';
      if (params.date) {
        try {
          const d = new Date(params.date + 'T00:00:00');
          const next = new Date(d.getTime() + 86400000);
          const fmt = (x: Date) => `${x.getFullYear()}/${String(x.getMonth() + 1).padStart(2, '0')}/${String(x.getDate()).padStart(2, '0')}`;
          const qDate = `after:${fmt(d)} before:${fmt(next)}`;
          qPrimary = [qPrimary, qDate].filter(Boolean).join(' ').trim();
        } catch {}
      }

      const limit = Number(process.env.GMAIL_LIST_LIMIT || '8');
      const attempt = async (q: string) => {
        const { items, api_ms } = await listGmailMessages({ limit, q, labelIds: ['INBOX'] });
        const lines = items.slice(0, 10).map((e, i) => formatOneLine(i + 1, e.subject, e.from, e.date));
        return { items, lines, api_ms } as const;
      };

      // 1st try: exact day window [date, date+1)
      let { items, lines, api_ms } = await attempt(qPrimary);

      // 2nd try (tz tolerance): expand to [date-1, date+2) if too few
      if ((lines?.length || 0) < 2 && params.date) {
        try {
          const d = new Date(params.date + 'T00:00:00');
          const prev = new Date(d.getTime() - 86400000);
          const next2 = new Date(d.getTime() + 86400000 * 2);
          const fmt = (x: Date) => `${x.getFullYear()}/${String(x.getMonth() + 1).padStart(2, '0')}/${String(x.getDate()).padStart(2, '0')}`;
          const qWide = [params.query || '', `after:${fmt(prev)} before:${fmt(next2)}`].filter(Boolean).join(' ').trim();
          console.info('[phase2-list] direct_gmail primary window yielded <2; retrying with widened window');
          const res2 = await attempt(qWide);
          items = res2.items; lines = res2.lines; api_ms = res2.api_ms;
          // Best-effort: keep qPrimary for logging if it existed, else use widened
          if (!qPrimary) qPrimary = qWide;
        } catch {}
      }

      if (lines.length >= 2) {
        const saved = await EmailDetectionService.detectAndSaveEmailList(lines.join('\n'), userId, {
          channel: message.channel,
          thread_ts: message.ts,
          workspaceId: (message as any).team,
          mailbox: params.mailbox,
          query: params.date,
        });
        if (saved && saved.emails.length >= 2) {
          try {
            logAction({
              route: 'gmail_read',
              trace_id: generateTraceId('log'),
              user_id_hashed: hashUserId(userId),
              matched_trigger: 'list_emails',
              match_type: 'phase2_list',
              confidence: 1,
              params: { mailbox: params.mailbox, date: params.date, q: qPrimary },
              count: saved.emails.length,
              source: 'direct_gmail',
              api_ms,
              limit,
              result_summary: `${saved.emails.length}件のメールを検出・保存 (gmail-api)`,
              shadow: false,
            });
          } catch {}
          await say(`📬 受信一覧\n${lines.join('\n')}`);
          return;
        }
      }
      console.info('[phase2-list] direct_gmail insufficient results; falling back');
    } catch (e) {
      console.warn('[phase2-list] direct_gmail path failed; fallback to Responses API', e);
    }
  }

  // Fallback path requires Pipedream connect token (Responses/MCP)
  let token: string;
  try {
    token = await fetchConnectToken();
  } catch (e) {
    console.error('[phase2-list] fetchConnectToken failed', e);
    await say('⚠️ 認証エラーのため一覧取得に失敗しました');
    return;
  }

  const gmailTool = getMcpTool('gmail', token);
  const calendarTool = getMcpTool('calendar', token);

  const client = getOpenAIClient();
  const nudge = buildListNudge(params);

  // Fast-path: direct call (feature-flag)
  if (process.env.FEATURE_LIST_FASTPATH === 'true') {
    try {
      const known = getGmailListActionPath();
      if (known) console.info(`[direct.gmail] using cached action path: ${known}`);
      const t0 = Date.now();
      const direct = await listMessagesDirect(token, { mailbox: params.mailbox, date: params.date, query: params.query, limit: Number(process.env.GMAIL_LIST_LIMIT || '10') }, known);
      const ms = Date.now() - t0;
      if (direct.count >= 2) {
        const saved = await EmailDetectionService.detectAndSaveEmailList(direct.linesText, userId, {
          channel: message.channel,
          thread_ts: message.ts,
          workspaceId: (message as any).team,
          mailbox: params.mailbox,
          query: params.date,
        });
        if (saved && saved.emails.length >= 2) {
          const lines = saved.emails.map((e, i) => formatOneLine(i + 1, e.subject, e.from, (e as any).date));
          try {
            logAction({
              route: 'gmail_read',
              trace_id: generateTraceId('log'),
              user_id_hashed: hashUserId(userId),
              matched_trigger: 'list_emails',
              match_type: 'phase2_list',
              confidence: 1,
              params: { mailbox: params.mailbox, date: params.date },
              count: saved.emails.length,
              source: 'direct',
              responses_ms: ms,
              result_summary: `${saved.emails.length}件のメールを検出・保存 (direct)`,
              shadow: false,
            });
          } catch {}
          await say(`📬 受信一覧\n${lines.join('\n')}`);
          return;
        }
      }
    } catch (e) {
      console.warn('[phase2-list] direct path failed; falling back to Responses API', e);
    }
  }

  try {
    const { getPhase2ListModel } = await import('../config/models.js');
    const t0 = Date.now();
    let notifiedSlow = false;
    const slowTimer = setTimeout(async () => {
      try {
        notifiedSlow = true;
        await say('⌛ 時間がかかっています。結果が出たら続報します。');
      } catch {}
    }, Number(process.env.PHASE2_TIMEBOX_MS || '8000'));

    const resp1 = await client.responses.create({
      model: getPhase2ListModel(),
      input: nudge,
      tools: [gmailTool, calendarTool],
      temperature: 0.0,
      max_output_tokens: 350,
    });
    clearTimeout(slowTimer);
    const t1 = Date.now();
    console.info(`[perf] phase2-list round1 responses_ms=${t1 - t0}`);
    // Learn direct action path only when fastpath is enabled
    if (process.env.FEATURE_LIST_FASTPATH === 'true') {
      try {
        const out = (resp1 as any)?.output || [];
        const toolLists = out.filter((e: any) => e?.type === 'mcp_list_tools' && /gmail/i.test(e?.server_label || ''));
        const names: string[] = [];
        for (const tl of toolLists) {
          for (const t of (tl.tools || [])) {
            const name = t?.name || '';
            if (typeof name === 'string' && name) names.push(name);
          }
        }
        const uniqueNames = Array.from(new Set(names));
        if (uniqueNames.length > 0 && !getGmailListActionPath()) {
          for (const nm of uniqueNames) {
            const preferred = `/actions/gmail/${nm}`;
            try {
              const probe = await listMessagesDirect(token, { mailbox: params.mailbox, date: params.date, query: params.query, limit: 3 }, preferred);
              if (probe.count >= 0) { // any response means endpoint exists
                setGmailListActionPath(preferred);
                console.info(`[direct.gmail] learned action path: ${preferred}`);
                break;
              }
            } catch {}
          }
        }
      } catch (e) {
        console.warn('[direct.gmail] learn phase skipped', e);
      }
    }
    const vio1 = extractViolationTools(resp1);
    if (vio1.length > 0) {
      console.warn('[violation] write-like tool attempt:', vio1.join(','));
    }
    const text1 = (resp1 as any).output_text ?? '';
    const saved1 = await EmailDetectionService.detectAndSaveEmailList(text1, userId, {
      channel: message.channel,
      thread_ts: message.ts,
      workspaceId: (message as any).team,
      mailbox: params.mailbox,
      query: params.date,
    });

    if (saved1 && saved1.emails.length >= 2) {
      logAction({
        route: 'gmail_read',
        shadow: false,
        user_id: userId,
        raw_text: userText,
        normalized_text: userText,
        matched_trigger: 'list_emails',
        match_type: 'phase2_list',
        confidence: 1.0,
        params,
        suggested_action: 'list_emails',
        result_summary: `${saved1.emails.length}件のメールを検出・保存` ,
        session_id: `${message.channel}:${message.ts}`,
        error: null,
      });
      console.info(`[phase2-list] fetched=${saved1.emails.length} saved=YES`);
      const lines = saved1.emails.map((e, i) => formatOneLine(i + 1, e.subject, e.from, (e as any).date));
      try {
        logAction({
          route: 'gmail_read',
          trace_id: generateTraceId('log'),
          user_id_hashed: hashUserId(userId),
          matched_trigger: 'list_emails',
          match_type: 'phase2_list',
          confidence: 1,
          params: { mailbox: params.mailbox, date: params.date },
          count: saved1.emails.length,
          result_summary: `${saved1.emails.length}件のメールを検出・保存`,
          shadow: false,
          source: 'responses',
          responses_ms_round1: (t1 - t0),
        });
      } catch {}
      await say(`📬 受信一覧\n${lines.join('\n')}`);
      return;
    } else if (saved1 && saved1.emails.length === 1) {
      logAction({
        route: 'gmail_read',
        shadow: false,
        user_id: userId,
        raw_text: userText,
        normalized_text: userText,
        matched_trigger: 'list_emails',
        match_type: 'phase2_list',
        confidence: 1.0,
        params,
        suggested_action: 'list_emails',
        result_summary: `1件のみ検出（保存スキップ）` ,
        session_id: `${message.channel}:${message.ts}`,
        error: null,
      });
      console.info('[phase2-list] fetched=1 saved=NO reason=items_lt_2');
      try {
        logAction({
          route: 'gmail_read',
          trace_id: generateTraceId('log'),
          user_id_hashed: hashUserId(userId),
          matched_trigger: 'list_emails',
          match_type: 'phase2_list',
          confidence: 0.8,
          params: { mailbox: params.mailbox, date: params.date },
          count: 1,
          result_summary: `1件を検出（保存スキップ）`,
          shadow: true,
          source: 'responses',
          responses_ms_round1: (t1 - t0),
        });
      } catch {}
      await say('ℹ️ 1件のみ検出しました（保存はスキップ）。もう少し範囲を広げて再試行してください。');
      return;
    }

    // If detection failed or no tools used, attempt retry restricting to read-only tools
    const allowed = pickGmailListToolsFromOutput(resp1);
    if (allowed.length > 0) (gmailTool as any).allowed_tools = allowed;
    const { getPhase2ListModel: _getListModel } = await import('../config/models.js');
    const t2 = Date.now();
    const resp2 = await client.responses.create({
      model: _getListModel(),
      input: nudge + '\n（読み取り専用の検索ツール（gmail-find-email 等）のみ使用してください）',
      tools: [gmailTool, calendarTool],
      temperature: 0.0,
      max_output_tokens: 300,
    });
    console.info(`[perf] phase2-list round2 responses_ms=${Date.now() - t2}`);
    const vio2 = extractViolationTools(resp2);
    if (vio2.length > 0) {
      console.warn('[violation] write-like tool attempt (retry):', vio2.join(','));
    }
    const text2 = (resp2 as any).output_text ?? '';
    const saved2 = await EmailDetectionService.detectAndSaveEmailList(text2, userId, {
      channel: message.channel,
      thread_ts: message.ts,
      workspaceId: (message as any).team,
      mailbox: params.mailbox,
      query: params.date,
    });
    if (saved2 && saved2.emails.length >= 2) {
      logAction({
        route: 'gmail_read',
        shadow: false,
        user_id: userId,
        raw_text: userText,
        normalized_text: userText,
        matched_trigger: 'list_emails',
        match_type: 'phase2_list_retry',
        confidence: 1.0,
        params,
        suggested_action: 'list_emails',
        result_summary: `${saved2.emails.length}件のメールを検出・保存` ,
        session_id: `${message.channel}:${message.ts}`,
        error: null,
      });
      console.info(`[phase2-list] fetched=${saved2.emails.length} saved=YES (retry)`);
      const lines = saved2.emails.map((e, i) => formatOneLine(i + 1, e.subject, e.from, (e as any).date));
      try {
        logAction({
          route: 'gmail_read',
          trace_id: generateTraceId('log'),
          user_id_hashed: hashUserId(userId),
          matched_trigger: 'list_emails',
          match_type: 'phase2_list',
          confidence: 1,
          params: { mailbox: params.mailbox, date: params.date },
          count: saved2.emails.length,
          result_summary: `${saved2.emails.length}件のメールを検出・保存 (retry)`,
          shadow: false,
          source: 'responses',
          responses_ms_round1: (t1 - t0),
          responses_ms_round2: (Date.now() - t2),
        });
      } catch {}
      await say(`📬 受信一覧\n${lines.join('\n')}`);
    } else if (saved2 && saved2.emails.length === 1) {
      logAction({
        route: 'gmail_read',
        shadow: false,
        user_id: userId,
        raw_text: userText,
        normalized_text: userText,
        matched_trigger: 'list_emails',
        match_type: 'phase2_list_retry',
        confidence: 1.0,
        params,
        suggested_action: 'list_emails',
        result_summary: `1件のみ検出（保存スキップ）` ,
        session_id: `${message.channel}:${message.ts}`,
        error: null,
      });
      console.info('[phase2-list] fetched=1 saved=NO reason=items_lt_2 (retry)');
      try {
        logAction({
          route: 'gmail_read',
          trace_id: generateTraceId('log'),
          user_id_hashed: hashUserId(userId),
          matched_trigger: 'list_emails',
          match_type: 'phase2_list',
          confidence: 0.8,
          params: { mailbox: params.mailbox, date: params.date },
          count: 1,
          result_summary: `1件を検出（保存スキップ、retry）`,
          shadow: true,
          source: 'responses',
          responses_ms_round1: (t1 - t0),
          responses_ms_round2: (Date.now() - t2),
        });
      } catch {}
      await say('ℹ️ 1件のみ検出しました（保存はスキップ）。もう少し範囲を広げて再試行してください。');
    } else {
      logAction({
        route: 'gmail_read',
        shadow: false,
        user_id: userId,
        raw_text: userText,
        normalized_text: userText,
        matched_trigger: 'list_emails',
        match_type: 'phase2_list',
        confidence: 1.0,
        params,
        suggested_action: 'list_emails',
        result_summary: '一覧の検出に失敗',
        session_id: `${message.channel}:${message.ts}`,
        error: 'detection_failed',
      });
      console.warn('[phase2-list] detection failed');
      try {
        logAction({
          route: 'gmail_read',
          trace_id: generateTraceId('log'),
          user_id_hashed: hashUserId(userId),
          matched_trigger: 'list_emails',
          match_type: 'phase2_list',
          confidence: 0,
          params: { mailbox: params.mailbox, date: params.date },
          count: 0,
          result_summary: `一覧の検出に失敗`,
          shadow: true,
          error: 'detection_failed',
          source: 'responses',
          responses_ms_round1: (t1 - t0),
          responses_ms_round2: (Date.now() - t2),
        });
      } catch {}
      await say('⚠️ 一覧の取得に失敗しました。日付やキーワードを調整して再試行してください。');
    }
  } catch (e: any) {
    console.error('[phase2-list] OpenAI error', util.inspect(e, { depth: 1 }));
    // Try token refresh on 401
    if (e.response?.status === 401) {
      try {
        clearTokenCache();
        const newToken = await fetchConnectToken();
        const newGmail = getMcpTool('gmail', newToken);
        const newCalendar = getMcpTool('calendar', newToken);
        const client2 = getOpenAIClient();
        const { getPhase2ListModel: __getListModel } = await import('../config/models.js');
        const resp = await client2.responses.create({ model: __getListModel(), input: buildListNudge(params), tools: [newGmail, newCalendar], temperature: 0.1 });
        const text = (resp as any).output_text ?? '';
        const saved = await EmailDetectionService.detectAndSaveEmailList(text, userId, {
          channel: message.channel,
          thread_ts: message.ts,
          workspaceId: (message as any).team,
          mailbox: params.mailbox,
          query: params.date,
        });
        if (saved && saved.emails.length >= 2) {
          logAction({
            route: 'gmail_read',
            shadow: false,
            user_id: userId,
            raw_text: userText,
            normalized_text: userText,
            matched_trigger: 'list_emails',
            match_type: 'phase2_list_retry401',
            confidence: 1.0,
            params,
            suggested_action: 'list_emails',
            result_summary: `${saved.emails.length}件のメールを検出・保存` ,
            session_id: `${message.channel}:${message.ts}`,
            error: null,
          });
          console.info(`[phase2-list] fetched=${saved.emails.length} saved=YES (retry401)`);
          const lines = saved.emails.map((e, i) => formatOneLine(i + 1, e.subject, e.from, (e as any).date));
          await say(`📬 受信一覧\n${lines.join('\n')}`);
          return;
        }
        logAction({
          route: 'gmail_read',
          shadow: false,
          user_id: userId,
          raw_text: userText,
          normalized_text: userText,
          matched_trigger: 'list_emails',
          match_type: 'phase2_list_retry401',
          confidence: 1.0,
          params,
          suggested_action: 'list_emails',
          result_summary: '401後の再試行でも検出できず',
          session_id: `${message.channel}:${message.ts}`,
          error: 'detection_failed_after_401',
        });
        console.warn('[phase2-list] detection failed after 401 retry');
        await say('⚠️ 一覧の取得に失敗しました。');
      } catch (e2) {
        console.error('[phase2-list] retry after 401 failed', e2);
        await say('⚠️ 一覧の取得に失敗しました。');
      }
    } else {
      await say('⚠️ 一覧の取得に失敗しました。');
    }
  }
}

function toDateStr(s?: string): string {
  if (!s) return '';
  // Try to normalize common formats to YYYY-MM-DD HH:mm
  try {
    // If already ISO-like
    if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.replace('T', ' ').slice(0, 16);
    // Replace slashes
    const m1 = s.match(/(\d{4})[\/](\d{1,2})[\/](\d{1,2})(?:[\sT](\d{1,2}):(\d{2}))?/);
    if (m1) {
      const y = m1[1];
      const mo = m1[2].padStart(2, '0');
      const d = m1[3].padStart(2, '0');
      const hh = (m1[4] || '00').padStart(2, '0');
      const mm = (m1[5] || '00').padStart(2, '0');
      return `${y}-${mo}-${d} ${hh}:${mm}`;
    }
  } catch {}
  return s;
}

function formatOneLine(index: number, subject?: string, from?: string, date?: string): string {
  const safeSubj = (subject || '').trim() || '(件名なし)';
  const safeFrom = (from || '').trim() || '(送信者不明)';
  const ds = toDateStr(date);
  const datePart = ds ? `（${ds}）` : '';
  return `${index}. ${safeSubj} — ${safeFrom}${datePart}`;
}
