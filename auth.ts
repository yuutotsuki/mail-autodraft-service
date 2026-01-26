import express from 'express';
import axios from 'axios';
import crypto from 'crypto';
import { initializeEnvironment } from './config/environment';
import { upsertAutodraftUser } from './db/postgres';

initializeEnvironment();

const app = express();
const port = Number(process.env.PORT || '3000');
const clientId = process.env.GOOGLE_CLIENT_ID || '';
const clientSecret = process.env.GOOGLE_CLIENT_SECRET || '';
const redirectUri = process.env.GOOGLE_REDIRECT_URI || '';
const scopes = (process.env.OAUTH_SCOPES
  || 'openid email https://www.googleapis.com/auth/gmail.modify').trim();
const stateTtlMs = Number(process.env.OAUTH_STATE_TTL_SEC || '600') * 1000;

const stateStore = new Map<string, number>();

function buildAuthUrl(state: string): string {
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: scopes,
    access_type: 'offline',
    prompt: 'consent',
    include_granted_scopes: 'true',
    state,
  });
  return `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`;
}

function validateConfig(): string | null {
  if (!clientId) return 'GOOGLE_CLIENT_ID が未設定です';
  if (!clientSecret) return 'GOOGLE_CLIENT_SECRET が未設定です';
  if (!redirectUri) return 'GOOGLE_REDIRECT_URI が未設定です';
  return null;
}

app.get('/', (_req, res) => {
  res.status(200).send('Mail Autodraft OAuth Server');
});

app.get('/auth/start', (_req, res) => {
  const err = validateConfig();
  if (err) {
    res.status(500).send(err);
    return;
  }
  const state = crypto.randomBytes(16).toString('hex');
  stateStore.set(state, Date.now() + stateTtlMs);
  res.redirect(buildAuthUrl(state));
});

app.get('/auth/callback', async (req, res) => {
  const err = validateConfig();
  if (err) {
    res.status(500).send(err);
    return;
  }
  const { code, state, error } = req.query as { code?: string; state?: string; error?: string };
  if (error) {
    res.status(400).send(`OAuth error: ${error}`);
    return;
  }
  if (!code || !state) {
    res.status(400).send('missing code or state');
    return;
  }
  const exp = stateStore.get(state);
  stateStore.delete(state);
  if (!exp || exp < Date.now()) {
    res.status(400).send('invalid or expired state');
    return;
  }

  try {
    const params = new URLSearchParams({
      code,
      client_id: clientId,
      client_secret: clientSecret,
      redirect_uri: redirectUri,
      grant_type: 'authorization_code',
    });
    const tokenResp = await axios.post('https://oauth2.googleapis.com/token', params.toString(), {
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      timeout: 10000,
    });
    const refreshToken = tokenResp.data?.refresh_token as string | undefined;
    const accessToken = tokenResp.data?.access_token as string | undefined;
    if (!refreshToken) {
      res.status(400).send('refresh_token が取得できませんでした（再同意が必要な可能性があります）');
      return;
    }
    if (!accessToken) {
      res.status(400).send('access_token が取得できませんでした');
      return;
    }

    const userInfo = await axios.get('https://openidconnect.googleapis.com/v1/userinfo', {
      headers: { Authorization: `Bearer ${accessToken}` },
      timeout: 10000,
    });
    const email = String(userInfo.data?.email || '').trim();
    if (!email) {
      res.status(400).send('メールアドレスが取得できませんでした');
      return;
    }

    await upsertAutodraftUser(email, refreshToken, true);

    res.status(200).send(`登録完了: ${email}`);
  } catch (e: any) {
    const status = e?.response?.status || 500;
    const message = e?.response?.data?.error_description || e?.response?.data?.error || e?.message || 'unknown_error';
    res.status(500).send(`OAuth callback failed: ${message} (${status})`);
  }
});

app.listen(port, () => {
  console.log(`🔐 OAuth server running on port ${port}`);
});
