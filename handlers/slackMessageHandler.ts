import { initializeEnvironment } from '../config/environment';
import { SayFn } from '@slack/bolt';
import { WebClient } from '@slack/web-api';
import OpenAI from 'openai';
import {
  getHistory,
  setHistory,
  appendToHistory,
  clearHistory,
} from '../conversationStore';
import { getMcpTool } from '../getMcpTool';
import { buildSystemPrompt } from '../promptBuilder';

import util from 'util';
import { logger } from '../utils/logger';
import { fetchConnectToken, clearTokenCache } from '../services/tokenService';
import {
  generateDraftId,
  saveDraft,
  getDrafts,
  deleteDraft,

} from '../models/draftStore';
import { EmailDetectionService } from '../services/emailDetectionService';
import { NumberedReplyHandler } from './numberedReplyHandler';
import { routePhase1Intent } from '../services/intentRouter';
import { runPhase2List } from '../services/listEmailsService';
import { MemOSService } from '../services/memosService';
import { generateTraceId } from '../utils/ids';

import { 
  MEMOS_SEARCH_PATTERN, 
  DRAFT_ID_PATTERN, 
  BODY_PATTERN, 
  SUBJECT_PATTERN, 
  TO_PATTERN, 
  THREAD_ID_PATTERN 
} from '../utils/regexPatterns';
import { DraftData } from '../types/email';
import axios from 'axios';
import { promptUserConfirmation } from '../services/safetyService';
import { createGmailDraftViaResponses, createGmailDraftDirect } from '../services/gmailService';
import { resolveDryRunEnabled } from '../config/mailActionsConfig';
import { promptMailDryRun } from '../services/mailDryRunService';
import { getLatestEmailListCacheByScope } from '../db/sqlite';
import { refreshToolsStatus, getCachedToolsStatus } from '../services/toolsChecker';
import { detectComposeOrReply } from '../services/composeDetectionService';
import { logAction, hashUserId } from '../utils/actionLogger';

function isTruthyEnv(value?: string): boolean {
  if (!value) return false;
  const trimmed = value.trim().toLowerCase();
  return trimmed === '1' || trimmed === 'true' || trimmed === 'yes' || trimmed === 'on';
}

// 環境変数初期化（最初に実行）
initializeEnvironment();

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

