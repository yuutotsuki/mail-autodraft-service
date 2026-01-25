// ===== .env.personal / .env.company 切り替え対応エントリーポイント =====
// slack-bot.ts
// ------------------------------------------------------------
import dotenv from 'dotenv';

// ENV が "personal" なら .env.personal、指定が無ければ .env.company を読む（デフォルトをcompanyに変更）
const envPath = `.env.${process.env.ENV || 'company'}`;
dotenv.config({ path: envPath });
console.log(`✅ .env ファイル読み込み: ${envPath}`);

// 環境変数の読み込み確認
console.log(`🔧 現在の環境: ${process.env.ENV || 'company'}`);
console.log(`🤖 Bot Token: ${process.env.SLACK_BOT_TOKEN ? '設定済み' : '未設定'}`);
console.log(`🔐 Signing Secret: ${process.env.SLACK_SIGNING_SECRET ? '設定済み' : '未設定'}`);
console.log(`📱 App Token: ${process.env.SLACK_APP_TOKEN ? '設定済み' : '未設定'}`);

import { App, LogLevel } from '@slack/bolt';
import { handleSlackMessage } from './handlers/slackMessageHandler';
import { initDb, updateExecution, getExecutionByTraceId, findExpiredConfirmed, confirmIfPending, cancelIfPending, sweepExpiredEmailListCache } from './db/sqlite';
import { plannedMessageIdFromTrace } from './utils/ids';
import { SAFETY_ENFORCE } from './services/executionGate';
import { startAutoDraftWorker } from './services/autoDraftService';
import { logger } from './utils/logger';
import { createGmailDraftViaResponses, createGmailDraftDirect } from './services/gmailService';
import { fetchConnectToken } from './services/tokenService';
import { deleteDraft, DraftData, getDrafts } from './models/draftStore';
import util from 'util';
import { ExecutionRecord } from './types/execution';
import { logAction, hashUserId } from './utils/actionLogger';
import { logDryRun } from './services/mailDryRunService';
import { refreshToolsStatus, getCachedToolsStatus } from './services/toolsChecker';
import { FEATURE_PHASE3_ACTIONS, FEATURE_MAIL_ACTIONS_DRYRUN, MAX_SEND_PER_SWEEP, SEND_SWEEP_SECONDS, getAllowedSendDomains, resolveDryRunEnabled } from './config/mailActionsConfig';

function isTruthyEnv(value?: string): boolean {
  if (!value) return false;
  const trimmed = value.trim().toLowerCase();
  return trimmed === '1' || trimmed === 'true' || trimmed === 'yes' || trimmed === 'on';
}

// ログレベルの設定（環境変数で制御可能）
const logLevel = process.env.LOG_LEVEL === 'DEBUG' ? LogLevel.DEBUG : LogLevel.INFO;
console.log(`📝 ログレベル: ${process.env.LOG_LEVEL || 'INFO'}`);
console.log(`🛡️ Safety gate: ${SAFETY_ENFORCE ? 'ENFORCED' : 'DISABLED'}`);
const EXEC_TTL_MINUTES = Number(process.env.EXECUTION_TTL_MINUTES || '10');
const EXPIRY_SWEEP_SEC = Number(process.env.EXPIRY_SWEEP_SECONDS || '30');
console.log(`⏱️ Execution TTL: ${EXEC_TTL_MINUTES} min  Sweep: ${EXPIRY_SWEEP_SEC}s`);
const dryRunResolved = resolveDryRunEnabled();
console.log(`✉️ Phase3 Actions: ${FEATURE_PHASE3_ACTIONS ? 'ENABLED' : 'DISABLED'}  DryRun: ${dryRunResolved.enabled ? 'ON' : 'OFF'} (source=${dryRunResolved.source})`);
console.log(`✉️ Send Sweep: every ${SEND_SWEEP_SECONDS}s, max ${MAX_SEND_PER_SWEEP}  Allowed domains: ${getAllowedSendDomains().join(',')}`);

const app = new App({
  token: process.env.SLACK_BOT_TOKEN,
  signingSecret: process.env.SLACK_SIGNING_SECRET,
  socketMode: true,
  appToken: process.env.SLACK_APP_TOKEN,
  developerMode: false, // 明示的に追加
  logLevel: logLevel,
});

