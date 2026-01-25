export type DraftData = {
  body: string;
  threadId?: string;
  subject?: string;
  to?: string;
  cc?: string;
  bcc?: string;
  inReplyToMessageId?: string;
  createdAt: number; // UNIXタイムスタンプ
  draftId?: string;
};

// userIdごとにdraftIdでDraftDataを管理
const draftMap: { [userId: string]: { [draftId: string]: DraftData } } = {};

// UUID生成関数（簡易版）
export function generateDraftId(): string {
  return 'draft-' + Math.random().toString(36).substr(2, 9);
}

export function saveDraft(userId: string, draftId: string, draft: DraftData): void {
  if (!draftMap[userId]) draftMap[userId] = {};
  draftMap[userId][draftId] = draft;
}

export function getDrafts(userId: string): { [draftId: string]: DraftData } {
  return draftMap[userId] || {};
}

export function deleteDraft(userId: string, draftId: string): boolean {
  if (draftMap[userId] && draftMap[userId][draftId]) {
    delete draftMap[userId][draftId];
    return true;
  }
  return false;
}

export function getLatestDraftId(userId: string): string | undefined {
  if (!draftMap[userId]) return undefined;
  const drafts = Object.entries(draftMap[userId]);
  if (drafts.length === 0) return undefined;
  drafts.sort((a, b) => b[1].createdAt - a[1].createdAt);
  return drafts[0][0];
} 
