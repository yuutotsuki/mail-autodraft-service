import OpenAI from 'openai';
import axios from 'axios';
import { readFileSync } from 'fs';
import path from 'path';
import { getGmailThread, listGmailMessages } from './gmailApiList';
import { createGmailDraftDirect, getGmailPrimarySignatureText } from './gmailService';
import { logAction, hashUserId } from '../utils/actionLogger';
import { generateTraceId } from '../utils/ids';
import { getAutodraftState, upsertAutodraftState } from '../db/sqlite';
import { getEnabledUsers } from '../db/postgres';
import { getAutoDraftModel } from '../config/models';
import { decodeMimeWords } from '../utils/mime';
import { getGoogleAccessTokenForScope, getGoogleAccessTokenForRefreshToken } from './googleTokenProvider';

function getEnvBool(name: string, def = false): boolean {
  const v = process.env[name];
  if (v == null) return def;
  return /^(1|true|yes|on)$/i.test(v);
}

function extractDisplayName(addr?: string): string | undefined {
  if (!addr) return undefined;
  const primary = String(addr).split(',')[0]; // handle multi-address but take the first
  let decoded = decodeMimeWords(primary).trim();
  const quoted = decoded.match(/"([^"]+)"/);
  if (quoted) decoded = quoted[1];
  if (decoded.includes('<')) {
    decoded = decoded.replace(/<[^>]+>/g, '').trim();
  }
  decoded = decoded.replace(/["']/g, '').trim();
  if (!decoded) return undefined;
  if (/^[^@<>]+@[^@<>]+$/.test(decoded)) return undefined;
  return decoded;
}

const CORPORATE_HINTS = [
  '株式会社',
  '有限会社',
  '合同会社',
  'inc',
  'co.,',
  'co ',
  'company',
  'corp',
  'llc',
  'ltd',
  '大学',
  '病院',
  '支店',
  '本社',
  '部',
  '課',
  '局',
];

function hasCorporateHint(value: string): boolean {
  const lower = value.toLowerCase();
  return CORPORATE_HINTS.some((hint) => lower.includes(hint));
}

function endsWithCorporateToken(value: string): boolean {
  const tokens = value.split(/[\s　]+/).filter(Boolean);
  if (tokens.length === 0) return false;
  const last = tokens[tokens.length - 1].toLowerCase();
  return CORPORATE_HINTS.some((hint) => last.includes(hint));
}

function buildRecipientGreeting(displayName?: string): string | undefined {
  if (!displayName) return undefined;
  const normalized = displayName.replace(/[\s\u00A0]+/g, ' ').trim();
  if (!normalized) return undefined;
  if (/[様御中殿]$/.test(normalized)) return normalized;
  const isCorporate = hasCorporateHint(normalized);
  const lastIsCorporate = endsWithCorporateToken(normalized);
  const honorific = isCorporate && !normalized.split(/[\s　]+/).some((token) => !hasCorporateHint(token)) && lastIsCorporate
    ? '御中'
    : '様';
  return `${normalized}${honorific}`;
}

function extractEmail(addr?: string): string | undefined {
  if (!addr) return undefined;
  const text = addr.trim();
  if (!text) return undefined;
  const angleMatch = text.match(/<([^>]+)>/);
  if (angleMatch && isValidEmail(angleMatch[1])) return angleMatch[1];
  if (isValidEmail(text)) return text;
  const inlineMatch = text.match(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/);
  if (inlineMatch && isValidEmail(inlineMatch[0])) return inlineMatch[0];
  return undefined;
}

function isValidEmail(value: string): boolean {
  if (!value) return false;
  const trimmed = value.trim();
  if (!trimmed) return false;
  return /^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/.test(trimmed);
}

function ensureReplySubject(subject?: string): string {
  const s = subject || '';
  return /^\s*Re:/i.test(s) ? s : `Re: ${s}`;
}

const PROCESSED_LABEL = (process.env.AUTODRAFT_PROCESSED_LABEL || 'autodraft-processed').trim();
const labelCache = new Map<string, string>();
const gmailBase = 'https://gmail.googleapis.com/gmail/v1';

async function ensureProcessedLabelId(accessTokenOverride?: string, cacheKey?: string): Promise<string | null> {
  if (!PROCESSED_LABEL) return null;
  const key = cacheKey || PROCESSED_LABEL;
  if (labelCache.has(key)) return labelCache.get(key)!;
  try {
    const token = accessTokenOverride || await getGoogleAccessTokenForScope('https://www.googleapis.com/auth/gmail.modify');
    const timeout = Number(process.env.GMAIL_API_TIMEOUT_MS || '8000');
    const headers = { Authorization: `Bearer ${token}` };
    const list = await axios.get(`${gmailBase}/users/me/labels`, { headers, timeout });
    const found = (list.data?.labels || []).find((l: any) => l?.name === PROCESSED_LABEL);
    if (found?.id) {
      labelCache.set(key, found.id);
      return found.id;
    }
    const created = await axios.post(`${gmailBase}/users/me/labels`, { name: PROCESSED_LABEL }, { headers, timeout });
    if (created.data?.id) {
      labelCache.set(key, created.data.id);
      return created.data.id;
    }
  } catch (e: any) {
    console.warn('[autodraft] ensure label failed', e?.response?.status || e?.message || e);
  }
  return null;
}

async function markMessageProcessed(messageId: string, accessTokenOverride?: string, cacheKey?: string): Promise<void> {
  if (!PROCESSED_LABEL || !messageId) return;
  try {
    const labelId = await ensureProcessedLabelId(accessTokenOverride, cacheKey);
    if (!labelId) return;
    const token = accessTokenOverride || await getGoogleAccessTokenForScope('https://www.googleapis.com/auth/gmail.modify');
    const timeout = Number(process.env.GMAIL_API_TIMEOUT_MS || '8000');
    const headers = { Authorization: `Bearer ${token}` };
    await axios.post(`${gmailBase}/users/me/messages/${encodeURIComponent(messageId)}/modify`, {
      addLabelIds: [labelId],
    }, { headers, timeout });
  } catch (e: any) {
    console.warn('[autodraft] failed to mark message processed', e?.response?.status || e?.message || e);
  }
}

function shouldSkipByHeuristics(from?: string, subject?: string): boolean {
  const f = (from || '').toLowerCase();
  const s = (subject || '').toLowerCase();
  if (!from) return true; // defensive: unknown sender
  const self = (process.env.SELF_USER_EMAIL || '').toLowerCase();
  if (self && f.includes(self)) return true;
  if (f.includes('no-reply') || f.includes('noreply')) return true;
  if (/mailer-daemon|postmaster/.test(f)) return true; // bounces
  if (/auto.?reply|out.?of.?office|休暇|自動.?応答/.test(s)) return true;
  return false;
}

function buildConversationText(thread: { messages: Array<{ from?: string; to?: string; date?: string; subject?: string; text?: string }> }): string {
  const parts: string[] = [];
  const last = Math.max(0, thread.messages.length - Number(process.env.AUTODRAFT_HISTORY_LIMIT || '5'));
  const slice = thread.messages.slice(last);
  for (const m of slice) {
    const head = [`From: ${m.from || ''}`, `To: ${m.to || ''}`, `Date: ${m.date || ''}`, `Subject: ${m.subject || ''}`].join(' | ');
    const body = (m.text || '').replace(/\r\n/g, '\n').split('\n').slice(0, 80).join('\n');
    parts.push(`${head}\n${body}`);
  }
  return parts.join('\n\n---\n\n');
}

const DEFAULT_SYSTEM_PROMPT = [
  'あなたは日本語のビジネスメールの下書きを作成するアシスタントです。',
  '敬体で簡潔・具体的に返答してください。署名は付けません。',
  '相手の要件に直接応答し、不明点は1〜2点の質問として端的に確認します。',
  '出力は本文のみ。件名や挨拶の装飾は最小限にしてください。',
].join('\n');

const DEFAULT_USER_PROMPT_TEMPLATE = [
  '以下は直近のメールのやり取りです。これを踏まえて適切な返信本文（日本語）を作成してください。',
  '本文のみを出力してください。',
  '{{GREETING_INSTRUCTION}}',
  '--- 会話ログ ---',
  '{{THREAD_TEXT}}',
].join('\n');

type PromptKey = 'system' | 'user';
const promptCache: Record<PromptKey, string | null> = { system: null, user: null };

function getPromptDirectory(): string {
  if (process.env.AUTODRAFT_PROMPT_DIR) {
    return process.env.AUTODRAFT_PROMPT_DIR;
  }
  return path.resolve(process.cwd(), 'prompts', 'autodraft');
}

function loadPromptTemplate(key: PromptKey, fallback: string): string {
  const cached = promptCache[key];
  if (cached) return cached;
  const filename = `${key}.txt`;
  const filePath = path.join(getPromptDirectory(), filename);
  try {
    const raw = readFileSync(filePath, 'utf8').replace(/\r\n/g, '\n');
    if (raw.trim().length > 0) {
      promptCache[key] = raw;
      return raw;
    }
  } catch (err: any) {
    // ignore missing files and fall back to defaults
    if (process.env.LOG_VERBOSITY === 'debug') {
      console.debug(`[autodraft] prompt template missing or unreadable: ${filePath}`, err);
    }
  }
  promptCache[key] = fallback;
  return fallback;
}

function getSystemPrompt(): string {
  return loadPromptTemplate('system', DEFAULT_SYSTEM_PROMPT);
}

function buildUserPrompt(threadText: string, greeting?: string): string {
  const template = loadPromptTemplate('user', DEFAULT_USER_PROMPT_TEMPLATE);
  const normalizedThread = threadText.replace(/\r\n/g, '\n');
  const greetingInstruction = greeting
    ? `返信冒頭に次の宛名を一行で配置し、本文との間に空行を1行挟んでください: ${greeting}`
    : '';
  const lines: string[] = [];
  for (const rawLine of template.split('\n')) {
    if (rawLine.includes('{{THREAD_TEXT}}')) {
      const [before, after] = rawLine.split('{{THREAD_TEXT}}');
      if (before) lines.push(before);
      lines.push(normalizedThread);
      if (after) lines.push(after);
      continue;
    }
    if (rawLine.includes('{{GREETING_INSTRUCTION}}')) {
      if (greetingInstruction) {
        const replaced = rawLine.replace('{{GREETING_INSTRUCTION}}', greetingInstruction);
        if (replaced.trim().length > 0) {
          lines.push(replaced);
        }
      }
      continue;
    }
    lines.push(rawLine);
  }
  const merged = lines.join('\n').replace(/\n{3,}/g, '\n\n');
  return merged.trim();
}

function getOpenAIClient(): OpenAI { return new OpenAI({ apiKey: process.env.OPENAI_API_KEY }); }

function appendSignature(body: string, signatureOverride?: string): string {
  const signatureRaw = signatureOverride ?? process.env.AUTODRAFT_SIGNATURE;
  if (!signatureRaw) return body;
  const normalizedSignature = signatureRaw
    .replace(/\r\n/g, '\n')
    .replace(/\\n/g, '\n');
  const trimmedBody = body.replace(/[\s\u00A0]+$/u, '');
  const needsBlankLine = trimmedBody.length > 0 && !/\n{2}$/.test(trimmedBody);
  const separator = needsBlankLine ? (trimmedBody.endsWith('\n') ? '' : '\n\n') : '';
  return `${trimmedBody}${separator}${normalizedSignature}`;
}

function ensureGreeting(body: string, greeting?: string): string {
  if (!greeting) return body;
  const normalizedGreeting = greeting.trim();
  if (!normalizedGreeting) return body;
  const strippedBody = body.trimStart();
  const firstLine = strippedBody.split('\n')[0]?.trim() || '';
  if (firstLine.replace(/[\s　]+/g, '') === normalizedGreeting.replace(/[\s　]+/g, '')) {
    return strippedBody;
  }
  if (!strippedBody) {
    return normalizedGreeting;
  }
  return `${normalizedGreeting}\n\n${strippedBody}`;
}

async function generateDraftBody(threadText: string, greeting?: string, signature?: string): Promise<string> {
  const client = getOpenAIClient();
  const model = getAutoDraftModel();
  const sys = getSystemPrompt();
  const user = buildUserPrompt(threadText, greeting);
  const resp = await client.responses.create({
    model,
    input: [
      { role: 'system', content: sys },
      { role: 'user', content: user },
    ],
    max_output_tokens: 400,
    temperature: 0.3,
  } as any);
  const text = ((resp as any).output_text || '').toString();
  const body = text.trim();
  const withGreeting = ensureGreeting(body, greeting);
  return appendSignature(withGreeting, signature);
}


export async function runAutoDraftOnce(): Promise<number> {
  // Build Gmail search query
  const lookback = process.env.AUTODRAFT_LOOKBACK || '1d';
  const defaultRequireAllowLabel = getEnvBool('AUTODRAFT_REQUIRE_ALLOW_LABEL', true);
  const allowLabel = (process.env.AUTODRAFT_ALLOW_LABEL_NAME || 'ai-draft-allow').trim();
  if (defaultRequireAllowLabel && !allowLabel) {
    console.warn('[autodraft] require allow-label is enabled but AUTODRAFT_ALLOW_LABEL_NAME is empty; skipping');
    return 0;
  }
  const buildQuery = (requireAllowLabel: boolean): string => {
    const qParts = [`in:inbox`, `is:unread`, `newer_than:${lookback}`];
    if (requireAllowLabel && allowLabel) qParts.push(`label:${allowLabel}`);
    if (getEnvBool('AUTODRAFT_EXCLUDE_PROMOTIONS', true)) qParts.push('-category:promotions');
    if (PROCESSED_LABEL) qParts.push(`-label:${PROCESSED_LABEL}`);
    return qParts.join(' ');
  };
  const limit = Number(process.env.AUTODRAFT_MAX_PER_POLL || '5');
  const perUserSleepMs = Math.max(0, Number(process.env.AUTODRAFT_USER_SLEEP_MS || '2000'));

  const enabledUsers = await getEnabledUsers();
  if (enabledUsers.length > 0) {
    let total = 0;
    for (let i = 0; i < enabledUsers.length; i++) {
      const u = enabledUsers[i];
      const maskedEmail = u.email.replace(/(.{2}).+(@.+)/, '$1***$2');
      try {
        const token = await getGoogleAccessTokenForRefreshToken(
          u.refresh_token,
          'https://www.googleapis.com/auth/gmail.modify'
        );
        if (u.require_allow_label && !allowLabel) {
          console.warn('[autodraft] require allow-label is enabled but AUTODRAFT_ALLOW_LABEL_NAME is empty; skipping user', { user: maskedEmail });
          continue;
        }
        const q = buildQuery(u.require_allow_label);
        total += await runAutoDraftForToken(token, q, limit, maskedEmail);
      } catch (e) {
        console.warn('[autodraft] user failed', { user: maskedEmail, error: (e as any)?.message || e });
      }
      if (i < enabledUsers.length - 1 && perUserSleepMs > 0) {
        await new Promise((r) => setTimeout(r, perUserSleepMs));
      }
    }
    return total;
  }

  const q = buildQuery(defaultRequireAllowLabel);
  return await runAutoDraftForToken(undefined, q, limit);
}

async function runAutoDraftForToken(
  accessToken: string | undefined,
  q: string,
  limit: number,
  maskedEmail?: string
): Promise<number> {
  const useGmailSignature = getEnvBool('AUTODRAFT_USE_GMAIL_SIGNATURE', true);
  const gmailSignature = useGmailSignature
    ? await getGmailPrimarySignatureText(accessToken)
    : undefined;

  // Fetch recent unread messages (metadata)
  const { items } = await listGmailMessages({ limit: 20, q, labelIds: ['INBOX'] }, accessToken);
  const byThread = new Map<string, { latestId: string; subject?: string; from?: string }>();
  for (const it of items) {
    if (!it.threadId || !it.id) continue;
    const prev = byThread.get(it.threadId);
    if (!prev) byThread.set(it.threadId, { latestId: it.id, subject: it.subject, from: it.from });
  }
  const threads = Array.from(byThread.entries()).slice(0, limit);
  let drafted = 0;

  for (const [threadId, meta] of threads) {
    try {
      const state = getAutodraftState(threadId);
      if (state && state.last_message_id === meta.latestId) continue; // already drafted for this head
      if (shouldSkipByHeuristics(meta.from, meta.subject)) continue;

      const thread = await getGmailThread(threadId, accessToken);
      const msgs = thread.messages;
      if (!Array.isArray(msgs) || msgs.length === 0) continue;
      const lastMsg = msgs[msgs.length - 1];
      const toAddr = extractEmail(lastMsg.from) || extractEmail(meta.from);
      const subject = ensureReplySubject(lastMsg.subject || meta.subject);
      if (!toAddr) {
        console.info('[autodraft] skip: no valid recipient email', {
          threadId,
          fromHeader: lastMsg.from,
          metaFrom: meta.from,
        });
        continue;
      }

      const ctx = buildConversationText({ messages: msgs });
      const displayName = extractDisplayName(lastMsg.from) || extractDisplayName(meta.from);
      const greeting = buildRecipientGreeting(displayName);
      const t0 = Date.now();
      const body = await generateDraftBody(ctx, greeting, gmailSignature);
      const draftPayload = { to: toAddr, subject, body, threadId, createdAt: Date.now() } as any;
      await createGmailDraftDirect(draftPayload, accessToken);
      drafted++;
      try { await markMessageProcessed(meta.latestId, accessToken, maskedEmail || accessToken); } catch (e) { console.warn('[autodraft] mark processed failed', e); }
      try { upsertAutodraftState(threadId, meta.latestId); } catch {}
      try {
        logAction({
          route: 'gmail_autodraft',
          trace_id: generateTraceId('draft'),
          user_id_hashed: hashUserId('autodraft'),
          params: { threadId, to: toAddr, subject, greeting, user: maskedEmail },
          count: 1,
          source: 'direct',
          responses_ms: Date.now() - t0,
          result_summary: '下書きを自動作成',
          shadow: false,
        });
      } catch {}
    } catch (e) {
      console.warn('[autodraft] failed for thread', { threadId, user: maskedEmail, error: (e as any)?.message || e });
    }
  }
  return drafted;
}

let timer: NodeJS.Timeout | null = null;
export function startAutoDraftWorker() {
  if (!getEnvBool('FEATURE_AUTODRAFT_ALL', false)) {
    console.log('[autodraft] disabled');
    return;
  }
  const everySec = Math.max(30, Number(process.env.AUTODRAFT_POLL_SECONDS || '120'));
  console.log(`[autodraft] enabled: every ${everySec}s, lookback=${process.env.AUTODRAFT_LOOKBACK || '1d'}, max/poll=${process.env.AUTODRAFT_MAX_PER_POLL || '5'}`);
  async function tick() {
    try {
      const n = await runAutoDraftOnce();
      console.info(`[autodraft] drafted=${n}`);
    } catch (e) {
      console.warn('[autodraft] tick failed', e);
    } finally {
      timer = setTimeout(tick, everySec * 1000);
    }
  }
  timer = setTimeout(tick, 5000);
}
