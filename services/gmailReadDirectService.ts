import axios from 'axios';
import { getEnvironmentVariable } from '../config/environment';

type ListParams = { mailbox?: string; date?: string; query?: string; limit?: number };

function buildPdHeaders(token: string) {
  return {
    Authorization: `Bearer ${token}`,
    'Content-Type': 'application/json',
    'x-pd-project-id': getEnvironmentVariable('PIPEDREAM_PROJECT_ID'),
    'x-pd-environment': getEnvironmentVariable('PIPEDREAM_ENVIRONMENT'),
    'x-pd-external-user-id': getEnvironmentVariable('PIPEDREAM_EXTERNAL_USER_ID'),
    'x-pd-app-slug': 'gmail',
  } as Record<string, string>;
}

function toDateStr(s?: string | number): string {
  if (!s) return '';
  try {
    if (typeof s === 'number') {
      const d = new Date(s);
      return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
    }
    if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.replace('T', ' ').slice(0, 16);
    const m1 = s.match(/(\d{4})[\/年-](\d{1,2})[\/月-](\d{1,2})(?:[\sT]*(\d{1,2}):(\d{2}))?/);
    if (m1) {
      const y = m1[1];
      const mo = m1[2].padStart(2, '0');
      const d = m1[3].padStart(2, '0');
      const hh = (m1[4] || '00').padStart(2, '0');
      const mm = (m1[5] || '00').padStart(2, '0');
      return `${y}-${mo}-${d} ${hh}:${mm}`;
    }
  } catch {}
  return String(s);
}

function formatLine(idx: number, subject?: string, from?: string, date?: string, id?: string): string {
  const safeSubj = (subject || '').trim() || '(件名なし)';
  const safeFrom = (from || '').trim() || '(送信者不明)';
  const ds = toDateStr(date);
  const datePart = ds ? `（${ds}）` : '';
  const idPart = id ? ` [id:${id}]` : '';
  return `${idx}. ${safeSubj} — ${safeFrom}${datePart}${idPart}`;
}

async function tryPost(url: string, headers: Record<string, string>, body: any) {
  try {
    const res = await axios.post(url, body, { headers, timeout: Number(getEnvironmentVariable('MCP_HTTP_TIMEOUT_MS', '2000')) });
    return res.data;
  } catch (e: any) {
    if (e?.response?.status === 404) return null;
    throw e; // other errors propagate
  }
}

