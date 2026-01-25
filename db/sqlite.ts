import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';
import { ExecutionRecord, ExecutionStatus } from '../types/execution';
import { EmailListCacheRecord } from '../types/cache';

// Minimal, stable typings to avoid relying on external @types
type RunResult = { changes: number };
type Prepared = { run: (params?: any) => RunResult; get: (...args: any[]) => any; all: (...args: any[]) => any[] };
type BetterSqlite3Like = { exec: (sql: string) => void; prepare: (sql: string) => Prepared };

let db: BetterSqlite3Like;

export function initDb(projectRoot?: string) {
  const base = projectRoot || path.resolve(__dirname, '..');
  const dataDir = path.resolve(base, 'data');
  if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir);

  const dbPath = path.resolve(dataDir, 'bot.db');
  // Cast to our minimal interface to keep typing stable without @types
  db = new (Database as unknown as { new (path: string): BetterSqlite3Like })(dbPath);

  db.exec(`
    CREATE TABLE IF NOT EXISTS executions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      trace_id TEXT NOT NULL UNIQUE,
      type TEXT NOT NULL,
      user_id TEXT NOT NULL,
      action TEXT NOT NULL,
      params TEXT NOT NULL,
      digest TEXT,
      expires_at INTEGER,
      status TEXT NOT NULL,
      reason TEXT,
      channel TEXT,
      message_ts TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_executions_trace_id ON executions(trace_id);
    CREATE INDEX IF NOT EXISTS idx_executions_status ON executions(status);
  `);

  // Migrate existing DBs: add columns if missing
  try {
    const info = db.prepare(`PRAGMA table_info(executions)`).all() as any[];
    const cols = new Set((info || []).map((r: any) => r.name));
    if (!cols.has('digest')) {
      db.exec(`ALTER TABLE executions ADD COLUMN digest TEXT`);
    }
    if (!cols.has('expires_at')) {
      db.exec(`ALTER TABLE executions ADD COLUMN expires_at INTEGER`);
    }
  } catch (e) {
    // fail-closedではなくログだけに留める（初期化は継続）
    console.warn('[db] migration check failed:', e);
  }

  // email_list_cache テーブルの作成（最小実装）
  db.exec(`
    CREATE TABLE IF NOT EXISTS email_list_cache (
      cache_key TEXT PRIMARY KEY,
      created_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL,
      items_json TEXT NOT NULL,
      channel TEXT,
      thread_ts TEXT
    );
  `);
  // Index to accelerate expiry sweeps
  db.exec(`CREATE INDEX IF NOT EXISTS idx_email_list_cache_exp ON email_list_cache(expires_at);`);
  console.info('[cache] email_list_cache ready');

  // Autodraft processed table
  db.exec(`
    CREATE TABLE IF NOT EXISTS autodraft_processed (
      thread_id TEXT PRIMARY KEY,
      last_message_id TEXT,
      drafted_at INTEGER NOT NULL
    );
  `);
}

export function createExecution(rec: Omit<ExecutionRecord, 'created_at' | 'updated_at'>): ExecutionRecord {
  const now = Date.now();
  const insert = db.prepare(`
    INSERT INTO executions (trace_id, type, user_id, action, params, digest, expires_at, status, reason, channel, message_ts, created_at, updated_at)
    VALUES (@trace_id, @type, @user_id, @action, @params, @digest, @expires_at, @status, @reason, @channel, @message_ts, @created_at, @updated_at)
  `);
  const params = JSON.stringify(rec.params || {});
  insert.run({
    trace_id: rec.trace_id,
    type: rec.type,
    user_id: rec.user_id,
    action: rec.action,
    params,
    digest: (rec as any).digest ?? null,
    expires_at: (rec as any).expires_at ?? null,
    status: rec.status,
    reason: rec.reason || null,
    channel: rec.channel || null,
    message_ts: rec.message_ts || null,
    created_at: now,
    updated_at: now,
  });
  return { ...rec, params: rec.params, created_at: now, updated_at: now } as ExecutionRecord;
}

