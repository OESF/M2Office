---
id: updates-v0-40-0-admin
title: 管理者向け: Google Chat から秘書に頼む設定（2026 年 11 月 12 日）
audience: admin
category: updates
related: [admin-google-chat, admin-google-chat-trouble, admin-google-setup]
---
従業員が Google Chat から秘書に頼めるようにするには、会社の Chat アプリに、M2Office が発言を受け取る口を設定します。手順は「Google Chat のつなぎ方（管理者・くわしい手順）」の記事にまとめました。Google Cloud コンソールに、ある程度慣れた人が行ってください。

## できるようになったこと
- 管理者ページの「接続 › Google Workspace › 追加の機能 › Chat への通知（Chat アプリの鍵）」に「Chat で秘書に頼む」が増えました。クラウド版は「受け口の URL を作る」で出た URL を、社内のサーバーは Cloud Pub/Sub の購読の名前を入れます
- 新しく作る Chat アプリ（Google が Workspace アドオンの形に決めたもの）に対応しました
- ヘルプに「Google Chat のつなぎ方（管理者・くわしい手順）」と「Google Chat がつながらないとき（管理者）」を足しました

## 変わったこと
- 通知の時間帯を決めていなかった従業員にも、夜（21:00〜翌 7:00）と休みの日には Chat に送らない決まりが効きます。会社の休みの日は、会社の営業日の設定に従います
