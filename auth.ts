import express from 'express';
import axios from 'axios';
import crypto from 'crypto';
import path from 'path';
import { initializeEnvironment } from './config/environment';
import {
  disconnectAutodraftUser,
  getAutodraftUserCount,
  getAutodraftUserByEmail,
  updateAutodraftUserEnabled,
  upsertAutodraftUser,
} from './db/postgres';

initializeEnvironment();

const app = express();
app.use(express.urlencoded({ extended: false }));
const port = Number(process.env.PORT || '3000');
const clientId = process.env.GOOGLE_CLIENT_ID || '';
const clientSecret = process.env.GOOGLE_CLIENT_SECRET || '';
const redirectUri = process.env.GOOGLE_REDIRECT_URI || '';
const scopes = (process.env.OAUTH_SCOPES
  || 'openid email https://www.googleapis.com/auth/gmail.modify').trim();
const stateTtlMs = Number(process.env.OAUTH_STATE_TTL_SEC || '600') * 1000;

const stateStore = new Map<string, number>();
const settingsStore = new Map<string, { email: string; expiresAt: number }>();
const settingsTtlMs = Number(process.env.OAUTH_SETTINGS_TTL_SEC || '1800') * 1000;

function buildSettingsToken(email: string): string {
  const token = crypto.randomBytes(16).toString('hex');
  settingsStore.set(token, { email, expiresAt: Date.now() + settingsTtlMs });
  return token;
}

function consumeSettingsToken(token: string): string | null {
  const entry = settingsStore.get(token);
  settingsStore.delete(token);
  if (!entry || entry.expiresAt < Date.now()) return null;
  return entry.email;
}

function renderSettingsPage(params: { email: string; enabled: boolean; message?: string; token: string }): string {
  const { email, enabled, message, token } = params;
  const statusLabel = enabled ? 'ON' : 'OFF';
  const statusText = enabled ? '下書き自動作成は有効です' : '下書き自動作成は停止中です';
  const buttonText = enabled ? '停止する' : '再開する';
  const nextEnabled = enabled ? 'false' : 'true';
  return `<!doctype html>
<html lang="ja">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>つきのーと | 設定</title>
  <style>
    :root {
      --bg: #fff6f6;
      --ink: #2b1f2a;
      --accent: #c23a5f;
      --accent-dark: #8f2745;
      --accent-soft: #ffd8e5;
      --card: #fff;
      --muted: #6b5d64;
      --shadow: 0 16px 50px rgba(194, 58, 95, 0.18);
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      font-family: "Hiragino Kaku Gothic ProN", "Meiryo", "Avenir Next", sans-serif;
      color: var(--ink);
      background:
        radial-gradient(1200px 700px at 80% 15%, #ffffff 0%, #fff3f7 52%, #ffe8f1 100%),
        linear-gradient(135deg, var(--bg), #ffe9f2);
      min-height: 100vh;
      display: grid;
      place-items: center;
      padding: 32px 18px;
    }
    .card {
      width: min(520px, 100%);
      background: var(--card);
      border-radius: 20px;
      padding: 28px 24px;
      box-shadow: var(--shadow);
      border: 1px solid rgba(194, 58, 95, 0.08);
    }
    h1 {
      margin: 0 0 6px;
      font-size: 26px;
    }
    .email {
      font-size: 13px;
      color: var(--muted);
      margin-bottom: 16px;
    }
    .status {
      display: flex;
      align-items: center;
      gap: 12px;
      background: rgba(194, 58, 95, 0.08);
      padding: 12px 14px;
      border-radius: 14px;
      margin-bottom: 18px;
    }
    .pill {
      background: ${enabled ? 'var(--accent)' : 'rgba(194, 58, 95, 0.35)'};
      color: #fff;
      padding: 4px 10px;
      border-radius: 999px;
      font-weight: 700;
      font-size: 12px;
    }
    .message {
      font-size: 13px;
      color: var(--muted);
      margin: 8px 0 0;
    }
    button {
      width: 100%;
      margin-top: 14px;
      padding: 12px 16px;
      border-radius: 999px;
      border: none;
      background: linear-gradient(135deg, var(--accent) 0%, #e04f77 100%);
      color: #fff;
      font-weight: 600;
      cursor: pointer;
      box-shadow: 0 12px 30px rgba(194, 58, 95, 0.28);
    }
    .disconnect {
      margin-top: 18px;
      background: linear-gradient(135deg, #b3193e 0%, #e04f77 100%);
      box-shadow: 0 12px 26px rgba(179, 25, 62, 0.32);
    }
    .danger-note {
      margin-top: 8px;
      font-size: 12px;
      color: #8f2745;
    }
    .note {
      margin-top: 14px;
      font-size: 12px;
      color: var(--muted);
      line-height: 1.6;
    }
  </style>
</head>
<body>
  <div class="card">
    <h1>設定</h1>
    <div class="email">${email}</div>
    <div class="status">
      <span class="pill">${statusLabel}</span>
      <div>${statusText}</div>
    </div>
    ${message ? `<div class="message">${message}</div>` : ''}
    <form method="post" action="/settings">
      <input type="hidden" name="token" value="${token}" />
      <input type="hidden" name="enabled" value="${nextEnabled}" />
      <button type="submit">${buttonText}</button>
    </form>
    <form method="post" action="/settings/disconnect">
      <input type="hidden" name="token" value="${token}" />
      <button class="disconnect" type="submit">Google連携を解除する</button>
      <div class="danger-note">この操作は取り消せません。再開するには再度Googleで接続が必要です。</div>
    </form>
    <div class="note">反映には数分かかることがあります。</div>
    <div class="note">下書の対象は<strong>直近3日以内</strong>の未読メールのみです。</div>
  </div>
</body>
</html>`;
}