export async function handleSlackMessage(message: any, say: SayFn, client?: WebClient) {
  logger.debug('Step 1: Slackからメッセージを受信しました', message);
  const userId = message.user;
  if (!userId || message.subtype === 'bot_message') return;

  // Autodraft専用モード: Slack経由の他機能を強制停止
  if (isTruthyEnv(process.env.FEATURE_AUTODRAFT_ONLY_MODE)) {
    await say('✋ 自動下書き専用モードです。他の機能はOFFにしています。');
    return;
  }

  // メッセージテキストの前処理
  let processedText = preprocessMessage(message.text);

  // 先にcompose/replyのローカル判定を走らせて、ルール内訳をログへ（挙動は変えない）
  try {
    const det = detectComposeOrReply(processedText, { in_thread: Boolean((message as any).thread_ts) });
    const rule_ids = det.rule_hits.map((h) => h.rule_id);
    const score_breakdown = det.rule_hits.map((h) => ({ rule_id: h.rule_id, weight: h.weight }));
    const summary = `compose=${det.compose_score.toFixed(2)} reply=${det.reply_score.toFixed(2)} -> ${det.label}`;
    logAction({
      route: 'compose_detect',
      user_id_hashed: hashUserId(userId),
      normalized_text: processedText,
      matched_trigger: det.label,
      match_type: 'compose_router',
      result_summary: summary,
      shadow: true,
      rule_ids,
      score_breakdown,
    });
  } catch (e) {
    console.warn('[compose_detect] log failed', e);
  }

  // One-time per-user guidance if Gmail read-only tools seem absent
  if (client) {
    if (await maybeWarnMissingGmailTools(message, client)) {
      // continue normal flow; we do not return here
    }
  }

  // Admin/diagnostic command: ツール一覧
  if (client && await handleDiagCommand(processedText, message, client)) {
    return;
  }
  
  // 確認UIテスト用の簡易コマンド
  if (await handleSafetyTestCommand(processedText, message, say)) {
    return;
  }

  // Phase3: 新規作成または番号返信のDry-runカード（先行処理）
  // 優先度: FEATURE_MAIL_ACTIONS_DRYRUN/PHASE3_MODE の解決結果を優先（マスターフラグOFFでもdry-run動作を可能に）
  if (resolveDryRunEnabled().enabled && client) {
    if (await handlePhase3QuickCommands(processedText, message, say, client)) {
      return;
    }
  }

  // memOS記憶検索・チャットコマンドの処理
  if (await handleMemOSCommand(processedText, userId, say)) {
    return;
  }

  const start = isStartMessage(message, userId);
  const history = getHistory(userId);

  if (start) {
    await say('📨 アシスタントを起動したよ！🤖');
    setHistory(userId, [buildSystemPrompt(message.text)]);
  } else {
    appendToHistory(userId, `\n---\n${message.text}\n---`);
  }

  // Feature flag: Phase1 ルーター
  if (process.env.FEATURE_PHASE1_ROUTER === 'true') {
    // 「N番を開いて」はLLMを呼ぶ前にキャッシュで即時解決（受け入れ条件: Responses/APIを呼ばない）
    if (await NumberedReplyHandler.tryOpenFromCache(message, say)) {
      return;
    }
    // それ以外は Phase1 で判定（toolなし・低温度・JSON）
    const intent = await routePhase1Intent(processedText);
    if (intent) {
      console.info(`[intent] action=${intent.action} params=${JSON.stringify(intent.params || {})}`);
      if (intent.violation) console.warn('[violation] intent-phase tool call');
      if (intent.action === 'list_emails') {
        if (process.env.FEATURE_PHASE2_LIST === 'true') {
          await runPhase2List(processedText, userId, message, say);
        } else {
          await say('🧭 受信一覧の取得を準備中（Phase2へハンドオフ）');
        }
        return;
      } else if (intent.action === 'compose' && client && resolveDryRunEnabled().enabled) {
        const channel = message.channel as string | undefined;
        const thread = (message as any).thread_ts || message.ts;
        if (channel) {
          const draft: DraftData = { body: '', subject: undefined, to: undefined, cc: undefined, bcc: undefined, createdAt: Date.now() };
          await promptMailDryRun({ client, channel, user: userId, draft, sourceText: processedText, sessionId: `${channel}:${thread}` });
          return;
        }
      }
      // open_index は上のfast-pathで処理済み／otherは従来フローへフォールバック
    }
  } else {
    // 既存のファストパス（flag OFF時も従来挙動を維持）
    if (await NumberedReplyHandler.tryOpenFromCache(message, say)) {
      return;
    }
  }

  // OpenAI API呼び出し
  try {
    const response = await callOpenAI(userId);
    if (!response) return;

    let text = response.output_text ?? '';
    logger.debug('[handleSlackMessage] OpenAI response text:', text);
    try {
      const { logAction } = await import('../services/actionLogger.js');
      const sessionId = `${message.channel}:${(message as any).thread_ts || message.ts}`;
      logAction({
        route: 'responses',
        shadow: true,
        user_id: userId,
        raw_text: message.text,
        normalized_text: processedText,
        matched_trigger: null,
        match_type: null,
        confidence: null,
        params: null,
        suggested_action: null,
        result_summary: 'OpenAI応答を受信',
        session_id: sessionId,
        error: null,
      });
    } catch {}

    // メール一覧検出・保存処理（read-onlyのツール未実行時は1回だけナッジして再試行）
    let emailListData = await EmailDetectionService.detectAndSaveEmailList(text, userId, {
      channel: message.channel,
      thread_ts: message.ts,
      workspaceId: (message as any).team,
      mailbox: 'inbox',
    });
    if (!emailListData && isListIntent(processedText)) {
      const used = didUseTool(response);
      if (!used) {
        const allowed = pickGmailListTools(response);
        if (allowed.length > 0) {
          logger.debug('[responses] Found Gmail list tools for retry:', allowed);
        } else {
          logger.debug('[responses] No specific Gmail list tools found; retrying with general nudge');
        }
        const nudge = '読み取り専用のMCPツール（Gmailの一覧/検索）を今すぐ実行し、指定日の受信トレイ(INBOX)のメールを番号付きで出力してください。書き込み系ツールの呼び出しは禁止です。該当するGmailツール名（list/search系）を用いてください。';
        const retryResp = await callOpenAI(userId, { nudge, gmailAllowedTools: allowed });
        const retryText = retryResp.output_text ?? '';
        logger.debug('[handleSlackMessage][retry] OpenAI response text:', retryText);
        emailListData = await EmailDetectionService.detectAndSaveEmailList(retryText, userId, {
          channel: message.channel,
          thread_ts: message.ts,
          workspaceId: (message as any).team,
          mailbox: 'inbox',
        });
      }
    }
    if (emailListData) {
      console.log(`📝 [メール一覧検出] ${emailListData.emails.length}件のメールを検出・保存しました`);
    }

    // 下書き処理
    const draftResult = await processDraft(text, userId, message, say);
    let shouldPrompt = Boolean(draftResult?.shouldPrompt);
    if (/保存して|送信して/.test(message.text)) {
      shouldPrompt = false;
    }

    // 番号指定の返信指示を処理
    if (await NumberedReplyHandler.handleRequest(message, userId, await getToken(), say)) {
      if (shouldPrompt && draftResult) {
        await promptUserConfirmation(say, userId, 'gmail_draft', draftResult.draft, { draftId: draftResult.draftId });
      }
      return;
    }

    // 通常の応答処理
    await handleNormalResponse(text, message, userId, say);

    if (shouldPrompt && draftResult) {
      await promptUserConfirmation(say, userId, 'gmail_draft', draftResult.draft, { draftId: draftResult.draftId });
    }
  } catch (error) {
    console.error('❌ OpenAI応答に失敗しました:', error);
    await say('⚠️ OpenAI応答に失敗しました。しばらく待ってから再試行してください。');
  }
}

