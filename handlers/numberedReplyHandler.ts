import { SayFn } from '@slack/bolt';
import { EmailListData, DraftData } from '../types/email';
import { MemOSService } from '../services/memosService';
import { NUMBERED_REPLY_PATTERN, SUBJECT_REPLY_PATTERN } from '../utils/regexPatterns';
import { logger } from '../utils/logger';
import { generateDraftId, saveDraft } from '../models/draftStore';
import { getLatestEmailListCacheByScope } from '../db/sqlite';
import { openEmailBodyFromCache } from '../services/openEmailService';

export class NumberedReplyHandler {
  // 開いて系はLLMや外部APIを呼ばず、まずキャッシュだけで即時解決を試みる
  static async tryOpenFromCache(message: any, say: SayFn): Promise<boolean> {
    const numberMatch = (message.text || '').match(NUMBERED_REPLY_PATTERN);
    if (!numberMatch) return false;
    const action = numberMatch[2];
    if (!/(開いて|開く|open)/.test(action)) return false;

    const targetIndex = parseInt(numberMatch[1]);
    const scopeChannel = message.channel as string | undefined;
    const scopeThread = (message as any).thread_ts || message.ts;
    if (!scopeChannel) return false;

    const cache = await getLatestEmailListCacheByScope(scopeChannel, scopeThread);
    if (!cache) {
      await say('♻️ 最近の一覧が見つかりません。「受信トレイを一覧」と指示して再取得してください。');
      return true; // LLMは呼ばない
    }

    const nowSec = Math.floor(Date.now() / 1000);
    if (nowSec > (cache.expires_at ?? 0)) {
      await say('♻️ 一覧が期限切れです。「受信トレイを一覧」と指示して再取得してください。');
      return true; // LLMは呼ばない
    }

    try {
      const parsed = JSON.parse(cache.items_json || '{}');
      const items: any[] = parsed.items || [];
      const item = items.find((i) => Number(i.index) === targetIndex);
      if (item && item.messageId) {
        logger.debug(`[cache-hit] key=${cache.cache_key} index=${targetIndex}`);
        // ここで本文を1通だけ取得して表示
        await openEmailBodyFromCache({
          say,
          index: targetIndex,
          item,
          cacheKey: cache.cache_key,
        });
        return true;
      }
      await say(`⚠️ インデックス #${targetIndex} が一覧に見つかりませんでした。「受信トレイを一覧」で再取得してください。`);
      return true;
    } catch (e) {
      logger.warn('[cache] parse error on items_json (open fast-path)', e);
      await say('⚠️ 一覧の読み取りに失敗しました。「受信トレイを一覧」と指示して再取得してください。');
      return true;
    }
  }
  static async handleRequest(message: any, userId: string, token: string, say: SayFn): Promise<boolean> {
    try {
      // 番号指定のパターンを検出
      const numberMatch = message.text.match(NUMBERED_REPLY_PATTERN);
      
      if (numberMatch) {
        return await this.handleNumberedRequest(numberMatch, message, userId, token, say);
      }

      // 件名や送信者名での検索も試行
      const subjectMatch = message.text.match(SUBJECT_REPLY_PATTERN);
      
      if (subjectMatch) {
        return await this.handleSubjectRequest(subjectMatch, userId, token, say);
      }
      
      return false; // 番号指定でも件名指定でもない

    } catch (error: any) {
      console.error('❌ [番号指定処理エラー]', error);
      await say('⚠️ 番号指定の処理中にエラーが発生しました: ' + (error.message || error.toString()));
      return true;
    }
  }

  private static async handleNumberedRequest(match: RegExpMatchArray, message: any, userId: string, token: string, say: SayFn): Promise<boolean> {
    const targetIndex = parseInt(match[1]);
    const action = match[2];
    
    logger.debug(`🔍 [番号指定検出] インデックス: ${targetIndex}, アクション: ${action}`);

    // Step3 A案: SQLiteキャッシュで番号解決（memOSは保持するが解決はキャッシュ優先）
    const scopeChannel = message.channel as string | undefined;
    const scopeThread = (message as any).thread_ts || message.ts;
    if (!scopeChannel) {
      logger.warn('[cache] no channel in message; skip memOS fallback due to scope');
      await say('♻️ 一覧のスレッド情報が見つかりません。「受信トレイを一覧」と指示して再取得してください。');
      return true;
    }

    const cache = await getLatestEmailListCacheByScope(scopeChannel, scopeThread);
    if (cache) {
      const nowSec = Math.floor(Date.now() / 1000);
      if (nowSec <= (cache.expires_at ?? 0)) {
        try {
          const parsed = JSON.parse(cache.items_json || '{}');
          const items: any[] = parsed.items || [];
          const item = items.find((i) => Number(i.index) === targetIndex);
          if (item && item.messageId) {
            logger.debug(`[cache-hit] key=${cache.cache_key} index=${targetIndex}`);
            if (action === '開いて' || action === 'open' || action === '開く') {
              await openEmailBodyFromCache({
                say,
                index: targetIndex,
                item,
                cacheKey: cache.cache_key,
              });
              return true;
            }
            // 他アクション（返信/下書き）は従来通りtargetEmail相当の形にして流す
            const targetEmail = {
              subject: item.subject,
              from: item.from,
              thread_id: item.threadId, // ない場合あり
              id: item.messageId,
              index: item.index,
            };
            return await this.executeEmailAction(targetEmail, action, userId, token, say);
          }
        } catch (e) {
          logger.warn('[cache] parse error on items_json', e);
        }
      } else {
        logger.debug(`[cache-expired] key=${cache.cache_key} now=${nowSec} exp=${cache.expires_at}`);
        await say('♻️ 一覧が期限切れです。「受信トレイを一覧」と指示して再取得してください。');
        return true;
      }
    }

    // フォールバック: memOS検索（グローバル無効時は抑止）
    if (process.env.FEATURE_MEMOS_ENABLED === 'false') {
      await say('♻️ 最近の一覧が見つかりません。「受信トレイを一覧」と指示して再取得してください。');
      return true;
    }
    const targetEmail = await this.findEmailByIndex(userId, targetIndex);
    if (!targetEmail) {
      await say(`⚠️ インデックス ${targetIndex} のメールが見つかりません。`);
      return true;
    }
    return await this.executeEmailAction(targetEmail, action, userId, token, say);
  }

