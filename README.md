# M2Office

中小企業向けの AI エージェントシステム。
従業員ひとりひとりに秘書エージェントが付き、業務エージェントが承認を経て作業を代行します。

設計の正は [specification.md](specification.md) です。実装はそれに従います。

## 前提

| 項目 | 内容 |
|---|---|
| Node.js | 22 以上 |
| Docker | データベース（PostgreSQL）の起動に使う |
| ポート | **3100 番台**を使う（3100 画面 / 3101 API / 3102 ワーカー / 3103 ビルド確認 / 3105 DB） |

LLM の鍵は無くても動きます。未設定のときはスタブが応答し、全体の流れを確認できます。

## セットアップ

```bash
cp .env.example .env
npm install
npm run db:reset    # DB を起動し、スキーマ適用と初期データ投入まで行う
```

## 起動

```bash
npm run dev
```

画面・API・ワーカーが同時に立ち上がります。

| テナント | URL |
|---|---|
| 株式会社アルファ商事 | http://a.lvh.me:3100 |
| 株式会社ベータ工業 | http://b.lvh.me:3100 |

`lvh.me` は任意のサブドメインが `127.0.0.1` に解決される開発用のドメインです。
使えない環境では `http://localhost:3100/?tenant=a` でも開けます。

利用者を切り替えるには `?user=member@alpha.example.jp` を付けます。

## 動作確認

```bash
npm run smoke
```

通しの動作を確認します。とくに**承認ゲートで中断し、承認後に別のワーカーが
再開して完了する**経路（仕様書 第24.3.2節の段階 5 と 7）を検証します。
あわせてテナント分離と権限区画の隔離も確認します。

## 構成

```
packages/
  shared/   型定義と定数。画面・API・ワーカーが共通で参照する
  core/     ドメインロジック。実行エンジン、承認、ツール、秘書、LLM 抽象化層
  api/      公開 API（Hono）。画面も外部アプリも同じ API を経由する
  worker/   ジョブ実行の常駐プロセス。承認による中断と再開を担う
  web/      ワークスペース（Vite + React の SPA）
db/migrations/   スキーマ
scripts/         DB 操作と動作確認
docs/            開発規約・リリース規定・設計判断記録
```

依存の向きは [docs/coding-standards.md](docs/coding-standards.md) 第3章に従います。
**`core` に HTTP やフレームワークを持ち込まないこと。**

## 設定

| 変数 | 既定 | 意味 |
|---|---|---|
| `WEB_PORT` | 3100 | 画面の開発サーバー |
| `API_PORT` | 3101 | API |
| `WORKER_PORT` | 3102 | ワーカー（health 用。現時点では未使用） |
| `DB_PORT` | 3105 | PostgreSQL |
| `DATABASE_URL` | — | 接続先 |
| `BASE_DOMAIN` | lvh.me | 開発用のベースドメイン |
| `LLM_PROVIDER` | stub | `stub` または `gemini` |
| `GEMINI_API_KEY` | — | `gemini` のときに必要 |
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` | — | Google 連携（未実装） |

## 現時点で実装しているもの

| 項目 | 状態 |
|---|---|
| テナント解決（サブドメイン）と分離 | 実装済み |
| エージェント定義スキーマ v1 と検証 | 実装済み |
| 実行エンジン（**承認による中断と再開**） | 実装済み |
| 業務エージェント 2 つ（AG-04 / AG-02） | 実装済み |
| 秘書の 3 層応答 | 実装済み |
| 権限区画の隔離（検索の絞り込み） | 実装済み |
| 監査ログ | 実装済み |
| 実行ごとのコスト記録 | 実装済み |
| Google 連携 | **未実装**（B-2・B-3 の準備後） |
| 音声（Gemini Live） | 未実装 |
| 拡張機構・マーケット | 未実装 |
| 課金・運営バックヤード | 未実装 |

## 関連文書

| 文書 | 内容 |
|---|---|
| [specification.md](specification.md) | システム仕様の全体 |
| [CLAUDE.md](CLAUDE.md) | 開発時に守ること（要点） |
| [docs/coding-standards.md](docs/coding-standards.md) | コードの書き方、JSDoc、README |
| [docs/release-process.md](docs/release-process.md) | バージョンとリリース |
| [docs/adr/](docs/adr/) | 設計判断の記録 |
