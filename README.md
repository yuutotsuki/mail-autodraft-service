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

## ライセンス

MIT
