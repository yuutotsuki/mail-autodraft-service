import { Pool } from 'pg';

type CachedToken = { email: string; refresh_token: string; expires_at: number };

let pool: Pool | null = null;
let cachedToken: CachedToken | null = null;

function getPool(): Pool | null {
  const url = process.env.DATABASE_URL;
  if (!url) return null;
  if (pool) return pool;
  const needsSsl = /render\.com|dpg-/.test(url);
  pool = new Pool({
    connectionString: url,
    ssl: needsSsl ? { rejectUnauthorized: false } : undefined,
  });
  return pool;
}

export async function getEnabledUserToken(): Promise<{ email: string; refresh_token: string } | null> {
  const url = process.env.DATABASE_URL;
  if (!url) return null;
  const now = Date.now();
  if (cachedToken && cachedToken.expires_at > now) {
    return { email: cachedToken.email, refresh_token: cachedToken.refresh_token };
  }
  const client = getPool();
  if (!client) return null;
  try {
    const res = await client.query(
      `SELECT email, refresh_token
         FROM autodraft_users
        WHERE enabled = true
        ORDER BY created_at ASC
        LIMIT 1`
    );
    const row = res.rows?.[0];
    if (!row?.refresh_token || !row?.email) return null;
    cachedToken = {
      email: row.email,
      refresh_token: row.refresh_token,
      expires_at: now + 60_000,
    };
    return { email: row.email, refresh_token: row.refresh_token };
  } catch (e: any) {
    const message = e?.message || e?.code || e;
    console.warn('[db] failed to read autodraft_users', message);
    return null;
  }
}

export async function getEnabledUsers(): Promise<Array<{ email: string; refresh_token: string }>> {
  const url = process.env.DATABASE_URL;
  if (!url) return [];
  const client = getPool();
  if (!client) return [];
  try {
    const res = await client.query(
      `SELECT email, refresh_token
         FROM autodraft_users
        WHERE enabled = true
        ORDER BY created_at ASC`
    );
    return (res.rows || []).filter((r: any) => r?.email && r?.refresh_token);
  } catch (e: any) {
    const message = e?.message || e?.code || e;
    console.warn('[db] failed to list autodraft_users', message);
    return [];
  }
}

export async function upsertAutodraftUser(email: string, refreshToken: string, enabled = true): Promise<void> {
  const client = getPool();
  if (!client) {
    throw new Error('database_url_not_configured');
  }
  await client.query(
    `INSERT INTO autodraft_users (email, refresh_token, enabled)
     VALUES ($1, $2, $3)
     ON CONFLICT (email) DO UPDATE
       SET refresh_token = EXCLUDED.refresh_token,
           enabled = EXCLUDED.enabled,
           updated_at = now()`,
    [email, refreshToken, enabled]
  );
  cachedToken = null;
}
