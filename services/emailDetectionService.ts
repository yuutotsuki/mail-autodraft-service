import { EMAIL_LIST_PATTERNS } from '../utils/regexPatterns';
import { EmailItem, EmailListData } from '../types/email';
import axios from 'axios';
import { upsertEmailListCache } from '../db/sqlite';
import { buildGmailListCacheKey } from '../utils/cacheKey';
import { MemOSService } from './memosService';
import { logger } from '../utils/logger';

export class EmailDetectionService {
  static async detectAndSaveEmailList(text: string, userId: string, opts?: { channel?: string; thread_ts?: string; workspaceId?: string; mailbox?: string; query?: string; pageToken?: string; page?: number }): Promise<EmailListData | null> {
    try {
      const emails = this.detectEmailPatterns(text);
      
      if (emails.length === 0) {
        logger.info(`❌ [メール一覧検出] メール一覧が見つかりませんでした。`);
        logger.debug(`[デバッグ] テキストの一部: ${text.substring(0, 500)}...`);
        return null;
      }

      // 保存条件の強化: items >= 2 の場合のみ保存（1件は誤検知の可能性があるためスキップ）
      if (emails.length < 2) {
        console.warn(`⚠️ [メール一覧検出] 件数が少ないため保存をスキップ: count=${emails.length}`);
        return {
          type: 'email_list',
          generated_at: new Date().toISOString(),
          user_id: userId,
          session_id: `${userId}_${Date.now()}`,
          emails: emails,
          tags: ['email_list', 'skip_save_items_lt_2']
        } as EmailListData;
      }

      const sessionId = `${userId}_${Date.now()}`;
      const emailListData: EmailListData = {
        type: 'email_list',
        generated_at: new Date().toISOString(),
        user_id: userId,
        session_id: sessionId,
        emails: emails,
        tags: ['email_list', '操作対象']
      };

      // Step2: キャッシュ保存（SQLite）＋ memOSには要約のみ保存（items>=2 の場合に限定）
      try {
        const ttlMin = Number(process.env.GMAIL_LIST_TTL_MIN || '5');
        const nowSec = Math.floor(Date.now() / 1000);
        const expiresAt = nowSec + ttlMin * 60;

        // cache_key 生成（pageToken優先、queryはハッシュ化）
        const cacheKey = buildGmailListCacheKey({
          userId,
          workspaceId: opts?.workspaceId,
          mailbox: opts?.mailbox,
          query: opts?.query,
          pageToken: opts?.pageToken,
          page: opts?.page,
        });

        // items_json: 1始まり番号・id・件名・送信者・日付
        const items = emails.map((e) => ({
          index: e.index,
          messageId: e.id, // ツール由来でない場合は擬似ID
          subject: e.subject,
          from: e.from,
          date: (e as any).date,
        }));
        const itemsJson = JSON.stringify({ items });

        await upsertEmailListCache(cacheKey, itemsJson, expiresAt, { channel: opts?.channel, thread_ts: opts?.thread_ts, createdAt: nowSec });
        logger.info(`[cache] saved email_list: key=${cacheKey} count=${items.length} ttl_min=${ttlMin}`);

        // memOS: 要約のみ保存（生データは保存しない）
        const sampleSubjects = items.slice(0, 3).map(i => `「${i.subject}」`).join(' ');
        const expiresIso = new Date(expiresAt * 1000).toISOString();

        const summary = [
          `${new Date().toLocaleDateString('ja-JP')}のメール一覧（${items.length}件）`,
          sampleSubjects ? `- 件名例: ${sampleSubjects}` : undefined,
          `cache_key: ${cacheKey}`,
          `expires_at: ${expiresIso}`,
          '#email_list #cache_ref',
        ].filter(Boolean).join('\n');

        const memosEnabled = process.env.FEATURE_MEMOS_ENABLED !== 'false';
        if (memosEnabled && process.env.FEATURE_MEMOS_SAVE_EMAIL_LIST !== 'false') {
          await MemOSService.saveMemory({ memory_content: summary, user_id: userId });
          logger.info(`[memos] saved email_list_summary: key=${cacheKey} count=${items.length}`);
        } else {
          logger.debug('[memos] skip save (FEATURE_MEMOS_ENABLED=false or FEATURE_MEMOS_SAVE_EMAIL_LIST=false)');
        }
      } catch (e) {
        logger.warn('[email_list] save hooks failed (cache or memOS)', e);
      }

      // 互換: 返却値は従来どおり
      logger.info(`✅ [メール一覧検出] 保存完了: sessionId=${sessionId}`);

      return emailListData;

    } catch (error: any) {
      logger.error('❌ [メール一覧保存エラー]', {
        message: error.message,
        status: error.response?.status,
        data: error.response?.data
      });
      return null;
    }
  }