function renderCapacityFullPage(): string {
  return `<!doctype html>
<html lang="ja">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>満員です | つきのーと</title>
  <style>
    body {
      margin: 0;
      font-family: "Hiragino Kaku Gothic ProN", "Meiryo", "Avenir Next", sans-serif;
      background: #fff6f6;
      color: #2b1f2a;
      display: grid;
      place-items: center;
      min-height: 100vh;
      padding: 24px;
    }
    .card {
      width: min(520px, 100%);
      background: #fff;
      border-radius: 20px;
      padding: 28px 24px;
      box-shadow: 0 16px 50px rgba(194, 58, 95, 0.18);
      border: 1px solid rgba(194, 58, 95, 0.08);
      text-align: center;
    }
    h1 { margin: 0 0 10px; font-size: 24px; }
    p { margin: 8px 0; color: #6b5d64; line-height: 1.7; }
    a {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      margin-top: 18px;
      padding: 10px 20px;
      border-radius: 999px;
      background: linear-gradient(135deg, #c23a5f 0%, #e04f77 100%);
      color: #fff;
      text-decoration: none;
      font-weight: 600;
      box-shadow: 0 12px 30px rgba(194, 58, 95, 0.28);
    }
  </style>
</head>
<body>
  <div class="card">
    <h1>ただいま満員です</h1>
    <p>テスト運用のため、現在は先着5名までの受付です。</p>
    <p>空きができたら、もう一度お試しください。</p>
    <a href="/">入口に戻る</a>
  </div>
</body>
</html>`;
}

