import dotenv from 'dotenv';

export function initializeEnvironment(): void {
  const envPath = process.env.ENV ? `.env.${process.env.ENV}` : '.env';
  dotenv.config({ path: envPath });

  console.log(`✅ [environment.ts] .env ファイル読み込み: ${envPath}`);
  // セキュリティ考慮で値は一部だけ
  console.log('🔍 [environment.ts] 環境変数読み込み確認:');
  console.log('  - ENV:', process.env.ENV);
  console.log('  - NODE_ENV:', process.env.NODE_ENV);
  console.log('  - CONNECT_TOKEN_URL:', process.env.CONNECT_TOKEN_URL);
  console.log('  - OPENAI_API_KEY:', process.env.OPENAI_API_KEY ? '設定済み' : '未設定');
  console.log('  - PIPEDREAM_PROJECT_ID:', process.env.PIPEDREAM_PROJECT_ID ? '設定済み' : '未設定');
}

export function getEnvironmentVariable(key: string, defaultValue?: string): string {
  const value = process.env[key];
  if (!value && defaultValue === undefined) {
    throw new Error(`環境変数 ${key} が設定されていません`);
  }
  return value || defaultValue!;
} 