// WebSocket接続状態の監視ログを追加（app.receiver.clientを利用）
const socketModeClient = (app as any).receiver?.client;
if (socketModeClient) {
  socketModeClient.on("disconnect", (error: any) => {
    console.warn("🛑 WebSocket disconnected:", error?.reason || error);
  });

  socketModeClient.on("connecting", () => {
    console.log("🔄 WebSocket reconnecting...");
  });

  socketModeClient.on("connected", () => {
    console.log("✅ WebSocket reconnected!");
  });

  socketModeClient.on("error", (err: any) => {
    console.error("🚨 WebSocket error:", err);
  });

  setInterval(() => {
    const connected = socketModeClient.connected ?? false;
    console.log("📶 WS isConnected:", connected);
  }, 5 * 60 * 1000);
}

app.message(async ({ message, say, client }) => {
  await handleSlackMessage(message, say, client);
});

// 初期化: SQLite
initDb();

// 期限監視: TTL超過で自動キャンセル短報
function startExpiryWatcher() {
  setInterval(async () => {
    try {
      const now = Date.now();
      const expired = findExpiredConfirmed(now);
      for (const rec of expired) {
        // 二重キャンセル防止: 更新してから通知
        const updated = updateExecution(rec.trace_id, { status: 'canceled', reason: '期限超過' });
        if (!updated) continue;
        if (rec.channel && rec.message_ts) {
          try {
            await app.client.chat.postMessage({
              channel: rec.channel,
              thread_ts: rec.message_ts,
              text: `⏳ 期限超過により自動キャンセル trace_id=\`${rec.trace_id}\``,
            });
          } catch (e) {
            console.warn('[expiry-short-report] postMessage failed', e);
          }
        }
      }
    } catch (e) {
      console.warn('[expiry-watcher] sweep failed', e);
    }
  }, Math.max(5, EXPIRY_SWEEP_SEC) * 1000);
}
startExpiryWatcher();

// Cache sweeper for email_list_cache (expired entries cleanup)
function startCacheSweeper() {
  // Defaults: dev vs prod, overridable by ENV
  const isProd = (process.env.NODE_ENV === 'production');
  const baseSweepSec = Number(process.env.CACHE_SWEEP_SECONDS || (isProd ? '120' : '30'));
  const graceSec = Number(process.env.CACHE_SWEEP_GRACE_SECONDS || (isProd ? '300' : '60'));
  const jitterSec = Number(process.env.CACHE_SWEEP_JITTER_SECONDS || '15');
  const maxDelete = Number(process.env.MAX_DELETE_PER_SWEEP || '1000');

  const scheduleNext = () => {
    const jitter = Math.floor((Math.random() * 2 - 1) * jitterSec); // [-jitterSec, +jitterSec]
    const delayMs = Math.max(5, baseSweepSec + jitter) * 1000;
    setTimeout(runOnce, delayMs);
  };

  const runOnce = () => {
    try {
      const nowSec = Math.floor(Date.now() / 1000);
      const res = sweepExpiredEmailListCache(nowSec, graceSec, maxDelete);
      logger.debug(`[cache.sweep] table=email_list_cache expired=${res.expired} deleted=${res.deleted} grace=${graceSec}s max=${maxDelete}`);
    } catch (e) {
      logger.warn('[cache.sweep] failed', e);
    } finally {
      scheduleNext();
    }
  };

  logger.info(`🧹 Cache Sweeper: every ~${baseSweepSec}s (±${jitterSec}s) grace=${graceSec}s`);
  scheduleNext();
}
startCacheSweeper();

// Auto-draft worker (creates Gmail drafts without user interaction; guarded by feature flag)
startAutoDraftWorker();

function buildDraftFromExecution(rec: ExecutionRecord): DraftData {
  return {
    body: rec.params?.body || '',
    subject: rec.params?.subject,
    to: rec.params?.to,
    threadId: rec.params?.threadId,
    createdAt: Date.now(),
    draftId: rec.params?.draftId,
  };
}

async function safePostThreadMessage(client: any, channel: string | undefined, messageTs: string | undefined, text: string) {
  if (!channel || !messageTs) return;
  try {
    await client.chat.postMessage({ channel, thread_ts: messageTs, text });
  } catch (err) {
    console.warn('[safety.confirm] postMessage failed', err);
  }
}

