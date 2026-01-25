import OpenAI from 'openai';
import { fetchConnectToken, clearTokenCache } from './tokenService';
import { getMcpTool } from '../getMcpTool';

type ToolsStatus = {
  gmailTools: string[];
  calendarTools: string[];
  gmailHasReadOnly: boolean; // any of find/list/search/messages/threads/get_*
  gmailHasFind: boolean;
};

let cached: { status: ToolsStatus | null; checkedAt: number } = { status: null, checkedAt: 0 };

function extractTools(resp: any, labelRegex: RegExp): string[] {
  try {
    const out = resp?.output || [];
    const names: string[] = [];
    for (const entry of out) {
      if (entry?.type === 'mcp_list_tools' && labelRegex.test(entry?.server_label || '')) {
        const tools = entry?.tools || [];
        for (const t of tools) {
          const name = t?.name || '';
          if (typeof name === 'string' && name) names.push(name);
        }
      }
    }
    return Array.from(new Set(names));
  } catch {
    return [];
  }
}

function getClient(): OpenAI {
  return new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
}

export async function refreshToolsStatus(): Promise<ToolsStatus> {
  let token: string;
  token = await fetchConnectToken();
  const gmail = getMcpTool('gmail', token);
  const calendar = getMcpTool('calendar', token);
  const client = getClient();
  try {
    const resp = await client.responses.create({
      model: process.env.RESPONSES_MODEL_DEFAULT || 'gpt-4.1-mini',
      input: 'List available tools only.',
      tools: [gmail, calendar],
      temperature: 0,
    });
    const gmailTools = extractTools(resp, /gmail/i);
    const calendarTools = extractTools(resp, /Google_Calendar/i);
    const hasFind = gmailTools.some((n) => /find/i.test(n));
    const hasReadOnly = gmailTools.some((n) => /(find|list|search|messages|threads|get_?message|get_?thread)/i.test(n));
    const status: ToolsStatus = { gmailTools, calendarTools, gmailHasReadOnly: hasReadOnly, gmailHasFind: hasFind };
    cached = { status, checkedAt: Date.now() };
    return status;
  } catch (e: any) {
    if (e?.response?.status === 401) {
      clearTokenCache();
      const t2 = await fetchConnectToken();
      const gmail2 = getMcpTool('gmail', t2);
      const calendar2 = getMcpTool('calendar', t2);
      const client2 = getClient();
      const resp2 = await client2.responses.create({ model: process.env.RESPONSES_MODEL_DEFAULT || 'gpt-4.1-mini', input: 'List available tools only.', tools: [gmail2, calendar2], temperature: 0 });
      const gmailTools = extractTools(resp2, /gmail/i);
      const calendarTools = extractTools(resp2, /Google_Calendar/i);
      const hasFind = gmailTools.some((n) => /find/i.test(n));
      const hasReadOnly = gmailTools.some((n) => /(find|list|search|messages|threads|get_?message|get_?thread)/i.test(n));
      const status: ToolsStatus = { gmailTools, calendarTools, gmailHasReadOnly: hasReadOnly, gmailHasFind: hasFind };
      cached = { status, checkedAt: Date.now() };
      return status;
    }
    throw e;
  }
}

export function getCachedToolsStatus(): ToolsStatus | null {
  const ttlMs = 10 * 60 * 1000; // 10 minutes
  if (cached.status && Date.now() - cached.checkedAt < ttlMs) return cached.status;
  return null;
}

