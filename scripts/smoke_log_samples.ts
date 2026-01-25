import { logAction } from '../services/actionLogger';

function run() {
  // compose (shadow)
  logAction({
    route: 'compose',
    shadow: true,
    user_id: 'U12345',
    raw_text: '田中さんに taro@example.com へ電話して。090-1234-5678 です',
    normalized_text: '田中さんに taro@example.com へ電話して。090-1234-5678 です',
    matched_trigger: '新規メール',
    match_type: 'compose_trigger',
    confidence: 0.9,
    params: { to: 'taro@example.com', subject: '件名', body: '本文' },
    suggested_action: 'compose',
    result_summary: 'Dry-runカードを表示',
    session_id: 'C123:1720000000.000',
    error: null,
  });

  // responses (shadow)
  logAction({
    route: 'responses',
    shadow: true,
    user_id: 'U12345',
    raw_text: 'このメールに丁寧な返信案を考えて',
    normalized_text: 'このメールに丁寧な返信案を考えて',
    matched_trigger: '返信案',
    match_type: 'responses_hint',
    confidence: 0.7,
    params: null,
    suggested_action: 'reply_suggestion',
    result_summary: '返信案を提示（未送信）',
    session_id: 'C123:1720000000.000',
    error: null,
  });

  // gmail_read (exec)
  logAction({
    route: 'gmail_read',
    shadow: false,
    user_id: 'U12345',
    raw_text: '7/29 の受信一覧を見せて',
    normalized_text: '7/29 の受信一覧を見せて',
    matched_trigger: 'list_emails',
    match_type: 'phase2_list',
    confidence: 1.0,
    params: { date: '2025-07-29', mailbox: 'inbox' },
    suggested_action: 'list_emails',
    result_summary: '5件のメールを検出・保存',
    session_id: 'C123:1720000000.000',
    error: null,
  });
}

run();

