const userConversations: Record<string, string[]> = {};

export function getHistory(userId: string): string[] {
  return userConversations[userId] ?? [];
}

export function setHistory(userId: string, history: string[]) {
  userConversations[userId] = history;
}

export function appendToHistory(userId: string, message: string) {
  const history = getHistory(userId);
  history.push(message);
  userConversations[userId] = history;
}

export function clearHistory(userId: string) {
  delete userConversations[userId];
} 