const landingHtml = `<!doctype html>
<html lang="ja">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>ai mail auto draft service</title>
  <style>
    :root {
      --bg: #fff6f6;
      --ink: #2b1f2a;
      --accent: #c23a5f;
      --accent-dark: #8f2745;
      --accent-soft: #ffd8e5;
      --sky: #ffeef4;
      --cloud: #fff;
      --line: rgba(194, 58, 95, 0.18);
      --card: #fff;
      --muted: #6b5d64;
      --shadow: 0 16px 50px rgba(194, 58, 95, 0.18);
    }

    * { box-sizing: border-box; }
    body {
      margin: 0;
      font-family: "Hiragino Mincho ProN", "Yu Mincho", "Avenir Next", "Georgia", serif;
      color: var(--ink);
      background:
        radial-gradient(1200px 700px at 80% 15%, #ffffff 0%, #fff3f7 52%, #ffe8f1 100%),
        linear-gradient(135deg, var(--bg), #ffe9f2);
      min-height: 100vh;
    }

    .page {
      max-width: 1100px;
      margin: 0 auto;
      padding: 48px 24px 72px;
      position: relative;
    }

    .sky {
      position: absolute;
      inset: 0;
      background-image:
        repeating-linear-gradient(135deg, rgba(255, 255, 255, 0.42) 0 10px, rgba(255, 255, 255, 0) 10px 26px);
      opacity: 0.65;
      pointer-events: none;
    }

    header {
      position: relative;
      z-index: 1;
    }

    .brand {
      display: inline-flex;
      align-items: center;
      gap: 12px;
      font-weight: 600;
      letter-spacing: 0.08em;
      text-transform: uppercase;
      font-size: 12px;
      color: var(--accent-dark);
    }

    .brand .dot {
      width: 10px;
      height: 10px;
      background: var(--accent);
      border-radius: 999px;
      box-shadow: 0 0 0 6px rgba(194, 58, 95, 0.12);
    }

    .hero {
      display: grid;
      grid-template-columns: minmax(0, 1fr) minmax(0, 420px);
      gap: 48px;
      margin-top: 24px;
      align-items: center;
      position: relative;
      z-index: 1;
    }

    h1 {
      font-size: clamp(40px, 6vw, 72px);
      margin: 12px 0 8px;
      letter-spacing: 0.04em;
    }

    .subtitle {
      font-family: "Hiragino Kaku Gothic ProN", "Meiryo", "Avenir Next", sans-serif;
      color: var(--muted);
      font-size: clamp(16px, 2.3vw, 22px);
      margin: 0 0 24px;
    }

    .lead {
      font-family: "Hiragino Kaku Gothic ProN", "Meiryo", "Avenir Next", sans-serif;
      font-size: 16px;
      line-height: 1.9;
      background: var(--card);
      padding: 18px 20px;
      border-radius: 18px;
      box-shadow: var(--shadow);
      border: 1px solid rgba(194, 58, 95, 0.08);
    }

    .lead strong {
      color: var(--accent-dark);
    }

    .cta {
      margin-top: 26px;
      display: flex;
      align-items: center;
      gap: 16px;
      flex-wrap: wrap;
    }

    .cta a {
      display: inline-flex;
      align-items: center;
      gap: 10px;
      padding: 14px 28px;
      border-radius: 999px;
      background: linear-gradient(135deg, var(--accent) 0%, #e04f77 100%);
      color: #fff;
      text-decoration: none;
      font-family: "Hiragino Kaku Gothic ProN", "Meiryo", sans-serif;
      font-weight: 600;
      box-shadow: 0 18px 40px rgba(194, 58, 95, 0.35);
      transition: transform 0.2s ease, box-shadow 0.2s ease;
    }

    .cta a:hover {
      transform: translateY(-2px);
      box-shadow: 0 22px 50px rgba(194, 58, 95, 0.42);
    }

    .toggle {
      display: inline-flex;
      align-items: center;
      gap: 10px;
      padding: 10px 14px;
      border-radius: 999px;
      border: 1px solid rgba(194, 58, 95, 0.2);
      background: rgba(255, 255, 255, 0.7);
      font-family: "Hiragino Kaku Gothic ProN", "Meiryo", sans-serif;
      font-size: 13px;
    }

    .toggle .pill {
      width: 44px;
      height: 24px;
      border-radius: 999px;
      background: var(--accent-soft);
      position: relative;
      box-shadow: inset 0 0 0 1px rgba(194, 58, 95, 0.25);
    }

    .toggle .pill::after {
      content: "";
      width: 20px;
      height: 20px;
      border-radius: 50%;
      background: var(--accent);
      position: absolute;
      top: 2px;
      left: 2px;
      box-shadow: 0 3px 8px rgba(194, 58, 95, 0.4);
    }

    .toggle .note {
      color: var(--muted);
      font-size: 12px;
    }

    .panel {
      margin-top: 36px;
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(240px, 1fr));
      gap: 18px;
      font-family: "Hiragino Kaku Gothic ProN", "Meiryo", sans-serif;
    }

    .card {
      background: var(--card);
      border-radius: 16px;
      padding: 18px;
      box-shadow: 0 12px 30px rgba(194, 58, 95, 0.12);
      border: 1px solid rgba(194, 58, 95, 0.08);
    }

    .card h3 {
      margin: 0 0 10px;
      font-size: 14px;
      letter-spacing: 0.08em;
      text-transform: uppercase;
      color: var(--accent-dark);
    }

    .tag {
      display: inline-block;
      padding: 6px 10px;
      border-radius: 999px;
      background: rgba(194, 58, 95, 0.12);
      color: var(--accent-dark);
      font-weight: 600;
      font-size: 12px;
      margin-right: 6px;
    }

    .note {
      color: var(--muted);
      font-size: 13px;
      line-height: 1.7;
    }

    .steps {
      margin-top: 28px;
      font-family: "Hiragino Kaku Gothic ProN", "Meiryo", sans-serif;
    }

    .steps h2 {
      margin: 0 0 12px;
      font-size: 14px;
      letter-spacing: 0.12em;
      text-transform: uppercase;
      color: var(--accent-dark);
    }

    .steps .list {
      background: var(--card);
      border-radius: 16px;
      padding: 18px 20px;
      box-shadow: 0 12px 30px rgba(194, 58, 95, 0.12);
      border: 1px solid rgba(194, 58, 95, 0.08);
    }

    .steps ol {
      margin: 0;
      padding-left: 20px;
      display: grid;
      gap: 12px;
      color: var(--muted);
      line-height: 1.7;
      font-size: 14px;
    }

    .badge {
      display: inline-flex;
      align-items: center;
      padding: 4px 10px;
      border-radius: 999px;
      background: rgba(194, 58, 95, 0.15);
      color: var(--accent-dark);
      font-weight: 600;
      font-size: 12px;
      margin-left: 6px;
    }

    .disclaimer {
      margin-top: 28px;
      background: rgba(255, 255, 255, 0.7);
      border: 1px dashed rgba(194, 58, 95, 0.2);
      border-radius: 14px;
      padding: 14px 18px;
      font-family: "Hiragino Kaku Gothic ProN", "Meiryo", sans-serif;
      font-size: 12px;
      line-height: 1.7;
      color: var(--muted);
    }

    .figure {
      position: relative;
      display: flex;
      justify-content: center;
      align-items: center;
    }

    .figure img {
      width: min(380px, 100%);
      border-radius: 28px;
      box-shadow: 0 30px 60px rgba(194, 58, 95, 0.25);
      transform: translateX(-12px);
      animation: float 6s ease-in-out infinite;
      background: var(--cloud);
      padding: 18px;
    }

    .glow {
      position: absolute;
      inset: 0;
      background: radial-gradient(circle at 60% 40%, rgba(255, 255, 255, 0.9), rgba(255, 255, 255, 0));
      opacity: 0.8;
      filter: blur(40px);
      z-index: -1;
    }

    footer {
      margin-top: 28px;
      font-family: "Hiragino Kaku Gothic ProN", "Meiryo", sans-serif;
      font-size: 12px;
      color: var(--muted);
      text-align: center;
    }

    @keyframes float {
      0%, 100% { transform: translate(-12px, 0); }
      50% { transform: translate(-12px, -12px); }
    }

    @media (max-width: 900px) {
      .hero {
        grid-template-columns: 1fr;
      }
      .figure {
        order: -1;
        margin-bottom: 12px;
      }
      .figure img {
        transform: none;
        width: min(420px, 100%);
      }
      .cta {
        justify-content: flex-start;
      }
    }

    @media (prefers-reduced-motion: reduce) {
      .figure img { animation: none; }
      .cta a { transition: none; }
    }
  </style>
</head>
<body>
  <div class="page">
    <div class="sky"></div>
    <header>
      <div class="brand">
        <span class="dot"></span>
        Moon AI Studio
      </div>
    </header>

    <main class="hero">
      <section>
        <h1>AI Mail Auto Draft Service</h1>
        <p class="subtitle">AIがあなたのメールに下書</p>
        <div class="lead">
          Gmailの未読メールから、返信の<strong>下書きだけ</strong>をそっと作成します。<br />
          送信はしません。あなたのタイミングで、安心して整えられます。
        </div>

        <div class="cta">
          <a href="/auth/start" aria-label="Googleで接続">Googleで接続</a>
        </div>

        <div class="note" style="margin-top: 8px;">
          設定ページを開くには、まずGoogleで接続してください。
        </div>
        <div class="note" style="margin-top: 6px;">
          ※ テスト運用のため、先着3名までの受付です。
        </div>

        <div class="steps">
          <h2>導入は3ステップ</h2>
          <div class="list">
            <ol>
              <li>
                Gmailでラベルを2つ作成
                <span class="tag">ai-draft-allow</span>
                <span class="tag">autodraft-processed</span>
              </li>
              <li>「Googleで接続」を押す（OAuth）</li>
              <li>
                ai-draft-allow を付けた未読メールに返信下書きを自動作成
                <span class="badge">送信しません</span>
              </li>
            </ol>
          </div>
        </div>

        <div class="panel">
          <div class="card">
            <h3>How it works</h3>
            <div class="note">
              「ラベルを付けたメールだけ処理」<br />
              <span class="tag">ai-draft-allow</span>
              未読メールに付けると下書きを作成します。
            </div>
          </div>
          <div class="card">
            <h3>Safety</h3>
            <div class="note">
              <span class="tag">autodraft-processed</span>
              下書き作成後に自動付与され、二重作成を防ぎます。
            </div>
          </div>
          <div class="card">
            <h3>Permission</h3>
            <div class="note">
              Gmail権限 <strong>gmail.modify</strong> は、
              下書き作成とラベル付与のためだけに使います。
            </div>
          </div>
        </div>
      </section>

      <section class="figure">
        <div class="glow"></div>
        <img src="/assets/tsuki.png" alt="AIアイドル 月" />
      </section>
    </main>

    <div class="disclaimer">
      このサービスは非エンジニアが趣味で作ったものです。内容の正確性や結果についての最終判断・責任は、利用者ご本人にあります。
      また、予告なく停止・終了する場合があります。
    </div>

    <footer>
      キャラクターはこちらを使用しています。Live2Dモデル：KenKenMo6（X: @KenKenMo6）
    </footer>
  </div>
</body>
</html>`;

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

