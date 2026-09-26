---
id: admin-audit
title: 監査ログの見方（管理者）
audience: admin
category: admin
related: [admin-runs, admin-users, faq-privacy]
---
管理者ページの左のメニュー、**記録の「監査ログ」**には、「いつ・誰が・何をしたか」の記録が並びます。
トラブルのときに、誰の指示で何が行われたかを確かめるためのものです。

**記録は足していくだけで、変えることも消すこともできません。** 管理者にもできません。

## 画面に出るもの

**新しい順に、直近の 200 件**を出します。

| 列 | 内容 |
|---|---|
| 日時 | 操作した日時 |
| 主体 | 誰が操作したか。種類と ID で出ます |
| 操作 | 何をしたか。英字の決まった名前で出ます（下の表） |
| 対象 | 何に対してか。種類と ID の先頭で出ます |

**主体の種類**

| 表示 | 意味 |
|---|---|
| `user` | 人（従業員・管理者）。秘書に頼んで行った操作も、頼んだ本人として記録します |
| `secretary` | 秘書。ID は、その秘書が付いている人の ID です |
| `agent` | 業務。業務がツール（メールの下書き・予定の登録など）を使うたびに、1 件ずつ記録します |
| `system` | M2Office 自身（定時実行の起動、業務の完了や失敗の記録、期限切れの処理など） |

## 主な操作

| 操作 | 意味 |
|---|---|
| `auth.login`・`auth.logout` | ログイン・ログアウト。`auth.login.denied` はログインを断ったとき |
| `job.create` | 業務を依頼した |
| `run.complete`・`run.fail`・`run.cancel`・`run.expire` | 業務が完了した・失敗した・中止された・期限切れになった |
| `run.await_approval`・`run.await_confirmation` | 業務が承認・操作の確認を待ち始めた |
| `approval.auto` | 社外にもお金にも関わらない承認の段を、自動で通した |
| `approval.decide` | 承認または却下した |
| `tool.invoke` | 業務がツールを使った。`tool.blocked` は使うのを止めたとき |
| `schedule.create`・`schedule.update`・`schedule.trigger`・`schedule.delete`・`schedule.skip` | 定時実行を作った・変えた・動かした・消した・飛ばした（秘書に頼んで止めた・動かしたものは、行った者が秘書になる） |
| `secretary.*` | 秘書が応対した（`secretary.chat` は会話、`secretary.route` は業務へのつなぎ、`secretary.voice` は音声の始まりと終わり）。**話した中身は記録しません** |
| `user.invite`・`user.update` | 人を招待した・ロールや状態を変えた |
| `group.*`・`compartment.*` | グループ・権限区画を作った・変えた・消した |
| `settings.update` | 会社の設定を変えた |
| `connection.*` | Gemini の鍵、Google との接続、コネクタ（MCP）を登録した・変えた・外した。コネクタの道具を止めた・戻した |
| `extension.*` | 拡張機能を取り込んだ・導入した・有効にした・無効にした・削除した |
| `knowledge.*` | 知識を登録した・直した・消した。秘書が会社の知識に加えた（`knowledge.promote.auto`）・会話で直した（`knowledge.correct`） |
| `memory.*` | 秘書が覚えた・直した・消した。**記憶の中身は記録しません** |

## 記録しないもの

秘書との会話の中身、業務の入力と成果物、記憶の中身は、監査ログに残しません。
残るのは「何をしたか」までです。

## いまできないこと

期間や人での絞り込みと、CSV での書き出しは、まだできません。いまは直近の 200 件を見るだけです。
