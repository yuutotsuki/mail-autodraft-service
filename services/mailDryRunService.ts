import { WebClient } from '@slack/web-api';
import { DraftData, generateDraftId, saveDraft } from '../models/draftStore';

function previewBody(body: string, limit = 500): string {
  const s = body || '';
  if (s.length <= limit) return s;
  return s.slice(0, limit) + '\n…（長文のためプレビューを省略）';
}

function safeField(v?: string): string {
  const s = (v || '').trim();
  return s ? s : '_(未設定)_';
}

export async function promptMailDryRun(opts: {
  client: WebClient;
  channel: string;
  user: string;
  draft: DraftData;
  sourceText?: string; // optional: original user text for logging
  sessionId?: string; // optional: session/thread identifier
}): Promise<{ draftId: string }> {
  const { client, channel, user } = opts;
  // Save draft under a fresh id for retrieval when button is clicked
  const draftId = generateDraftId();
  saveDraft(user, draftId, opts.draft);

  const fields = [
    { type: 'mrkdwn', text: `*To:* ${safeField(opts.draft.to)}` },
    { type: 'mrkdwn', text: `*Cc:* ${safeField(opts.draft.cc)}` },
    { type: 'mrkdwn', text: `*Bcc:* ${safeField(opts.draft.bcc)}` },
    { type: 'mrkdwn', text: `*Subject:* ${safeField(opts.draft.subject)}` },
  ];

  const blocks: any[] = [
    { type: 'section', text: { type: 'mrkdwn', text: '*送信内容の確認（Dry-run）*' } },
    { type: 'section', fields },
    { type: 'section', text: { type: 'mrkdwn', text: `*本文プレビュー*\n${previewBody(opts.draft.body || '')}` } },
    { type: 'context', elements: [{ type: 'mrkdwn', text: ':warning: Dry-run。実送信は行いません。' }] },
    {
      type: 'actions',
      elements: [
        {
          type: 'button',
          text: { type: 'plain_text', text: 'OK（Dry-run実行）', emoji: true },
          style: 'primary',
          action_id: 'mail_dryrun_ok',
          value: JSON.stringify({ draft_id: draftId }),
        },
        {
          type: 'button',
          text: { type: 'plain_text', text: 'キャンセル', emoji: true },
          style: 'danger',
          action_id: 'mail_dryrun_cancel',
          value: JSON.stringify({ draft_id: draftId }),
        },
      ],
    },
  ];

  await client.chat.postEphemeral({ channel, user, text: '送信内容の確認（Dry-run）', blocks });
  try {
    const { logAction } = await import('./actionLogger.js');
    logAction({
      route: 'compose',
      shadow: true,
      user_id: user,
      raw_text: opts.sourceText,
      normalized_text: opts.sourceText,
      matched_trigger: 'compose_quick',
      match_type: 'compose_trigger',
      confidence: 0.95,
      params: { to: opts.draft.to, cc: opts.draft.cc, bcc: opts.draft.bcc, subject: opts.draft.subject },
      suggested_action: 'compose',
      result_summary: 'Dry-runカードを表示',
      session_id: opts.sessionId || null,
      error: null,
    });
  } catch {}
  return { draftId };
}

export function logDryRun(draft: DraftData) {
  const to = (draft.to || '').toString();
  const subj = (draft.subject || '').toString();
  const bytes = Buffer.byteLength((draft.body || ''), 'utf8');
  // Fixed one-line format
  console.log(`[mail.send] dryrun to=${to} subj=${subj} bytes=${bytes}`);
}
