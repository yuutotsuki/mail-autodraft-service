import { initializeEnvironment } from '../config/environment';
import { SayFn } from '@slack/bolt';
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
import { fetchConnectToken, clearTokenCache } from '../services/tokenService';
import { createGmailDraft, sendGmailMail } from '../services/gmailService';
import {
  generateDraftId,
  saveDraft,
  getDrafts,
  deleteDraft,

} from '../models/draftStore';
import { EmailDetectionService } from '../services/emailDetectionService';
import { NumberedReplyHandler } from './numberedReplyHandler';
import { MemOSService } from '../services/memosService';

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

// 環境変数初期化（最初に実行）
initializeEnvironment();

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

export async function handleSlackMessage(message: any, say: SayFn) {
  console.log(" Step 1: Slackからメッセージを受信しました", message);
  const userId = message.user;
  if (!userId || message.subtype === 'bot_message') return;

  // メッセージテキストの前処理
  let processedText = preprocessMessage(message.text);
  
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

  // OpenAI API呼び出し
  try {
    const response = await callOpenAI(userId);
    if (!response) return;

    let text = response.output_text ?? '';
    console.log('[handleSlackMessage] OpenAI response text:', text);

    // メール一覧検出・保存処理
    const emailListData = await EmailDetectionService.detectAndSaveEmailList(text, userId);
    if (emailListData) {
      console.log(`📝 [メール一覧検出] ${emailListData.emails.length}件のメールを検出・保存しました`);
    }

    // 下書き処理
    await processDraft(text, userId, message, say);

    // 番号指定の返信指示を処理
    if (await NumberedReplyHandler.handleRequest(message, userId, await getToken(), say)) {
      return;
    }

    // 通常の応答処理
    await handleNormalResponse(text, message, userId, say);
  } catch (error) {
    console.error('❌ OpenAI応答に失敗しました:', error);
    await say('⚠️ OpenAI応答に失敗しました。しばらく待ってから再試行してください。');
  }
}

// プライベートメソッド群
function preprocessMessage(text: string): string {
  // Slackメンション（<@U1234567890>）を除去
  let processed = text.replace(/<@[A-Z0-9]+>/g, '').trim();
  // 連続する空白を単一の空白に置換
  return processed.replace(/\s+/g, ' ');
}

async function handleMemOSCommand(text: string, userId: string, say: SayFn): Promise<boolean> {
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

async function callOpenAI(userId: string): Promise<any> {
  let token: string;
  try {
    console.log("🔐 Step 2: connect-token-server へ fetchConnectToken 開始");
    token = await fetchConnectToken();
    console.log(" Step 3: トークン取得成功", token);
  } catch (error: any) {
    console.error('❌ [fetchConnectToken] トークン取得エラー:', error);
    throw error;
  }

  const gmailTool = getMcpTool('gmail', token);
  const calendarTool = getMcpTool('calendar', token);

  try {
    console.log(" Step 4: OpenAI に問い合わせ開始");
    const response = await openai.responses.create({
      model: 'gpt-4.1',
      input: getHistory(userId).join('\n'),
      tools: [gmailTool, calendarTool],
    });
    console.log("✅ Step 5: OpenAI 応答を受信", response);
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
        
        const response = await openai.responses.create({
          model: 'gpt-4.1',
          input: getHistory(userId).join('\n'),
          tools: [newGmailTool, newCalendarTool],
        });
        console.log("✅ Step 5: トークン更新後のOpenAI 応答を受信", response);
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

async function processDraft(text: string, userId: string, message: any, say: SayFn): Promise<void> {
  // draftId抽出・保存処理
  let draftIdMatch = text.match(DRAFT_ID_PATTERN);
  let draftId = draftIdMatch ? draftIdMatch[1] : undefined;
  if (!draftId) {
    draftId = generateDraftId();
    text += `\ndraftId: ${draftId}`;
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
  saveDraft(userId, draftId, draftData);
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
  try {
    const token = await getToken();
    let result;
    
    if (/保存して/.test(message.text)) {
      result = await createGmailDraft(token, draft);
      await say(`✅ 下書きを保存しました（draftId: ${useDraftId}）`);
    } else if (/送信して/.test(message.text)) {
      result = await sendGmailMail(token, draft);
      await say(`✅ メールを送信しました（draftId: ${useDraftId}）`);
    }
    
    // draft使用後は削除
    deleteDraft(userId, useDraftId);
  } catch (e: any) {
    console.error('❌ [Gmail API連携エラー]', redactSensitive(util.inspect(e, { depth: 1 })));
    
    if (e.response?.status === 401) {
      await handleGmailRetry(e, draft, userId, useDraftId, message, say);
    } else {
      await say('⚠️ Gmail API連携エラー: ' + (e.message || e.toString()));
    }
  }
}

async function handleGmailRetry(error: any, draft: any, userId: string, useDraftId: string, message: any, say: SayFn): Promise<void> {
  console.log(" [Gmail API] 401エラー検出、トークンを更新して再試行");
  clearTokenCache();
  
  try {
    const newToken = await fetchConnectToken();
    let retryResult;
    
    if (/保存して/.test(message.text)) {
      retryResult = await createGmailDraft(newToken, draft);
      await say(`✅ 下書きを保存しました（draftId: ${useDraftId}）`);
    } else if (/送信して/.test(message.text)) {
      retryResult = await sendGmailMail(newToken, draft);
      await say(`✅ メールを送信しました（draftId: ${useDraftId}）`);
    }
    
    // draft使用後は削除
    deleteDraft(userId, useDraftId);
  } catch (retryError: any) {
    console.error("❌ [Gmail API再試行エラー]", redactSensitive(util.inspect(retryError, { depth: 1 })));
    await say('⚠️ トークン更新後もGmail API連携エラーが発生しました: ' + (retryError.message || retryError.toString()));
  }
}

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