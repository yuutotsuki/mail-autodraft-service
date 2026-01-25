export type ExecutionStatus = 'pending' | 'confirmed' | 'canceled' | 'executed';

export interface PendingParams {
  to?: string;
  subject?: string;
  body?: string;
  threadId?: string;
  draftId?: string;
}

export interface ExecutionRecord {
  trace_id: string;
  type: 'gmail_send' | 'gmail_draft' | 'calendar_create';
  user_id: string;
  action: string; // human readable action label
  params: PendingParams;
  digest?: string; // 要約ダイジェスト（to/subject/body先頭）
  expires_at?: number; // 期限（epoch ms）
  status: ExecutionStatus;
  reason?: string;
  channel?: string;
  message_ts?: string;
  created_at: number;
  updated_at: number;
}
