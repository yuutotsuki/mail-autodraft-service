import { SayFn } from '@slack/bolt';
import { createExecution } from '../db/sqlite';
import { generateTraceId } from '../utils/ids';
import { DraftData } from '../models/draftStore';
import { ExecutionRecord } from '../types/execution';
import { hashUserId, logAction } from '../utils/actionLogger';
import { cleanEmailLike } from '../utils/text';

export type SafetyActionType = 'gmail_send' | 'gmail_draft' | 'calendar_create';

export function buildSummary(draft: DraftData): { to?: string; subject?: string; bodyPreview?: string } {
  const body = draft.body || '';
  const preview = body.length > 60 ? body.slice(0, 60) + '…' : body;
  const toClean = cleanEmailLike(draft.to) || draft.to;
  return { to: toClean, subject: draft.subject, bodyPreview: preview };
}

interface ConfirmationOptions {
  draftId?: string;
}

export async function promptUserConfirmation(
  say: SayFn,
  userId: string,
  actionType: SafetyActionType,
  draft: DraftData,
  options: ConfirmationOptions = {}
): Promise<{ traceId: string; postTs?: string }> {
  const traceId = generateTraceId('exec');
  const summary = buildSummary(draft);
  const primaryLabel = actionType === 'gmail_draft' ? '保存' : actionType === 'gmail_send' ? '送信' : 'OK';

  const record: Omit<ExecutionRecord, 'created_at' | 'updated_at'> = {
    trace_id: traceId,
    type: actionType,
    user_id: userId,
    action: actionType === 'gmail_send' ? 'Gmail送信' : actionType === 'gmail_draft' ? 'Gmail下書き作成' : 'Calendar作成',
    params: { to: summary.to, subject: summary.subject, body: draft.body, threadId: draft.threadId, draftId: options.draftId },
    status: 'pending',
    reason: undefined,
    channel: undefined,
    message_ts: undefined,
  };
  createExecution(record);

  const blocks = [
    {
      type: 'section',
      text: { type: 'mrkdwn', text: `実行前の確認が必要です。\n*アクション:* ${record.action}\n*trace_id:* ${traceId}` },
    },
    {
      type: 'section',
      fields: [
        { type: 'mrkdwn', text: `*宛先:* ${summary.to || '(未設定)'}` },
        { type: 'mrkdwn', text: `*件名:* ${summary.subject || '(未設定)'}` },
        { type: 'mrkdwn', text: `*本文(先頭):* ${summary.bodyPreview || '(なし)'}` },
      ],
    },
    {
      type: 'actions',
      elements: [
        {
          type: 'button',
          text: { type: 'plain_text', text: primaryLabel, emoji: true },
          style: 'primary',
          action_id: 'safety_confirm',
          value: JSON.stringify({ trace_id: traceId }),
        },
        {
          type: 'button',
          text: { type: 'plain_text', text: 'キャンセル', emoji: true },
          style: 'danger',
          action_id: 'safety_cancel',
          value: JSON.stringify({ trace_id: traceId, reason: 'ユーザー操作' }),
        },
      ],
    },
  ];

  const res = (await say({ text: '実行前の確認', blocks })) as any;
  try {
    logAction({
      route: 'safety_prompt',
      trace_id: traceId,
      user_id_hashed: hashUserId(userId),
      params: { to: summary.to, subject: summary.subject, body_head: summary.bodyPreview },
      result_summary: `${record.action}の確認UIを表示`,
      shadow: true,
      matched_trigger: null,
      match_type: 'safety_gate',
    });
  } catch {}
  return { traceId, postTs: res?.ts };
}
