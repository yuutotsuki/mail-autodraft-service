import axios from 'axios';
import { getGoogleAccessToken } from './googleTokenProvider';
import { decodeMimeWords } from '../utils/mime';

const DEBUG_MIME_ENV = process.env.DEBUG_MIME_DECODE;
const DEBUG_MIME = /^(1|true|yes|on)$/i.test((DEBUG_MIME_ENV || '').trim());
const MIME_LOG_LIMIT = Number(process.env.DEBUG_MIME_LIMIT || '40');
let mimeLogCount = 0;
function maybeLogMime(label: string, raw: string, decoded: string) {
  if (!DEBUG_MIME) return;
  if (mimeLogCount >= MIME_LOG_LIMIT) return;
  mimeLogCount += 1;
  const hasMimeWord = /=\?[^?]+\?[bqBQ]\?[^?]+\?=/.test(raw || '');
  // Always log under debug (up to the limit) so we can see raw/decoded even when unchanged
  console.log(`[mime-debug] ${label}`, { raw, decoded, hasMimeWord });
}
if (DEBUG_MIME) {
  console.log('[mime-debug] enabled (set DEBUG_MIME_DECODE=1)');
} else {
  console.log(`[mime-debug] env DEBUG_MIME_DECODE=${DEBUG_MIME_ENV ?? '(unset)'} parsed=${DEBUG_MIME}`);
}

export type GmailListParams = { limit?: number; q?: string; labelIds?: string[] };

export type GmailListItem = {
  id?: string;
  threadId?: string;
  subject?: string;
  from?: string;
  date?: string;
};

function parseHeader(headers: Array<{ name: string; value: string }>, key: string): string | undefined {
  const h = headers.find((x) => x.name?.toLowerCase() === key.toLowerCase());
  return h?.value;
}

export async function listGmailMessages(
  params: GmailListParams = {},
  accessTokenOverride?: string
): Promise<{ items: GmailListItem[]; api_ms: number }>
{
  const accessToken = accessTokenOverride || await getGoogleAccessToken();
  const base = 'https://gmail.googleapis.com/gmail/v1';
  const limit = Math.max(1, Math.min(50, Number(process.env.GMAIL_LIST_LIMIT || params.limit || 8)));
  const timeout = Number(process.env.GMAIL_API_TIMEOUT_MS || '6000');
  const labelIds = params.labelIds && params.labelIds.length > 0 ? params.labelIds : ['INBOX'];
  const q = params.q || '';

  const t0 = Date.now();
  const listResp = await axios.get(`${base}/users/me/messages`, {
    headers: { Authorization: `Bearer ${accessToken}` },
    params: { maxResults: limit, labelIds: labelIds.join(','), q },
    timeout,
  });
  const msgs: Array<{ id: string; threadId?: string }> = listResp.data?.messages || [];
  if (!Array.isArray(msgs) || msgs.length === 0) {
    return { items: [], api_ms: Date.now() - t0 };
  }

  // Simple concurrency control without external deps
  const ids = msgs.slice(0, limit);
  const concurrency = 5;
  const detailed: GmailListItem[] = [];
  let index = 0;
  async function worker() {
    while (index < ids.length) {
      const current = ids[index++];
      try {
        const r = await axios.get(`${base}/users/me/messages/${current.id}`, {
          headers: { Authorization: `Bearer ${accessToken}` },
          params: { format: 'metadata', metadataHeaders: ['Subject', 'From', 'Date'] },
          timeout,
        });
        const payload = r.data?.payload || {};
        const headers = Array.isArray(payload.headers) ? payload.headers : [];
        const rawSubject = parseHeader(headers, 'Subject') || '';
        const subject = decodeMimeWords(rawSubject) || r.data?.snippet || '';
        const rawFrom = parseHeader(headers, 'From') || '';
        const from = decodeMimeWords(rawFrom);
        maybeLogMime('list.subject', rawSubject, subject);
        maybeLogMime('list.from', rawFrom, from);
        const date = parseHeader(headers, 'Date') || '';
        detailed.push({ id: current.id, threadId: current.threadId, subject, from, date });
      } catch {
        detailed.push({ id: current.id, threadId: current.threadId });
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, ids.length) }, () => worker()));
  return { items: detailed.filter(Boolean), api_ms: Date.now() - t0 };
}

// Fetch a full Gmail thread and return lightweight normalized messages
export async function getGmailThread(threadId: string, accessTokenOverride?: string): Promise<{
  id: string;
  messages: Array<{ id: string; subject?: string; from?: string; to?: string; date?: string; text?: string }>;
}> {
  const accessToken = accessTokenOverride || await getGoogleAccessToken();
  const base = 'https://gmail.googleapis.com/gmail/v1';
  const r = await axios.get(`${base}/users/me/threads/${encodeURIComponent(threadId)}`, {
    headers: { Authorization: `Bearer ${accessToken}` },
    params: { format: 'full' },
    timeout: Number(process.env.GMAIL_API_TIMEOUT_MS || '8000'),
  });
  const data = r.data || {};
  const msgs: any[] = Array.isArray(data.messages) ? data.messages : [];

  function parseHeader(headers: Array<{ name: string; value: string }>, key: string): string | undefined {
    const h = headers.find((x) => x.name?.toLowerCase() === key.toLowerCase());
    return h?.value;
  }
  function decodeBody(payload: any): string | undefined {
    try {
      // Depth-first search for text/plain
      const stack = [payload];
      while (stack.length) {
        const p = stack.pop();
        if (!p) continue;
        const mime = p.mimeType || '';
        if (mime === 'text/plain' && p.body?.data) {
          const b64 = String(p.body.data).replace(/-/g, '+').replace(/_/g, '/');
          const buf = Buffer.from(b64, 'base64');
          return buf.toString('utf8');
        }
        if (Array.isArray(p.parts)) {
          for (const child of p.parts) stack.push(child);
        }
      }
    } catch {}
    return undefined;
  }

  const out = msgs.map((m) => {
    const payload = m.payload || {};
    const headers = Array.isArray(payload.headers) ? payload.headers : [];
    const rawSubject = parseHeader(headers, 'Subject') || '';
    const subject = decodeMimeWords(rawSubject);
    const rawFrom = parseHeader(headers, 'From') || '';
    const from = decodeMimeWords(rawFrom);
    const rawTo = parseHeader(headers, 'To') || '';
    const to = decodeMimeWords(rawTo);
    maybeLogMime('thread.subject', rawSubject, subject);
    maybeLogMime('thread.from', rawFrom, from);
    maybeLogMime('thread.to', rawTo, to);
    const date = parseHeader(headers, 'Date');
    const text = decodeBody(payload) || m.snippet || '';
    return { id: m.id as string, subject, from, to, date, text };
  });
  return { id: String(data.id || threadId), messages: out };
}
