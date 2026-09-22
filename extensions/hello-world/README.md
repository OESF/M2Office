# あいさつ（サンプル）

「こんにちは」と入力すると「Hello World」と返す、最小の拡張機能です。
拡張機能の作り方は、開発者マニュアルの「はじめての拡張機能」
（[docs/developer/02-quickstart.md](../../docs/developer/02-quickstart.md)）で、このサンプルを使って説明しています。

## 構成

| ファイル | 内容 |
|---|---|
| `manifest.json` | 拡張機能の ID・名前・版・提供者・必要な権限 |
| `agents/hello.json` | 業務エージェント「あいさつ」の定義 |
| `evals/hello.json` | 評価のケースと、LLM の鍵が無いときの見本の応答 |

## 必要な権限

| 項目 | 値 |
|---|---|
| 使うツール | `document.create`（返事を成果物として保存する） |
| 最大の危険度 | `draft`（下書きや資料を作るだけ。送信はしない） |

## 確かめ方

```bash
npm run ext:validate extensions/hello-world
```

管理者ページの「拡張機能」で導入し、左のメニューの「あいさつ（サンプル）」に「こんにちは」と入れて実行します。
実行の詳細の成果物に「Hello World」と出ます。
