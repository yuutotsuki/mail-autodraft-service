import process from 'process';

export function getMcpTool(toolName: string, token: string): any {
  let tool;

  switch (toolName) {
    case 'gmail':
      tool = {
        type: 'mcp',
        server_url: process.env.MCP_BASE_URL || 'https://remote.mcp.pipedream.net',
        server_label: 'Gmail',
        headers: {
          Authorization: `Bearer ${token}`,
          'x-pd-project-id': process.env.PIPEDREAM_PROJECT_ID!,
          'x-pd-environment': process.env.PIPEDREAM_ENVIRONMENT!,
          'x-pd-external-user-id': process.env.PIPEDREAM_EXTERNAL_USER_ID!,
          'x-pd-app-slug': 'gmail',
        },
        require_approval: 'never',
      };
      break;

    case 'calendar':
      tool = {
        type: 'mcp',
        server_url: process.env.MCP_BASE_URL || 'https://remote.mcp.pipedream.net',
        server_label: 'Google_Calendar',
        headers: {
          Authorization: `Bearer ${token}`,
          'x-pd-project-id': process.env.PIPEDREAM_PROJECT_ID!,
          'x-pd-environment': process.env.PIPEDREAM_ENVIRONMENT!,
          'x-pd-external-user-id': process.env.PIPEDREAM_EXTERNAL_USER_ID!,
          'x-pd-app-slug': 'google_calendar',
        },
        require_approval: 'never',
      };
      break;

    default:
      throw new Error(`未対応のMCPツール: ${toolName}`);
  }

  return tool;
}
