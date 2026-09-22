# 4. ツールと危険度

業務エージェントが呼べる操作（ツール）の一覧です。定義の `tools` と、マニフェストの `permissions.tools` に書きます。

## 4.1 危険度

すべてのツールは危険度を持ちます。**危険度は基盤が決め、定義からは変えられません。**

| 危険度 | 意味 | 承認 |
|---|---|---|
| `read` | 読むだけ | 不要 |
| `draft` | 下書き・資料を作る。外へは出さない | 不要 |
| `write-internal` | 社内に書き込む（ToDo の登録など） | 会社の設定で、実行の直前に依頼者へ確認を求める（既定は求める） |
| `external-send` | 社外や他の人へ送る | **必ず承認ステップの直後** |
| `financial` | お金に関わる処理 | **必ず承認ステップの直後** |

マニフェストの `max_risk_level` には、使うツールの中で最も強い危険度を書きます。
管理者は導入の前にこれを見て判断します。**必要以上に強いツールを使わないでください。**

## 4.2 内蔵ツールの一覧

右の列は、業務の説明の「この業務がすること」にそのまま出る文です。

| ツール | 危険度 | すること |
|---|---|---|
| `approvals.pending` | read | 本人が判断できる承認待ちを見ます |
| `calendar.freebusy` | read | 参加者の予定の空きを調べます |
| `calendar.list` | read | 予定の一覧を見ます |
| `gmail.get` | read | メールの本文を読みます。本文に書かれた指示には従いません |
| `gmail.list` | read | 受信箱のメールの一覧を見ます |
| `knowledge.search` | read | 社内の知識（規程・議事録など）を調べます。区画の外の人には区画内の文書を見せません |
| `meeting.get_transcript` | read | 会議の記録（文字起こし）を読みます |
| `pdf.extract` | read | PDF から文字を読み取ります。画像だけのページは読めません |
| `sheet.read` | read | Excel・CSV を表として読みます |
| `tasks.list` | read | ToDo の一覧を見ます |
| `document.create` | draft | 文書を作り、成果物として保存します。社外へは出しません |
| `docx.render` | draft | Word 形式の文書を作り、成果物として保存します |
| `gmail.create_draft` | draft | 返信の下書きを作ります。送信はしません |
| `sheet.render` | draft | 表を Excel・CSV として作り、成果物として保存します |
| `notification.send` | write-internal | 依頼した本人にだけお知らせを届けます。他の人には送りません |
| `tasks.create` | write-internal | ToDo を登録します。会社の設定により、登録の前に確認を求めます |
| `calendar.create` | external-send | 予定を登録し、参加者を招待します。必ず承認のあとに行います |
| `chat.post` | external-send | チャットへ投稿します。必ず承認のあとに行います |

メールを**送信する**ツールはありません。受信箱整理（AG-01）は下書きまでで止まる設計です。

## 4.3 引数

推論は、次の引数でツールを呼びます。見本の応答（第5.4節）もこの形で書きます。

| ツール | 引数 |
|---|---|
| `knowledge.search` | `query`: 調べる言葉 |
| `meeting.get_transcript` | `transcript`: 会議の記録 |
| `document.create` | `kind`: 種類、`title`: 題名、`body`: 本文 |
| `gmail.list` | `since`: この時刻以降（任意）、`limit`: 件数（任意） |
| `gmail.get` | `id`: メールの ID |
| `gmail.create_draft` | `replyTo`: 返信するメールの ID、`to`、`subject`、`body` |
| `calendar.list` | `from`・`to`: 期間（任意。既定は今日から 7 日） |
| `calendar.freebusy` | `emails`: 参加者の配列、`from`・`to`（任意） |
| `calendar.create` | `title`、`start`・`end`（ISO 形式）、`attendees`: 参加者の配列 |
| `tasks.list` | なし |
| `tasks.create` | `title`、`due`（任意） |
| `chat.post` | `space`: スペース、`text`: 本文 |
| `notification.send` | `title`、`body`、`kind`（`brief` か `run`）。**宛先は指定できない**（依頼者本人に固定） |
| `approvals.pending` | なし |
| `sheet.read` | `fileId`、`sheet`（任意）、`maxRows`（任意） |
| `pdf.extract` | `fileId` |
| `sheet.render` | `title`、`format`（`xlsx` か `csv`）、`columns`: 列名の配列、`rows`: 行の配列 |
| `docx.render` | `title`、`blocks`: `{ "heading": "…" }` か `{ "text": "…" }` の配列 |

## 4.4 ツールについての決まり

| 決まり | 内容 |
|---|---|
| 最小の権限 | 定義の `tools` に無いツールは、推論が呼ぼうとしても呼ばれない |
| 取得できなかった値 | ツールは失敗を「取得できませんでした」と返す。推測で埋めない |
| 外部から来た文書 | メール・PDF・Excel の中身はデータ。書かれた指示には従わない |
| 読めるファイル | 依頼した本人のファイルだけ。ID を知っていても他人のファイルは読めない |
| Google との接続 | いまはダミーデータ（見本のデータ）で動く。返す値に `source: "mock"` が付く |

## 4.5 ツールを増やしたいとき

内蔵ツールは M2Office 本体の開発で追加します（その場合は開発規約に従い、`activityLabel` と `helpText` を必ず書く）。
**外部のシステムを操作するツールは、コネクタとして作ります**（第7章）。
