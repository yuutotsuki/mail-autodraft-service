# Mail Autodraft Service

Gmailの受信メールに対して、**自動で下書きを作成する**ためのサービスです。
送信は行わず、下書きのみを作成します。

## 主な特徴

- 未読メールを検知して下書きを自動作成
- 許可ラベル必須モード（安全運用）
- プロモーションカテゴリ除外
- 送信は一切しない（下書きのみ）

## 前提

- Node.js 18+（推奨: 20+）
- Gmail API の OAuth 設定

## セットアップ

### 1) 依存関係のインストール

```bash
npm install
```

### 2) 環境変数の準備

`.env.example` をコピーして `.env` を作成してください。

```bash
cp .env.example .env
```

`.env` には最低限以下が必要です。

- Gmail OAuth
  - `GOOGLE_CLIENT_ID`
  - `GOOGLE_CLIENT_SECRET`
  - `GOOGLE_REFRESH_TOKEN`
- OpenAI
  - `OPENAI_API_KEY`

複数ユーザーのトークンをDBで管理する場合は `DATABASE_URL` を設定してください。

## OAuth登録（マルチユーザー）

ユーザー自身にGoogleログインしてもらい、refresh_token をDBに登録する最小フローです。

### 必要な環境変数

- `GOOGLE_CLIENT_ID`
- `GOOGLE_CLIENT_SECRET`
- `GOOGLE_REDIRECT_URI`（例: `https://your-service.onrender.com/auth/callback`）
- `OAUTH_SCOPES`（例: `openid email https://www.googleapis.com/auth/gmail.modify`）
- `DATABASE_URL`（Postgres接続）

### 起動

```bash
npm run build
npm run auth:prod
```

### 使い方

1. `/auth/start` にアクセス  
2. Googleでログイン  
3. `/auth/callback` が `登録完了` を表示  

登録が完了すると `autodraft_users` に1行追加されます。

### 3) ビルド

```bash
npm run build
```

### 4) 起動

```bash
npm start
```

`.env` がデフォルトで読み込まれます。

## 自動下書きの設定

`.env` の主な設定値:

- `FEATURE_AUTODRAFT_ALL=true`
- `FEATURE_AUTODRAFT_ONLY_MODE=true`
- `AUTODRAFT_REQUIRE_ALLOW_LABEL=true`
- `AUTODRAFT_ALLOW_LABEL_NAME=ai-draft-allow`（任意）
- `AUTODRAFT_EXCLUDE_PROMOTIONS=true`
- `AUTODRAFT_USER_SLEEP_MS=2000`（ユーザー間の待機）

### 許可ラベル運用

`AUTODRAFT_REQUIRE_ALLOW_LABEL=true` の場合、
**許可ラベルが付いている未読メールのみ**が自動下書き対象になります。

## 安全設計

- **送信はしません**（Gmail下書きのみ作成）
- プロモーションカテゴリは対象外
- 同じメールでの再生成を防ぐため `autodraft-processed` ラベルを付与

## 注意

- `.env` は絶対にコミットしないでください
- Refresh Token は機密情報です

## 免責

本ソフトウェアは「現状のまま」提供されます。利用により生じたいかなる損害についても、作者は責任を負いません。ご利用は自己責任でお願いします。

## ライセンス

MIT