async function discoverGmailActions(token: string): Promise<string[]> {
  const baseUrl = getEnvironmentVariable('MCP_BASE_URL', 'https://remote.mcp.pipedream.net');
  const headers = buildPdHeaders(token);
  const paths: string[] = [];
  // Best-effort: try to list app actions
  try {
    const r1 = await axios.get(`${baseUrl}/actions/gmail`, { headers, timeout: Number(getEnvironmentVariable('MCP_HTTP_TIMEOUT_MS', '2000')) });
    const data = r1.data;
    if (Array.isArray(data)) {
      for (const name of data) {
        if (typeof name === 'string') paths.push(`/actions/gmail/${name}`);
      }
    } else if (data && Array.isArray(data?.actions)) {
      for (const a of data.actions) {
        const name = typeof a === 'string' ? a : a?.name;
        if (typeof name === 'string') paths.push(`/actions/gmail/${name}`);
      }
    }
  } catch (e) {
    console.info('[direct.gmail] listing /actions/gmail failed; will try global /actions');
  }

  // Fallback: list all actions then filter those under /actions/gmail
  if (paths.length === 0) {
    try {
      const r2 = await axios.get(`${baseUrl}/actions`, { headers, timeout: Number(getEnvironmentVariable('MCP_HTTP_TIMEOUT_MS', '2000')) });
      const data2 = r2.data;
      const pushIf = (p?: string) => {
        if (typeof p === 'string' && /\/actions\/gmail\//.test(p)) paths.push(p);
      };
      if (Array.isArray(data2)) {
        for (const entry of data2) {
          if (typeof entry === 'string') pushIf(entry);
          else if (entry && typeof entry === 'object') pushIf((entry as any).path || (entry as any).url);
        }
      } else if (data2 && Array.isArray(data2?.actions)) {
        for (const a of data2.actions) {
          if (typeof a === 'string') pushIf(a);
          else if (a && typeof a === 'object') pushIf(a.path || a.url || `/actions/gmail/${a.name}`);
        }
      }
    } catch (e) {
      console.info('[direct.gmail] listing /actions failed');
    }
  }

  const unique = Array.from(new Set(paths));
  if (unique.length > 0) {
    console.info(`[direct.gmail] discovered actions: ${unique.join(', ')}`);
  } else {
    console.info('[direct.gmail] no actions discovered');
  }
  return unique;
}

export async function listMessagesDirect(token: string, p: ListParams, preferredPath?: string): Promise<{ linesText: string; count: number }> {
  const baseUrl = getEnvironmentVariable('MCP_BASE_URL', 'https://remote.mcp.pipedream.net');
  const limit = Number(getEnvironmentVariable('GMAIL_LIST_LIMIT', String(p.limit || 10)));
  const headers = buildPdHeaders(token);
  const body: any = { mailbox: p.mailbox || 'inbox', limit, maxResults: limit };
  if (p.date) {
    body.date = p.date;
    // Also provide Gmail-style q as a hint window [date, date+1)
    try {
      const d = new Date(p.date + 'T00:00:00');
      const next = new Date(d.getTime() + 86400000);
      const fmt = (x: Date) => `${x.getFullYear()}/${String(x.getMonth() + 1).padStart(2, '0')}/${String(x.getDate()).padStart(2, '0')}`;
      const qDate = `after:${fmt(d)} before:${fmt(next)}`;
      body.q = [body.q, qDate].filter(Boolean).join(' ').trim();
      body.query = body.q;
    } catch {}
  }
  if (p.query) { body.query = p.query; body.q = p.query; }
  // Add common Gmail list filters as hints (best-effort)
  if ((p.mailbox || 'inbox').toLowerCase() === 'inbox') {
    (body as any).labelIds = ['INBOX'];
  }

  const configured = preferredPath || getEnvironmentVariable('GMAIL_LIST_ACTION', '/actions/gmail/list_messages');
  if (preferredPath) {
    console.info(`[direct.gmail] preferred action path provided: ${preferredPath}`);
  } else {
    console.info(`[direct.gmail] configured default action: ${configured}`);
  }
  const hardcoded = [
    '/actions/gmail/list_messages',
    '/actions/gmail/search_messages',
    '/actions/gmail/list_emails',
    '/actions/gmail/list',
    '/actions/gmail/messages/list',
    '/actions/gmail/inbox_list',
    // Additional common variants
    '/actions/gmail/messages_list',
    '/actions/gmail/users_messages_list',
    '/actions/gmail/users_threads_list',
    '/actions/gmail/get_messages',
    '/actions/gmail/get_threads',
    '/actions/gmail/list_inbox',
    '/actions/gmail/inbox',
    '/actions/gmail/threads/list',
    '/actions/gmail/threads_search',
    '/actions/gmail/messages/search',
    '/actions/gmail/search',
    '/actions/gmail/query',
    '/actions/gmail/listThreads',
    '/actions/gmail/listMessages',
  ];
  const discovered = await discoverGmailActions(token);
  const tried = new Set<string>();

  const candidates = [configured, ...discovered, ...hardcoded].filter((p) => {
    if (tried.has(p)) return false;
    tried.add(p);
    return true;
  });

  let data: any = null;
  let usedPath: string | undefined;
  for (const path of candidates) {
    const url = `${baseUrl}${path}`;
    data = await tryPost(url, headers, body);
    if (data) {
      usedPath = path;
      console.info(`[direct.gmail] using action=${path}`);
      break;
    } else {
      console.info(`[direct.gmail] 404 for action=${path}, trying next`);
    }
  }
  if (!data) {
    throw new Error('direct_list_not_found');
  }

  // Try to map a few possible shapes
  const items: Array<{ id?: string; subject?: string; from?: string; date?: string | number }>
    = Array.isArray(data?.items) ? data.items
    : Array.isArray(data?.messages) ? data.messages
    : Array.isArray(data) ? data
    : [];

  const lines = items.slice(0, limit).map((m, i) => {
    const id = (m as any).id || (m as any).messageId || (m as any).threadId;
    const subject = (m as any).subject || (m as any).snippet || (m as any).title;
    const from = (m as any).from || (m as any).sender || (m as any).author || (m as any).email;
    const date = (m as any).date || (m as any).internalDate || (m as any).receivedAt || (m as any).createdAt;
    return formatLine(i + 1, subject, from, String(date || ''), id);
  });

  return { linesText: lines.join('\n'), count: lines.length };
}
