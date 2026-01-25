import axios from 'axios';
import { initializeEnvironment } from '../config/environment';

function red(s?: string) { return `\x1b[31m${s || ''}\x1b[0m`; }
function green(s?: string) { return `\x1b[32m${s || ''}\x1b[0m`; }
function yellow(s?: string) { return `\x1b[33m${s || ''}\x1b[0m`; }

async function tryToken(endpoint: string, body: URLSearchParams, useBasicAuth: boolean, cid: string, secret: string) {
  const headers: Record<string, string> = { 'Content-Type': 'application/x-www-form-urlencoded' };
  if (useBasicAuth) {
    const basic = Buffer.from(`${cid}:${secret}`).toString('base64');
    headers['Authorization'] = `Basic ${basic}`;
  }
  try {
    const r = await axios.post(endpoint, body.toString(), { headers, timeout: 8000, validateStatus: () => true });
    return { ok: r.status >= 200 && r.status < 300, status: r.status, data: r.data } as const;
  } catch (e: any) {
    return { ok: false, status: e?.response?.status || 0, data: e?.response?.data || { error: String(e) } } as const;
  }
}

function hintFor(error: string, status: number): string {
  const e = (error || '').toLowerCase();
  if (e.includes('invalid_grant')) {
    return [
      '- invalid_grant: Refresh Tokenが失効・取り消し・スコープ不一致の可能性',
      '  対処: 同じクライアントID/Secretで、access_type=offline + prompt=consent で再発行',
      '  （OAuth同意画面がTestingなら7日制限。必要なら本番公開 or 再発行）',
    ].join('\n');
  }
  if (e.includes('unauthorized_client') || e.includes('invalid_client')) {
    return [
      `- ${error}: Refresh Tokenを発行したクライアントと現在のclient_id/secretが不一致の可能性`,
      '  対処: OAuth Playgroundで取得したなら「Use your own OAuth credentials」をONにし、',
      '        今設定中のclient_id/secretを使って再発行する。あるいはPlaygroundのクレデンシャルを環境に設定する。',
      '  併せて: Gmail APIが有効化済み、同意画面のテストユーザーに対象アカウントが含まれているか確認',
      '  （Google Workspaceの場合は管理コンソールの「OAuthアプリアクセス制御」で許可が必要な場合あり）',
    ].join('\n');
  }
  if (status === 400) {
    return '- 400: パラメータ不備の可能性（grant_type、client_id/secret、refresh_token）を再確認';
  }
  return '- 詳細不明: コンソールのOAuth同意画面/クライアント設定/スコープ/テストユーザーを再確認';
}

async function main() {
  initializeEnvironment();
  const cid = process.env.GOOGLE_CLIENT_ID || '';
  const secret = process.env.GOOGLE_CLIENT_SECRET || '';
  const refresh = process.env.GOOGLE_REFRESH_TOKEN || '';

  if (!cid || !secret || !refresh) {
    console.log(red('GOOGLE_CLIENT_ID/SECRET/REFRESH_TOKEN のいずれかが未設定です (.env.* を確認)。'));
    process.exit(1);
  }

  const body = new URLSearchParams();
  body.set('client_id', cid);
  body.set('client_secret', secret);
  body.set('refresh_token', refresh);
  body.set('grant_type', 'refresh_token');

  const endpoints = [
    'https://oauth2.googleapis.com/token',
    'https://accounts.google.com/o/oauth2/token',
  ];

  for (const ep of endpoints) {
    for (const basic of [false, true]) {
      console.log(yellow(`\n[Diag] POST ${ep} (basicAuth=${basic})`));
      const res = await tryToken(ep, body, basic, cid, secret);
      if (res.ok) {
        console.log(green(`OK status=${res.status}`));
        console.log(green('access_tokenあり。直結は動作するはずです。'));
        process.exit(0);
      } else {
        const err = (res.data?.error || '').toString();
        const desc = (res.data?.error_description || '').toString();
        console.log(red(`NG status=${res.status} error=${err} desc=${desc}`));
        console.log(hintFor(`${err}`, res.status));
      }
    }
  }

  console.log('\n診断終了。上のヒントを参考に、クライアント一致と同意画面/テストユーザー/Gmail API有効化を確認してください。');
}

main().catch((e) => { console.error(e); process.exit(1); });

