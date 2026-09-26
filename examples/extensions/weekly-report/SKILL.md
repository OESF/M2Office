---
name: weekly
description: 今週の予定と未完了の ToDo から、週報の下書きを作る（送らない）
when_to_use: 「週報を下書きして」と頼まれたとき
argument-hint: 今週
arguments: [対象の週]
allowed-tools: calendar.list tasks.list document.create
metadata:
  author: サンプル株式会社
  version: "2.0.0"
  m2office-id: jp.example.weekly-report
---

# 週報の下書き

対象の週（$対象の週）の週報を下書きする。

1. `calendar.list` で対象の週の予定を、`tasks.list` で未完了の ToDo を取得する
2. 集めた予定と ToDo から週報の下書きを作り、`document.create` で保存する。種類（`kind`）は `weekly-report`、題名は「週報の下書き（対象の週）」
3. 本文は「今週やったこと」「来週の予定」「持ち越しの ToDo」「相談したいこと」の 4 つの見出しで書く。「相談したいこと」は空欄にして、本人が書き足すようにする

## 守ること

- 予定と ToDo に無いことを書き足さない
- 送らない。下書きを作るだけにする