function didUseTool(resp: any): boolean {
  try {
    const out = resp?.output || [];
    for (const entry of out) {
      const t = entry?.type || '';
      if (typeof t === 'string' && t !== 'message' && t !== 'mcp_list_tools') {
        return true;
      }
    }
  } catch {}
  return false;
}

function isListIntent(text: string): boolean {
  const s = (text || '').toLowerCase();
  return /(一覧|表示|受信|リスト|list|inbox|見せて|みせて)/.test(s);
}

function pickGmailListTools(resp: any): string[] {
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
    // 一意化
    return Array.from(new Set(names));
  } catch {
    return [];
  }
}

// 安全確認のベースラインテスト用（実行抑止の確認）
async function handleSafetyTestCommand(text: string, message: any, say: SayFn): Promise<boolean> {
  const m1 = text.match(/^確認テスト(?:\s+(.+))?$/);
  const m2 = text.match(/^\/?safety\s+test(?:\s+(.+))?$/i);
  if (!m1 && !m2) return false;

  const args = (m1?.[1] || m2?.[1] || '').trim();
  const params: Record<string, string> = {};
  if (args) {
    args.split(/\s+/).forEach(pair => {
      const [k, v] = pair.split('=');
      if (k && v) params[k] = v;
    });
  }

  const draft: DraftData = {
    to: params.to || 'test@example.com',
    subject: params.subject || 'テスト件名',
    body: params.body || 'これはテスト本文です。安全確認UIの検証用です。',
    createdAt: Date.now(),
  };

  const userId = message.user;
  // テスト用にdraftStoreにも保存しておく（後続で「送信して」を打つと確認UIが出る）
  const draftId = generateDraftId();
  draft.draftId = draftId;
  saveDraft(userId, draftId, draft);
  await promptUserConfirmation(say, userId, 'gmail_send' as any, draft, { draftId });
  return true;
}

// プライベートメソッド群
function preprocessMessage(text: string): string {
  // Slackメンション（<@U1234567890>）を除去
  let processed = text.replace(/<@[A-Z0-9]+>/g, '').trim();
  // 連続する空白を単一の空白に置換
  return processed.replace(/\s+/g, ' ');
}

