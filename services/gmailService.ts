import axios from 'axios';
import OpenAI from 'openai';
import util from 'util';
import { getEnvironmentVariable } from '../config/environment';
import { getGoogleAccessTokenForScope } from './googleTokenProvider';
import { DraftData } from '../models/draftStore';
import { getMcpTool } from '../getMcpTool';
import { logger } from '../utils/logger';

function isTruthyEnv(value?: string): boolean {
  if (!value) return false;
  const trimmed = value.trim().toLowerCase();
  return trimmed === '1' || trimmed === 'true' || trimmed === 'yes' || trimmed === 'on';
}

function buildPdHeaders(token: string) {
  return {
    Authorization: `Bearer ${token}`,
    'Content-Type': 'application/json',
    'x-pd-project-id': getEnvironmentVariable('PIPEDREAM_PROJECT_ID'),
    'x-pd-environment': getEnvironmentVariable('PIPEDREAM_ENVIRONMENT'),
    'x-pd-external-user-id': getEnvironmentVariable('PIPEDREAM_EXTERNAL_USER_ID'),
    'x-pd-app-slug': 'gmail',
  };
}

async function discoverGmailDraftActions(token: string): Promise<string[]> {
  const baseUrl = getEnvironmentVariable('MCP_BASE_URL', 'https://remote.mcp.pipedream.net');
  const timeoutMs = Number(getEnvironmentVariable('MCP_HTTP_TIMEOUT_MS', '6000'));
  const headers = buildPdHeaders(token);
  const paths: string[] = [];
  const bases = baseUrl.includes('/v1') ? [baseUrl] : [baseUrl, `${baseUrl.replace(/\/$/, '')}/v1`];
  // List app-specific actions
  try {
    let r1;
    for (const b of bases) {
      try { r1 = await axios.get(`${b}/actions/gmail`, { headers, timeout: timeoutMs }); break; } catch (e) { r1 = undefined; }
    }
    if (!r1) throw new Error('actions_gmail_discovery_failed');
    const data = r1.data;
    const push = (name?: string) => { if (typeof name === 'string') paths.push(`/actions/gmail/${name}`); };
    if (Array.isArray(data)) data.forEach((n) => push(typeof n === 'string' ? n : (n?.name)));
    else if (data && Array.isArray(data?.actions)) data.actions.forEach((a: any) => push(typeof a === 'string' ? a : a?.name));
  } catch (e: any) {
    console.info('[gmailService] discovery /actions/gmail skipped:', e?.code || e?.message || 'unknown');
  }
  // Fallback: all actions then filter
  if (paths.length === 0) {
    try {
      let r2;
      for (const b of bases) {
        try { r2 = await axios.get(`${b}/actions`, { headers, timeout: timeoutMs }); break; } catch (e) { r2 = undefined; }
      }
      if (!r2) throw new Error('actions_discovery_failed');
      const pushIf = (p?: string) => { if (typeof p === 'string' && /\/actions\/gmail\//.test(p)) paths.push(p); };
      const data2 = r2.data;
      if (Array.isArray(data2)) {
        for (const entry of data2) {
          if (typeof entry === 'string') pushIf(entry);
          else if (entry && typeof entry === 'object') pushIf((entry as any).path || (entry as any).url);
        }
      } else if (data2 && Array.isArray(data2?.actions)) {
        for (const a of data2.actions) pushIf(typeof a === 'string' ? a : (a.path || a.url || `/actions/gmail/${a.name}`));
      }
    } catch (e: any) {
      console.info('[gmailService] discovery /actions skipped:', e?.code || e?.message || 'unknown');
    }
  }
  // Only draft-like, avoid send
  const uniq = Array.from(new Set(paths));
  return uniq.filter((p) => /draft/i.test(p) && !/send/i.test(p));
}

export async function createGmailDraft(token: string, draft: DraftData) {
  const baseUrl = getEnvironmentVariable('MCP_BASE_URL', 'https://remote.mcp.pipedream.net');
  const configured = getEnvironmentVariable('GMAIL_CREATE_DRAFT_ACTION', '/actions/gmail/create_draft');
  const timeoutMs = Number(getEnvironmentVariable('MCP_HTTP_TIMEOUT_MS', '8000'));
  const headers = buildPdHeaders(token);
  const bases = baseUrl.includes('/v1') ? [baseUrl] : [baseUrl, `${baseUrl.replace(/\/$/, '')}/v1`];
  // Pipedream official action (components/gmail/actions/create-draft/create-draft.mjs)
  // expects: to, cc, bcc, subject, body, bodyType, attachments, inReplyTo, mimeType, fromEmail, signature
  // We send the minimal required fields; unknown props may be rejected by some gateways, so avoid custom keys like threadId.
  const data: Record<string, any> = {
    to: draft.to,
    subject: draft.subject,
    body: draft.body,
  };
  console.log('🚀 [gmailService] Gmail 下書き作成リクエスト開始');
  // Try a broad set of common action paths (underscore/hyphen variants included)
  const candidates = [
    configured,
    '/actions/gmail/create_draft',
    '/actions/gmail/create-draft',
    '/actions/gmail/gmail-create-draft',
    '/actions/gmail/drafts/create',
    '/actions/gmail/createDraft',
    '/actions/gmail/create_email_draft',
  ];
  const discovered = await discoverGmailDraftActions(token);
  const tried = new Set<string>();
  for (const p of [...new Set([...candidates, ...discovered])]) {
    if (tried.has(p)) continue;
    tried.add(p);
    try {
      let res;
      for (const b of bases) {
        console.info(`[gmailService] trying ${b}${p}`);
        try {
          res = await axios.post(`${b}${p}`, data, { headers, timeout: timeoutMs });
          if (res) break;
        } catch (e: any) {
          if (e?.response?.status === 404 || e?.code === 'ECONNABORTED') {
            console.info(`[gmailService] ${b}${p} -> ${e?.response?.status || e?.code}`);
            continue;
          }
          // If we get other HTTP errors, try next base or next path
          console.warn(`[gmailService] ${b}${p} HTTP error:`, e?.response?.status || e?.code || e?.message);
          continue;
        }
      }
      if (!res) { throw { response: { status: 404 } }; }
      console.log('✅ [gmailService] Gmail 下書き作成成功 via', p);
      return res;
    } catch (e: any) {
      if (e?.response?.status === 404) {
        console.info(`[gmailService] 404 for ${p}; trying next`);
        continue;
      } else if (e?.code === 'ECONNABORTED') {
        console.warn(`[gmailService] timeout for ${p}; trying next`);
        continue;
      } else if (e?.response?.status) {
        console.warn(`[gmailService] HTTP ${e.response.status} for ${p}; body=${JSON.stringify(e.response.data || {})}`);
        continue;
      }
      throw e;
    }
  }
  throw new Error('gmail_create_draft_action_not_found');
}

type ResponsesDraftOptions = {
  forcedToolName?: string;
  modelOverride?: string;
};

function encodeHeaderUtf8(value: string): string {
  if (!value) return '';
  // If pure ASCII, keep as-is to avoid unnecessary encoding
  if (/^[\x00-\x7f]*$/.test(value)) return value;
  const b64 = Buffer.from(value, 'utf8').toString('base64');
  return `=?UTF-8?B?${b64}?=`;
}

export async function createGmailDraftViaResponses(
  token: string,
  draft: DraftData,
  options: ResponsesDraftOptions = {}
) {
  const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

  const execute = async (allowedTools?: string[], forcedTool?: string) => {
    const gmailTool = getMcpTool('gmail', token);
    const allowList = Array.from(new Set([...(allowedTools || []), ...(forcedTool ? [forcedTool] : [])])) as string[];
    if (allowList.length > 0) {
      (gmailTool as any).allowed_tools = allowList;
    }

    const chosenModel = options.modelOverride
      || process.env.RESPONSES_MODEL_CREATE_DRAFT
      || process.env.RESPONSES_MODEL_AUTODRAFT
      || process.env.RESPONSES_MODEL_DEFAULT
      || 'gpt-4.1-mini';

    const sys = [
      'あなたは Gmail の下書きを作成するオペレーターです。',
      '必ず Gmail 用 MCP ツールを呼び出し、to/subject/body（必要なら threadId）のみを渡してください。',
      '添付ファイルやその他のフィールドは渡さないでください。',
      'ツール実行後は簡潔に「OK」などの確認メッセージを返信します。',
    ].join('\n');

    const bodyBlock = draft.body || '';
    const lines = [
      '次の内容で Gmail の下書きを作成してください。',
      'to=' + (draft.to || ''),
      'subject=' + (draft.subject || ''),
      'body=<<<BODY>>>',
      bodyBlock,
      '<<<BODY>>>',
    ];
    if (draft.threadId) {
      lines.push('threadId=' + draft.threadId);
    }
    lines.push('JSON 形式の引数でツールを呼び出してください。');

    const user = lines.join('\n');

    const toolChoice: any = 'required';

    const maxTokens = Number(process.env.RESPONSES_DRAFT_MAX_OUTPUT_TOKENS || '120');

    const resp: any = await client.responses.create({
      model: chosenModel,
      input: [
        { role: 'system', content: sys },
        { role: 'user', content: user },
      ],
      tools: [gmailTool],
      tool_choice: toolChoice,
      max_output_tokens: maxTokens,
      temperature: 0,
    } as any);

    if (isTruthyEnv(process.env.DEBUG_RESPONSES_RAW)) {
      try {
        const snapshot = JSON.stringify(resp, null, 2);
        logger.debug('[gmailService][responses] raw response snapshot', snapshot);
      } catch (jsonErr) {
        logger.debug('[gmailService][responses] raw response snapshot (inspect)', util.inspect(resp, { depth: 6 }));
      }
    }

    const outputs = Array.isArray(resp?.output) ? resp.output : [];
    const mcpCalls = outputs.filter((entry: any) => entry?.type === 'mcp_call');
    const contents = outputs.flatMap((entry: any) => {
      const collected: any[] = [];
      if (entry && typeof entry === 'object' && typeof entry.type === 'string' && /tool_/.test(entry.type)) {
        collected.push(entry);
      }
      if (Array.isArray(entry?.content)) {
        collected.push(...entry.content);
      }
      return collected;
    });
    const toolUses = contents.filter((c: any) => c?.type === 'tool_use');
    const toolResults = contents.filter((c: any) => c?.type === 'tool_result');
    const firstResult = toolResults[0];
    const matchedUse = toolUses.find((u: any) => u?.id === firstResult?.tool_use_id);

    if (!firstResult || !matchedUse) {
      const listEntries = contents.filter((c: any) => c?.type === 'mcp_list_tools');
      const listed = listEntries
        .flatMap((entry: any) => Array.isArray(entry?.tools) ? entry.tools : [])
        .map((tool: any) => tool?.name || tool?.id)
        .filter((name: any) => typeof name === 'string');
      const fallback = toolUses[0]?.name ? [toolUses[0].name] : [];
      const combined = Array.from(new Set([...(listed || []), ...fallback]));
      const outputText = typeof resp?.output_text === 'string' ? resp.output_text : '';
      const successfulCall = mcpCalls.find((call: any) => !call?.error && typeof call?.name === 'string');
      if (successfulCall) {
        if (isTruthyEnv(process.env.DEBUG_RESPONSES_RAW)) {
          logger.debug('[gmailService][responses] parse via mcp_call', {
            outputText,
            mcpCallName: successfulCall.name,
            hasError: !!successfulCall.error,
          });
        }
        return {
          response: resp,
          toolName: successfulCall.name,
          toolUses: mcpCalls,
          toolResults: [],
          listedTools: [] as string[],
        };
      }
      if (isTruthyEnv(process.env.DEBUG_RESPONSES_RAW)) {
        logger.debug('[gmailService][responses] parse debug', {
          outputText,
          outputTypes: outputs.map((entry: any) => entry?.type || entry?.role || typeof entry),
          toolUseCount: toolUses.length,
          toolResultCount: toolResults.length,
          mcpCallCount: mcpCalls.length,
          mcpCallErrors: mcpCalls.map((call: any) => call?.error)?.filter(Boolean),
          run: resp?.run,
        });
      }
      console.warn('[gmailService][responses] no tool execution', { outputText, listed, fallback, rawList: listEntries });
      throw Object.assign(new Error('responses_no_tool_execution'), { listedTools: combined, outputText });
    }

    return {
      response: resp,
      toolName: matchedUse?.name,
      toolUses,
      toolResults,
      listedTools: [] as string[],
    };
  };

  try {
    return await execute(undefined, options.forcedToolName);
  } catch (err: any) {
    if (err?.message !== 'responses_no_tool_execution') throw err;
    const listed = Array.isArray(err?.listedTools) ? err.listedTools : [];
    const draftTools = listed.filter((name: string) => /draft/i.test(name));
    if (draftTools.length === 0) throw err;
    return await execute(draftTools, draftTools[0]);
  }
}

// Direct Gmail API draft creation (fallback). Uses gmail.modify scope provided via token server.
export async function createGmailDraftDirect(draft: DraftData) {
  const accessToken = await getGoogleAccessTokenForScope('https://www.googleapis.com/auth/gmail.modify');
  const url = 'https://gmail.googleapis.com/gmail/v1/users/me/drafts';
  // Build minimal RFC2822 message
  const subjectHeader = encodeHeaderUtf8(draft.subject || '');
  const lines = [
    `To: ${draft.to || ''}`,
    `Subject: ${subjectHeader}`,
    'Content-Type: text/plain; charset=UTF-8',
    'Content-Transfer-Encoding: 8bit',
    'MIME-Version: 1.0',
    '',
    draft.body || '',
  ];
  const raw = Buffer.from(lines.join('\r\n'), 'utf8')
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '');
  const payload = { message: { raw } } as any;
  if (draft.threadId) payload.message.threadId = draft.threadId;
  try {
    const res = await axios.post(url, payload, {
      headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
      timeout: Number(process.env.GMAIL_API_TIMEOUT_MS || '8000'),
    });
    console.log('✅ [gmailService] Gmail 直APIで下書き作成成功');
    return res;
  } catch (err: any) {
    if (axios.isAxiosError?.(err)) {
      const status = err.response?.status;
      const data = err.response?.data;
      const message = err.response?.data?.error?.message || err.message;
      console.error('[gmailService] Gmail 直APIで下書き作成失敗', {
        status,
        message,
        data,
        hasThread: Boolean(draft.threadId),
        bodyPreview: (draft.body || '').slice(0, 120),
      });
    } else {
      console.error('[gmailService] Gmail 直APIで下書き作成失敗', {
        message: (err as any)?.message || err,
      });
    }
    throw err;
  }
}

export async function sendGmailMail(token: string, draft: DraftData) {
  const url = 'https://remote.mcp.pipedream.net/actions/gmail/send_email';
  const headers = buildPdHeaders(token);
  const data = {
    to: draft.to,
    subject: draft.subject,
    body: draft.body,
    threadId: draft.threadId,
  };
  console.log('🚀 [gmailService] Gmail メール送信リクエスト開始');
  const res = await axios.post(url, data, { headers });
  console.log('✅ [gmailService] Gmail メール送信リクエスト成功', res.data);
  return res;
} 