async function executeGmailDraftAction(rec: ExecutionRecord, client: any, channel?: string, messageTs?: string) {
  const draft = buildDraftFromExecution(rec);
  const started = Date.now();
  try {
    const token = await fetchConnectToken();
    const forcedTool = (process.env.GMAIL_DRAFT_TOOL_NAME || 'gmail-create-draft').trim();
    let via: 'responses' | 'direct' = 'responses';
    let toolName: string | undefined;
    try {
      const result = await createGmailDraftViaResponses(token, draft, { forcedToolName: forcedTool });
      toolName = result.toolName;
    } catch (err: any) {
      if (err?.message !== 'responses_no_tool_execution') throw err;
      if (isTruthyEnv(process.env.AUTODRAFT_FORCE_RESPONSES_ONLY)) throw err;
      via = 'direct';
      await createGmailDraftDirect(draft);
    }

    updateExecution(rec.trace_id, { status: 'executed', reason: undefined });
    if (draft.draftId) {
      deleteDraft(rec.user_id, draft.draftId);
    }
    const subjectLabel = draft.subject || '(件名未設定)';
    const toolLabel = via === 'responses' ? (toolName ? ` /tool=${toolName}` : ' /responses') : ' /direct';
    await safePostThreadMessage(client, channel, messageTs, `✅ Gmail下書きを保存しました（件名: ${subjectLabel}${toolLabel}） trace_id=\`${rec.trace_id}\``);
    try {
      logAction({
        route: 'gmail_draft_manual',
        trace_id: rec.trace_id,
        user_id_hashed: hashUserId(rec.user_id),
        params: { to: draft.to, subject: draft.subject, tool: via === 'responses' ? (toolName || 'responses') : 'direct_api' },
        result_summary: `保存完了 via ${via === 'responses' ? (toolName || 'responses') : 'direct'}`,
        source: via === 'responses' ? 'responses' : 'direct',
        responses_ms: Date.now() - started,
      });
    } catch (logErr) {
      console.warn('[gmail_draft_exec] logAction failed', logErr);
    }
  } catch (err: any) {
    const messageRaw = err?.message || err?.response?.data?.error || err?.code || err;
    const message = typeof messageRaw === 'string' ? messageRaw : JSON.stringify(messageRaw);
    logger.error('❌ [gmail_draft_exec] failed', redactSensitive(util.inspect(err, { depth: 2 })));
    const listedTools = Array.isArray(err?.listedTools) ? err.listedTools : undefined;
    const extra = listedTools && listedTools.length ? `\n候補ツール: ${listedTools.join(', ')}` : '';
    updateExecution(rec.trace_id, { status: 'canceled', reason: message });
    await safePostThreadMessage(client, channel, messageTs, `⚠️ Gmail下書き保存に失敗しました trace_id=\`${rec.trace_id}\`\n${message}${extra}`);
    try {
      logAction({
        route: 'gmail_draft_manual',
        trace_id: rec.trace_id,
        user_id_hashed: hashUserId(rec.user_id),
        params: { to: draft.to, subject: draft.subject, listed_tools: listedTools },
        result_summary: '保存失敗',
        error: message,
        source: 'responses',
      });
    } catch (logErr) {
      console.warn('[gmail_draft_exec] logAction(error) failed', logErr);
    }
  }
}

function redactSensitive(str: string): string {
  return str
    .replace(/Bearer [\w\-\.]+/g, 'Bearer ***')
    .replace(/token["']?: ?["']?[\w\-\.]+["']?/gi, 'token: "***"');
}

// Startup MCP tools self-check (non-blocking)
(async () => {
  try {
    const status = await refreshToolsStatus();
    console.log(`🔍 MCP tools: Gmail=${status.gmailTools.join(', ') || '(none)'} Calendar=${status.calendarTools.join(', ') || '(none)'}`);
    if (!status.gmailHasReadOnly) {
      console.warn('⚠️ Gmail MCP read-only検索ツールが見当たりません（find/list/messagesなど）。一覧/本文取得が制限される可能性');
    }
  } catch (e) {
    console.warn('[startup] tools self-check failed', e);
  }
})();

