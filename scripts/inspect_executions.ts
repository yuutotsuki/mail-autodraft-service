import Database from 'better-sqlite3';
import path from 'path';

const dbPath = path.resolve(__dirname, '..', 'data', 'bot.db');
const db = new Database(dbPath, {});

const rows = db.prepare('SELECT trace_id, type, user_id, action, status, reason, created_at, updated_at FROM executions ORDER BY created_at DESC LIMIT 50').all();

if (rows.length === 0) {
  console.log('No executions found.');
  process.exit(0);
}

for (const r of rows) {
  const created = new Date(r.created_at).toISOString();
  const updated = new Date(r.updated_at).toISOString();
  console.log(`${r.status.toUpperCase()} | ${r.action} | trace_id=${r.trace_id} | created=${created} | updated=${updated}${r.reason ? ' | reason=' + r.reason : ''}`);
}

