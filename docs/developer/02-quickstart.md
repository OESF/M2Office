# 2. はじめての拡張機能 ―「こんにちは」に「Hello World」と返す

M2Office の業務は、**ふだん書いているスキル（SKILL.md）のまま**作れます（仕様書 第12.12節）。
スキルの書き方を知っていれば、M2Office で覚えることは次の 4 つだけです。

| # | M2Office で覚えること |
|---|---|
| 1 | **道具は `allowed-tools` に M2Office の道具を書く**（第4章）。書かなければ読むだけの道具。`Bash`・`Read` などは M2Office には無い |
| 2 | **利用者向けの説明は `HELP.md` に書く**（SKILL.md の隣）。業務の題名の「？」とヘルプセンターに出る |
| 3 | **プログラムは動かない**（`scripts/`・`` !`コマンド` ``）。処理が要るならコネクタ（第7章） |
| 4 | **承認は書かない**。送る道具を書けば、M2Office が承認を組み立てる |

完成したものは [extensions/hello-world](../../extensions/hello-world/) にあります。

## 2.1 フォルダを作る

```
hello-world/
  SKILL.md       ← スキルの書き方のまま（推論が読む指示）
  HELP.md        ← 利用者向けの説明（M2Office で足すもの）
  evals/
    hello.json   ← 評価のケース（入力と期待する結果。任意）
```

## 2.2 SKILL.md を書く

```markdown
---
name: hello
description: あいさつに英語で短く返事をする。「こんにちは」には「Hello World」と返す
argument-hint: こんにちは
arguments: [あいさつ]
allowed-tools: ""
metadata:
  m2office-id: jp.m2office.samples.hello-world
---

# あいさつ（サンプル）

次のあいさつに、英語で 1 行だけ返事をする。

あいさつ: $あいさつ

- 「こんにちは」には「Hello World」と返す
- あいさつ以外の依頼には応じず、「あいさつだけにお返事します」と日本語で返す
```

スキルの項目は、スキルと同じ意味で効きます。

| 書いたところ | M2Office での効き方 |
|---|---|
| `name` | 業務の ID の一部（省けばフォルダ名） |
| `description` | メニューの説明と、**秘書が業務へ取り次ぐ手がかり**（スキルの自動の呼び出しと同じ） |
| `argument-hint` | 入力の欄に薄く出る例 |
| `arguments` と `$あいさつ` | 入力の欄が「あいさつ」になり、実行のときに本文の `$あいさつ` が置き換わる |
| `allowed-tools: ""` | 道具を使わない（M2Office の道具の名前を書けば、その道具だけが使える） |
| `# あいさつ（サンプル）` | 本文の最初の見出しが、メニューに出る業務の名前 |
| `metadata.m2office-id` | 他の会社に配るときの ID。自社だけで使うなら要らない |

## 2.3 HELP.md を書く

```markdown
# あいさつ（サンプル）

あいさつを入れると、英語で短く返事をします。

## 使い方

- 「こんにちは」と入れると「Hello World」と返します
```

**SKILL.md は推論が読む指示、HELP.md は人が読む説明**です。分けておくと、指示を直しても説明が崩れません。
承認が入る場所と実行例は M2Office が添えます。

## 2.4 評価のケースを書く（任意）

```json
{
  "agent": "hello",
  "cases": [
    { "name": "こんにちは", "input": { "あいさつ": "こんにちは" }, "expect": "「Hello World」と返す" }
  ]
}
```

本物の推論で実行し、結果が `expect` に合うかを見比べて指示を直します。

## 2.5 検証する

```bash
npm run ext:validate extensions/hello-world
```

```
✓ あいさつ（サンプル）（jp.m2office.samples.hello-world 2.1.0）
    業務エージェント jp.m2office.samples.hello-world:hello: 1 ステップ、ツール 
    評価のケース 2 件
```

（`extensions/hello-world` の完成品には `metadata.version` と評価のケースを 2 件足してあります。上の手順のとおりに作ると、版は `1.0.0`、ケースは 1 件と出ます。）

スキルの項目のうち M2Office で使わないもの（`model`・`context`・`hooks` など）や、M2Office に無い道具は、ここと取り込みの画面で知らせます。

## 2.6 取り込んで動かす

1. 管理者ページの「拡張機能」→「ファイルから追加」で、フォルダを ZIP にしたもの（または SKILL.md 1 つ）を選ぶ
2. 「この拡張機能に許可すること」を確かめて「同意して導入する」
3. 左のメニューの「あいさつ（サンプル）」に「こんにちは」と入れて「実行」

業務は会社の Gemini で動きます。接続が無い会社では「Gemini の接続が設定されていません」と出て動きません。

## 2.7 次に読むもの

- スキルの項目と M2Office での扱いの一覧 → [第3章](03-agent-definition.md)
- 使える道具 → [第4章](04-tools.md)
- 外部のシステムとつなぐ → [第7章](07-connectors.md)
