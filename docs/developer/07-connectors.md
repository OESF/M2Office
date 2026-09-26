# 7. コネクタの作り方（DeepWiki を例に）

**コネクタは、外部のサービスの操作を、業務エージェントから呼べるツールとして持ち込むもの**です。
外部のサービスが提供する **MCP サーバ**（Model Context Protocol）に、M2Office が接続します（仕様書 第12.11節）。

| いまの版でできること | まだできないこと |
|---|---|
| 認証の要らない MCP サーバへの接続（`auth: none`） | 利用者ごとの認可（`oauth`。Canva など）・管理者が登録する鍵（`api_key`。freee など） |
| ツールの宣言と推奨の危険度、導入時の同意 | 管理者があとからツールの危険度を強くする画面 |
| 承認・操作の確認・監査ログを内蔵ツールと同じに扱う | ほかの拡張機能のコネクタを使う |
| 管理者ページからの接続の確認 | ダッシュボードの「接続先」への表示 |

## 7.1 しくみ

```
業務エージェント ーツールを呼ぶ＞ M2Office（ワーカー） ーMCP＞ MCP サーバ ーAPI＞ 外部のサービス
                                  （承認・危険度・記録）       （M2Office の外で動く）
```

| なぜ外で動かすのか | 説明 |
|---|---|
| 第三者のコードを中で動かさない | M2Office は第三者のコードを自分のプロセスで実行しない（不変則 I-7）。拡張機能にプログラムは入れられない |
| 既存の MCP サーバを使える | 外部のサービスが公開している MCP サーバを、宣言を書くだけでつなげる |
| 言語を選ばない | 自分で作る場合も、MCP に対応していれば、どの言語で作ってもよい |

## 7.2 役割の分担

| 担うこと | M2Office | MCP サーバ |
|---|---|---|
| 外部のサービスの API を呼ぶ | | ✓ |
| ツールの一覧を返す | | ✓（MCP の `tools/list`） |
| **どのツールを使うか** | **✓（拡張機能が宣言したものだけ）** | 提供するだけ |
| **ツールの危険度を決める** | **✓（推奨の危険度を示し、管理者が同意したもの）** | 推奨を宣言できるだけ |
| 承認・操作の確認 | ✓ | |
| 呼び出しの記録（監査ログ） | ✓ | |
| 応答をデータとして扱う | ✓（指示として解釈しない。長い応答は切り詰める） | |

**MCP サーバが提供していても、宣言していないツールは使いません。** 管理者が見ていない操作を使わないためです。

## 7.3 サンプル: リポジトリ調査（DeepWiki）

