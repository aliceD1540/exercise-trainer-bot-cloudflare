# Exercise Trainer Bot - Cloudflare

Blueskyのエクササイズ投稿にAIで励ましのコメントを返すボット（Cloudflare Workers版）

## 機能

- Blueskyの特定ユーザーの投稿を監視
- Gemini APIで投稿内容と画像を分析
- 励ましのリプライを自動投稿
- Cloudflare Workersで5分ごとに定期実行

## セットアップ

### 1. 依存関係のインストール

```bash
npm install
```

### 2. KV Namespaceの作成

セッション情報を保存するためのKVストレージを作成します。

```bash
# 本番用
npx wrangler kv:namespace create SESSIONS

# プレビュー用
npx wrangler kv:namespace create SESSIONS --preview
```

作成されたIDを`wrangler.toml`の`id`と`preview_id`に設定してください。

### 3. 環境変数の設定

以下のシークレットを設定します：

```bash
npx wrangler secret put BSKY_USER_NAME
# → Blueskyのユーザー名を入力

npx wrangler secret put BSKY_APP_PASS
# → Blueskyのアプリパスワードを入力

npx wrangler secret put CHECK_BSKY_DID
# → 監視対象のBlueskyユーザーのDIDを入力

npx wrangler secret put GOOGLE_API_KEY
# → Google Gemini APIキーを入力
```

## デプロイ

```bash
npx wrangler deploy
```

## ローカルテスト

```bash
# 開発モード
npx wrangler dev

# Cron Triggerのテスト
npx wrangler dev --test-scheduled
```

## 設定

### wrangler.toml

- `crons`: 実行スケジュール（デフォルト: 5分ごと）
- `compatibility_date`: Workers互換性日付

### src/index.js

- `RULES`: Geminiへのプロンプト（評価基準等）
- 検索期間: デフォルトは12時間前まで

## 必要なAPI・サービス

1. **Cloudflare Workers** (無料枠あり)
   - Cron Triggers機能を使用
   - KV Namespaceでセッション保存

2. **Bluesky Account**
   - ボット用のアカウント
   - アプリパスワードの発行が必要

3. **Google Gemini API**
   - 無料枠あり
   - gemini-2.0-flash-exp-liteを使用

## トラブルシューティング

### セッションエラー

KV Namespaceのセッション情報をクリア：

```bash
npx wrangler kv:key delete bsky_session --namespace-id=YOUR_KV_ID
```

### ログ確認

```bash
npx wrangler tail
```

## ライセンス

MIT
