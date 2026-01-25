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

function pickCalendarToolsFromOutput(resp: any): string[] {
  try {
    const out = resp?.output || [];
    const names: string[] = [];
    for (const entry of out) {
      if (entry?.type === 'mcp_list_tools' && /Google_Calendar/i.test(entry?.server_label || '')) {
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
  console.log('--- Calendar Diagnosis START ---');
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

  const calendarTool = getMcpTool('calendar', token);
  const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

  // Step 1: list tools (Calendar only)
  console.log('\n[Step1] Calendar list_tools (Calendar only)');
  try {
    const resp = await client.responses.create({
      model: process.env.RESPONSES_MODEL_DEFAULT || 'gpt-4.1-mini',
      input: 'Google Calendar のツール一覧だけを教えてください。説明文は不要です。',
      tools: [calendarTool],
      temperature: 0,
    });
    const tools = pickCalendarToolsFromOutput(resp as any);
    console.log('✅ list_tools success. tools=', tools);
  } catch (e: any) {
    console.error('❌ list_tools error:', e?.status, e?.code, e?.type, e?.error?.message);
    if (e?.response?.status === 401) {
      console.log('↻ 401 detected; retrying after token refresh...');
      try {
        clearTokenCache();
        const newToken = await fetchConnectToken();
        const cal2 = getMcpTool('calendar', newToken);
        const resp2 = await client.responses.create({ model: process.env.RESPONSES_MODEL_DEFAULT || 'gpt-4.1-mini', input: 'Google Calendar のツール一覧だけを教えてください。', tools: [cal2], temperature: 0 });
        const tools2 = pickCalendarToolsFromOutput(resp2 as any);
        console.log('✅ list_tools success after refresh. tools=', tools2);
      } catch (e2: any) {
        console.error('❌ list_tools retry failed:', e2?.status, e2?.code, e2?.type, e2?.error?.message);
      }
    }
  }

  // Step 2: minimal events list (today ±1 day)
  console.log('\n[Step2] Minimal events.list (today ±1 day)');
  try {
    // Narrow to likely read-only list tools if available
    // We cannot know the exact names; let model choose but instruct tightly.
    const prompt = [
      '今日から±1日の範囲のイベント一覧を、読み取り専用ツールで取得してください。',
      '出力は日本語で、番号付きでタイトル/開始時刻/主な参加者名のみ。',
      '書き込み操作は禁止。説明文は不要です。'
    ].join('\n');
    const resp = await client.responses.create({
      model: process.env.RESPONSES_MODEL_DEFAULT || 'gpt-4.1-mini',
      input: prompt,
      tools: [calendarTool],
      temperature: 0,
    });
    const text = (resp as any).output_text ?? '';
    console.log('✅ events.list text (head):\n', text.slice(0, 400));
  } catch (e: any) {
    console.error('❌ events.list error:', e?.status, e?.code, e?.type, e?.error?.message);
  }

  console.log('\n--- Calendar Diagnosis END ---');
}

main().catch((e) => {
  console.error('❌ Fatal in diagnosis:', redact(e));
  process.exit(1);
});

