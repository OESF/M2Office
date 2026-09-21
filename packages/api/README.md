# @m2office/api

公開 API（Hono）。**画面も外部アプリも、同じ API を経由します。**

画面専用の抜け道を作らないことが方針です（仕様書 第11.1節 A-1・A-2）。
SPA 構成のため、これは構造として保たれます。

## 前提

Node.js 22 以上、PostgreSQL。ポートは既定で **3101**。

## 起動

```bash
npm run dev     # 監視付き
npm run start   # 単発
```

## テナントの指定

ホスト名からテナントを解決します（`a.lvh.me:3101` → `a`）。
開発と外部からの確認のため、ヘッダーでの指定も受け付けます。

```bash
curl -H 'x-tenant: a' http://localhost:3101/v1/agents
curl -H 'x-tenant: a' -H 'x-user: member@alpha.example.jp' http://localhost:3101/v1/me
```

## 主なエンドポイント

| メソッド・パス | 内容 |
|---|---|
| `GET /health` | 生存確認。テナント不要 |
| `GET /v1/me` | テナントと利用者 |
| `GET /v1/agents` | 利用できるエージェントと入力スキーマ |
| `POST /v1/jobs` | ジョブを作成し待ち行列へ入れる。実行はワーカーが担う |
| `GET /v1/jobs` | 実行の一覧 |
| `GET /v1/runs/:id` | 実行の詳細、ステップ、成果物 |
| `GET /v1/approvals` | 承認待ちの一覧 |
| `POST /v1/approvals/:id` | 承認または却下 |
| `POST /v1/secretary` | 秘書への依頼。どの層で答えたかを返す |
| `GET /v1/audit-events` | 監査ログ |

## 承認の扱い

承認の API 化は慎重に扱います（仕様書 第11.3節）。
外部アプリからの承認は既定で禁止とし、`external-send` と `financial` は
**恒久的に禁止**します。現時点では画面からの操作だけを受け付けます。

## 構成

```
src/index.ts          サーバーの組み立て
src/context.ts        依存の構築（永続化・LLM・ツール・エンジン・秘書）
src/middleware/       テナント解決
src/routes/           エンドポイント
```

## 関連文書

- 仕様書 第11章 プラットフォーム API とエコシステム
- [ADR-0002 API フレームワークに Hono を採用する](../../docs/adr/0002-api-framework-hono.md)
