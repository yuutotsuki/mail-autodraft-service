import axios from 'axios';

// 型定義
export interface MemorySearchResult {
  memories: Array<{
    memory: string;
    metadata: {
      mail_items?: Array<{
        sender_name: string;
        subject: string;
        date: string;
        snippet: string;
      }>;
    };
  }>;
}

export interface ChatResult {
  response: string | {
    code: number;
    message: string;
    data: string;
  };
  // 必要に応じて追加フィールド
}

export interface MemorySavePayload {
  memory_content: string;
  user_id: string;
  mem_cube_id?: string;
}

export class MemOSService {
  private static readonly BASE_URL = process.env.MEMOS_API_BASE || 'http://127.0.0.1';
  private static readonly PORT = process.env.MEMOS_API_PORT || '8000';
  private static readonly SEARCH_ENDPOINT = process.env.MEMOS_SEARCH_ENDPOINT || '/search';
  private static readonly CHAT_ENDPOINT = process.env.MEMOS_CHAT_ENDPOINT || '/chat';
  private static readonly MEMORIES_ENDPOINT = '/memories';

  // フォールバック用：既存のMEMOS_API_URLが設定されている場合は優先
  private static readonly LEGACY_API_URL = process.env.MEMOS_API_URL;

  private static getBaseUrl(): string {
    // 既存のMEMOS_API_URLが設定されている場合は優先（フォールバック対応）
    if (this.LEGACY_API_URL) {
      return this.LEGACY_API_URL;
    }
    return `${this.BASE_URL}:${this.PORT}`;
  }

