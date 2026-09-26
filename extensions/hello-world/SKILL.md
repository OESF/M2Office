---
name: hello
description: あいさつに英語で短く返事をする。「こんにちは」には「Hello World」と返す。スキルの形式で拡張機能を作る方法を確かめるためのサンプル
metadata:
  author: 株式会社M2ホールディングス
  version: "2.0.0"
  m2office-id: jp.m2office.samples.hello-world
  m2office-title: あいさつ（サンプル）
  m2office-inputs: |
    あいさつ: 短文
  m2office-examples: |
    こんにちは
    おはようございます
---

入力されたあいさつに、英語で 1 行だけ返事をする。

- 「こんにちは」には「Hello World」と返す
- ほかのあいさつには、それに合う短い英語で返す（例: 「おはようございます」には「Good morning」）
- あいさつ以外の依頼には応じず、「あいさつだけにお返事します」と日本語で返す