// Phase 3.0: Dry-run quick commands
async function handlePhase3QuickCommands(text: string, message: any, say: SayFn, client: WebClient): Promise<boolean> {
  const userId = message.user;
  const channel = message.channel as string | undefined;
  const thread = (message as any).thread_ts || message.ts;
  if (!channel) return false;

  // 新規メール作成（表現ゆらぎを許容）
  const composePattern = /^(?:新規メール(?:作成)?|メール(?:を)?(?:作成|作って|書いて)|新しいメール)$/;
  if (composePattern.test(text.trim())) {
    const draft: DraftData = { body: '', subject: undefined, to: undefined, cc: undefined, bcc: undefined, createdAt: Date.now() };
    await promptMailDryRun({ client, channel, user: userId, draft, sourceText: text, sessionId: `${channel}:${thread}` });
    return true;
  }

  // N番に返信
  const m = text.match(/^(\d+)\s*(?:番)?\s*(?:を)?\s*に?\s*(返信|reply)$/);
  if (m) {
    const idx = parseInt(m[1], 10);
    const cache = await getLatestEmailListCacheByScope(channel, thread);
    if (!cache) {
      await client.chat.postEphemeral({ channel, user: userId, text: '先にメール一覧を取得してね（例: 「受信トレイを一覧」）' });
      return true;
    }
    const nowSec = Math.floor(Date.now() / 1000);
    if (nowSec > (cache.expires_at ?? 0)) {
      await client.chat.postEphemeral({ channel, user: userId, text: '一覧が期限切れです。再取得してください（例: 「受信トレイを一覧」）。' });
      return true;
    }
    try {
      const parsed = JSON.parse(cache.items_json || '{}');
      const items: any[] = parsed.items || [];
      const item = items.find((i) => Number(i.index) === idx);
      if (!item) {
        await client.chat.postEphemeral({ channel, user: userId, text: `インデックス #${idx} が一覧に見つかりません。再取得してください。` });
        return true;
      }
      const subj = String(item.subject || '');
      const subject = /^\s*Re:/i.test(subj) ? subj : `Re: ${subj}`;
      const draft: DraftData = {
        body: `\n\n--- 元のメール ---\n件名: ${item.subject}\n送信者: ${item.from}\n`,
        subject,
        to: item.from,
        inReplyToMessageId: item.messageId,
        threadId: item.threadId,
        createdAt: Date.now(),
      };
      await promptMailDryRun({ client, channel, user: userId, draft, sourceText: text, sessionId: `${channel}:${thread}` });
      return true;
    } catch (e) {
      await client.chat.postEphemeral({ channel, user: userId, text: '一覧の読み取りに失敗しました。再取得してください。' });
      return true;
    }
  }

  return false;
}

async function handleMemOSCommand(text: string, userId: string, say: SayFn): Promise<boolean> {
  // Global feature gate for memOS features
  const memosEnabled = process.env.FEATURE_MEMOS_ENABLED !== 'false';
  if (!memosEnabled) {
    if (/^\/memos\b/.test(text)) {
      await say('🔕 memOS機能は現在無効です（FEATURE_MEMOS_ENABLED=false）');
      return true;
    }
    return false;
  }
  // memOS記憶保存コマンドの処理（最優先）
  const saveMatch = text.match(/^\/memos\s+記憶\s+(.+)$/);
  if (saveMatch) {
    const memoryContent = saveMatch[1].trim();
    console.log(`💾 memOS記憶保存実行: "${memoryContent}"`);
    
    try {
      const result = await MemOSService.saveMemory({
        memory_content: memoryContent,
        user_id: userId
      });
      await say(`✅ 記憶を保存しました:\n${memoryContent}`);
    } catch (error: any) {
      console.error('❌ [memOS記憶保存エラー]', error);
      await say(`⚠️ ${error.message}`);
    }
    
    return true;
  }

  // memOS検索コマンドの処理（優先度を上げる）
  const searchMatch = text.match(/^\/memos\s+検索\s+(.+)$/);
  if (searchMatch) {
    const keyword = searchMatch[1].trim();
    console.log(`🔍 memOS検索実行: "${keyword}"`);
    
    try {
      const result = await MemOSService.searchMemories(keyword, userId);
      const memories = result.memories;
      
      if (!Array.isArray(memories) || memories.length === 0) {
        await say(`「${keyword}」に関する記憶は見つかりませんでした。`);
      } else {
        const messages = memories.slice(0, 3).map((m: any, i: number) => {
          // memoryフィールドがJSON文字列の場合はパース
          let memoryContent = m.memory;
          try {
            const parsedMemory = JSON.parse(m.memory);
            if (parsedMemory.type === 'email_list' && parsedMemory.emails) {
              const emails = parsedMemory.emails;
              return `【${i + 1}】メールリスト\n件数: ${emails.length}件\n最新メール: ${emails[0]?.from ?? ''}`;
            } else {
              memoryContent = JSON.stringify(parsedMemory, null, 2);
            }
          } catch (parseError) {
            // JSONパースに失敗した場合はそのまま使用
          }
          
          const meta = m.metadata;
          return `【${i + 1}】${memoryContent}\n更新日時: ${meta?.updated_at ?? ''}`;
        }).join('\n\n');
        await say(`「${keyword}」に関する記憶:\n${messages}`);
      }
    } catch (error: any) {
      console.error('❌ [memOS検索エラー]', error);
      await say(`⚠️ ${error.message}`);
    }
    
    return true;
  }

  // memOSチャットコマンドの処理
  const chatMatch = text.match(/^\/memos\s+(.+)$/);
  if (chatMatch) {
    const query = chatMatch[1].trim();
    console.log(`💬 memOSチャット実行: "${query}"`);
    
    try {
      const result = await MemOSService.chat(query, userId);
      let response = result.response;
      
      // responseは既にオブジェクトなので、dataプロパティを取得
      if (typeof response === 'object' && response.data) {
        response = response.data;
      } else if (typeof response === 'string') {
        // 文字列の場合はそのまま使用
        try {
          const parsedResponse = JSON.parse(response);
          if (typeof parsedResponse === 'object' && parsedResponse.data) {
            response = parsedResponse.data;
          }
        } catch (parseError) {
          // JSONパースに失敗した場合はそのまま使用
          console.log('レスポンスはJSON形式ではありません');
        }
      }
      
      await say(`💬 memOSチャット応答:\n${response}`);
    } catch (error: any) {
      console.error('❌ [memOSチャットエラー]', error);
      await say(`⚠️ ${error.message}`);
    }
    
    return true;
  }

  return false;
}

