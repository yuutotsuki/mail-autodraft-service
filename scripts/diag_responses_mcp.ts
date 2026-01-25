import { initializeEnvironment } from '../config/environment';
import OpenAI from 'openai';
import { fetchConnectToken } from '../services/tokenService';
import { getMcpTool } from '../getMcpTool';

initializeEnvironment();

async function main() {
  const token = await fetchConnectToken();
  const tool = getMcpTool('gmail', token);
  // Do not execute tools; just ensure handshake works
  const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  console.log('[diag_responses_mcp] model=', process.env.RESPONSES_MODEL_AUTODRAFT || 'gpt-4.1');
  try {
    const resp: any = await client.responses.create({
      model: process.env.RESPONSES_MODEL_AUTODRAFT || 'gpt-4.1',
      input: [{ role: 'user', content: 'Say ok.' }],
      tools: [tool],
      tool_choice: 'none',
      max_output_tokens: 16,
      temperature: 0,
    } as any);
    console.log('[diag_responses_mcp] ok: output_text.len=', String(resp?.output_text || '').length);
  } catch (e: any) {
    console.log('[diag_responses_mcp] error:', {
      status: e?.status || e?.response?.status,
      code: e?.code || e?.error?.code,
      reqId: e?.request_id,
      message: e?.error?.message || e?.message,
    });
    process.exit(1);
  }
}

main();

