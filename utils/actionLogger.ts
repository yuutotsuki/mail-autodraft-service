import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { getConfigVersions } from './configVersion';
import { generateTraceId } from './ids';
import { maskEmailAndPhone } from './pii';

export type ScoreBreakdown = { rule_id: string; weight: number };

export type ActionLog = {
  ts_iso: string;
  route: string;
  trace_id?: string;
  session_id?: string | null;
  user_id?: string;
  user_id_hashed?: string;
  raw_text?: string;
  raw_text_masked?: string;
  normalized_text?: string;
  matched_trigger?: string | null;
  match_type?: string | null;
  confidence?: number | null;
  params?: any;
  count?: number;
  source?: 'responses' | 'direct' | 'cache' | 'direct_gmail';
  responses_ms?: number;
  responses_ms_round1?: number;
  responses_ms_round2?: number;
  api_ms?: number;
  cache_hit?: boolean;
  limit?: number;
  suggested_action?: string | null;
  result_summary?: string | null;
  shadow?: boolean;
  error?: string | null;
  schema_version?: 'v1';
  config?: { compose_version?: string; normalize_version?: string };
  rule_ids?: string[];
  score_breakdown?: ScoreBreakdown[];
};

function ensureLogsDir(baseDir: string) {
  if (!fs.existsSync(baseDir)) fs.mkdirSync(baseDir, { recursive: true });
}

function hmacSha256Hex(salt: string, data: string): string {
  return crypto.createHmac('sha256', salt).update(data).digest('hex');
}

export function hashUserId(userId?: string): string | undefined {
  if (!userId) return undefined;
  const salt = process.env.HASH_SALT;
  try {
    if (salt && userId) return hmacSha256Hex(salt, userId);
  } catch {}
  return undefined;
}

function dailyFileName(): string {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `actions-${y}${m}${day}.jsonl`;
}

export function logAction(partial: Partial<ActionLog> & { route: string }): string {
  const base = path.resolve(__dirname, '..');
  const logsDir = path.resolve(base, 'logs');
  ensureLogsDir(logsDir);
  const file = path.resolve(logsDir, dailyFileName());
  const ts_iso = new Date().toISOString();
  const cfg = getConfigVersions(base);
  const user_id_hashed = partial.user_id_hashed ?? hashUserId(partial.user_id);
  const raw_text_masked = partial.raw_text_masked ?? maskEmailAndPhone(partial.raw_text);
  const normalized_text_masked = partial.normalized_text === undefined
    ? undefined
    : maskEmailAndPhone(partial.normalized_text);
  const record: ActionLog = {
    ts_iso,
    route: partial.route,
    trace_id: partial.trace_id || generateTraceId('log'),
    session_id: partial.session_id ?? null,
    user_id_hashed,
    raw_text_masked,
    normalized_text: normalized_text_masked,
    matched_trigger: partial.matched_trigger ?? null,
    match_type: partial.match_type ?? null,
    confidence: partial.confidence ?? null,
    params: partial.params,
    count: partial.count,
    source: partial.source,
    responses_ms: partial.responses_ms,
    responses_ms_round1: partial.responses_ms_round1,
    responses_ms_round2: partial.responses_ms_round2,
    api_ms: partial.api_ms,
    cache_hit: partial.cache_hit,
    limit: partial.limit,
    suggested_action: partial.suggested_action ?? null,
    result_summary: partial.result_summary ?? null,
    shadow: partial.shadow ?? false,
    error: partial.error ?? null,
    schema_version: 'v1',
    config: { compose_version: cfg.compose, normalize_version: cfg.normalize },
    rule_ids: partial.rule_ids || [],
    score_breakdown: partial.score_breakdown || [],
  };
  try {
    fs.appendFileSync(file, JSON.stringify(record) + '\n', 'utf8');
  } catch (e) {
    // fallback: best-effort console log
    console.warn('[actionLog] append failed', e);
    console.info('[actionLog] record', record);
  }
  return record.trace_id || '';
}