// 安全確認: OK
app.action('safety_confirm', async ({ ack, body, client }) => {
  await ack();
  try {
    const action = (body as any).actions?.[0];
    const payload = action?.value ? JSON.parse(action.value) : {};
    const traceId = payload.trace_id as string;
    const channel = (body as any).channel?.id as string | undefined;
    const messageTs = (body as any).container?.message_ts as string | undefined;

    const rec = getExecutionByTraceId(traceId);
    if (!rec) {
      if (channel && messageTs) {
        await client.chat.postMessage({ channel, thread_ts: messageTs, text: `⚠️ trace_id=\`${traceId}\` は見つかりませんでした。` });
      }
      return;
    }

    // digest生成（to/subject/body先頭50）
    const to = (rec.params?.to || '').toString();
    const subject = (rec.params?.subject || '').toString();
    const bodyHead = (rec.params?.body || '').toString().slice(0, 50);
    const digest = `to=${to}; subject=${subject}; body_head=${bodyHead}`;
    const expiresAt = Date.now() + EXEC_TTL_MINUTES * 60 * 1000;

    const confirmed = confirmIfPending(traceId, { channel, message_ts: messageTs, digest, expires_at: expiresAt });
    if (confirmed) {
      if (confirmed.type === 'gmail_draft') {
        await executeGmailDraftAction(confirmed, client, channel, messageTs);
      } else {
        const plannedId = plannedMessageIdFromTrace(traceId);
        await safePostThreadMessage(client, channel, messageTs, `✅ ${confirmed.action} 準備OK (messageId予定=${plannedId}) trace_id=\`${traceId}\``);
      }
    } else {
      const latest = getExecutionByTraceId(traceId);
      await safePostThreadMessage(client, channel, messageTs, `♻️ 再利用: 既に処理済みです（status=${latest?.status}） trace_id=\`${traceId}\``);
    }
  } catch (err) {
    console.error('[safety_confirm] error', err);
  }
});

// 安全確認: キャンセル
app.action('safety_cancel', async ({ ack, body, client }) => {
  await ack();
  try {
    const action = (body as any).actions?.[0];
    const payload = action?.value ? JSON.parse(action.value) : {};
    const traceId = payload.trace_id as string;
    const reason = payload.reason as string || 'ユーザー操作';
    const channel = (body as any).channel?.id as string | undefined;
    const messageTs = (body as any).container?.message_ts as string | undefined;

    const rec = getExecutionByTraceId(traceId);
    if (!rec) {
      if (channel && messageTs) {
        await client.chat.postMessage({ channel, thread_ts: messageTs, text: `⚠️ trace_id=\`${traceId}\` は見つかりませんでした。` });
      }
      return;
    }

    const canceled = cancelIfPending(traceId, { reason, channel, message_ts: messageTs });
    if (canceled) {
      if (channel && messageTs) {
        await client.chat.postMessage({
          channel,
          thread_ts: messageTs,
          text: `🚫 実行キャンセル（${reason}） trace_id=\`${traceId}\``,
        });
      }
    } else {
      const latest = getExecutionByTraceId(traceId);
      if (channel && messageTs) {
        await client.chat.postMessage({ channel, thread_ts: messageTs, text: `♻️ 再利用: 既に処理済みです（status=${latest?.status}） trace_id=\`${traceId}\`` });
      }
    }
  } catch (err) {
    console.error('[safety_cancel] error', err);
  }
});

// Phase3: Mail dry-run OK
// Throttling window state (in-memory)
let dryRunWindowStart = 0;
let dryRunCount = 0;

function normalizeEmail(addr?: string): string | null {
  if (!addr) return null;
  const m = addr.trim().match(/<([^>]+)>/); // Support "Name <email@domain>"
  const raw = (m ? m[1] : addr).trim().toLowerCase();
  // Very loose email check
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(raw)) return null;
  return raw;
}

async function getSlackUserEmail(client: any, userId: string): Promise<string | null> {
  try {
    const info = await client.users.info({ user: userId });
    const email = (info as any)?.user?.profile?.email as string | undefined;
    return email ? email.toLowerCase() : null;
  } catch {
    // Fallback to env var if provided
    const fallback = (process.env.SELF_USER_EMAIL || '').trim().toLowerCase();
    return fallback || null;
  }
}

