import { EMAIL_LIST_PATTERNS } from '../utils/regexPatterns';
import { EmailItem, EmailListData } from '../types/email';
import axios from 'axios';

export class EmailDetectionService {
  static async detectAndSaveEmailList(text: string, userId: string): Promise<EmailListData | null> {
    try {
      const emails = this.detectEmailPatterns(text);
      
      if (emails.length === 0) {
        console.log(`❌ [メール一覧検出] メール一覧が見つかりませんでした。`);
        console.log(`�� [デバッグ] テキストの一部: ${text.substring(0, 500)}...`);
        return null;
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

      await this.saveToMemOS(emailListData, userId);
      console.log(`✅ [メール一覧検出] memOS保存完了: sessionId=${sessionId}`);
      
      return emailListData;

    } catch (error: any) {
      console.error('❌ [メール一覧保存エラー]', {
        message: error.message,
        status: error.response?.status,
        data: error.response?.data
      });
      return null;
    }
  }

  private static detectEmailPatterns(text: string): EmailItem[] {
    let emails: EmailItem[] = [];

    for (const pattern of EMAIL_LIST_PATTERNS) {
      const matches = [...text.matchAll(pattern)];
      console.log(`�� [メール一覧検出] パターン: ${pattern.source}, マッチ数: ${matches.length}`);
      
      if (matches.length > 0) {
        console.log(`✅ [メール一覧検出] パターンマッチ成功: ${matches.length}件`);
        emails = this.parseEmailMatches(matches, pattern);
        break; // 最初に見つかったパターンを使用
      }
    }

    return emails;
  }

  private static parseEmailMatches(matches: RegExpMatchArray[], pattern: RegExp): EmailItem[] {
    return matches.map((match, index) => {
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
    
    console.log(`�� [メール一覧保存] memOSに保存開始: ${emailListData.emails.length}件のメール`);
    
    await axios.post(addUrl, {
      memory_content: JSON.stringify(emailListData, null, 2),
      user_id: userId,
      mem_cube_id: "Ki-Seki/mem_cube_2"
    }, {
      timeout: 10000,
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json'
      }
    });
  }
}