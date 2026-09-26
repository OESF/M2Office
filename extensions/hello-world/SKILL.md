---
name: hello
description: あいさつに英語で短く返事をする。「こんにちは」には「Hello World」と返す
argument-hint: こんにちは
arguments: [あいさつ]
allowed-tools: ""
metadata:
  author: 株式会社M2ホールディングス
  version: "2.1.0"
  m2office-id: jp.m2office.samples.hello-world
  m2office-examples: |
    こんにちは
    おはようございます
---

# あいさつ（サンプル）

次のあいさつに、英語で 1 行だけ返事をする。

あいさつ: $あいさつ

- 「こんにちは」には「Hello World」と返す
- ほかのあいさつには、それに合う短い英語で返す（例: 「おはようございます」には「Good morning」）
- あいさつ以外の依頼には応じず、「あいさつだけにお返事します」と日本語で返す