  private static detectEmailPatterns(text: string): EmailItem[] {
    let emails: EmailItem[] = [];

    // Preprocess: strip code fences and normalize common wrappers
    const stripped = this.stripCodeFences(text);

    for (const pattern of EMAIL_LIST_PATTERNS) {
      const matches = [...stripped.matchAll(pattern)];
      logger.debug(`[メール一覧検出] パターン: ${pattern.source}, マッチ数: ${matches.length}`);
      
      if (matches.length > 0) {
        logger.debug(`✅ [メール一覧検出] パターンマッチ成功: ${matches.length}件`);
        emails = this.parseEmailMatches(matches, pattern);
        break; // 最初に見つかったパターンを使用
      }
    }

    // Fallback: try to parse JSON blocks like { items: [{subject, from, date, id}, ...] }
    if (emails.length === 0) {
      const json = this.extractJsonCandidate(text);
      if (json) {
        try {
          const obj = JSON.parse(json);
          const items = Array.isArray(obj) ? obj : (Array.isArray(obj?.items) ? obj.items : (Array.isArray(obj?.messages) ? obj.messages : []));
          if (Array.isArray(items) && items.length > 0) {
            emails = items.slice(0, 50).map((m: any, i: number) => ({
              id: m.id || m.messageId || m.threadId || `email_${Date.now()}_${i}`,
              subject: String(m.subject || m.snippet || m.title || '').trim(),
              from: String(m.from || m.sender || m.author || m.email || '').trim(),
              index: i + 1,
              ...(m.date ? { date: String(m.date) } : {}),
            } as EmailItem)).filter(e => e.subject || e.from);
            if (emails.length > 0) {
              logger.debug(`✅ [メール一覧検出] JSON解析で ${emails.length} 件を抽出`);
            }
          }
        } catch (e) {
          logger.debug('[メール一覧検出] JSON解析に失敗しました');
        }
      }
    }

    return emails;
  }

  private static stripCodeFences(s: string): string {
    try {
      return (s || '').replace(/```[a-zA-Z0-9]*\n([\s\S]*?)```/g, '$1');
    } catch {
      return s;
    }
  }

  private static extractJsonCandidate(s: string): string | null {
    // Prefer explicit ```json blocks
    const m1 = s.match(/```json\n([\s\S]*?)```/i);
    if (m1 && m1[1]) return m1[1].trim();
    // Next, any ``` fenced block
    const m2 = s.match(/```\n([\s\S]*?)```/);
    if (m2 && m2[1] && /\{|\[/.test(m2[1])) return m2[1].trim();
    // Last resort: substring between first { and last }
    const first = s.indexOf('{');
    const last = s.lastIndexOf('}');
    if (first !== -1 && last !== -1 && last > first && (last - first) <= 20000) {
      const candidate = s.slice(first, last + 1);
      if (/"(items|messages)"\s*:\s*\[/.test(candidate)) return candidate;
    }
    return null;
  }

  private static parseEmailMatches(matches: RegExpMatchArray[], pattern: RegExp): EmailItem[] {
    return matches.map((match, index) => {
      // 新1行形式（id/日付対応）: index, subject, from, date, time?, id?
      if (/\[id:/.test(pattern.source) || /—/.test(pattern.source)) {
        const idx = parseInt(match[1]);
        const subject = (match[2] || '').trim();
        let from = (match[3] || '').trim();
        const d1 = (match[4] || '').trim();
        const t1 = (match[5] || '').trim();
        const mid = (match[6] || '').trim();
        const date = d1 ? (t1 ? `${d1.replace(/[年月]/g, '-').replace(/日$/, '')} ${t1}` : d1.replace(/[年月]/g, '-').replace(/日$/, '')) : undefined;
        // fromに日付が混ざっていた場合の後処理（保険）
        from = from.replace(/[（(].*?[）)]\s*$/, '').trim();
        return {
          id: mid ? mid : `email_${Date.now()}_${index}`,
          subject,
          from,
          index: idx,
          ...(date ? { date } : {}),
        } as EmailItem;
      }
      if (pattern.source.includes('ID')) {
        return {
          id: match[1],
          subject: match[2].trim(),
          from: match[3].trim(),
          index: index + 1
        };
      } else if (pattern.source.includes('**件名:**')) {
        return {
          id: `email_${Date.now()}_${index}`,
          subject: match[2].trim(),
          from: match[3].trim(),
          index: parseInt(match[1])
        };
      } else if (pattern.source.includes('スレッドID')) {
        const emailItem: EmailItem = {
          id: `email_${Date.now()}_${index}`,
          subject: match[3].trim(),
          from: match[4].trim(),
          thread_id: match[2].trim(),
          index: parseInt(match[1])
        };
        
        if (match[5]) {
          emailItem.date = match[5].trim();
        }
        
        return emailItem;
      } else if (pattern.source.includes('件名')) {
        return {
          id: `email_${Date.now()}_${index}`,
          subject: match[1].trim(),
          from: match[2].trim(),
          index: index + 1
        };
      } else {
        return {
          id: `email_${Date.now()}_${index}`,
          subject: match[2].trim(),
          from: match[3].trim(),
          index: parseInt(match[1])
        };
      }
    });
  }

  private static async saveToMemOS(emailListData: EmailListData, userId: string): Promise<void> {
    const memosApiUrl = process.env.MEMOS_API_URL || 'http://localhost:5001';
    const addUrl = `${memosApiUrl}/memories`;
    
    logger.debug(`[メール一覧保存] memOSに保存開始: ${emailListData.emails.length}件のメール`);
    
    await axios.post(addUrl, {
      memory_content: JSON.stringify(emailListData, null, 2),
      user_id: userId,
      mem_cube_id: "Ki-Seki/mem_cube_2"
    }, {
      timeout: 10000,
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json',
        'X-Slack-User-ID': userId  // SlackユーザーIDをヘッダーに追加
      }
    });
  }
}