async function callOpenAI(userId: string, opts?: { nudge?: string; gmailAllowedTools?: string[] }): Promise<any> {
  let token: string;
  try {
    logger.debug('🔐 Step 2: connect-token-server へ fetchConnectToken 開始');
    token = await fetchConnectToken();
    logger.debug('Step 3: トークン取得成功');
  } catch (error: any) {
    console.error('❌ [fetchConnectToken] トークン取得エラー:', error);
    throw error;
  }

  const gmailTool = getMcpTool('gmail', token);
  const calendarTool = getMcpTool('calendar', token);
  if (opts?.gmailAllowedTools && Array.isArray(opts.gmailAllowedTools) && opts.gmailAllowedTools.length > 0) {
    (gmailTool as any).allowed_tools = opts.gmailAllowedTools;
    console.log('[responses] Restricting Gmail allowed_tools:', opts.gmailAllowedTools);
  }

  try {
    logger.debug('Step 4: OpenAI に問い合わせ開始');
    const { getDefaultResponsesModel } = await import('../config/models.js');
    const response = await openai.responses.create({
      model: getDefaultResponsesModel(),
      input: opts?.nudge ? getHistory(userId).concat(['\n[実行指示]\n' + opts.nudge]).join('\n') : getHistory(userId).join('\n'),
      tools: [gmailTool, calendarTool],
      temperature: 0.2,
    });
    logger.debug('✅ Step 5: OpenAI 応答を受信');
    return response;
  } catch (e: any) {
    console.error("❌ [OpenAI APIエラー]", redactSensitive(util.inspect(e, { depth: 1 })));
    
    if (e.response?.status === 401) {
      console.log("🔄 [OpenAI API] 401エラー検出、トークンを更新して再試行");
      clearTokenCache();
      
      try {
        const newToken = await fetchConnectToken();
        const newGmailTool = getMcpTool('gmail', newToken);
        const newCalendarTool = getMcpTool('calendar', newToken);
        if (opts?.gmailAllowedTools && Array.isArray(opts.gmailAllowedTools) && opts.gmailAllowedTools.length > 0) {
          (newGmailTool as any).allowed_tools = opts.gmailAllowedTools;
          console.log('[responses] Restricting Gmail allowed_tools (retry after 401):', opts.gmailAllowedTools);
        }
        
        const { getDefaultResponsesModel: _getModel } = await import('../config/models.js');
        const response = await openai.responses.create({
          model: _getModel(),
          input: opts?.nudge ? getHistory(userId).concat(['\n[実行指示]\n' + opts.nudge]).join('\n') : getHistory(userId).join('\n'),
          tools: [newGmailTool, newCalendarTool],
          temperature: 0.2,
        });
        logger.debug('✅ Step 5: トークン更新後のOpenAI 応答を受信');
        return response;
      } catch (retryError: any) {
        console.error("❌ [OpenAI API再試行エラー]", redactSensitive(util.inspect(retryError, { depth: 1 })));
        throw retryError;
      }
    } else {
      throw e;
    }
  }
}