[extensions/deepwiki-research](../../extensions/deepwiki-research/) は、GitHub の公開リポジトリについて
[DeepWiki](https://deepwiki.com/) の MCP サーバに質問し、答えを資料に残す拡張機能です。認証が要らないため、すぐに試せます。

```
deepwiki-research/
  SKILL.md                   業務（スキルの書き方のまま）。allowed-tools にコネクタの道具を書く
  HELP.md                    利用者向けの説明
  connectors/deepwiki.json   コネクタの宣言
  evals/research.json        評価のケース（入力と期待する結果）
  README.md
  icon.png
```

### コネクタの宣言（connectors/deepwiki.json）

```json
{
  "id": "deepwiki",
  "name": "DeepWiki",
  "description": "GitHub で公開されているリポジトリの説明文書を調べます。認証は要りません",
  "transport": "http",
  "url": "https://mcp.deepwiki.com/mcp",
  "auth": { "type": "none" },
  "tools": [
    { "name": "ask_wiki_question", "description": "公開リポジトリについて質問し、答えを得ます", "risk": "read" },
    { "name": "read_wiki_structure", "description": "公開リポジトリの説明文書の目次を得ます", "risk": "read" }
  ]
}
```

| 項目 | 規則 |
|---|---|
| `id` | 英小文字・数字・ハイフン。内蔵のツールの頭の部分（`gmail` など）やほかのコネクタと重ならないこと |
| `transport` | `http`（MCP の Streamable HTTP）だけ。M2Office の中でプログラムを起動する方式（stdio）は使えない |
| `url` | `https` に限る。開発用の `localhost` だけは `http` でよい |
| `auth.type` | いまは `none` だけ |
| `tools[].name` | MCP サーバでのツールの名前（`tools/list` で確かめる） |
| `tools[].description` | すること。**導入の同意の画面とヘルプにそのまま出る**ので、業務の言葉で書く |
| `tools[].risk` | 危険度。拡張機能が扱う最大の危険度は、SKILL.md の `allowed-tools` の道具の危険度から決まる。`external-send` 以上なら「作業 → 承認 → 送る」になる |

### SKILL.md から使う

同じフォルダの SKILL.md の `allowed-tools` に、`<コネクタの ID>.<ツールの名前>` で書きます。書いた道具しか使えません。

```markdown
---
name: research
description: GitHub で公開されているリポジトリについて DeepWiki に質問し、答えを資料にまとめる
allowed-tools: deepwiki.ask_wiki_question deepwiki.read_wiki_structure document.create
metadata:
  m2office-id: jp.m2office.samples.deepwiki-research
  m2office-inputs: |
    リポジトリ: 短文
    知りたいこと: 長文
---

# リポジトリ調査（DeepWiki）

1. `deepwiki.ask_wiki_question` で質問する。`repoName` に $リポジトリ を、`question` に $知りたいこと を渡す
2. 答えを日本語で要点にまとめ、`document.create` で保存する。取得できなかったときは、そのことと理由だけを書く
```

宣言していないコネクタの道具を `allowed-tools` に書いても使われず、取り込みの画面で知らされます。

### 評価のケース（evals/research.json）

```json
{ "name": "MCP の TypeScript SDK",
  "input": { "リポジトリ": "modelcontextprotocol/typescript-sdk", "知りたいこと": "このリポジトリは何をするものですか？" },
  "expect": "DeepWiki の答えをもとに、SDK の目的と主な機能を資料に保存する" }
```

コネクタを使う業務も、本物の推論で動かして確かめます。推論が選んだツールで **DeepWiki に実際に問い合わせ**、その答えが資料に残ることを、`expect` と見比べます（第6.4節）。
このファイルにある `stub` は M2Office の自動テスト用です。拡張機能を作るときは書きません（第5.4節）。

### 動かす

1. 管理者ページの「拡張機能」→「配布元から追加」→「リポジトリ調査（DeepWiki）」を導入する
2. カードの「詳細」→「接続を確認する」で、宣言したツールが「提供あり」になることを確かめる
3. ワークスペースで「リポジトリ調査（DeepWiki）」を選び、例の入力で実行する

## 7.4 既存の MCP サーバをつなぐ手順

1. MCP サーバの URL と、認証が要るかを確かめる（いまは認証の要らないものだけ）
2. ツールの一覧を確かめる

   ```bash
   curl -s -H 'Content-Type: application/json' -H 'Accept: application/json, text/event-stream' \
     https://mcp.deepwiki.com/mcp -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
   ```

3. 使うツールだけを `connectors/<名前>.json` に宣言し、推奨の危険度を付ける
4. 業務エージェントの `tools` とマニフェストの `permissions.tools` に `<コネクタの ID>.<ツールの名前>` を書く
5. `npm run ext:validate` で検証し、`npm run ext:pack` でファイルにする

**危険度の付け方**: 外部に何も書き込まない問い合わせは `read`、外部に下書きを作るものは `draft`、
外部の人に届く・公開される操作は `external-send`、お金に関わる操作は `financial` です。迷ったら強いほうにしてください。

## 7.5 MCP サーバを自分で作るときの決まり

| # | 決まり | 理由 |
|---|---|---|
| 1 | Streamable HTTP で公開する。`https` にする | M2Office は中でプログラムを起動しない。通信を守るため |
| 2 | ツールの説明を業務の言葉で書く。**すること・しないこと**を必ず含める | 管理者の判断材料になる |
| 3 | 読む・下書き・確定を**別のツールに分ける** | 承認を必要な所にだけ置ける |
| 4 | 取得に失敗したら、失敗として返す（`isError`）。空の結果で代用しない | 「無い」と「取得できなかった」を取り違えないため |
| 5 | 応答に指示のような文を含めない。含めても M2Office は従わない | 不変則 I-6 |
| 6 | 1 回の応答を大きくしすぎない（M2Office は約 6000 字で切り詰める）。一覧は件数の上限と続きの取り方を持つ | 推論に渡す量に上限がある |
| 7 | 60 秒以内に応答する | それを超えると「取得できませんでした」になる |
| 8 | 認証情報を応答に含めない。冪等にする | ログへの漏れと、再試行での二重処理を防ぐ |

開発中は、手元で動かした MCP サーバを `http://localhost:<番号>/mcp` で宣言して試せます。

## 7.6 これから: 認証の要るコネクタ（freee・Canva）

認証の要るコネクタは次の段階で実装します（仕様書 第12.11.5節、Q-72）。いまは検証で「まだ使えません」と表示されます。

| 方式 | 例 | 認証情報 |
|---|---|---|
| `api_key` | freee | 管理者が管理者ページで登録する。暗号化して保存し、推論には渡さない |
| `oauth` | Canva | 利用者ごとに、そのサービスの画面で認可する |

freee の請求書のような業務では、**下書きと確定を別のツールに**してください。

| ツール | freee で行うこと | 推奨の危険度 |
|---|---|---|
| `freee.list_deals` | 取引の一覧を取る | read |
| `freee.create_invoice_draft` | 請求書を**下書き**で作る | draft |
| `freee.issue_invoice` | 請求書を発行する（取引先に届く・会計に載る） | **financial** |

`financial` のツールは、定義の書き方によらず、承認ステップの直後のステップでしか呼べません。これは基盤が強制します。