export function getExecutionByTraceId(traceId: string): ExecutionRecord | undefined {
  const row = db.prepare('SELECT * FROM executions WHERE trace_id = ?').get(traceId) as any;
  if (!row) return undefined;
  return {
    trace_id: row.trace_id,
    type: row.type,
    user_id: row.user_id,
    action: row.action,
    params: JSON.parse(row.params || '{}'),
    digest: row.digest || undefined,
    expires_at: row.expires_at || undefined,
    status: row.status as ExecutionStatus,
    reason: row.reason || undefined,
    channel: row.channel || undefined,
    message_ts: row.message_ts || undefined,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

// 柔軟な更新（status/理由/チャンネル/期限/ダイジェストなど）
export function updateExecution(traceId: string, patch: Partial<Pick<ExecutionRecord,
  'status' | 'reason' | 'channel' | 'message_ts' | 'expires_at' | 'digest'
>>): ExecutionRecord | undefined {
  const now = Date.now();
  const upd = db.prepare(`
    UPDATE executions
       SET status = COALESCE(@status, status),
           reason = COALESCE(@reason, reason),
           channel = COALESCE(@channel, channel),
           message_ts = COALESCE(@message_ts, message_ts),
           expires_at = COALESCE(@expires_at, expires_at),
           digest = COALESCE(@digest, digest),
           updated_at = @updated_at
     WHERE trace_id = @trace_id
  `);
  const info = upd.run({
    trace_id: traceId,
    status: (patch as any).status ?? null,
    reason: (patch as any).reason ?? null,
    channel: (patch as any).channel ?? null,
    message_ts: (patch as any).message_ts ?? null,
    expires_at: (patch as any).expires_at ?? null,
    digest: (patch as any).digest ?? null,
    updated_at: now,
  });
  if (info.changes === 0) return undefined;
  return getExecutionByTraceId(traceId);
}

export function findExpiredConfirmed(nowMillis: number): ExecutionRecord[] {
  const rows = db.prepare(
    `SELECT * FROM executions WHERE status = 'confirmed' AND expires_at IS NOT NULL AND expires_at <= ?`
  ).all(nowMillis) as any[];
  return rows.map((row) => ({
    trace_id: row.trace_id,
    type: row.type,
    user_id: row.user_id,
    action: row.action,
    params: JSON.parse(row.params || '{}'),
    digest: row.digest || undefined,
    expires_at: row.expires_at || undefined,
    status: row.status as ExecutionStatus,
    reason: row.reason || undefined,
    channel: row.channel || undefined,
    message_ts: row.message_ts || undefined,
    created_at: row.created_at,
    updated_at: row.updated_at,
  }));
}

// CAS: pending -> confirmed（同時押下対策）
export function confirmIfPending(traceId: string, patch: Partial<Pick<ExecutionRecord,
  'channel' | 'message_ts' | 'expires_at' | 'digest'
>>): ExecutionRecord | undefined {
  const now = Date.now();
  const upd = db.prepare(`
    UPDATE executions
       SET status = 'confirmed',
           channel = COALESCE(@channel, channel),
           message_ts = COALESCE(@message_ts, message_ts),
           expires_at = COALESCE(@expires_at, expires_at),
           digest = COALESCE(@digest, digest),
           updated_at = @updated_at
     WHERE trace_id = @trace_id AND status = 'pending'
  `);
  const info = upd.run({
    trace_id: traceId,
    channel: (patch as any).channel ?? null,
    message_ts: (patch as any).message_ts ?? null,
    expires_at: (patch as any).expires_at ?? null,
    digest: (patch as any).digest ?? null,
    updated_at: now,
  });
  if (info.changes === 0) return undefined;
  return getExecutionByTraceId(traceId);
}

// CAS: pending -> canceled（同時押下対策）
export function cancelIfPending(traceId: string, patch: Partial<Pick<ExecutionRecord,
  'reason' | 'channel' | 'message_ts'
>>): ExecutionRecord | undefined {
  const now = Date.now();
  const upd = db.prepare(`
    UPDATE executions
       SET status = 'canceled',
           reason = COALESCE(@reason, reason),
           channel = COALESCE(@channel, channel),
           message_ts = COALESCE(@message_ts, message_ts),
           updated_at = @updated_at
     WHERE trace_id = @trace_id AND status = 'pending'
  `);
  const info = upd.run({
    trace_id: traceId,
    reason: (patch as any).reason ?? null,
    channel: (patch as any).channel ?? null,
    message_ts: (patch as any).message_ts ?? null,
    updated_at: now,
  });
  if (info.changes === 0) return undefined;
  return getExecutionByTraceId(traceId);
}

// ===============
// Email List Cache DAO (最小実装／Promise署名だが同期実行)
// 時刻はUTCエポック秒で管理する
// ===============

export async function upsertEmailListCache(
  cacheKey: string,
  itemsJson: string,
  expiresAtSec: number,
  meta?: { channel?: string; thread_ts?: string; createdAt?: number }
): Promise<void> {
  // If DB is not initialized (e.g., smoke runs without native module), act as a no-op.
  if (!db) return;
  const createdAt = (meta?.createdAt ?? Math.floor(Date.now() / 1000));
  const stmt = db.prepare(`
    INSERT INTO email_list_cache (cache_key, created_at, expires_at, items_json, channel, thread_ts)
    VALUES (@cache_key, @created_at, @expires_at, @items_json, @channel, @thread_ts)
    ON CONFLICT(cache_key) DO UPDATE SET
      expires_at = excluded.expires_at,
      items_json = excluded.items_json,
      channel = COALESCE(excluded.channel, email_list_cache.channel),
      thread_ts = COALESCE(excluded.thread_ts, email_list_cache.thread_ts)
  `);
  stmt.run({
    cache_key: cacheKey,
    created_at: createdAt,
    expires_at: expiresAtSec,
    items_json: itemsJson,
    channel: meta?.channel ?? null,
    thread_ts: meta?.thread_ts ?? null,
  });
}

export async function getEmailListCache(cacheKey: string): Promise<null | EmailListCacheRecord> {
  if (!db) return null;
  const row = db.prepare(`SELECT cache_key, created_at, expires_at, items_json, channel, thread_ts FROM email_list_cache WHERE cache_key = ?`).get(cacheKey) as any;
  if (!row) return null;
  return {
    cache_key: row.cache_key,
    created_at: row.created_at,
    expires_at: row.expires_at,
    items_json: row.items_json,
    channel: row.channel || undefined,
    thread_ts: row.thread_ts || undefined,
  };
}

export async function getLatestEmailListCacheByScope(channel: string, thread_ts?: string): Promise<null | EmailListCacheRecord> {
  if (!db) return null;
  if (thread_ts) {
    const rowExact = db.prepare(
      `SELECT cache_key, created_at, expires_at, items_json, channel, thread_ts
         FROM email_list_cache
        WHERE channel = ? AND thread_ts = ?
        ORDER BY created_at DESC LIMIT 1`
    ).get(channel, thread_ts) as any;
    if (rowExact) {
      return {
        cache_key: rowExact.cache_key,
        created_at: rowExact.created_at,
        expires_at: rowExact.expires_at,
        items_json: rowExact.items_json,
        channel: rowExact.channel || undefined,
        thread_ts: rowExact.thread_ts || undefined,
      };
    }
  }
  const row = db.prepare(
    `SELECT cache_key, created_at, expires_at, items_json, channel, thread_ts
       FROM email_list_cache
      WHERE channel = ?
      ORDER BY created_at DESC LIMIT 1`
  ).get(channel) as any;
  if (!row) return null;
  return {
    cache_key: row.cache_key,
    created_at: row.created_at,
    expires_at: row.expires_at,
    items_json: row.items_json,
    channel: row.channel || undefined,
    thread_ts: row.thread_ts || undefined,
  };
}

// ===== Cache Sweeper helpers =====
export function countExpiredEmailList(beforeSec: number): number {
  const row = db.prepare(`SELECT COUNT(1) as c FROM email_list_cache WHERE expires_at < ?`).get(beforeSec) as any;
  return Number(row?.c || 0);
}

export function deleteExpiredEmailList(beforeSec: number, maxDelete: number): number {
  // Use rowid window to cap deletions safely across SQLite versions
  const info = db.prepare(
    `DELETE FROM email_list_cache 
      WHERE rowid IN (
        SELECT rowid FROM email_list_cache WHERE expires_at < ? LIMIT ?
      )`
  ).run([beforeSec, Math.max(1, maxDelete)]) as RunResult;
  return Number(info?.changes || 0);
}

export function sweepExpiredEmailListCache(nowSec: number, graceSec = 0, maxDelete = 1000): { expired: number; deleted: number } {
  const threshold = nowSec - Math.max(0, graceSec);
  const expired = countExpiredEmailList(threshold);
  const deleted = expired > 0 ? deleteExpiredEmailList(threshold, maxDelete) : 0;
  return { expired, deleted };
}

// ===== Autodraft helpers =====
export function getAutodraftState(threadId: string): { thread_id: string; last_message_id?: string; drafted_at: number } | null {
  try {
    const row = db.prepare(`SELECT thread_id, last_message_id, drafted_at FROM autodraft_processed WHERE thread_id = ?`).get(threadId) as any;
    if (!row) return null;
    return { thread_id: row.thread_id, last_message_id: row.last_message_id || undefined, drafted_at: Number(row.drafted_at || 0) };
  } catch {
    return null;
  }
}

export function upsertAutodraftState(threadId: string, lastMessageId: string): void {
  const now = Math.floor(Date.now() / 1000);
  const stmt = db.prepare(`
    INSERT INTO autodraft_processed (thread_id, last_message_id, drafted_at)
    VALUES (@thread_id, @last_message_id, @drafted_at)
    ON CONFLICT(thread_id) DO UPDATE SET last_message_id = excluded.last_message_id, drafted_at = excluded.drafted_at
  `);
  stmt.run({ thread_id: threadId, last_message_id: lastMessageId, drafted_at: now });
}
