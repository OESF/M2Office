# 2. はじめての拡張機能 ―「こんにちは」に「Hello World」と返す

最小の拡張機能を作り、会社に導入して動かすまでを通します。
完成したものは [extensions/hello-world](../../extensions/hello-world/) にあります。

所要時間はおよそ 15 分です。

## 2.1 作るもの

| 項目 | 内容 |
|---|---|
| 入力 | あいさつ（例: 「こんにちは」） |
| 出力 | 英語の返事を成果物として保存する（例: 「Hello World」） |
| 使うツール | `document.create`（文書を作り、成果物として保存する。危険度 `draft`） |
| 承認 | 不要（社外にも他の人にも何も送らないため） |

## 2.2 ディレクトリを作る

```
extensions/
  hello-world/
    manifest.json      ← 拡張機能の名札と、必要な権限
    agents/
      hello.json       ← 業務エージェントの定義
    evals/
      hello.json       ← 評価のケースと、鍵が無いときの見本の応答
    README.md
```

`extensions/` の下の 1 つのディレクトリが、1 つの拡張機能です。ディレクトリ名は何でもかまいません。

## 2.3 マニフェストを書く（manifest.json）

```json
{
  "id": "jp.m2office.samples.hello-world",
  "name": "あいさつ（サンプル）",
  "version": "1.0.0",
  "description": "「こんにちは」と入力すると「Hello World」と返す、拡張機能の作り方を確かめるためのサンプルです。",
  "publisher": { "name": "株式会社M2ホールディングス", "verified": true },
  "platform_schema": ">=1 <2",
  "permissions": {
    "tools": ["document.create"],
    "max_risk_level": "draft"
  }
}
```

| 項目 | 書き方 |
|---|---|
| `id` | 逆ドメイン名の形（`jp.自社.名前`）。他と重ならない名前にする |
| `version` | `1.0.0` の形。中身を変えたら上げる |
| `permissions.tools` | **この拡張機能が使うツールをすべて**書く。ここに無いツールは定義で使えない |
| `permissions.max_risk_level` | 使うツールの中で最も強い危険度。管理者は導入の前にこれを見て判断する |

## 2.4 業務エージェントを書く（agents/hello.json）

```json
{
  "schemaVersion": 1,
  "id": "hello",
  "version": 1,
  "name": "あいさつ（サンプル）",
  "category": "sample",
  "description": "あいさつに英語で返事をします。「こんにちは」には「Hello World」と返します",
  "locale": "ja-JP",
  "compartment": null,
  "inputs": {
    "type": "object",
    "required": ["message"],
    "properties": {
      "message": { "type": "string", "title": "あいさつ" }
    }
  },
  "tools": ["document.create"],
  "steps": [
    {
      "id": "reply",
      "type": "agent",
      "label": "返事",
      "instruction": "入力されたあいさつ（message）に、英語で短く返事をする。「こんにちは」には「Hello World」と返す。返事は document.create で、種類を reply、題名を「返事」、本文を返事の文として保存する。",
      "onEmpty": "stop",
      "onError": "stop"
    }
  ],
  "constraints": ["返事は 1 行の英語にする", "あいさつ以外の依頼には応じない"],
  "limits": { "maxSteps": 3, "maxTokens": 5000, "timeoutSec": 60 },
  "help": {
    "summary": "あいさつを入力すると、英語で返事をします。「こんにちは」には「Hello World」と返します。",
    "examples": [
      { "title": "「こんにちは」と言ってみる", "input": { "message": "こんにちは" } }
    ]
  }
}
```

ポイントは 4 つです。

1. **`inputs` から入力のフォームが自動で作られます。** `title` が入力欄の見出しになります
2. **`steps` が手順です。** ここでは `agent` ステップが 1 つだけです。`instruction` に、推論にさせたいことを業務の言葉で書きます
3. **`tools` には、マニフェストで宣言したツールだけを書けます**
4. **`help.summary` は必須です。** 業務のカードに出ます。「この業務がすること」「安心して使えるように」は、使うツールから自動で作られます

`id` は拡張機能の中での名前です。M2Office の中では `jp.m2office.samples.hello-world:hello` になります。

## 2.5 見本の応答を書く（evals/hello.json）

