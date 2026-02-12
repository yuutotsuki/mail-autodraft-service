import axios from 'axios';
import { getGoogleAccessTokenForScope } from './googleTokenProvider';
import { DraftData } from '../models/draftStore';

function encodeHeaderUtf8(value: string): string {
  if (!value) return '';
  if (/^[\x00-\x7f]*$/.test(value)) return value;
  const b64 = Buffer.from(value, 'utf8').toString('base64');
  return `=?UTF-8?B?${b64}?=`;
}

function decodeBasicHtmlEntities(value: string): string {
  return value
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'");
}

function htmlSignatureToText(html: string): string {
  return decodeBasicHtmlEntities(
    html
      .replace(/\r\n/g, '\n')
      // Gmail signatures often use <br clear="all"> or block wrappers for line breaks.
      .replace(/<br\b[^>]*>/gi, '\n')
      .replace(/<\/?(div|p|li|tr)\b[^>]*>/gi, '\n')
      .replace(/<[^>]*>/g, '')
  )
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{2,}/g, '\n')
    .trim();
}

export async function getGmailPrimarySignatureText(accessTokenOverride?: string): Promise<string | undefined> {
  try {
    const accessToken = accessTokenOverride || await getGoogleAccessTokenForScope('https://www.googleapis.com/auth/gmail.settings.basic');
    const res = await axios.get('https://gmail.googleapis.com/gmail/v1/users/me/settings/sendAs', {
      headers: { Authorization: `Bearer ${accessToken}` },
      timeout: Number(process.env.GMAIL_API_TIMEOUT_MS || '8000'),
    });
    const list = Array.isArray(res.data?.sendAs) ? res.data.sendAs : [];
    const candidate = list.find((x: any) => x?.isPrimary) || list.find((x: any) => x?.isDefault) || list[0];
    const signatureHtml = String(candidate?.signature || '').trim();
    if (!signatureHtml) return undefined;
    const text = htmlSignatureToText(signatureHtml);
    return text || undefined;
  } catch (e: any) {
    if (process.env.LOG_VERBOSITY === 'debug') {
      console.debug('[gmailService] failed to fetch Gmail signature', e?.response?.status || e?.message || e);
    }
    return undefined;
  }
}

// Direct Gmail API draft creation. Uses gmail.modify scope.
export async function createGmailDraftDirect(draft: DraftData, accessTokenOverride?: string) {
  const accessToken = accessTokenOverride || await getGoogleAccessTokenForScope('https://www.googleapis.com/auth/gmail.modify');
  const url = 'https://gmail.googleapis.com/gmail/v1/users/me/drafts';
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
