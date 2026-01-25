#!/bin/bash

# Autodraft Service 起動スクリプト
# 使用方法: ./start-bot.sh [personal|company]

set -e

# デフォルト環境をcompanyに設定
ENV_TYPE=${1:-company}

echo "🚀 Autodraft Service を起動します..."
echo "📁 環境: $ENV_TYPE"

# プロジェクトディレクトリに移動
cd "$(dirname "$0")"

# 環境変数ファイルの存在確認
ENV_FILE=".env.$ENV_TYPE"
if [ ! -f "$ENV_FILE" ]; then
    echo "❌ エラー: $ENV_FILE が見つかりません"
    echo "利用可能な環境:"
    ls -la .env.* 2>/dev/null || echo "環境ファイルが見つかりません"
    exit 1
fi

echo "✅ 環境ファイル: $ENV_FILE"

# 環境変数を読み込み
echo "📋 環境変数を読み込み中..."
set -a
source "$ENV_FILE"
set +a

echo "✅ 環境変数の読み込み完了"

# Node.jsの依存関係を確認
if [ ! -d "node_modules" ]; then
    echo "📦 node_modulesが見つかりません。依存関係をインストールします..."
    npm install
fi

# サービスを起動
echo "⚡️ サービスを起動中..."
ENV=$ENV_TYPE npm start
