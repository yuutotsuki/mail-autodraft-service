export interface EmailListCacheRecord {
  cache_key: string;
  created_at: number; // UTC epoch seconds
  expires_at: number; // UTC epoch seconds
  items_json: string; // JSON string of list items
  channel?: string;
  thread_ts?: string;
}