app.use('/assets', express.static(path.join(process.cwd(), 'assets')));

app.get('/', (_req, res) => {
  res.status(200).type('html').send(landingHtml);
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

    const existingUser = await getAutodraftUserByEmail(email);
    if (!existingUser) {
      const count = await getAutodraftUserCount();
      if (count >= 5) {
        res.status(200).type('html').send(renderCapacityFullPage());
        return;
      }
    }

    await upsertAutodraftUser(email, refreshToken, true);
    const user = await getAutodraftUserByEmail(email);
    const enabled = user?.enabled ?? true;
    const token = buildSettingsToken(email);
    res.status(200).type('html').send(
      renderSettingsPage({ email, enabled, token, message: '登録が完了しました。' })
    );
  } catch (e: any) {
    const status = e?.response?.status || 500;
    const message = e?.response?.data?.error_description || e?.response?.data?.error || e?.message || 'unknown_error';
    res.status(500).send(`OAuth callback failed: ${message} (${status})`);
  }
});

app.post('/settings', async (req, res) => {
  const token = String(req.body?.token || '').trim();
  const enabledRaw = String(req.body?.enabled || '').trim().toLowerCase();
  const enabled = enabledRaw === 'true';
  const email = token ? consumeSettingsToken(token) : null;
  if (!email) {
    res.status(400).send('設定トークンが無効です。もう一度 /auth/start からやり直してください。');
    return;
  }
  try {
    await updateAutodraftUserEnabled(email, enabled);
    const tokenNext = buildSettingsToken(email);
    const message = enabled ? '下書き自動作成を再開しました。' : '下書き自動作成を停止しました。';
    res.status(200).type('html').send(
      renderSettingsPage({ email, enabled, token: tokenNext, message })
    );
  } catch (e: any) {
    const message = e?.message || 'failed';
    res.status(500).send(`設定の更新に失敗しました: ${message}`);
  }
});