type DraftProcessResult = { draftId: string; draft: DraftData; shouldPrompt: boolean };

async function processDraft(text: string, userId: string, message: any, say: SayFn): Promise<DraftProcessResult | null> {
  // draftId抽出・保存処理
  let draftIdMatch = text.match(DRAFT_ID_PATTERN);
  let draftId = draftIdMatch ? draftIdMatch[1] : undefined;
  if (!draftId) {
    draftId = generateDraftId();
  }

  // 本文・threadId・件名・宛先の抽出
  const bodyMatch = text.match(BODY_PATTERN);
  const subjectMatch = text.match(SUBJECT_PATTERN);
  const toMatch = text.match(TO_PATTERN);
  const threadIdMatch = text.match(THREAD_ID_PATTERN);

  const draftData: DraftData = {
    body: bodyMatch ? bodyMatch[1].trim() : '',
    subject: subjectMatch ? subjectMatch[1].trim() : undefined,
    to: toMatch ? toMatch[1].trim() : undefined,
    threadId: threadIdMatch ? threadIdMatch[1].trim() : undefined,
    createdAt: Date.now(),
  };
  draftData.draftId = draftId;
  const hasContent = Boolean((draftData.body || '').trim() || draftData.subject || draftData.to);
  if (!hasContent) {
    return null;
  }
  saveDraft(userId, draftId, draftData);
  return { draftId, draft: draftData, shouldPrompt: true };
}

async function handleNormalResponse(text: string, message: any, userId: string, say: SayFn): Promise<void> {
  if (/下書きが作成|送信しました|ラベルを追加|保存しました/.test(text)) {
    await say('✅ Gmail 操作を完了したよ！\n\n' + text + '\n\n💬 必要なら書き続けて指示してね。');
    clearHistory(userId);
  } else if (/認証|エラー/.test(text)) {
    await say('⚠️ エラーかも…トークンや権限を確認してね。');
    clearHistory(userId);
  } else if (/保存して|送信して/.test(message.text)) {
    await handleDraftAction(message, userId, say);
  } else {
    await say('💬 ' + text + '\n\n問題なければ「送信して」「ラベルをつけて」など返信してね。やめる場合は返信不要だよ。');
  }
}

async function handleDraftAction(message: any, userId: string, say: SayFn): Promise<void> {
  // メッセージからdraftIdを抽出
  let msgDraftIdMatch = message.text.match(/draftId[:：]?\s*([a-zA-Z0-9\-_]+)/);
  let useDraftId = msgDraftIdMatch ? msgDraftIdMatch[1] : undefined;
  
  if (!useDraftId && getDrafts(userId)) {
    // 直近のdraftId（createdAtが最大のもの）
    const drafts = Object.entries(getDrafts(userId));
    if (drafts.length > 0) {
      drafts.sort((a, b) => b[1].createdAt - a[1].createdAt);
      useDraftId = drafts[0][0];
    }
  }
  
  if (!useDraftId || !getDrafts(userId) || !getDrafts(userId)[useDraftId]) {
    await say('⚠️ draftIdが見つかりません。直近のメール作成後に「保存して」や「送信して」と指示してください。');
    return;
  }

  const draft = getDrafts(userId)[useDraftId];
  const isSave = /保存して/.test(message.text);

  if (isSave) {
    await runImmediateDraftSave(userId, useDraftId, draft, say);
    return;
  }

  // このフェーズでは実行せず、安全確認UIを表示して終了
  const actionType = (/送信して/.test(message.text)) ? 'gmail_send' : 'gmail_draft';
  await promptUserConfirmation(say, userId, actionType as any, draft, { draftId: useDraftId });
}

