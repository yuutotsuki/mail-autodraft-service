export interface EmailItem {
    id: string;
    subject: string;
    from: string;
    from_email?: string;
    index: number;
    thread_id?: string;
    date?: string;
  }
  
  export interface EmailListData {
    type: 'email_list';
    generated_at: string;
    user_id: string;
    session_id: string;
    emails: EmailItem[];
    tags: string[];
  }
  
export interface DraftData {
  body: string;
  subject?: string;
  to?: string;
  cc?: string;
  bcc?: string;
  inReplyToMessageId?: string;
  threadId?: string;
  createdAt: number;
  draftId?: string;
}
  