業務エージェントの手順は推論が進めます。LLM の鍵が無い開発環境では、スタブが代わりに応答しますが、
スタブはこの業務の中身を知りません。そこで、**「この入力のときは、こう応答する」という見本**を書きます。

```json
{
  "agent": "hello",
  "cases": [
    {
      "name": "こんにちは",
      "input": { "message": "こんにちは" },
      "expect": "本文が「Hello World」の返事を保存する",
      "stub": {
        "reply": [
          { "name": "document.create", "args": { "kind": "reply", "title": "返事", "body": "Hello World" } }
        ]
      }
    }
  ]
}
```

| 項目 | 内容 |
|---|---|
| `agent` | どの業務エージェントの評価か（定義の `id`） |
| `input` | 実行の入力。これと一致したときに見本が使われる |
| `expect` | 期待する結果を文章で書く。本物の LLM での評価の基準になる |
| `stub` | ステップ ID（`reply`）ごとに、推論が呼ぶはずのツールと引数 |

**見本は定義の一部ではありません。** 本物の LLM では使われず、定義の `instruction` に従って推論されます。
鍵が用意できれば、同じ定義がそのまま本物の推論で動きます。

## 2.6 検証する

```bash
npm run ext:validate extensions/hello-world
```

```
✓ あいさつ（サンプル）（jp.m2office.samples.hello-world 1.0.0）
    業務エージェント jp.m2office.samples.hello-world:hello: 1 ステップ、ツール document.create=draft
    評価のケース 1 件（うち見本の応答つき 1 件）
```

問題があれば理由が出ます。直し方は第6.3節を見てください。

## 2.7 M2Office に読み込ませる

拡張機能は、API とワーカーの**起動時に**読み込まれます。`npm run dev` を一度止めて（`Ctrl + C`）、起動し直します。

```bash
npm run dev
```

ログに次の行が出れば読み込まれています。

```
[api] INFO  拡張機能を読み込みました  extensionId=jp.m2office.samples.hello-world version=1.0.0 agents=["jp.m2office.samples.hello-world:hello"]
```

検証を通らない拡張機能は読み込まれず、`WARN 拡張機能を読み込めませんでした` と理由が出ます。

## 2.8 会社に導入する

読み込まれただけでは、どの会社でも使えません。管理者が導入します。

1. http://a.lvh.me:3100/admin に管理者でログインする（開けない場合は http://localhost:3100/admin?tenant=a ）
2. 左の「拡張機能」を開く
3. 「あいさつ（サンプル）」の「導入する」を押す
4. **この拡張機能に許可すること**（扱う最大の危険度と、することの一覧）を確かめる
5. 「同意して導入する」を押す

## 2.9 動かす

1. 「ワークスペースへ戻る」を押す
2. 左のメニューに「あいさつ（サンプル）」が加わっている。押す
3. 業務の説明の「実行例」から「『こんにちは』と言ってみる」を押す（入力欄に「こんにちは」が入る）
4. 「実行する」を押す
5. 実行の詳細の**成果物に「Hello World」**と出る

右の「実行した処理」には `document.create（draft）` と出ます。
ステップの出力には「見本の応答を再生しています（評価のケース『こんにちは』）」と記録されます。

見本に無い入力（例: 「やあ」）を入れると、スタブは推測で返事を作らず、「この入力に対する見本の応答がありません」と記録します。

## 2.10 ここまでで確かめたこと

| # | 確かめたこと |
|---|---|
| 1 | 定義を書けば、プログラムを書かずに業務を追加できる |
| 2 | 使うツールと最大の危険度をマニフェストで宣言し、管理者が同意して初めて使える |
| 3 | 導入した会社でだけ使え、他の会社には現れない |
| 4 | 業務の説明（することと安全のための決まり）は、定義から自動で付く |
| 5 | 鍵が無くても、見本の応答で導入から成果物までを確かめられる |

## 2.11 次に読むもの

- 定義の項目をすべて知りたい → [第3章](03-agent-definition.md)
- どのツールが使えるか → [第4章](04-tools.md)
- 承認のある業務を作りたい → [第3.4節](03-agent-definition.md#34-approval-ステップ) と [第8章](08-writing-good-agents.md)
- 外部のシステムとつなぎたい → [第7章](07-connectors.md)