  private static generateReqId(): string {
    return `req_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  }

  private static logRequest(method: string, url: string, reqId: string, status?: number, attempt?: number): void {
    const maskedUrl = url.replace(/\/\/[^\/]+/, '//***'); // ホスト部分をマスク
    const attemptText = attempt ? ` (試行${attempt})` : '';
    console.log(`[memos] ${method} ${maskedUrl} ${status ? `(${status})` : ''} [${reqId}]${attemptText}`);
  }

  private static logError(error: any, reqId: string, attempt?: number): void {
    const attemptText = attempt ? ` (試行${attempt})` : '';
    console.error(`[memos] Error [${reqId}]${attemptText}:`, {
      message: error.message,
      status: error.response?.status,
      statusText: error.response?.statusText
    });
  }

  /**
   * 記憶検索（POST /search）
   */
  static async searchMemories(keyword: string, userId?: string): Promise<MemorySearchResult> {
    const reqId = this.generateReqId();
    const baseUrl = this.getBaseUrl();
    const searchUrl = `${baseUrl}${this.SEARCH_ENDPOINT}`;

    try {
      this.logRequest('POST', searchUrl, reqId);

      // POST メソッドで検索
      const response = await axios.post(searchUrl, {
        query: keyword,
        user_id: userId || 'default_user'
      }, {
        timeout: 30000, // 30秒に延長
        headers: {
          'Content-Type': 'application/json',
          'Accept': 'application/json'
        }
      });

      this.logRequest('POST', searchUrl, reqId, response.status);

      // memOSサーバーからのレスポンス形式を処理
      const responseData = response.data;
      let memories: any[] = [];
      
      if (responseData.data && responseData.data.text_mem && responseData.data.text_mem.length > 0) {
        // text_memからmemoriesを取得
        memories = responseData.data.text_mem[0].memories || [];
      } else if (Array.isArray(responseData)) {
        // 従来の形式（配列）
        memories = responseData;
      } else {
        throw new Error('Invalid response format: unexpected structure');
      }

      return { memories };
    } catch (error: any) {
      this.logError(error, reqId);
      
      // エラーメッセージを親切に変換
      if (error.code === 'ECONNREFUSED') {
        throw new Error('memOSサーバーに接続できません（memOSが起動していますか？）');
      } else if (error.response?.status) {
        throw new Error(`memOS API エラー: HTTP ${error.response.status} - ${error.response.statusText}`);
      } else {
        throw new Error(`memOS API エラー: ${error.message}`);
      }
    }
  }

  /**
   * チャット機能（POST /chat）
   */
  static async chat(query: string, userId: string): Promise<ChatResult> {
    const reqId = this.generateReqId();
    const baseUrl = this.getBaseUrl();
    const chatUrl = `${baseUrl}${this.CHAT_ENDPOINT}`;

    try {
      this.logRequest('POST', chatUrl, reqId);

      const response = await axios.post(chatUrl, {
        query: query,
        user_id: userId
      }, {
        timeout: 30000, // 30秒に延長
        headers: {
          'Content-Type': 'application/json',
          'Accept': 'application/json'
        }
      });

      this.logRequest('POST', chatUrl, reqId, response.status);

      return { response: response.data };
    } catch (error: any) {
      this.logError(error, reqId);
      
      // エラーメッセージを親切に変換
      if (error.code === 'ECONNREFUSED') {
        throw new Error('memOSチャットサーバーに接続できません（memOSが起動していますか？）');
      } else if (error.response?.status) {
        throw new Error(`memOSチャット API エラー: HTTP ${error.response.status} - ${error.response.statusText}`);
      } else {
        throw new Error(`memOSチャット API エラー: ${error.message}`);
      }
    }
  }

  /**
   * 記憶保存（POST /memories）
   */
  static async saveMemory(payload: MemorySavePayload): Promise<void> {
    const reqId = this.generateReqId();
    const baseUrl = this.getBaseUrl();
    const memoriesUrl = `${baseUrl}${this.MEMORIES_ENDPOINT}`;

    // リトライ機能付きで実行
    const maxRetries = 2;
    let lastError: any;

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        this.logRequest('POST', memoriesUrl, reqId, undefined, attempt);

        await axios.post(memoriesUrl, {
          memory_content: payload.memory_content,
          user_id: payload.user_id,
          mem_cube_id: payload.mem_cube_id || "operation_log_cube"
        }, {
          timeout: 30000, // 30秒に延長
          headers: {
            'Content-Type': 'application/json',
            'Accept': 'application/json',
            'X-Slack-User-ID': payload.user_id  // SlackユーザーIDをヘッダーに追加
          }
        });

        this.logRequest('POST', memoriesUrl, reqId, 200, attempt);
        return; // 成功したら終了
      } catch (error: any) {
        lastError = error;
        this.logError(error, reqId, attempt);
        
        // 最後の試行でない場合は少し待ってからリトライ
        if (attempt < maxRetries) {
          console.log(`[memos] リトライ ${attempt}/${maxRetries} を ${attempt * 1000}ms 後に実行 [${reqId}]`);
          await new Promise(resolve => setTimeout(resolve, attempt * 1000));
        }
      }
    }
    
    // 全てのリトライが失敗した場合
    if (lastError.code === 'ECONNREFUSED') {
      throw new Error('memOSサーバーに接続できません（memOSが起動していますか？）');
    } else if (lastError.response?.status) {
      throw new Error(`memOS保存 API エラー: HTTP ${lastError.response.status} - ${lastError.response.statusText}`);
    } else {
      throw new Error(`memOS保存 API エラー: ${lastError.message}`);
    }
  }

  /**
   * メールリスト検索（従来の互換性のため）
   */
  static async searchEmailList(userId: string): Promise<MemorySearchResult> {
    return this.searchMemories("email_list", userId);
  }

  /**
   * 設定情報の取得（デバッグ用）
   */
  static getConfig(): object {
    return {
      baseUrl: this.getBaseUrl(),
      searchEndpoint: this.SEARCH_ENDPOINT,
      chatEndpoint: this.CHAT_ENDPOINT,
      usingLegacyUrl: !!this.LEGACY_API_URL
    };
  }
}