async function runImmediateDraftSave(userId: string, draftId: string, draft: DraftData, say: SayFn) {
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
    deleteDraft(userId, draftId);
    clearHistory(userId);
    const subject = draft.subject || '(件名未設定)';
    const toolSuffix = via === 'responses' ? (toolName ? ` via ${toolName}` : ' via responses') : ' via direct';
    await say(`✅ Gmail下書きを保存したよ！\n件名: ${subject}${toolSuffix}`);
    logAction({
      route: 'gmail_draft_manual',
      trace_id: draft.draftId || generateTraceId('draft'),
      user_id_hashed: hashUserId(userId),
      params: { to: draft.to, subject: draft.subject, tool: via === 'responses' ? (toolName || 'responses') : 'direct_api' },
      result_summary: `保存完了${toolSuffix}`,
      source: via === 'responses' ? 'responses' : 'direct',
    });
  } catch (err: any) {
    console.error('❌ [draftImmediateSave] failed', redactSensitive(util.inspect(err, { depth: 2 })));
    const msgRaw = err?.message || err?.response?.data?.error || err?.code || err;
    const message = typeof msgRaw === 'string' ? msgRaw : JSON.stringify(msgRaw);
    const listedTools = Array.isArray(err?.listedTools) ? err.listedTools : undefined;
    const extra = listedTools && listedTools.length ? `\n候補ツール: ${listedTools.join(', ')}` : '';
    await say(`⚠️ Gmail下書き保存に失敗しちゃった… ${message}${extra}`);
    logAction({
      route: 'gmail_draft_manual',
      trace_id: draft.draftId || generateTraceId('draft'),
      user_id_hashed: hashUserId(userId),
      params: { to: draft.to, subject: draft.subject, listed_tools: listedTools },
      result_summary: '保存失敗',
      error: message,
      source: 'responses',
    });
  }
}

// Gmail実行リトライはこのフェーズでは未使用（実行自体を行わない）

async function getToken(): Promise<string> {
  return await fetchConnectToken();
}

function isStartMessage(message: any, userId: string): boolean {
  const text = typeof message.text === 'string' ? message.text : '';
  const hasKeyword = /(下書き|送信|ラベル|メール)/.test(text);
  const noHistory = !getHistory(userId) || getHistory(userId).length === 0;
  return hasKeyword || noHistory;
}

function redactSensitive(str: string): string {
  return str
    .replace(/Bearer [\w\-\.]+/g, 'Bearer ***')
    .replace(/token["']?: ?["']?[\w\-\.]+["']?/gi, 'token: "***"');
}
// Diagnostic: show MCP tools list (ephemeral)
async function handleDiagCommand(text: string, message: any, client: WebClient): Promise<boolean> {
  const m = text.match(/^診断[:：]\s*(?:ツール一覧|mcp\s*tools)$/i);
  if (!m) return false;
  const channel = message.channel as string | undefined;
  const userId = message.user as string;
  if (!channel) return true;
  try {
    const status = (await refreshToolsStatus());
    const gmail = status.gmailTools.join(', ') || '(none)';
    const cal = status.calendarTools.join(', ') || '(none)';
    const ro = status.gmailHasReadOnly ? 'YES' : 'NO';
    const find = status.gmailHasFind ? 'YES' : 'NO';
    const textOut = [
      '*MCPツール一覧*',
      `- Gmail: ${gmail}`,
      `- Calendar: ${cal}`,
      `- Gmail read-only検索可: ${ro}  find: ${find}`,
    ].join('\n');
    await client.chat.postEphemeral({ channel, user: userId, text: textOut });
  } catch (e) {
    await client.chat.postEphemeral({ channel, user: userId, text: '⚠️ 診断に失敗しました。' });
  }
  return true;
}
const warnedUsers = new Set<string>();
async function maybeWarnMissingGmailTools(message: any, client: WebClient): Promise<boolean> {
  const status = getCachedToolsStatus();
  if (!status) return false;
  if (status.gmailHasReadOnly) return false;
  const userId = message.user as string;
  const channel = message.channel as string | undefined;
  if (!channel || warnedUsers.has(userId)) return false;
  warnedUsers.add(userId);
  try {
    await client.chat.postEphemeral({ channel, user: userId, text: 'ℹ️ Gmail MCPにread-only検索ツール（gmail-find-email等）が見当たりません。機能が制限される可能性があります。"診断: ツール一覧" で確認できます。' });
  } catch {}
  return true;
}
