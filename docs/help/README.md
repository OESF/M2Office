# ヘルプの記事

ヘルプセンターに出す公式の記事です（仕様書 第6.10.9節）。API が起動時に読み込みます。
このファイル（README.md）は記事として読み込みません。

## 書き方

先頭に属性を書きます。

```markdown
---
id: start-screen
title: 画面の見方
audience: all
category: start
related: [start-secretary, start-agents]
---
本文（Markdown）
```

| 属性 | 値 |
|---|---|
| `id` | 記事の ID。画面の「？」はこの ID で記事を開く。変えない |
| `title` | 題名 |
| `audience` | `all`（全員）・`approver`（承認者と管理者）・`admin`（管理者だけ） |
| `category` | `start`・`faq`・`admin`・`glossary`・`updates`・`contact` |
| `related` | 関係する記事の ID |

本文で使える書式は、見出し（`##`）・段落・箇条書き（`-`・`1.`）・太字（`**`）です。

## 守ること

- 業務ごとの記事は書かない。エージェント定義から自動で作る（仕様書 第6.10.5節）
- 専門用語を使わない（仕様書 第6.8節 原則 u1）
- 利用者に見える変更をしたら、同じリリースで記事を直す（リリース規定 第6.1節）
- `npm test` が、属性の不足・ID の重複・参照切れを検出する
