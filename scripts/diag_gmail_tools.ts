import { initializeEnvironment } from '../config/environment';
import OpenAI from 'openai';
import { fetchConnectToken } from '../services/tokenService';
import { getMcpTool } from '../getMcpTool';

initializeEnvironment();

async function main() {
  const token = await fetchConnectToken();
  const gmailTool = getMcpTool('gmail', token);
  const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

  const resp: any = await client.responses.create({
    model: process.env.RESPONSES_MODEL_AUTODRAFT || 'gpt-4.1-mini',
    input: [
      { role: 'system', content: 'You are a diagnostic assistant. List the available Gmail MCP tools by invoking mcp_list_tools and return their names.' },
      { role: 'user', content: 'Gmail MCP の利用可能なツール一覧を教えてください。' }
    ],
    tools: [gmailTool],
    max_output_tokens: 300,
    temperature: 0,
  } as any);

  console.dir(resp?.output, { depth: null });
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
