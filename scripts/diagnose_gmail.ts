import dotenv from 'dotenv';
import OpenAI from 'openai';
import util from 'util';
import { fetchConnectToken, clearTokenCache } from '../services/tokenService';
import { getMcpTool } from '../getMcpTool';

const envPath = `.env.${process.env.ENV || 'company'}`;
dotenv.config({ path: envPath });
console.log(`✅ .env loaded for diagnosis: ${envPath}`);

function redact(s: any): string {
  try { return util.inspect(s, { depth: 2, maxArrayLength: 20 }); } catch { return String(s); }
}

function pickGmailReadOnlyTools(resp: any): string[] {
  try {
    const out = resp?.output || [];
    const names: string[] = [];
    for (const entry of out) {
      if (entry?.type === 'mcp_list_tools' && /gmail/i.test(entry?.server_label || '')) {
        const tools = entry?.tools || [];
        for (const t of tools) {
          const name = t?.name || '';
          if (typeof name === 'string' && /(list|search|messages|threads|get_?thread|get_?message)/i.test(name)) {
            names.push(name);
          }
        }
      }
    }
    return Array.from(new Set(names));
  } catch { return []; }
}

function listAllGmailTools(resp: any): string[] {
  try {
    const out = resp?.output || [];
    const names: string[] = [];
    for (const entry of out) {
      if (entry?.type === 'mcp_list_tools' && /gmail/i.test(entry?.server_label || '')) {
        const tools = entry?.tools || [];
        for (const t of tools) {
          const name = t?.name || '';
          if (typeof name === 'string' && name) names.push(name);
        }
      }
    }
    return Array.from(new Set(names));
  } catch { return []; }
}

async function main() {
  console.log('--- Gmail Diagnosis START ---');
  console.log('ENV presence:', {
    OPENAI_API_KEY: !!process.env.OPENAI_API_KEY,
    PIPEDREAM_PROJECT_ID: !!process.env.PIPEDREAM_PROJECT_ID,
    PIPEDREAM_ENVIRONMENT: !!process.env.PIPEDREAM_ENVIRONMENT,
    PIPEDREAM_EXTERNAL_USER_ID: !!process.env.PIPEDREAM_EXTERNAL_USER_ID,
  });

  // Step 0: token
  let token: string;
  try {
    token = await fetchConnectToken();
  } catch (e: any) {
    console.error('❌ fetchConnectToken failed:', e?.message || e);
    return;
  }

  const gmailTool: any = getMcpTool('gmail', token);
  const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

  // Step 1: list tools (Gmail only)
  console.log('\n[Step1] Gmail list_tools (Gmail only)');
  let allowed: string[] = [];
  try {
    const resp = await client.responses.create({
      model: process.env.RESPONSES_MODEL_DEFAULT || 'gpt-4.1-mini',
      input: 'Gmail の利用可能なツール一覧だけを教えてください。説明文は不要です。',
      tools: [gmailTool],
      temperature: 0,
    });
    const allTools = listAllGmailTools(resp as any);
    allowed = pickGmailReadOnlyTools(resp as any);
    console.log('✅ list_tools success. ALL tools=', allTools);
    console.log('ℹ️ read-only subset (list/search/messages/threads)=', allowed);
  } catch (e: any) {
    console.error('❌ list_tools error:', e?.status, e?.code, e?.type, e?.error?.message);
    if (e?.response?.status === 401) {
      console.log('↻ 401 detected; retrying after token refresh...');
      try {
        clearTokenCache();
        const newToken = await fetchConnectToken();
        const gmail2: any = getMcpTool('gmail', newToken);
        const resp2 = await client.responses.create({ model: process.env.RESPONSES_MODEL_DEFAULT || 'gpt-4.1-mini', input: 'Gmail のツール一覧だけを教えてください。', tools: [gmail2], temperature: 0 });
        const all2 = listAllGmailTools(resp2 as any);
        allowed = pickGmailReadOnlyTools(resp2 as any);
        console.log('✅ list_tools success after refresh. ALL tools=', all2);
        console.log('ℹ️ read-only subset (list/search/messages/threads)=', allowed);
      } catch (e2: any) {
        console.error('❌ list_tools retry failed:', e2?.status, e2?.code, e2?.type, e2?.error?.message);
      }
    }
  }

  // Step 2: minimal unread INBOX list (last 2 days)
  console.log('\n[Step2] Minimal INBOX unread list (last 2 days)');
  try {
    if (allowed.length > 0) gmailTool.allowed_tools = allowed;
    const prompt = [
      '過去2日間のINBOXの未読メール一覧を読み取り専用ツールで取得してください。',
      '出力は日本語、次の1行形式で番号付きで出力:',
      'N. 件名 — 送信者（YYYY-MM-DD HH:mm） [id:<messageId>]',
      '説明や謝罪文は不要。書き込み操作は禁止。'
    ].join('\n');
    const resp = await client.responses.create({
      model: process.env.RESPONSES_MODEL_DEFAULT || 'gpt-4.1-mini',
      input: prompt,
      tools: [gmailTool],
      temperature: 0,
    });
    const text = (resp as any).output_text ?? '';
    console.log('✅ unread list text (head):\n', text.slice(0, 600));
  } catch (e: any) {
    console.error('❌ unread list error:', e?.status, e?.code, e?.type, e?.error?.message);
  }

  console.log('\n--- Gmail Diagnosis END ---');
}

main().catch((e) => {
  console.error('❌ Fatal in diagnosis:', redact(e));
  process.exit(1);
});
