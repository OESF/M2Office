# リポジトリ調査（DeepWiki）

GitHub で公開されているリポジトリについて質問すると、[DeepWiki](https://deepwiki.com/) で調べて、答えを資料にまとめます。
**コネクタ（MCP）を使う拡張機能のサンプル**です。

## 構成

| 構成要素 | ファイル | 内容 |
|---|---|---|
| コネクタ | `connectors/deepwiki.json` | DeepWiki の MCP サーバ（`https://mcp.deepwiki.com/mcp`、認証なし）。使うツールは 2 つ |
| 業務エージェント | `agents/research.json` | 調査（DeepWiki に質問）→ 資料作成（`document.create`） |
| 評価のケース | `evals/research.json` | 評価のケース（入力と期待する結果）。中の `stub` は M2Office の自動テスト用で、拡張機能を作るときは書かない |

| ツール | すること | 危険度 |
|---|---|---|
| `deepwiki.ask_wiki_question` | 公開リポジトリについて質問し、答えを得る | 読むだけ |
| `deepwiki.read_wiki_structure` | 公開リポジトリの説明文書の目次を得る | 読むだけ |
| `document.create` | 答えを資料として保存する | 下書き |

## 管理者の方へ

- 質問の文とリポジトリ名は DeepWiki（社外のサービス）に送られます。社外に出してはならない情報を質問に書かないでください
- 調べられるのは公開リポジトリだけです。どこにも書き込みません
- 「詳細」の「接続を確認する」で、DeepWiki につながるかを確かめられます

## 開発者の方へ

作り方の説明は [開発者マニュアル 第7章](../../docs/developer/07-connectors.md) にあります。

```bash
npm run ext:validate extensions/deepwiki-research
npm run ext:pack extensions/deepwiki-research
```
