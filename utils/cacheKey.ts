import crypto from 'crypto';

export function sha1Hex(input: string): string {
  return crypto.createHash('sha1').update(input, 'utf8').digest('hex');
}

export interface GmailListKeyParams {
  userId: string;
  workspaceId?: string;
  mailbox?: string; // inbox or query
  query?: string;
  pageToken?: string;
  page?: number;
}

// gmail|user=U123|ws=T123|mailbox=inbox|qsha=abcd...|pageToken=... (or page=1)
export function buildGmailListCacheKey(p: GmailListKeyParams): string {
  const ws = p.workspaceId || 'unknown';
  const mailbox = p.mailbox || (p.query ? 'query' : 'inbox');
  const parts = [
    'gmail',
    `user=${p.userId}`,
    `ws=${ws}`,
    `mailbox=${mailbox}`,
  ];
  if (p.query) {
    parts.push(`qsha=${sha1Hex(p.query)}`);
  }
  if (p.pageToken) {
    parts.push(`pageToken=${p.pageToken}`);
  } else if (p.page) {
    parts.push(`page=${p.page}`);
  } else {
    parts.push(`page=1`);
  }
  return parts.join('|');
}