  private static async handleSubjectRequest(match: RegExpMatchArray, userId: string, token: string, say: SayFn): Promise<boolean> {
    const searchTerm = match[1].trim();
    const action = match[2];
    
    logger.debug(`🔍 [件名検索] 検索語: "${searchTerm}", アクション: ${action}`);
    // memOS全体無効ならフォールバックを抑止
    if (process.env.FEATURE_MEMOS_ENABLED === 'false') {
      await say('♻️ 件名検索のための記録が見つかりません。「受信トレイを一覧」と指示して再取得してください。');
      return true;
    }

    const targetEmail = await this.findEmailBySubject(userId, searchTerm);
    if (!targetEmail) {
      await say(`⚠️ "${searchTerm}" に一致するメールが見つかりません。`);
      return true;
    }

    return await this.executeEmailAction(targetEmail, action, userId, token, say);
  }

  private static async findEmailByIndex(userId: string, targetIndex: number): Promise<any> {
    if (process.env.FEATURE_MEMOS_ENABLED === 'false') return null;
    const result = await MemOSService.searchEmailList(userId);
    const memories = result.memories;
    
    if (!Array.isArray(memories) || memories.length === 0) {
      return null;
    }

    const latestEmailList = this.getLatestEmailList(memories, userId);
    if (!latestEmailList) {
      return null;
    }

    return latestEmailList.emails.find(email => email.index === targetIndex);
  }

  private static async findEmailBySubject(userId: string, searchTerm: string): Promise<any> {
    if (process.env.FEATURE_MEMOS_ENABLED === 'false') return null;
    const result = await MemOSService.searchEmailList(userId);
    const memories = result.memories;
    
    if (!Array.isArray(memories) || memories.length === 0) {
      return null;
    }

    const latestEmailList = this.getLatestEmailList(memories, userId);
    if (!latestEmailList) {
      return null;
    }
    
    return latestEmailList.emails.find(email => 
      email.subject.toLowerCase().includes(searchTerm.toLowerCase()) ||
      email.from.toLowerCase().includes(searchTerm.toLowerCase())
    );
  }

  private static getLatestEmailList(memories: any[], userId: string): EmailListData | null {
    const emailListMemories = memories
      .filter((m: any) => {
        try {
          const data = JSON.parse(m.memory);
          return data.type === 'email_list' && data.user_id === userId;
        } catch {
          return false;
        }
      })
      .sort((a: any, b: any) => {
        const dataA = JSON.parse(a.memory);
        const dataB = JSON.parse(b.memory);
        return new Date(dataB.generated_at).getTime() - new Date(dataA.generated_at).getTime();
      });

    if (emailListMemories.length === 0) {
      return null;
    }

    return JSON.parse(emailListMemories[0].memory) as EmailListData;
  }

  private static async executeEmailAction(targetEmail: any, action: string, userId: string, token: string, say: SayFn): Promise<boolean> {
    logger.debug(`📧 [対象メール特定] 件名: ${targetEmail.subject}, 送信者: ${targetEmail.from}`);

    if (action === '返信' || action === 'reply') {
      const replyData: DraftData = {
        body: `\n\n--- 元のメール ---\n件名: ${targetEmail.subject}\n送信者: ${targetEmail.from}\n`,
        subject: `Re: ${targetEmail.subject}`,
        threadId: targetEmail.thread_id,
        createdAt: Date.now(),
      };

      const draftId = generateDraftId();
      replyData.draftId = draftId;
      saveDraft(userId, draftId, replyData);

      await say(`�� 返信メールの下書きを作成しました（draftId: ${draftId}）\n\n件名: Re: ${targetEmail.subject}\n\n内容を入力して「送信して」と指示してください。`);
      
    } else if (action === '下書き' || action === 'draft') {
      const draftData: DraftData = {
        body: '',
        subject: targetEmail.subject,
        to: targetEmail.from_email || targetEmail.from,
        createdAt: Date.now(),
      };

      const draftId = generateDraftId();
      draftData.draftId = draftId;
      saveDraft(userId, draftId, draftData);

      await say(`📝 下書きメールを作成しました（draftId: ${draftId}）\n\n件名: ${targetEmail.subject}\n宛先: ${targetEmail.from}\n\n内容を入力して「送信して」と指示してください。`);
    }

    return true;
  }
}