function isRecipientAllowed(toAddr: string, allowed: string[], selfEmail: string | null): { ok: boolean; reason?: string } {
  const parsed = normalizeEmail(toAddr);
  if (!parsed) return { ok: false, reason: '宛先メールアドレスの形式が不正です。' };
  // If special token 'self' present, only allow exact self
  if (allowed.includes('self')) {
    if (!selfEmail) return { ok: false, reason: '自己メールアドレスが未取得のため許可できません。' };
    return parsed === selfEmail ? { ok: true } : { ok: false, reason: '現在は「自分宛て」のみ許可されています。' };
  }
  // Otherwise, allow domains in list
  const domain = parsed.split('@')[1] || '';
  if (!domain) return { ok: false, reason: '宛先ドメインが判定できません。' };
  const ok = allowed.some((d) => d && domain.toLowerCase() === d.toLowerCase());
  return ok ? { ok: true } : { ok: false, reason: `許可されていないドメインです: ${domain}` };
}

app.action('mail_dryrun_ok', async ({ ack, body, client }) => {
  await ack();
  try {
    const action = (body as any).actions?.[0];
    const payload = action?.value ? JSON.parse(action.value) : {};
    const draftId = payload.draft_id as string | undefined;
    const channel = (body as any).channel?.id as string | undefined;
    const user = (body as any).user?.id as string | undefined;
    if (!channel || !user) return;

    // Throttling window
    const now = Date.now();
    if (now - dryRunWindowStart > Math.max(1, SEND_SWEEP_SECONDS) * 1000) {
      dryRunWindowStart = now;
      dryRunCount = 0;
    }
    if (dryRunCount >= Math.max(1, MAX_SEND_PER_SWEEP)) {
      await client.chat.postEphemeral({ channel, user, text: `⏳ レート制限: ${SEND_SWEEP_SECONDS}sあたり最大${MAX_SEND_PER_SWEEP}件までです。少し待ってから再試行してください。` });
      return;
    }

    const userDrafts = draftId ? getDrafts(user) : undefined;
    const draft = draftId ? userDrafts?.[draftId] : undefined;
    if (!draft) {
      await client.chat.postEphemeral({ channel, user, text: '⚠️ ドラフトが見つかりませんでした。' });
      return;
    }

    // Recipient restriction
    const allowed = getAllowedSendDomains();
    const selfEmail = await getSlackUserEmail(client, user);
    const to = (draft.to || '').toString();
    if (!to) {
      await client.chat.postEphemeral({ channel, user, text: '⚠️ 宛先(To)が未設定です。' });
      return;
    }
    const chk = isRecipientAllowed(to, allowed, selfEmail);
    if (!chk.ok) {
      await client.chat.postEphemeral({ channel, user, text: `🚫 送信先が許可されていません: ${chk.reason || ''}` });
      return;
    }

    // Passed checks → count and log
    dryRunCount += 1;
    logDryRun(draft);
    const subj = draft.subject || '';
    const bytes = Buffer.byteLength(draft.body || '', 'utf8');
    await client.chat.postEphemeral({ channel, user, text: `Dry-run完了: subj="${subj}" (bytes=${bytes})` });
  } catch (e) {
    console.error('[mail_dryrun_ok] error', e);
  }
});

// Phase3: Mail dry-run Cancel
app.action('mail_dryrun_cancel', async ({ ack, body, client }) => {
  await ack();
  try {
    const channel = (body as any).channel?.id as string | undefined;
    const user = (body as any).user?.id as string | undefined;
    if (!channel || !user) return;
    await client.chat.postEphemeral({ channel, user, text: 'キャンセルしました' });
  } catch (e) {
    console.error('[mail_dryrun_cancel] error', e);
  }
});

const requiredEnvVars = [
  'SLACK_BOT_TOKEN',
  'SLACK_SIGNING_SECRET',
  'SLACK_APP_TOKEN',
];
const missingVars = requiredEnvVars.filter((key) => !process.env[key]);
if (missingVars.length > 0) {
  console.error(`❌ 必須の環境変数が設定されていません: ${missingVars.join(', ')}`);
  process.exit(1);
}

(async () => {
  try {
    await app.start(3000);
    console.log('⚡️ Slack Gmail Assistant is running on port 3000');
  } catch (error) {
    console.error('❌ アプリの起動中にエラーが発生しました:', error);
    process.exit(1);
  }
})();