app.post('/settings/disconnect', async (req, res) => {
  const token = String(req.body?.token || '').trim();
  const email = token ? consumeSettingsToken(token) : null;
  if (!email) {
    res.status(400).send('設定トークンが無効です。もう一度 /auth/start からやり直してください。');
    return;
  }
  try {
    await disconnectAutodraftUser(email);
    res.status(200).type('html').send(`<!doctype html>
<html lang="ja">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>連携解除 | つきのーと</title>
  <style>
    body {
      margin: 0;
      font-family: "Hiragino Kaku Gothic ProN", "Meiryo", "Avenir Next", sans-serif;
      background: #fff6f6;
      color: #2b1f2a;
      display: grid;
      place-items: center;
      min-height: 100vh;
      padding: 24px;
    }
    .card {
      width: min(520px, 100%);
      background: #fff;
      border-radius: 20px;
      padding: 28px 24px;
      box-shadow: 0 16px 50px rgba(194, 58, 95, 0.18);
      border: 1px solid rgba(194, 58, 95, 0.08);
      text-align: center;
    }
    h1 { margin: 0 0 10px; font-size: 24px; }
    p { margin: 8px 0; color: #6b5d64; line-height: 1.7; }
    a {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      margin-top: 18px;
      padding: 10px 20px;
      border-radius: 999px;
      background: linear-gradient(135deg, #c23a5f 0%, #e04f77 100%);
      color: #fff;
      text-decoration: none;
      font-weight: 600;
      box-shadow: 0 12px 30px rgba(194, 58, 95, 0.28);
    }
  </style>
</head>
<body>
  <div class="card">
    <h1>Google連携を解除しました</h1>
    <p>下書き生成は停止されています。</p>
    <p>再開するには、もう一度 Google で接続してください。</p>
    <a href="/auth/start">再接続する</a>
  </div>
</body>
</html>`);
  } catch (e: any) {
    const message = e?.message || 'failed';
    res.status(500).send(`連携解除に失敗しました: ${message}`);
  }
});

app.listen(port, () => {
  console.log(`🔐 OAuth server running on port ${port}`);
});
