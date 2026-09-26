# M2Office 開発者マニュアル

M2Office に**業務を追加する人**のための手引きです。拡張機能の作り方、定義のリファレンス、サンプルを載せています。

| 文書 | 読み手 | 内容 |
|---|---|---|
| **この開発者マニュアル** | 拡張機能を作る人（社内・パートナー・SIer） | 業務エージェントとコネクタの作り方 |
| [仕様書](../../specification.md) | M2Office の設計に関わる人 | システム全体の決まり（設計の正） |
| [開発規約](../coding-standards.md) | M2Office 本体を開発する人 | コードの書き方 |
| [ヘルプの記事](../help/) | 利用者・管理者 | 画面の使い方 |

## 目次

| # | 章 | 内容 |
|---|---|---|
| 1 | [用語と全体像](01-concepts.md) | 拡張機能・業務エージェント・コネクタ・ツールとは。何が作れて、何が作れないか |
| 2 | [はじめての拡張機能](02-quickstart.md) | **「こんにちは」に「Hello World」と返す**サンプルを SKILL.md で作り、動かすまで |
| 3 | [業務エージェントの書き方](03-agent-definition.md) | SKILL.md（スキルの形式）のリファレンス。JSON の定義（廃止の方向）も載せる |
| 4 | [ツールと危険度](04-tools.md) | 使えるツール（Google Workspace を操作するツールを含む 40 個）の一覧・引数・必要な Google の権限と、承認の決まり |
| 5 | [拡張機能パッケージ](05-package.md) | スキルのフォルダの構成、マニフェスト・評価のケースの書式、持ち運べるファイル（.m2ext） |
| 6 | [検証・導入・動作確認](06-validate-and-install.md) | 手元での検証、ファイルからの取り込み、スイッチ、利用できる人、よくあるエラーと直し方 |
| 7 | [コネクタの作り方（DeepWiki を例に）](07-connectors.md) | MCP サーバをつないで、外部のサービスのツールを使う方法 |
| 8 | [良い業務エージェントの書き方](08-writing-good-agents.md) | 指示・止める条件・承認の置き場所・ヘルプの書き方 |
| 9 | [公開の前の点検](09-review.md) | 審査で確かめること |

**はじめての人は、第1章と第2章から読んでください。**

| サンプル | 置き場所 | 見どころ |
|---|---|---|
| あいさつ | [extensions/hello-world](../../extensions/hello-world/) | いちばん小さい拡張機能。SKILL.md で書いた見本（第2章） |
| リポジトリ調査（DeepWiki） | [extensions/deepwiki-research](../../extensions/deepwiki-research/) | コネクタ（MCP）を使う拡張機能（第7章） |
| スライド作成（見本） | [extensions/research-slides](../../extensions/research-slides/) | 公式の「スライド作成」と同じ動きを SKILL.md で書いた見本（第4.5節） |
| 週報の下書き | [examples/extensions/weekly-report](../../examples/extensions/weekly-report/) | 内蔵ツールを組み合わせた実務の例。ファイルにして取り込む自社専用の拡張機能（第6章） |

## 1 冊の PDF で読む

配布や通読には、全章を 1 冊にまとめた PDF を使えます。

```bash
npm run docs:manual-pdf    # → docs/developer/developer-manual.pdf
```

## 前提

- M2Office の開発環境が動いていること（リポジトリ直下の README の「セットアップ」と「起動」）
- Gemini の鍵が設定されていること（`.env` の `GEMINI_API_KEY`、または管理者ページの「接続」）。無いと業務は動きません
- 業務エージェントを作るのに、プログラミングも JSON も要りません。業務の指示を文で書ければ十分です（SKILL.md。公開されているスキルを土台にもできます）
- コネクタ（第7章）を作るには、API を扱うプログラミングの知識が要ります

## この文書の版

M2Office の仕様書 第 0.122.0 版に対応します。業務エージェントはスキルの形式（SKILL.md。第12.12節）で書きます。中の定義の形式は `schema_version: 1` です。
