import axios from 'axios';
import { Mutex } from 'async-mutex';
import { getEnabledUserToken } from '../db/postgres';

type TokenInfo = { access_token: string; expires_in?: number; expires_at?: number };

type TokenSource = 'cache' | 'token_server' | 'refresh' | 'unknown';

let cached: TokenInfo | null = null;
let lastSource: TokenSource = 'unknown';
const mutex = new Mutex();

function nowMs() { return Date.now(); }

function isValid(t?: TokenInfo | null): boolean {
  if (!t?.access_token) return false;
  const exp = t.expires_at ?? (t.expires_in ? nowMs() + t.expires_in * 1000 : 0);
  // Apply small safety margin (30s)
  return exp === 0 ? true : exp - 30000 > nowMs();
}

async function fetchFromTokenServer(scopeOverride?: string): Promise<TokenInfo | null> {
  const base = process.env.TOKEN_SERVER_URL;
  if (!base) return null;
  const path = process.env.TOKEN_SERVER_PATH || '/google/access-token';
  const method = (process.env.TOKEN_SERVER_METHOD || 'GET').toUpperCase();
  const scopeParam = process.env.TOKEN_SERVER_SCOPE_PARAM || 'scope';
  const scope = scopeOverride || process.env.TOKEN_SERVER_SCOPE || 'https://www.googleapis.com/auth/gmail.readonly';
  const timeout = Number(process.env.TOKEN_SERVER_TIMEOUT_MS || process.env.GMAIL_API_TIMEOUT_MS || '6000');
  const url = new URL(path, base.endsWith('/') ? base : `${base}/`);
  const headers: Record<string, string> = {};
  if (process.env.TOKEN_SERVER_AUTH_HEADER && process.env.TOKEN_SERVER_API_KEY) {
    const headerName = process.env.TOKEN_SERVER_AUTH_HEADER;
    const raw = String(process.env.TOKEN_SERVER_API_KEY);
    // Normalize: if Authorization header and value lacks 'Bearer ', prepend it
    const value = /authorization/i.test(headerName) && !/^Bearer\s+/i.test(raw) ? `Bearer ${raw}` : raw;
    headers[headerName] = value;
  }
  try {
    let res;
    if (method === 'GET') {
      url.searchParams.set(scopeParam, scope);
      res = await axios.get(url.toString(), { headers, timeout });
    } else {
      const body: any = { [scopeParam]: scope };
      res = await axios.post(url.toString(), body, { headers, timeout });
    }
    const data = res.data || {};
    if (typeof data.access_token === 'string') {
      const expires_in = typeof data.expires_in === 'number' ? data.expires_in : 1800;
      return { access_token: data.access_token, expires_in, expires_at: nowMs() + expires_in * 1000 };
    }
  } catch (e: any) {
    const status = e?.response?.status;
    const code = e?.code || e?.response?.data?.error;
    const message = e?.response?.data?.error?.message || e?.message;
    console.warn('[googleToken] token-server fetch failed', { status, code, message });
  }
  return null;
}

async function exchangeRefreshToken(refresh: string, scopeOverride?: string): Promise<TokenInfo | null> {
  const cid = process.env.GOOGLE_CLIENT_ID;
  const secret = process.env.GOOGLE_CLIENT_SECRET;
  if (!cid || !secret || !refresh) return null;
  try {
    const params = new URLSearchParams();
    params.set('client_id', cid);
    params.set('client_secret', secret);
    params.set('refresh_token', refresh);
    params.set('grant_type', 'refresh_token');
    // scope is optional for refresh grants; omit unless provided
    const scope = scopeOverride || process.env.TOKEN_SERVER_SCOPE;
    if (scope) params.set('scope', scope);
    const r = await axios.post('https://oauth2.googleapis.com/token', params.toString(), {
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      timeout: Number(process.env.GMAIL_API_TIMEOUT_MS || '6000'),
    });
    const d = r.data || {};
    if (typeof d.access_token === 'string') {
      const expires_in = typeof d.expires_in === 'number' ? d.expires_in : 3600;
      return { access_token: d.access_token, expires_in, expires_at: nowMs() + expires_in * 1000 };
    }
  } catch (e: any) {
    const status = e?.response?.status;
    const code = e?.code || e?.response?.data?.error;
    const message = e?.response?.data?.error?.message || e?.message;
    console.warn('[googleToken] refresh-token flow failed', { status, code, message });
  }
  return null;
}

export async function getGoogleAccessTokenForRefreshToken(refreshToken: string, scope?: string): Promise<string> {
  const info = await exchangeRefreshToken(refreshToken, scope);
  if (!info || !isValid(info)) {
    throw new Error('google_access_token_unavailable_for_refresh_token');
  }
  return info.access_token;
}

async function fetchFromRefreshToken(scopeOverride?: string): Promise<TokenInfo | null> {
  let refresh = process.env.GOOGLE_REFRESH_TOKEN;
  if (!refresh) {
    try {
      const dbToken = await getEnabledUserToken();
      if (dbToken?.refresh_token) {
        refresh = dbToken.refresh_token;
      }
    } catch {}
  }
  if (!refresh) return null;
  return await exchangeRefreshToken(refresh, scopeOverride);
}

export async function getGoogleAccessToken(): Promise<string> {
  return await mutex.runExclusive(async () => {
    if (isValid(cached)) return cached!.access_token;
    // Try token server first
    const fromServer = await fetchFromTokenServer();
    if (fromServer && isValid(fromServer)) {
      cached = fromServer;
      lastSource = 'token_server';
      return cached.access_token;
    }
    // Fallback to local refresh-token flow
    const fromRefresh = await fetchFromRefreshToken();
    if (fromRefresh && isValid(fromRefresh)) {
      cached = fromRefresh;
      lastSource = 'refresh';
      return cached.access_token;
    }
    throw new Error('google_access_token_unavailable');
  });
}

export function clearGoogleTokenCache() { cached = null; lastSource = 'unknown'; }

export function getLastGoogleTokenSource(): TokenSource { return lastSource; }

// Explicit scope variant for write operations like draft creation
export async function getGoogleAccessTokenForScope(scope: string): Promise<string> {
  return await mutex.runExclusive(async () => {
    // Do not reuse cached read-only token when compose is requested
    const fromServer = await fetchFromTokenServer(scope);
    if (fromServer && isValid(fromServer)) {
      return fromServer.access_token;
    }
    // Fallback: refresh-token flow (scope is usually ignored for refresh)
    const fromRefresh = await fetchFromRefreshToken();
    if (fromRefresh && isValid(fromRefresh)) {
      return fromRefresh.access_token;
    }
    throw new Error('google_access_token_unavailable_for_scope');
  });
}
