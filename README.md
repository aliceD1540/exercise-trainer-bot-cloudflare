# Exercise Trainer Bot - Cloudflare

Blueskyのエクササイズ投稿にAIで励ましのコメントを返すボット（Cloudflare Workers版）

## 機能

- Blueskyの特定ユーザーの投稿を監視（過去24時間）
- **複数画像（1～4枚）を自動グリッド化してトークン消費を削減**
  - 1枚: そのまま送信
  - 2枚: 横並び (1x2)
  - 3～4枚: 2x2グリッド
  - グリッド化後の画像サイズは2000x2000px以内に自動調整
- Gemini APIで投稿内容と画像を分析
- 励ましのリプライを自動投稿
- 重複投稿の防止（処理済み記録を7日間保持）
- **3日以上運動していない場合、リマインダーメッセージを送信**
  - 最後の評価から72時間以上経過したら初回メッセージ
  - その後24時間ごとに追加のリマインダー
  - 体調を気遣う優しいトーンで問いかけ
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
npx wrangler kv:namespace create EXERCISE_TRAINER_SESSIONS

# プレビュー用
npx wrangler kv:namespace create EXERCISE_TRAINER_SESSIONS --preview
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
- `GEMINI_MODEL`: 使用するGemini AIモデル名（デフォルト: gemini-2.5-flash）
  - モデルが廃止された場合は、この設定を更新してください
- `REMINDER_INITIAL_HOURS`: 初回リマインダー送信までの時間（デフォルト: 72時間）
- `REMINDER_INTERVAL_HOURS`: リマインダーの再送間隔（デフォルト: 24時間）

### src/index.js

- `RULES`: Geminiへのプロンプト（評価基準等）
- 検索期間: デフォルトは24時間前まで
- 画像処理: 複数画像をグリッド化（2000x2000px以内に自動調整）

### AIモデルの更新方法

使用しているAIモデルが廃止された場合、`wrangler.toml`の`GEMINI_MODEL`を更新してください：

```toml
[vars]
GEMINI_MODEL = "gemini-2.5-flash-latest"  # 新しいモデル名に変更
```

モデルが利用できない場合、ボットは自動的にエラーメッセージをリプライします。

## 必要なAPI・サービス

1. **Cloudflare Workers** (無料枠あり)
   - Cron Triggers機能を使用
   - KV Namespaceでセッション保存

2. **Bluesky Account**
   - ボット用のアカウント
   - アプリパスワードの発行が必要

3. **Google Gemini API**
   - 無料枠あり
   - gemini-2.5-flashを使用

## 依存関係

- `@atproto/api`: Bluesky API クライアント
- `@google/generative-ai`: Google Gemini API クライアント  
- `@cf-wasm/photon`: 画像リサイズライブラリ（WebAssembly）

## トラブルシューティング

### セッションエラー

KV Namespaceのセッション情報をクリア：

```bash
npx wrangler kv:key delete bsky_session --binding=EXERCISE_TRAINER_SESSIONS
```

### ログ確認

```bash
npx wrangler tail
```

## ライセンス

MIT
