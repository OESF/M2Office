# @m2office/api

公開 API（Hono）。**画面も外部アプリも、同じ API を経由します。**

画面専用の抜け道を作らないことが方針です（仕様書 第13.1節 A-1・A-2）。
SPA 構成のため、これは構造として保たれます。

## 前提

Node.js 22 以上、PostgreSQL。ポートは既定で **3101**。

## 起動

```bash
npm run dev     # 監視付き
npm run start   # 単発
```

## テナントの指定と認証

ホスト名からテナントを解決します（`a.lvh.me:3101` → `a`）。

利用者は次の順で確認します。どちらでも確認できなければ 401 を返します。
**利用者の指定が無いときに管理者として扱うことはしません。**

| 順 | 手段 | 条件 |
|---|---|---|
| 1 | ログイン状態の Cookie（`m2o_session`） | テナントが一致すること。書き込みには `X-CSRF-Token` が必要 |
| 2 | `X-User` ヘッダー | **開発用**。`AUTH_DEV_HEADERS=true` のときだけ |

```bash
# 開発用ヘッダーでの確認（AUTH_DEV_HEADERS=true）
curl -H 'x-tenant: a' -H 'x-user: member@alpha.example.jp' http://localhost:3101/v1/me
```

Cookie は `HttpOnly`・`SameSite=Lax` で、`Domain` 属性を付けません。

### 権限区画の無効化と削除

`PUT /v1/admin/compartments/:id/enabled` と `DELETE /v1/admin/compartments/:id`（仕様書 第16.3.6.1節）。
無効の間は誰も区画に入れません（`listUserCompartments()` が `enabled` で絞ります）。
削除は、その区画の使っている知識（`countKnowledgeInCompartment()`。廃止・しまったものは数えない）と業務（会社から見える定義の `compartment`）が残っていれば 409 で断ります。

### 音声の中継（WebSocket）

`/v1/secretary/voice` は WebSocket で、ブラウザと音声の提供者のあいだを中継します（仕様書 第10.5.5節、ADR-0018）。
Hono の外側（Node のサーバーの `upgrade`）で受け、ログイン状態の Cookie（動作確認では開発用ヘッダー）で相手を確かめます。
停止中の会社では開けません。送りは 16 kHz、受けは 24 kHz の PCM で、**音はどこにも書き出しません**。
終わったときに、聞こえた文字と応答を会話ログへ 1 往復として残します。

音声の相手にはツールを 2 つ渡します（仕様書 第10.5.7節）。`handle_request` は本人の依頼を**画面の入力と同じ取次**（`Secretary.respond`）に渡し、
答えを音声の相手へ返します。**声で返すのが基本**で、答えが大きいとき（`needsCanvas`）だけ画面へ `{ type: 'secretary', request, reply }` を送り、
秘書のキャンバスに根拠や業務を開くボタンと一緒に出します（仕様書 第6.2.0節）。音声の相手には `shown_on_screen` で出したかを伝えます。
`show_on_canvas` は、本人に「画面に出して」と頼まれたときに、直前の答え（または頼まれたもの）を画面へ送ります。直前の答えは対話の間だけ持ちます。
終わった調べもの・頼んだ業務の結果も、大きければ画面へ送ります。声で頼まれた業務も、秘書が頼んで実行します（仕様書 第10.9.6節）。取次の 1 件ずつは会話ログに残しません（対話の終わりにまとめて残すため）。

秘書の名乗り・呼び方・応対スタイル・話し方の指示は `voice/persona.ts` にまとめ、音声の対話と「声を試す」（`POST /v1/me/voice-test`、`voice/sample.ts`）が同じものを使います。
声を試すときは同じ提供者を開き、挨拶だけを頼んで話し終わりまでの声を集めて返し、すぐ閉じます。ツールは渡さず、会話ログ・監査ログの `secretary.voice` には残しません（仕様書 第10.5.8節）。

後ろへ回した調べもの（仕様書 第10.11節）が終わったら、この中継が伝えます。
実行は別のプロセス（ワーカー）で進むため、3 秒ごとに終わったものを探します。
**秘書が話している間は伝えません**（`TurnGate`）。割り込むと再生中の音声が切れるためです。
待たせたものが複数あっても、話し終わりごとに 1 つだけ伝えます。
つないだ直後にも見に行きます。**画面も音声も閉じている間に終わったものは、ここで持ち越して伝わります**。
伝えたことは `lookup_deliveries` に記録し、**記録を先に取ってから伝えます**。
画面と音声を同時に開いていても、伝えるのは一方だけです。終わってから 7 日を過ぎたものは伝えません。

### ダッシュボードの SSE

`GET /v1/admin/dashboard/stream` は `text/event-stream` で「いま」の中身を送ります（仕様書 第6.7.9節、ADR-0013）。
`DASHBOARD_STREAM_TICK_MS`（既定 2 秒）ごとに状態を組み立て、**前回と違うときだけ**送ります。15 秒ごとに心拍を送ります。
画面は `EventSource` ではなく `fetch` の読み取りで受けます（認証のヘッダーを付けるため）。

### テナントの状態による制御

テナントの状態（`tenants.status`）で、受け付ける要求を変えます（仕様書 第23.8.6節）。判定は `resolveTenant()` にあります。

| 状態 | 受け付けるもの |
|---|---|
| `trial`・`active` | すべて |
| `suspended`（通常の停止） | 閲覧（`GET`。Google のログインの開始を除く）と、ログイン・ログアウト・お知らせの既読・端末のログアウト。ほかは 403（`suspended: true`） |
| `locked`（緊急停止） | なし。理由は返さない |
| `cancelled`（解約済み） | なし（持ち出しの実装までは） |

停止中に受け付ける書き込みを増やすときは、`allowedWhileSuspended()` の表と仕様書の表を同じコミットで直してください。
ワーカーは、試用・稼働中でない会社の待ち行列の実行と定時実行を取りません（移行 020）。
A 社のサブドメインで発行した Cookie は B 社へ送られず、持ち込んでも拒否します。
データベースには Cookie の値ではなくハッシュを保存します。

正式なログインは Google アカウントのみです（仕様書 第16.1節）。

**ログインと、Google のデータへのアクセスとで OAuth クライアントを分けます**（第16.1.1節）。
ログインは運営のもの 1 つ（`GOOGLE_LOGIN_CLIENT_ID` / `GOOGLE_LOGIN_CLIENT_SECRET`）で、
求める権限は `openid`・`email`・`profile` だけです。会社のデータには触れません。
会社のクライアントは管理者ページの接続で登録します。分ける理由は、会社のクライアントの登録に
管理者ページが要る以上、ログインまでそれに頼ると最初の管理者が入れないためです。

Google はリダイレクト URI に HTTPS を要求します（例外は `localhost`）。
テナントごとのホストを戻り先にできないため、次の経路にしています（第16.1.2節）。

| 順 | 口 | ホスト |
|---|---|---|
| 1 | `GET /v1/auth/google/start` | 会社のホスト。`state` に会社を入れて同意画面の URL を返す |
| 2 | `GET /v1/oauth/google/login-callback` | **運営のホスト 1 本**（開発は `localhost:3101`）。ここでは Cookie を張らない |
| 3 | `POST /v1/auth/exchange` | 会社のホスト。**1 回限りの引換券**を Cookie に換える |

ログイン Cookie は `Domain` を付けないため、運営のホストで張っても会社のホストには届きません。
引換券はそれを越えるためのもので、2 分で失効し、1 回しか使えません。
券に入れるのは会社と利用者の ID だけで、名前もメールアドレスも入れません。

未設定なら `GET /v1/auth/google/start` は 503 を返し、
開発用ログイン（`POST /v1/auth/dev-login`）で動かします。
開発用の手段は `NODE_ENV=production` で有効にすると起動を拒否します。

## 主なエンドポイント

| メソッド・パス | 内容 |
|---|---|
| `GET /health` | 生存確認。テナント不要 |
| `GET /v1/auth/providers` | 使えるログイン手段。認証不要 |
| `POST /v1/auth/dev-login` | 開発用ログイン。認証不要 |
| `GET /v1/auth/google/start` | Google の同意画面の URL を返す（仕様書 第16.1.2節）。運営のクライアントが未設定なら 503 |
| `POST /v1/auth/exchange` | 引換券を、このホストでのログイン状態に換える。券は 1 回限り・2 分 |
| `GET /v1/oauth/google/login-callback` | Google からの戻り。**運営のホストで受ける**。テナントの判定とログインより前 |
| `POST /v1/auth/logout` | ログアウト |
| `GET /v1/agents` | 本人が使える業務の一覧（`agents`。入力スキーマと、定時実行に登録できるかの `schedulable` を含む）。メニューのピン止めは個人設定（`menu.pinned`。仕様書 第6.1.1節） |
| `GET /v1/me` | テナント・利用者・CSRF トークン・接続の状態・本人のアバターの URL（`photo`。無ければ `null`）・サーバーの版（`serverVersion`。画面の版との食い違いの判定に使う。仕様書 第6.1.1.1節）。呼ばれたとき、まだなら朝のブリーフの定時実行（平日 7:30）を秘書が用意する（`secretary/morning.ts`。第9.5.5.1節） |
| `GET /v1/me/photo` | 本人のアバター（Google のプロフィール写真）。**本人の写真だけ**を返し、利用者の ID は受け取らない。`nosniff` と読み込みを禁じる CSP を付ける（仕様書 第6.5.1.1節） |
| `POST /v1/jobs` | ジョブを作成し待ち行列へ入れる。実行はワーカーが担う |
| `GET /v1/jobs` | **本人が依頼した**実行の一覧 |
| `GET /v1/runs/:id` | 実行の詳細。依頼者本人と、その実行に自分が判断できる承認がある人だけが見られる（仕様書 第6.2.1節）。ほかの人には 404。誰がいつ判断したか（`decisions`。第6.2.5節） |
| `POST /v1/runs/:id/cancel` | 実行の中止（仕様書 第9.3.1節）。**依頼した本人だけ**。承認する人は 403、終わった実行は 409。作りかけの文書のリンクを返す |
| `GET /v1/approvals` | 本人のロールで判断できる承認待ち |
| `GET /v1/approvals/decided` | 本人が判断した承認と却下（新しい順に 100 件）。判断したときの承認の画面・承認か却下か・日時・コメント・依頼した人・承認のあとに実際に行ったことと結果のリンク（仕様書 第6.2.5節） |
| `POST /v1/approvals/:id` | 承認または却下。ロールが無ければ 403 |
| `POST /v1/secretary` | 秘書への依頼。どの層で答えたかを返す。`fileId` で手元のファイルを 1 つ渡せる（仕様書 第10.10節）。**ファイルが付いていれば、この応答の中では読まず、調べものとして後ろへ回す**（第10.11節）。返る `lookup` は受け付けであって結果ではない |
| `GET /v1/secretary/lookups` | 後ろへ回した調べものと、秘書が頼んだ業務（`agentName`）の状態。動いているものは進み具合（承認待ちは「承認を待っています」）、終わったもの（`done`）は答え（成果物の題名と開くリンクを含む）と「伝えたか」を返す（第10.11.6節・第10.9.6節）。動いている段取りは `runId: plan:<ID>` で進み具合か本人への問いを返し、段の業務は個別には返さない（報告は段取りの報告の業務として届く。第10.14節） |
| `POST /v1/secretary/lookups/claim` | **まだ伝えていない調べものを受け取る**（第10.11.7節「持ち越し」）。読むだけの口ではなく、返したものは「伝えた」として記録され、会話ログにも残る（続きの依頼に答えるため）。受け取ったら必ず画面に出すこと |
| `GET /v1/notifications` | 本人宛の通知 |
| `POST /v1/notifications/:id/read` | 既読にする |
| `DELETE /v1/notifications/:id` ／ `POST /v1/notifications/delete` | 本人の通知を 1 件消す ／ 選んだものをまとめて消す（`ids`。100 件まで）。ほかの人の通知は消えない（第6.5.5節） |
| `GET /v1/schedules` | 本人の定時実行 |
| `GET /v1/cards` | 名刺の一覧と検索（`q`・`scope`・`trash=1`、交換した日の範囲 `from`・`to`）。本人の読み取り中・読み取れなかった名刺（`unresolved`）と進み具合（`progress`）、会社の既定の範囲も返す。名刺管理を切っている会社と利用範囲の外の人には、`/v1/cards` のどの口も 403（仕様書 第27.8節） |
| `POST /v1/cards/import` | 表（CSV・Excel。multipart の `file` と `scope`。5 MB・1,000 行まで）から名刺を取り込む。列の見出しはよくある言い方と推論で読み、1 行を 1 枚の名刺（画像なし）として登録し、同じ人はまとめる。登録した数・まとめた数・取り込めなかった行・列の読み方を返す（仕様書 第27.4節） |
| `GET /v1/cards/export` | 管理者: 会社で共有の名刺を CSV（`format=csv`。BOM 付きの UTF-8）か Excel（`format=xlsx`）で書き出す。自分だけの名刺は入れない。監査ログ `contact.export`（第27.10節） |
| `POST /v1/cards` | 名刺のファイルを受け付ける（multipart。`file` を 50 まで・`backOf`（裏を組にする表の番号の JSON）・`scope`）。読み取りを待たずに 202。受け付けなかったものは `rejected`（第27.4節） |
| `GET /v1/cards/:id` | 名刺の詳細（連絡先・名刺ごとの受け取った人と日・向き・四隅（`frontCorners`・`backCorners`。画面が切り出しに使う。第27.5節）・名刺の履歴・範囲を変えられるか）。一覧の各行にも `frontCorners` を返す。1 枚の写真に何枚も写っていれば、名刺ごとに同じ画像を指す（写真は、指す名刺が残っている間は消さない） |
| `PATCH /v1/cards/:id` | 項目とメモをその場で直す（見られる人の全員。直した値は名刺の「人が直した項目」にも残す） |
| `PUT /v1/cards/:id/scope` | 範囲を変える（`company`・`personal`。自分だけにできるのは本人で、ほかの人の名刺がまとまっていないとき） |
| `POST /v1/cards/:id/split` | まとめた名刺を別の連絡先に分ける（`cardId`） |
| `POST /v1/cards/bulk-mails` | まとめてのメールの下書きを作る（`contactIds`・`subject`・`body`。仕様書 第27.9.1節）。下書きは作った本人だけが見られる |
| `GET /v1/cards/bulk-mails/:bulkId` | 送る宛先・除いた人と理由・1 人目に差し込んだ見本・宣伝かどうか・送れない理由（`problems`）・送った数 |
| `PUT /v1/cards/bulk-mails/:bulkId` | 下書きの宛先・件名・本文を直す（承認待ちにした後は 409） |
| `DELETE /v1/cards/bulk-mails/:bulkId` | 下書きを削除する（送ったものは 409） |
| `POST /v1/cards/bulk-mails/:bulkId/submit` | 承認へ進める（業務「まとめてのメール」を始め、本人の承認を待つ。`runId`）。送れない理由があれば 400 |
| `POST /v1/cards/:id/changes/:changeId/revert` | メールの署名から新しくした記録を戻す（今の値が署名の値のままの項目だけ。仕様書 第27.6.1節）。詳細（`GET /v1/cards/:id`）の `changes` に記録が並ぶ（誰のメールからかは返さない） |
| `DELETE /v1/cards/:id` ／ `POST /v1/cards/:id/restore` ／ `DELETE /v1/cards/:id/purge` | ごみ箱へ移す／戻す／ごみ箱からいま本当に消す（画像ごと。取り込んだ本人と、会社で共有のものは管理者） |
| `GET /v1/cards/:id/vcard` | 1 件を vCard（3.0）で書き出す |
| `GET /v1/cards/:id/meetings` | 本人が名刺を受け取った日の本人の予定（開くたびにカレンダーから引く。保存しない。第27.8節） |
| `GET /v1/cards/card/:cardId/front` ／ `back` | 名刺の画像（見られる名刺のものだけ。ページだけの PDF は囲いの中で開かせる） |
| `PUT /v1/cards/card/:cardId/received` | 受け取った日を直す（`receivedOn`。受け取った本人だけ。今日より後は 400。初めの値は取り込んだ人のタイムゾーンでの取り込んだ日。第27.3節） |
| `DELETE /v1/cards/card/:cardId` | 読み取れなかった名刺を、待たずに消す（取り込んだ本人だけ） |
| `GET /v1/signage` ／ `PATCH /v1/signage/screens/:id` | 店頭サイネージ（仕様書 第31章）: 画面の一覧と状態・使っている容量と上限・管理者か ／ 画面の名前・向き・回し方・音の大きさ（`volume` 0〜100）を直す。サイネージを切っている会社と利用範囲の外の人には、`/v1/signage` のどの口も 403 |
| `GET` ／ `PUT /v1/signage/screens/:id/entries` | 画面の流れと版 ／ 並びごと置き換える（`version` が違えば 409） |
| `GET` ／ `POST /v1/signage/assets` | 素材の一覧（どの画面の流れに入っているかつき）／ 足す（本文はファイルの中身そのもの。`x-file-name`・`x-width`・`x-height`。形式・縦横・長さをサーバーでも確かめ、H.264 でない動画は 422。HTML は 10 MB・UTF-8 で、外への参照（`http:`・`https:`・`//`）が残れば 422、`<title>` を名前にする。同じ中身は 200 と前の素材） |
| `PUT /v1/signage/assets/:id/thumbnail` ／ `PATCH` ／ `DELETE /v1/signage/assets/:id` | 縮小画像（JPEG・100 KB まで）／ 名前・割り込みの素材にするか（`isInterrupt`。画像と HTML だけ。50 個まで）・鳴らす音（`jingle`）を直す ／ 消す（流れからも外し、外した画面の名前を返す） |
| `GET /v1/signage/assets/:id/content` ／ `/thumbnail` | 素材の中身（`Range` に応じる。HTML には外と通信させない `content-security-policy` を付ける）／ 縮小画像 |
| `POST` ／ `GET /v1/signage/interrupts` | 割り込みを出す（`text` か `number`・`place` か `assetId`、`screens`・`seconds`・`chime`・`jingle`。文は 80 字まで。同じ中身が待っているか出している画面にはまとめる。201 と足した画面・まとめた画面）／ 最近 24 時間の割り込みと画面ごとの状態 |
| `POST /v1/signage/interrupts/:id/clear` ／ `POST /v1/signage/clear` | その割り込みを消す ／ すべて消す（`screens` で画面を選べる） |
| `GET /v1/signage/phrases` ／ `POST /v1/signage/phrases/:id/hide` | よく出す案内（14 日に 3 回以上出した形）と割り込みの素材の使った回数 ／ 案内を外す |
| `GET /v1/signage/sounds` ／ `GET /v1/signage/mobile-qr.svg` | 会社のジングルの音の一覧 ／ スタッフのページ（`/m/signage`）の QR |
| `POST /v1/admin/extensions/signage/pairings/claim` ／ `DELETE /v1/admin/extensions/signage/screens/:id` ／ `PUT /v1/admin/extensions/signage/settings` | 管理者: 番号で画面を登録（1 社 3 台まで。外して 30 日以内の画面は引き継ぐ）／ 画面を外す（鍵はその場で効かない）／ 画像の秒数・店の色・割り込みの秒数（5〜60）・ジングルの有無と既定の音・呼び出しの言い回し（`{番号}` と `{場所}`） |
| `GET` ／ `POST /v1/admin/extensions/signage/sources` ／ `PUT …/sources/:id/status` ／ `POST …/sources/:id/reset-mapping` | 管理者: 呼び出しの受け口の一覧（今日の受け付けた数・断った数）／ 作る（URL と鍵は作ったときだけ返す）／ 止める・動かす ／ 項目の対応を忘れて推測し直す |
| `GET` ／ `POST /v1/admin/extensions/signage/sounds` ／ `DELETE …/sounds/:id` | 管理者: 会社のジングルの音（本文は MP3・WAV そのもの。`x-sound-name`・`x-duration-ms`。5 秒・300 KB・10 個まで）／ 消す（既定の音なら「ピンポーン」に戻す） |
| `/v1/signage-play/...` | 再生のページ（端末）。**ログインを使わず、画面の鍵（`Authorization: Bearer`）で名乗る**。`POST /pairings`（登録の番号。1 時間に 20 回まで）・`GET /pairings/qr.svg`・`POST /pairings/poll`（登録されたら鍵を 1 度だけ返す）・`GET /state`・`GET /assets/:id`（`Range`）・`GET /assets/:id/thumbnail`・`GET /events`（SSE。流れ・設定・外された・割り込み・消す・音の大きさ）・`POST /heartbeat`（停止中も受ける）・`GET /interrupts`（待っているものと出しているもの。経過はサーバーが数える）・`POST /interrupts/:id/started`・`/ended`（`ended` は停止中も受ける）・`GET /sounds/:id`。鍵が無い・違う会社は 401、切った会社は 404 |
| `GET /v1/inventory` | 在庫の品目の一覧（`q`・`stopped=1`）と使える数・場所・会社の機能の入り切り。在庫管理を切っている会社と利用範囲の外の人には、`/v1/inventory` のどの口も 403（仕様書 第29章） |
| `GET /v1/inventory/items/:id` | 品目の詳細（場所とロットごとの数・最近の記録） |
| `POST /v1/inventory/items` ／ `PUT /v1/inventory/items/:id` | 品目を作る・直す（バーコードは `codes` で足す。会社の中で重ならない）。作るときは `initialQty`（いまの数）を入庫として記録し、単位の欄の数ははじめの数として読んで `note` で返す。直すときに単位へ数を入れると 400 |
| `PUT /v1/inventory/items/:id/status` | 管理者: 品目を止める・使うに戻す（在庫が残れば止められない） |
| `DELETE /v1/inventory/items/:id/codes/:code` | 品目からバーコードを外す |
| `GET /v1/inventory/lookup` | 読んだ値（`code`。GS1・JAN・棚のラベル）から品目か棚を引く。GS1 なら使用期限とロットも返す |
| `GET /v1/inventory/jan/:code` | JAN（GTIN）から商品名・メーカー・分類を Gemini の Google 検索で引く（第29.6節）。一致を確かめられたときだけ `found: true`。見つからない・調べられない（鍵が無い・「ローカルだけ」の会社）ときも 200 で `found: false`。同じ会社の同じコードは 24 時間使い回す |
| `POST /v1/inventory/locations` ／ `DELETE /v1/inventory/locations/:id` | 場所を足す・外す（外すのは管理者。在庫が残れば外せない） |
| `POST /v1/inventory/moves` | 入庫・使用・移動・調整を記録する（`kind`・`itemId`・`qty`・`unit`・場所・ロット・理由）。在庫がマイナスになれば `warnings` で知らせる |
| `POST /v1/inventory/moves/:id/undo` | 自分の記録をその日のうちに取り消す（逆の記録を操作の組で足す） |
| `GET /v1/inventory/moves` | 入出庫の記録（`itemId`・`from`・`to`） |
| `POST /v1/inventory/import` | CSV・Excel から品目を取り込む（`file`。見出しを推論で読む。監査ログに残す） |
| `GET /v1/inventory/locations/labels.pdf` | 棚のラベル（QR）を A4 に 3 列 × 7 段で並べた PDF（`ids` で場所を絞る）。QR にはその棚を開くスマホ用のページの URL（会社のホスト＋`/m/inventory?shelf=…`）を入れる（第29.7節） |
| `GET /v1/inventory/suppliers` ／ `POST /v1/inventory/suppliers` | 仕入先の一覧 ／ 足す・直す（`id`・`name`・`method`: mail・web・phone・`contact`・`leadDays`。第29.4.1節） |
| `GET /v1/inventory/forecast` | 見張りの結果（使える数・1 日に使う数・あと何日・仕入れの日数・期限の近いロット・発注の案。急ぐ順。第29.14節） |
| `POST /v1/inventory/orders` | 発注を始める（`supplierId`・`lines`: itemId と qty）。メールの仕入先は付属の業務「発注の下書き」を起こす（送るのは本人の承認のあと。201 と `runId`）。Web・電話の仕入先は連絡先と伝える内容を返す |
| `POST /v1/inventory/slips` | 納品書の写真か PDF（`file`・`locationId`）を読み取り、照らせた行を入庫にする。結果は入庫にした行と照らせなかった行（理由と候補）。読めなければ 422。ファイルは会社のファイルとして残す（第29.9節） |
| `GET /v1/inventory/mobile-qr.svg` | スマホ用のページ（`/m/inventory`）を開く QR（SVG。第29.11.1節） |
| `GET /v1/inventory/counts` ／ `POST /v1/inventory/counts` | 開いている棚卸し（差の一覧つき）と最近の棚卸し ／ 始める（`scope`: all・location・category と `value`。開いていれば続ける。会社で 1 つ。第29.10節） |
| `GET /v1/inventory/counts/:id` | 棚卸しの姿（数えた行と数えていない行を差の大きい順に） |
| `POST /v1/inventory/counts/:id/lines` | 数える（`itemId`・`qty`・`mode`: add か set・`unit`・`locationId`・`lot`・`expiresOn`）。何人でも足し合わせる |
| `POST /v1/inventory/counts/:id/explain` | 差の大きい品目の考えられる理由（秘書の推測。帳簿は直さない） |
| `POST /v1/inventory/counts/:id/close` ／ `cancel` | 確定する（差を理由「棚卸し」の調整にし、数えていない行は 0 にしない）／ やめる。どちらも始めた人と管理者だけ（それ以外は 403） |
| `GET /v1/inventory/counts/:id/export` | 棚卸しの結果を CSV で書き出す（監査ログに残す） |
| `GET /v1/inventory/export` | 品目と数を書き出す（`format=csv` か `xlsx`。監査ログに残す） |
| `GET /v1/hr/employees` | 人事・給与（第30章）: 従業員の一覧（いまの雇用条件の要点・済んでいない手続きの数）と、済んでいない手続き・会社の設定。**会社で入れていて人事区画 `hr` に入っている人だけ**。それ以外は `/v1/hr` のどの口も 403。一覧を開いたことも監査ログに残す |
| `GET /v1/hr/employees/:id` | 1 人の台帳（雇用条件の履歴・手続き）。見たことを監査ログに残す（第30.21節） |
| `POST /v1/hr/employees` ／ `PUT /v1/hr/employees/:id` | 従業員を作る（最初の雇用条件 `terms` と入社の手続きを作る）／ 台帳の基本の項目を直す（入社日を変えたら入社の手続きの期限を直す）。社員番号は会社の中で重ならない |
| `POST /v1/hr/employees/:id/terms` | 雇用条件を足す（`effectiveOn` 必須。前の条件を引き継ぎ、送った項目だけを変える履歴。`schedule`: fixed・shift で働き方） |
| `PUT /v1/hr/employees/:id/photo` ／ `DELETE /v1/hr/employees/:id/photo` | 顔写真を入れる（`file`。JPEG か PNG・1 MB まで。前の写真は残さない）／ 外す（第30.5.4節、ADR-0055） |
| `POST /v1/hr/photos/import` | 顔写真をまとめて取り込むときの 1 枚（`file`）。ファイル名（社員番号・氏名・ふりがな）か写真の中の名札で人に当てる。当てられなければ 422 と理由 |
| `GET /v1/hr-photos/:employeeId` | 従業員の顔写真を見る。**社内の全員**が見られる（人事区画に入っていなくてよい。人事・給与を切っている会社は 404）。`/v1/me` の `photo` は、Google の写真が無ければ台帳の顔写真の URL になる |
| `POST /v1/hr/employees/:id/leave` | 退職を記録する（`leftOn`・`reason`）。退職の手続きを期限つきで作る（第30.5.2節） |
| `PUT /v1/hr/tasks/:id` | 手続きを済んだにする・戻す（`done`） |
| `POST /v1/hr/import` | CSV・Excel から従業員を取り込む（`file`。見出しを推論で読む。入社・退職から 60 日を過ぎた人の手続きは作らない） |
| `GET /v1/hr/attendance` ／ `GET /v1/hr/attendance/:employeeId` | 勤怠（段 2。第30.6.1節）: 期間（`month`: 締め日の月 YYYY-MM）の従業員ごとの集計・点検の数・36 協定の知らせと締め ／ 1 人の日ごとの勤怠（見たことを監査ログに残す） |
| `PUT /v1/hr/attendance/:employeeId/days/:date` | 担当者が 1 日の打刻を直す（`in`・`out`・`breaks`。締めた期間は 400） |
| `POST /v1/hr/attendance/close` ／ `POST /v1/hr/attendance/closes/:id/reopen` | 期間を締める（`month`。期間の終わりの日を過ぎてから）／ 締めを戻す |
| `GET /v1/hr/attendance/book` | 出勤簿を書き出す（`month`・`format`） |
| `GET /v1/hr/leave` ／ `GET /v1/hr/leave/register` | 有給（第30.7.1節）: 全員の残り・付与・取得義務・出勤率の低い人・取った日 ／ 年次有給休暇の管理簿を書き出す |
| `POST /v1/hr/leave/:employeeId/grants` ／ `POST /v1/hr/leave/:employeeId/takes` ／ `DELETE /v1/hr/leave/takes/:id` | 手作業の付与（導入のときの残日数）／ 担当者が取得を記録 ／ 取り消す |
| `GET /v1/hr/payroll/employees/:id` ／ `PUT .../profile` | 給与（段 3。第30.10.1節）: 1 人の給与の情報・標準報酬月額・家族 ／ 給与の情報を直す（`taxColumn`・`dependents`・`residentTax`・`commute`・`bank`・`insurance`（被保険者整理番号・学生か・見込みの時間外手当）） |
| `POST /v1/hr/payroll/employees/:id/standard-pay` | 標準報酬月額を足す（`fromMonth`・`pay`。報酬の額を等級表で標準報酬月額に直す） |
| `POST /v1/hr/payroll/employees/:id/family` ／ `DELETE .../family/:memberId` | 家族を足す・外す |
| `GET /v1/hr/payroll/runs` ／ `POST /v1/hr/payroll/runs` ／ `GET /v1/hr/payroll/runs/:id` | 給与の回の一覧（`month` で支払日と勤怠の期間も）／ 支給月（`month`）の月の給与を計算して点検し、下書きにする（同じ月の下書きは置き換える。確定した月は 400）／ 回と明細と点検（行ごとの根拠・確定を止めているもの `blockers`・確定できるか `canConfirm`。見たことを監査ログに残す） |
| `GET /v1/hr/employees/:id/terms-notice` ／ `POST .../terms-notice` | 労働条件通知書（第30.5.3節）: 明示事項と足りない事項・会社の定めの既定 ／ PDF（本文 `notice`: 昇給・賞与・退職手当・退職に関する事項・相談の窓口・その他。書いた文を次からの既定として残す。`on`: 雇用条件を選ぶ日） |
| `GET /v1/hr/calendar` | 労務の期限（第30.19.1節。`days` 既定 90。納付・年度更新・算定基礎届・36 協定・健康診断・契約の満了・入退社の手続き・有給の取得義務。過ぎて済んでいない手続きを先頭に） |
| `GET /v1/hr/payroll/adjustments` ／ `POST .../adjustments` ／ `DELETE .../adjustments/:id` | 調整の行（第30.10.4節。`kind`: monthly・bonus、`month`）／ 足す（`employeeId`・`label`・`direction`・`amount`・`taxable`・`insurable`・`reason`。確定した月は 400）／ 外す |
| `GET /v1/hr/payroll/bonus` ／ `PUT .../bonus` ／ `POST .../bonus/calculate` | 賞与の回の入力と入れられる従業員（`month`。前の賞与の額を既定に）／ 入力を残す（`payDate`・`longPeriod`・`amounts`）／ 賞与を計算して下書きにする（第30.11.1節） |
| `GET /v1/hr/payroll/runs/:id/bonus-report` ／ `POST .../runs/:id/correction` | 賞与支払届の下書き（確定した賞与の回。`format`）／ 確定した月の給与の訂正の回を作る（`payDate`。差が無ければ 400） |
| `POST /v1/hr/payroll/runs/:id/confirm` ／ `POST .../request` | 段 4（第30.10.3節）: 確定する（**管理者だけ**。押すことを承認とする。危険度 financial。点検で止まっていれば 400。監修前の表はデバッグモードのときだけ確定でき、回に残す。ADR-0053。確定すると同意した本人に明細を知らせる）／ 管理者に確定を頼む |
| `POST /v1/hr/payroll/runs/:id/transfer` | 振込データ（全銀協の形式・シフト JIS・120 バイトの固定長）を作る。確定した回から**管理者だけ**。作れなければ 400 と `problems`。`X-Transfer-Count`・`X-Transfer-Excluded`（振込先の無い人） |
| `GET /v1/hr/payroll/slips/:id/pdf` ／ `GET /v1/hr/payroll/ledger` | 明細の PDF ／ 賃金台帳（`year`・`format`: csv・xlsx。確定した月の給与と法定の記載事項） |
| `POST /v1/hr/payroll/resident-tax/read` ／ `POST /v1/hr/payroll/trials` | 住民税の決定通知書（`file`: PDF・写真）を AI で読み、氏名で当てて給与の情報に入れる（6 月分 ＋ 月額 × 11 ≠ 年税額は入れない。読めなければ 422）／ 試しの計算（`month`・`file`: 今の方法の給与の表。人ごと・項目ごとの差を `run.compare` に返す） |
| `GET /v1/hr/yea` ／ `POST .../yea/request` ／ `POST .../yea/calculate` | 年末調整（Phase 2 段 2。第30.15.1節）: 一覧（`year`。対象・申告の状態・不備・年末調整の回）／ 対象でまだ出していない人に申告を頼む ／ 計算して年末調整の回（下書き）にする（`year`・`payDate`: 還付を払う日） |
| `GET /v1/hr/yea/:employeeId` ／ `PUT ...` ／ `POST .../check` | 1 人の申告（`year`）／ 担当者が直す（`year`・`data`）／ 確かめた（`checked`。本人は直せなくなる） |
| `GET /v1/hr/yea/:employeeId/withholding.pdf` ／ `GET /v1/hr/yea/report` | 源泉徴収票（本人交付用）の PDF ／ 源泉徴収票（提出用）・給与支払報告書の下書き（`year`・`format`: csv・xlsx）。マイナンバーの欄は空ける |
| `GET /v1/hr/social` | 社会保険（Phase 2 段 3。第30.12.1節）: 定時決定（`year`）・随時改定の候補・前後 60 日の資格の取得と喪失と 70 歳到達・加入の判定・特定適用事業所の見込み |
| `POST /v1/hr/social/regular/report` ／ `POST .../social/change/report` ／ `POST .../social/events/:kind/report` | 算定基礎届（`year`）／ 月額変更届（`ids`）／ 資格取得届・資格喪失届・70 歳到達届（`kind`: acquire・lose・age70、`ids`）の表計算の下書き（`format`: xlsx・csv）。作った額を適用の月からの標準報酬月額として入れ、人数を `X-Applied` に返す。載せる人がいなければ 400 |
| `GET /v1/hr/shifts` ／ `PUT .../shifts/settings` ／ `POST .../shifts/generate` ／ `PUT .../shifts/cell` ／ `POST .../shifts/publish` | シフト（Phase 2 段 5。第30.6.2節）: 期間のシフト・休みの希望・点検（`month`: 締め日の月。省略すれば次の期間）／ 勤務の型・要る人数・変形労働時間制（`patterns`・`needs`・`variable`・`special44`）／ 案を作る（`month`。公開した期間は 400）／ 1 人 1 日を直す（`month`・`employeeId`・`date`・`patternId`。null は休み）／ 公開する（止まっている点検があれば 400。シフトの人に知らせる） |
| `GET /v1/hr/labor-insurance` ／ `PUT ...` ／ `POST .../report` | 労働保険の年度更新（Phase 2 段 4。第30.13.1節）: 前年度の月ごとの集計と計算（`year`: 申告する年。足りない月があれば `result` は `null` で `error` に理由）／ 足りない月の合計・申告済の概算保険料・見込みの賃金を残す（`year`・`supplements`・`declaredEstimate`・`estimateWages`）／ 算定基礎賃金集計表と申告書に書く額の下書き（`format`。結果を残す） |
| `GET /v1/hr/users` | 台帳に結び付けられる利用者（名前とメールアドレス） |
| `GET /v1/me/hr` | 本人の「給与・勤怠」（第30.25節）: 打刻の状態・期間の勤怠・有給の残りと取得義務。台帳に結び付いていなければ 404（同じメールアドレスなら自動で結び付く） |
| `POST /v1/me/hr/punch` ／ `PUT /v1/me/hr/days/:date` | 本人が打刻する（`kind`: in・out・break_start・break_end。できない打刻は 409）／ 1 日を直す（人事区画の人に知らせる。締めた期間は 400） |
| `POST /v1/me/hr/leave` ／ `DELETE /v1/me/hr/leave/:id` | 本人が有給を取る（`date`・`days`: 1 か 0.5。承認の段は挟まず、人事区画の人に知らせる）／ 取り消す |
| `GET /v1/me/hr/payslips` ／ `GET .../payslips/:id` ／ `GET .../payslips/:id/pdf` | 本人の確定した給与明細（**同意が無ければ出さない**）／ 1 つと前の回からの差の説明 ／ PDF |
| `PUT /v1/me/hr/payslip-consent` | 明細を画面で受け取る同意（`consent`: true・false。いつでも取り消せる） |
| `GET /v1/me/hr/shifts` ／ `PUT /v1/me/hr/shift-requests` | 本人のシフト（公開した期間）と休みの希望（シフトの人でなければ空）／ 休みの希望を入れるか外す（`date`・`on`。公開の前の、始まっていない期間の日だけ） |
| `GET /v1/me/hr/yea` ／ `PUT /v1/me/hr/yea` | 本人の年末調整（`year`。申告・対象か・直せるか・不備・結果）／ 申告を残す・出す（`year`・`data`・`submit`。出すと人事区画の人に知らせる。確かめた後は 400） |
| `POST /v1/me/hr/yea/certificate` ／ `GET /v1/me/hr/yea/withholding.pdf` | 控除証明書か前の勤め先の源泉徴収票を読む（`file`。申告には入れず、ファイルも残さない）／ 自分の源泉徴収票（確定した結果・明細の同意がある人） |
| `GET /v1/hr/roster` | 労働者名簿を書き出す（`format=csv` か `xlsx`。事業主本人は載せない。監査ログに残す） |
| `POST /v1/hr/books/export` | 管理者: 人事・給与の帳簿を ZIP でまとめて書き出す（解約のときに渡す。第30.17節・ADR-0054）。労働者名簿・賃金台帳・出勤簿・年次有給休暇管理簿・源泉徴収の記録と源泉徴収票・年末調整の申告・社会保険の届出の記録・年度更新。ファイルの数を `X-Books-Files` に返し、監査ログに 1 つ残す |
| `GET /v1/inventory/bookings` | 今日（日本時間）から先の予約と取り置き・予約の日を過ぎた取り置き（`overdue`）・使う品目の分からない予約（`unmapped`）。予約との引き当てを切っている会社は 403（第29.13節） |
| `POST /v1/inventory/bookings` | 取り置く（`itemId`・`qty`・`startsAt`・任意の `externalId`・`menu`）。使える数から引く |
| `POST /v1/inventory/bookings/:id/use` ／ `cancel` | 予約の人が来た（取り置きを使用の記録にする）／ 取り消す（使える数に戻す） |
| `POST /v1/inventory/menus` | メニューで使う品目を覚える（`menu`・`items`: itemId と qty。空なら在庫を使わない）。品目の分からない予約を取り置き直す |
| `POST /v1/hooks/line/:key` | **認証なしの受け口**。LINE 公式アカウントの Webhook（仕様書 第33.19節）。会社は鍵（32 文字）のハッシュから引き、その会社のチャネルのシークレットで `X-Line-Signature` を確かめる。知らない鍵・問い合わせの記録か LINE を切った会社は 404、署名が違えば 401、1 MB を超えれば 413。確かめたらすぐ 200 を返し、取り込みは後ろで行う（出来事の ID で 2 度残さない） |
| `POST /v1/hooks/signage/:key` ／ `POST /v1/hooks/signage`（`Authorization: Bearer`） | **認証なしの受け口**。受付などのシステムから店頭サイネージに割り込みを出す（第31.8.2節）。会社は鍵（32 文字）のハッシュから引く。JSON かフォーム（UTF-8）だけ（ほかは 415）、4 KB を超えれば 413、1 分 30 回を超えれば 429（`retry-after`）。知らない鍵・止めた受け口・切った会社はどれも 404、POST 以外は 405、読めない・知らない画面は 422。標準の形でない本文は、値を消した骨組みだけを推論に渡して対応を推測する（推論が使えなければ 503）。`requestId` を 10 分覚えて二度出さない。記録では URL の鍵を伏せる |
| `GET /v1/inventory/publications` | 管理者: Web への公開のまとまりの一覧（作った順。`max` は 1 社の上限 8）。1 つも無ければ「公開 1」を作って返す。「Web への公開」を切った会社と管理者でない人は 403（第29.12.1節・第29.12.2節） |
| `POST /v1/inventory/publications` | 管理者: まとまりを足す（承認する前の形。`name` を省けば「公開 N」）。8 つを超えると 400 |
| `POST /v1/inventory/publications/preview` | 管理者: 承認する前の見本（`itemIds`・`fields`（`category`・`price`）・`showCount`）。公開されるとおりの中身を返す |
| `PUT /v1/inventory/publications/:id` | 管理者: そのまとまりをこの内容で公開する（押した管理者が承認者。中身の変更・再開も同じ）。鍵は最初の承認で作り変えない。監査ログ `inventory.publication.approve` |
| `PUT /v1/inventory/publications/:id/name` | 管理者: まとまりの名前を変える（承認し直さない） |
| `POST /v1/inventory/publications/:id/stop` ／ `DELETE /v1/inventory/publications/:id` | 管理者: 公開を止める（監査ログ `inventory.publication.stop`）／ 止めてあるまとまりを削除する（公開中は 409。監査ログ `inventory.publication.delete`） |
| `GET` ／ `POST /v1/columns` | Web のコラム（仕様書 第32.18.1節）: 一覧と入れ先の WordPress ／ 書き始める（`theme`・`memo`。書き上げは裏で進め、すぐ 201 と `id`）。Web のコラムを切っている会社と利用範囲の外の人には、`/v1/columns` のどの口も 403。推論が使えなければ 409 |
| `GET` ／ `PUT` ／ `DELETE /v1/columns/:id` | コラムと版（新しい順）／ 直して保存する（`title`・`body`・`description`・`sns`。新しい版になる。承認待ちと書いている途中は 409）／ 削除する（承認へ進めていないものだけ） |
| `POST /v1/columns/:id/rewrite` ／ `/retry` | 指示（`instruction`）で書き直してもらう ／ 書けなかったコラムをもう一度書く |
| `POST /v1/columns/:id/suggestions/:index` ／ `/versions/:version/restore` | 赤入れの直し案に置き換える ／ 前の版に戻す（どちらも新しい版になる） |
| `GET /v1/columns/:id/export` | 記事に入れる形（Markdown と HTML。末尾に出典・監修者・AI の表示） |
| `POST /v1/columns/:id/cover/restore` | 前に作ったカバーに戻す（`fileId`。このコラムの前の版のカバーだけ。本文はいまのまま、新しい版になる） |
| `GET` ／ `POST /v1/columns/:id/cover` | カバー画像（PNG。`version` で前の版、`download=1` で保存させる）／ 作り直す（`kind`: template・ai・photo、`hint`。新しい版になる） |
| `POST /v1/columns/:id/photos` | 写真を入れ、そのコラムのカバーにする（本文は写真の中身。JPEG・PNG、10 MB まで。会社の写真の置き場にも入る） |
| `POST /v1/columns/:id/submit` | 承認へ進める（業務「コラムを WordPress に入れる」を始め、管理者か承認者の承認を待つ。版の指紋を残す。入力にカバーのファイルを含め、承認する人がその画像を見られるようにする。入れられない理由があれば 400） |
| `GET` ／ `POST /v1/inquiries` | 問い合わせの記録（仕様書 第33.17節）: 一覧（`status`: open・done・dropped・all、`q`、`contactId`）／ 1 行の文から残す（`text`。新しければ 201、前の問い合わせの続きなら 200、どの続きか決まらなければ `ambiguous` と候補）。使えない会社と利用範囲の外の人には、`/v1/inquiries` のどの口も 403 |
| `GET` ／ `PATCH` ／ `DELETE /v1/inquiries/:id` | 1 件と会話の履歴と次にやること ／ 項目を直す（`from`・`channel`・`category`・`summary`・`source`・`temperature`・`status`）／ 削除（残した本人と管理者だけ） |
| `POST /v1/inquiries/:id/events` ／ `/tasks` | その問い合わせに続きを足す（`text`）／ 次にやることを足す（`what`・`due`・`assignee`） |
| `POST /v1/inquiries/events/:eventId/split` | 会話の履歴 1 つを、別の問い合わせに分ける（その履歴から生まれた次にやることも移す。最初の履歴は 400） |
| `PATCH /v1/inquiries/tasks/:taskId` | 次にやることを直す・済みにする（`what`・`due`・`assignee`・`done`） |
| `POST /v1/inquiries/mail/check` ／ `GET /v1/inquiries/mail/skipped` | 窓口のアカウントの新しいメールを今すぐ読む（会社ごとに 30 秒に 1 回まで）／ 問い合わせでないと見分けたメール（仕様書 第33.18節） |
| `POST /v1/inquiries/mail/:messageId/promote` ／ `GET /v1/inquiries/events/:eventId/mail` | 問い合わせでないとしたメールを問い合わせにする ／ 会話の履歴のメールの中身（窓口のアカウントから読む。本文は写していない） |
| `POST /v1/inquiries/:id/replies` ／ `PUT`・`DELETE /v1/inquiries/replies/:replyId` | 返事の下書きを AI に書かせる（`instruction`）／ 直す（`to`・`subject`・`body`。下書きのときだけ）・削除 |
| `POST /v1/inquiries/replies/:replyId/submit` | 返事を承認へ進める（業務「問い合わせの返事を送る」。管理者か承認者の承認の後に、窓口のアカウントから届いた宛先で送る） |
| `GET /v1/inquiries/review` | 月の振り返り（`month`: YYYY-MM。無ければ先月。数はプログラムが数える） |
| `PUT /v1/admin/extensions/competitors/settings` | 管理者: 競合の分析で自動で覚える数（`autoMax`。1〜20。範囲の外は 400）を変える。次に探すときから効く |
| `PUT` ／ `DELETE /v1/admin/extensions/competitors/map-key` | 管理者: 競合の分析の地図の鍵（Google Cloud の API キー。`key`）を預ける（Places API を使えるかを確かめてから。使えなければ 400 と理由。見本の会社では確かめない）／ 外す |
| `GET /v1/competitors` | 競合の分析（仕様書 第36.18節）: 全体（自社の像・競合・動いている作業・最後の作業・地図の注意）。地図で見つけた競合の名前と Web サイトはここで引き直す。使えない会社と利用範囲の外の人には、`/v1/competitors` のどの口も 403 |
| `POST /v1/competitors/discover` ／ `POST /v1/competitors/check` | 競合を探す作業（`radiusKm`・`nationwide`・`auto` で商圏を変える）／ 今すぐ見回る作業を受け付ける（202。ワーカーが行う。動いていれば `already`） |
| `POST /v1/competitors` ／ `DELETE /v1/competitors/:id` | URL か店の名前で競合を入れる（`text`。トップを読めたときだけ。社内のアドレスは 400）／ 外す（次に探しても入れない） |
| `GET /v1/competitors/:id/facts` | 1 社の事実（`self` なら自社。新しい回から。出典の URL つき） |
| `GET /v1/competitors/reports/list` ／ `POST /v1/competitors/reports` | レポート（新しい順）／ いまある事実から、その場のレポートを作る |
| `GET /v1/inquiries/faq` | よくある質問の話題（`days`。既定 90 日。2 件以上・5 つまで。誰が聞いたかは返さない。仕様書 第33.19節） |
| `PUT` ／ `DELETE /v1/admin/extensions/inquiries/line` | 管理者: LINE 公式アカウントをつなぐ（`secret`・`token`。鍵を確かめて預け、受け口の URL `webhookUrl` を 1 度だけ返す。見本の会社では鍵を確かめない。ローカルの形では 409）／ 外す（受け口も止める） |
| `POST /v1/admin/extensions/inquiries/mailbox/connect` ／ `DELETE /v1/admin/extensions/inquiries/mailbox` | 管理者: 窓口のアカウントをつなぐ（Google の認可の URL。アカウントを選ばせる。見本の会社ではすぐつながる）／ 外す（Google の許可も取り消す）。戻りは `/v1/oauth/google/callback` |
| `GET /v1/public/inventory/:key` ／ `:key.json` | **認証なし**。在庫の公開のページ（他のサイトの iframe に入れてよい。`frame-ancestors *`・スクリプトなし）とデータ（`Access-Control-Allow-Origin: *`）。作り直して置いた中身だけを返す。知らない鍵・止めた公開・公開を切った会社はどれも 404 |
| `POST /v1/hooks/inventory/:key` | **認証なしの受け口**。予約のシステムの Webhook を受ける（第29.13.1節）。会社は鍵（32 文字）のハッシュから引き、ホスト名は見ない。64 KB を超えれば 413。知らない鍵・止めた受け口・引き当てを切った会社はどれも 404、予約として読めなければ 422。項目の対応は最初の予約から推論して受け口に覚える。予約した人の名前・連絡先は残さない |
| `GET /v1/notices` | 本人宛ての有効な社内のお知らせ（取り下げ・期間切れ・本人が済んだものを除く。`isNew`・`daysLeft` つき。仕様書 第10.15節） |
| `POST /v1/notices` | 社内のお知らせを出す（`title`・`body`・`link`（https だけ）・`all` か `groupIds`・`dueOn`・`until`）。会社の全員が出せる。承認は挟まない。201 |
| `POST /v1/notices/:id/withdraw` | 取り下げる（出した人と管理者だけ。ほかの人は 403、ほかの会社のものは 404） |
| `POST /v1/notices/:id/done` | 本人が済んだとする（本人の朝のブリーフに載せなくなる） |
| `POST /v1/schedules` | 定時実行を作る（毎日／毎平日／毎週、業務の入力）。ファイルを受け取る業務と秘書の調べものは 400、必須の入力が空なら 400（仕様書 第6.1.7節） |
| `PATCH /v1/schedules/:id` | 停止・再開、繰り返し・時刻・入力の変更。再開すると次回を今から求め直す（止めていた間の回は起動しない） |
| `POST /v1/schedules/:id/trigger` | 次の回を今にする（動作確認用） |
| `DELETE /v1/schedules/:id` | 本人の定時実行を消す。動いている実行は止めない |
| `GET /v1/admin/usage` | 管理者: エージェント別の利用量 |
| `GET /v1/admin/runs` | 管理者: 全利用者の実行の状態（中身は返さない） |
| `GET /v1/admin/schedules` | 管理者: 会社の全員の定時実行（人・業務・繰り返し・次回・前回・状態）。次の回に動かないものは、起動役と同じ判定（`scheduleBlocker`）の理由を添える。**業務の入力は返さない**。操作の口は無い（仕様書 第6.6.8.2節） |
| `GET /v1/admin/runs/:id` | 管理者: 実行 1 件の**状態だけ**。段の表示名と状態・失敗の理由・費用・削減時間まで。**入力・段の入出力・成果物は返さない**（仕様書 第6.6.8節、不変則 I-10） |
| `GET /v1/admin/users` | 管理者: 利用者の一覧 |
| `GET /v1/admin/audit-events` | 管理者: 監査ログ。`from`・`to`（日付）・`user`・`category`・`offset` で絞り、誰が（人の名前・指示した人）・何をしたか（業務の言葉）・何に対して（名前）と記録の値を返す。既定は直近 7 日、200 件ずつ（仕様書 第6.6.8.1節） |
| `GET /v1/admin/audit-events/export` | 管理者: 同じ絞り込みで CSV（BOM 付き UTF-8）を返す。出力したことを `audit.export` として記録する |
| `GET /v1/admin/connectors` | 管理者: 接続の状態（Google Workspace が本物か見本か、LLM の提供者）。画面からは使っていない（仕様書 第6.6.3.0節）。後方互換のために残す |
| `GET /v1/admin/connections` | 管理者: 接続の設定（Gemini の契約の形態・鍵の登録の有無・モデル、Google の OAuth クライアント・リダイレクト URI・求める許可・従業員の接続状況）。秘密の値は返さない |
| `PUT /v1/admin/connections/ai-policy` | 管理者: 会社の AI の方針（`mode`: `cloud`・`local-first`・`local-only`）。ローカルの方針はローカルの形（`M2O_DEPLOYMENT=onsite`）でだけ選べ、クラウドの形では 400（仕様書 第16.3.7.1節）。`GET /v1/admin/connections` の `ai` に配備の形・方針・ローカル AI の設定の有無が出る |
| `POST /v1/admin/connections/local-llm/test` | 管理者: ローカル AI に届くかを確かめる（使えるモデルの名前を返す。何も変えない） |
| `PUT /v1/admin/connections/gemini` | 管理者: Gemini の設定（`mode`・`apiKey`（渡したときだけ上書き）・`models`）。鍵は暗号化して保存 |
| `DELETE /v1/admin/connections/gemini/key` | 管理者: 自社の鍵を削除（運営一括に戻る） |
| `POST /v1/admin/connections/gemini/test` | 管理者: 接続の確認（`kind`: `text` か `live`） |
| `PUT /v1/admin/connections/google` | 管理者: 会社の OAuth クライアント（`clientId`・`clientSecret`）。**保存の前に Google で組を確かめ、誤り（`bad-secret`・`no-client`）なら 400 で断り、保存しない**。シークレットは暗号化して保存（仕様書 第14.3.3節） |
| `POST /v1/admin/connections/google/test` | 管理者: 登録済みの OAuth クライアントを Google で確かめる。何も変えない。`verdict`（`ok`・`bad-secret`・`no-client`・`unreachable`・`unexpected`）と文を返す |
| `GET /v1/admin/connections/google/impact` | 管理者: OAuth クライアントを消す（クライアント ID を替える）と影響する人数と業務の件数 |
| `DELETE /v1/admin/connections/google` | 管理者: OAuth クライアントの登録を消す。接続している全員の接続を消し、Google を使う動いている途中の業務を止める（仕様書 第6.5.2.1節）。クライアント ID を替える `PUT` も同じ |
| `GET /v1/me/google` | 本人: Google 連携の状況（業務の言葉の許可の一覧。トークンは返さない） |
| `POST /v1/me/google/connect` | 本人: 接続を始める（Google の同意の画面の URL を返す。state と PKCE つき） |
| `POST /v1/me/google/check` | 本人: 許可の状況を Google に問い合わせ直す。その許可で受け取れれば、プロフィール写真も取り込み直す |
| `GET /v1/me/google/impact` | 本人: 取り消すと止まる業務と、飛ばす定時実行の数 |
| `DELETE /v1/me/google` | 本人: 接続を取り消す（Google 側の許可も取り消し、トークンを消す）。Google を使う動いている途中の業務を止め、終わった実行の中身を消す（仕様書 第6.5.2.1節・第14.3.2節） |
| `GET /v1/me/connections` | 本人: 利用者ごとに許可する会社の接続（Slack など）と、接続しているか・許可したアカウント・接続し直しが要るか・使う業務（仕様書 第6.5.9節） |
| `POST /v1/me/connections/:id/connect` | 本人: 接続を始める（相手の許可の画面の URL を返す。state と PKCE つき。会社のアプリが無く、相手が自動登録に対応していれば、ここで 1 度だけアプリを登録する。どちらも無ければ 409） |
| `GET /v1/me/connections/:id/impact` | 本人: 取り消すと止まる業務・使えなくなる業務・飛ばす定時実行 |
| `DELETE /v1/me/connections/:id` | 本人: 接続を取り消す（相手の取り消しの口があればそこでも取り消し、認可を消す）。その接続を使う本人の動いている業務を止める（仕様書 第12.11.6.5節） |
| `GET /v1/oauth/google/callback` | Google からの戻り（ログイン不要。state で照合する） |
| `GET /v1/unsubscribe/:token`・`POST /v1/unsubscribe/:token` | まとめてのメールの配信の停止（ログイン不要。鍵は会社とアドレスを暗号化したもの。GET は「配信を停止する」の画面、POST で止める。`List-Unsubscribe-Post` も同じ URL。仕様書 第27.9.1節） |
| `GET /v1/oauth/connection/callback` | 認証の要る会社の接続（Slack など）の相手からの戻り（ログイン不要。state で照合し、認可を暗号化して保存して個人設定へ戻す。仕様書 第12.11.6.3節） |
| `GET /v1/admin/google-permissions` | 管理者: この会社の業務が求める Google の権限と段階（制限付きかどうか）、使うツールと業務 |
| `GET /v1/admin/extensions` | 管理者: 拡張機能の一覧（公式・自社専用）、構成要素、必要な権限の説明、導入と有効・無効の状態 |
| `POST /v1/admin/extensions/import` | 管理者: `.m2ext` を取り込む（本文はファイルのバイト列。5 MB まで）。検証を通らなければ `problems` を返す |
| `POST /v1/admin/extensions/:id/install` | 管理者: 同意して導入（本文に `consent: true`）。導入すると有効になる。同梱の接続は会社の接続として登録する（同じ ID が別の接続先で登録済みなら `notices` で知らせる） |
| `PUT /v1/admin/extensions/:id/enabled` | 管理者: 有効・無効の切り替え（本文に `enabled`）。権限が増えた版は 409。内蔵の拡張（名刺管理・在庫管理）は会社の設定で入り切りし、データは消さない（導入と削除は 409。仕様書 第12.13節） |
| `PUT /v1/admin/extensions/business-cards/settings` | 管理者: 名刺管理の、取り込んだ名刺の既定の範囲（`defaultScope`。第27.7節）と、メールの署名からの更新の入り切り（`mailSignature`。第27.6.1節）。渡した項目だけを変える。まとめてのメールで管理者の承認を加えるか（`bulkMailAdminApproval`。第27.9.1節） |
| `GET /v1/admin/extensions/business-cards/opt-outs` ／ `POST …/opt-outs/remove` | 管理者: まとめてのメールの配信を停止したアドレスの一覧（`q` で探す）と、停止を外す（`email`。本人から求められたとき。監査ログ `mail.opt_out.remove` にはアドレスそのものを残さない） |
| `GET /v1/admin/extensions/inventory/booking-sources` ／ `POST` | 管理者: 予約の受け口の一覧 ／ 作る（`name`）。作ったときだけ送り先の URL（鍵を含む）を返す。鍵はハッシュだけを持つ |
| `PUT /v1/admin/extensions/inventory/booking-sources/:id/status` ／ `mapping` | 管理者: 受け口を止める・再開する（`status`）／ 項目の対応を直す・やり直す（`mapping`。`null` で次の予約から推論し直す） |
| `POST /v1/admin/extensions/hr/proposal` | 管理者: 就業規則・賃金規程（`file`: PDF・Word・文字・写真）から、人事・給与の設定の案を作る（第30.8.2節。項目・今・案・規程の抜き書き・採らない理由。保存しない。読めなければ 422）。JSON で `knowledgeId` を送ると、知識に登録した社内規程から作る |
| `GET /v1/admin/extensions/hr/rule-checks` ／ `POST …/rule-checks/:itemId/:version/dismiss` | 管理者: 社内規程の登録・改定で見つかった今の設定との食い違い（残した答えを、いまの設定と並べ直す。第11.11.2節）／ 見終えた |
| `PUT /v1/admin/extensions/hr/settings` | 管理者: 人事・給与の会社の設定（`office`・`health`・`socialApply`・`pay`・`procedures`・`work`・`agreement`・`leave`・`payroll`・`transfer`（振込元。番号の桁を確かめる）・`duties`（納期の特例・定期健康診断の月）・`notice`（労働条件通知書の会社の定め）・`insurance`（事業所整理記号・事業所番号・特定適用事業所 auto・yes・no・通常の労働者の週の所定労働時間 10〜60）・`labor`（雇用保険の事業の種類・労災保険の事業の種類の番号・労働保険番号）。第30.8.1節）。`GET /v1/admin/extensions/hr/labor-industries` で労災保険率表の事業の種類、`GET /v1/admin/extensions/hr/allowances` で手当の扱い（雇用条件の手当の名前と、割増の基礎・所得税の対象・設定したか）。送った項目だけを変える。人事・給与を `PUT /v1/admin/extensions/hr/enabled` で入れると、区画 `hr` が無ければ作り、入れた管理者を入れる |
| `PUT /v1/admin/extensions/inventory/settings` | 管理者: 在庫管理の機能の入り切り（`features`）・残りわずかの既定の目安（`lowDefault`）・仕入れの日数（`leadDaysDefault`）・棚卸しの頻度（`countEveryDays`）。送った項目だけを変える（第29.4.1節） |
| `PUT /v1/admin/extensions/web-columns/settings` | 管理者: Web のコラムの分野（`topics`）・読み手（`audience`）・業種（`industry`。東証の 33 業種のコード。業種・分野・読み手・監修者が変われば、当てる表現の決まり `rules` を AI が選び直して返す）・監修者（`supervisor`）・AI の表示（`aiNotice`）・AI で挿絵を描くか（`aiIllustration`）。送った項目だけを変える（第32.18.1節） |
| `PUT` ／ `DELETE /v1/admin/extensions/web-columns/wordpress` | 管理者: WordPress の入れ先（`siteUrl`・`username`）とアプリケーションパスワード（`password`）を、つながるかを確かめてから暗号化して預ける（つながらなければ 400。パスワードは返さない）／ 外す |
| `GET /v1/admin/connections/mcp` | 管理者: 会社の接続（MCP）の一覧。ツールごとの危険度・有効かどうか・使っている業務、認証の状態（`authState`。秘密の値は返さない）、よく使うサービスの型（`presets`）（仕様書 第12.11節、ADR-0037・ADR-0044） |
| `POST /v1/admin/connections/mcp` | 管理者: URL を受け取り、ツールの一覧を取って会社の接続として登録する（読むだけの印が付いたツールは「読むだけ」、ほかは「社外へ送る」扱い）。`preset`（`slack`）で型から、`auth`（`oauth`・`api_key`）で認証の要る接続を登録する。`oauth` は相手の認可サーバの情報を読み、アプリの自動登録の口（`registration_endpoint`）があれば控える（仕様書 第12.11.6.2節、Q-99）。認証の要る接続のツールは、認証情報のあとで取る |
| `PUT /v1/admin/connections/mcp/:id/credentials` | 管理者: 認証情報を登録する。`oauth` はクライアント ID とシークレット（ID を替えると全員の認可を消す。自動で登録したアプリより先に使う）、`api_key` は会社の鍵（その鍵でツールを問い合わせる）。値は暗号化し、返さない（仕様書 第12.11.6節） |
| `PUT /v1/admin/connections/mcp/:id` | 管理者: 接続の名前と、ツールごとの危険度を変える |
| `POST /v1/admin/connections/mcp/:id/refresh` | 管理者: ツールの一覧を取り直す（決めた危険度は保つ）。認証の要る接続は管理者自身の認可（会社の鍵）で問い合わせる |
| `POST /v1/admin/connections/mcp/:id/check` | 管理者: 接続の確認（宣言したツールが提供されているか） |
| `GET /v1/admin/connections/mcp/:id/impact` | 管理者: 接続を消すと使えなくなる業務 |
| `GET /v1/admin/connections/mcp/:id/tools/:tool/impact` | 管理者: そのツールを止めると使えなくなる業務の名前と、飛ばす定時実行の数（仕様書 第6.6.3.1節） |
| `PUT /v1/admin/connections/mcp/:id/tools/:tool/enabled` | 管理者: ツールを 1 つ、有効または無効にする。止めたツールを使う業務はメニュー・秘書・定時実行・API から消える。動いている実行は止めない |
| `DELETE /v1/admin/connections/mcp/:id` | 管理者: 会社の接続を消す。そのツールを使う業務は使えなくなる |
| `DELETE /v1/admin/extensions/:id` | 管理者: 削除する。自社専用のものは取り込んだファイルも消す |
| `GET /v1/admin/groups` | 管理者: グループの一覧（所属する人と、割り当て先の区画・業務を含む。第16.7節） |
| `POST /v1/admin/groups` | 管理者: グループを作る（名前は会社の中で重ならない） |
| `PATCH /v1/admin/groups/:id` | 管理者: グループの名前・説明を変える |
| `PUT /v1/admin/groups/:id/members` | 管理者: 所属を丸ごと置き換える（本文に `userIds`） |
| `DELETE /v1/admin/groups/:id` | 管理者: グループを消す。範囲に誰も残らなくなった業務を `emptied` で返す |
| `GET /v1/admin/compartments` | 管理者: 権限区画と、その割当（グループと個人） |
| `POST /v1/admin/compartments` | 管理者: 権限区画を作る（名前は英小文字・数字・ハイフン） |
| `PUT /v1/admin/compartments/:id/assignment` | 管理者: 区画に入れるグループと人を置き換える。入れる人が変われば記録し、管理者全員に通知する |
| `GET /v1/admin/access` | 管理者: 業務・拡張機能ごとの利用範囲と、選択肢（グループ・利用者・対象） |
| `PUT /v1/admin/access/:target` | 管理者: 1 つの業務（または拡張機能）の利用範囲。本文 `{ scope: "all" \| { groups, users } }` |
| `GET /v1/admin/dashboard/live` | 管理者: ダッシュボードの「いま」（数値・業務の流れ・承認の滞留・出来事・本人と秘書の 1 組）。業務の状態の各行にまとまり（`group`。拡張機能か業務の分野）を付ける。中身は返さない |
| `GET /v1/admin/dashboard/people/:userId/photo` | 管理者: 人の状態に添える本人のプロフィール写真。**個人名で表示する会社の、停止していない利用者のものだけ**（仕様書 第6.7.4.4節） |
| `GET /v1/admin/dashboard/people/:userId/secretary-avatar` | 管理者: その人の秘書のアバター（本人が上げた画像）。**本人が個人設定に登録した画像だけ**を返し、ファイルの ID は受け取らない。同じく個人名で表示する会社だけ |
| `GET /v1/admin/dashboard/stats?days=1\|7\|30` | 管理者: ダッシュボードの集計（日ごと・時間帯・業務ごと・秘書の層・削減時間） |
| `GET /v1/admin/settings` | 管理者: 会社の設定（会社情報・自社の書き方・自動化ポリシー・業務の有効化） |
| `PUT /v1/admin/settings/:section` | 管理者: 設定の 1 区分を保存（`company`・`writingStyle`・`automation`・`agents`・`effect`・`slides`・`privacy`。`knowledge`（言い換えの登録）は 400 で断る（第 0.115.0 版から秘書が考える。第11.7.7.0節）。`privacy` は Google から取得したデータを残す日数） |
| `POST /v1/admin/users` | 管理者: 利用者の招待（Workspace のドメインのみ） |
| `POST /v1/admin/users/:id/forget-mail-signatures` | 管理者: Google のデータの削除を求められたとき、その人のメールの署名から名刺を新しくした値を前の値に戻し、変更の記録を消す（`count`。仕様書 第27.6.1節、Q-152） |
| `PATCH /v1/admin/users/:id` | 管理者: 表示名・ロール・状態（管理者が 0 人になる変更は 409）。止めたときは、止めた業務の数（`stoppedRuns`）と、30 日後に削除される自分だけの名刺の数（`personalCards`。仕様書 第27.7節、Q-94）を返す。止めた日時を持ち、戻すと空にする |
| `GET /v1/admin/knowledge` | 管理者: 組織知識の一覧（種類 `category`: `rule`・`minutes`・`learned`、状態 `status`: `active`・`retired`・`archived`、施行日と施行日が先の版。廃止・しまったものを含む）と、最後に整理した日と数（`consolidated`。仕様書 第11.11節） |
| `POST /v1/admin/knowledge` | 管理者: 社内規程の新規の登録（`effectiveFrom` を省くと今日）。ID を発行して 201 で返す（ADR-0019） |
| `PUT /v1/admin/knowledge/:id` | 管理者: 更新（`new` を指すか、無い ID なら新しい社内規程）。社内規程は版を残し、施行日が先なら施行日まで前の版で答える（`applied: false`）。議事録と秘書が学んだことは版を残さずに直す。廃止・しまったものは 409。本文を節に分け、分けた節を返す（50 万字まで） |
| `GET /v1/admin/knowledge/:id/sections` | 管理者: 1 件の知識の節（見出しの経路と字数） |
| `GET /v1/admin/knowledge/:id/versions` ／ `/versions/:version` | 管理者: 社内規程の版の一覧（施行中・施行前）／ 1 つの版の本文 |
| `POST /v1/admin/knowledge/:id/retire` ／ `/restore` | 管理者: 社内規程・議事録を廃止する（消さない。秘書が学んだことは 409）／ 廃止した・しまったものを戻す（1 年を過ぎたら 409） |
| `DELETE /v1/admin/knowledge/:id` | 管理者: 秘書が学んだことを消す（社内規程と議事録は 409） |
| `GET /v1/me/settings` | 本人の個人設定 |
| `PUT /v1/me/settings/:section` | 個人設定の 1 区分を保存（`profile`・`secretary`・`notifications`・`memory`・`menu`・`brief`）。`brief`（朝のブリーフの関心の分野と外した項目。第6.5.3.1節）は、秘書が最初の分野を選んだ印を画面から変えさせない |
| `POST /v1/me/voice-test` | 声を試す。本文の秘書の設定（保存の前でもよい）で秘書に名乗らせ、話した文字と声（24 kHz・16 ビットの PCM を base64）を返す。保存しない（仕様書 第10.5.8節） |
| `PATCH /v1/me/profile` | 表示名の変更 |
| `GET /v1/me/sessions` | ログイン中の端末 |
| `DELETE /v1/me/sessions/:id` | 端末を個別にログアウト |
| `GET /v1/me/usage` | 本人の利用状況 |
| `GET /v1/me/memories` | 本人が秘書に覚えられていること（`source` が `learned` なら秘書が会話から自分で覚えたもの。仕様書 第11.5.2節） |
| `PATCH /v1/me/memories/:id` | 覚えていることを本人が直す（`{ text }`）。認証情報・覚えない言葉・200 字超は 400。秘書が覚えた文を直すと、元の文は再び覚えない |
| `DELETE /v1/me/memories/:id` | 1 件を消す。秘書が覚えた文を消すと、同じ文は再び覚えない |
| `DELETE /v1/me/memories` | すべて消す |
| `GET /v1/me/memories/archived` ／ `POST /v1/me/memories/:id/restore` | 週 1 回の整理でしまった記憶（理由つき）／ 戻す（仕様書 第11.11.4節） |
| `GET /v1/me/promotions` | 本人の記憶から、秘書が会社の知識にしたものの履歴（本人のものだけ。第6.5.4節）。本人が出す・管理者が承認する API は第 0.115.0 版でなくした |
| `GET /v1/help/articles?scope=` | ヘルプの記事の一覧（役割と有効な業務で出し分け）と、読めるマニュアルの名前（`manuals`）。`scope=admin` は管理者ページ（管理者向けの記事だけ）、それ以外はワークスペース（管理者向けを除く）。業務のマニュアルの章（`docs/manual/`）は、その業務を使える人にだけ出す（第6.10.7節・第6.10.7.3節） |
| `GET /v1/help/articles/:id` | 記事の本文。見られない記事は 404 |
| `GET /v1/help/search?q=&scope=` | 記事の検索（出す所の記事の中から） |
| `GET /v1/debug/events` ／ `DELETE` | デバッグモード（`M2O_DEBUG=true`）の本人の記録（新しい順。`after` でそれより後だけ）／ 消す。デバッグモードでなければ 404（仕様書 第20.4.1節） |
| `GET /v1/help/agents/:agentId` | 業務の説明（定義から自動で作る） |
| `GET /v1/onboarding/tour` | 本人の初回の案内の状態 |
| `POST /v1/onboarding/tour` | 案内を見終えた記録。`{ "reset": true }` で見直し |
| `GET /v1/onboarding/checklist` | 管理者: 初期設定のチェックリスト |
| `POST /v1/onboarding/checklist/notified` | 管理者: 従業員へ知らせたことの記録 |
| `POST /v1/files` | ファイルの受け取り（multipart の `file`。10 MB まで） |
| `GET /v1/files/:id` | メタデータ。所有者と承認者のみ |
| `GET /v1/files/:id/content` | 中身。必ず保存させる（`attachment`） |
| `GET /v1/files/:id/view` | 画像（PNG・JPEG）だけを画面に出す（承認の画面のカバー画像など）。読める人は中身と同じ。ほかの形は 404 |

## 承認の扱い

承認の API 化は慎重に扱います（仕様書 第13.3節）。
外部アプリからの承認は既定で禁止とし、`external-send` と `financial` は
**恒久的に禁止**します。現時点では画面からの操作だけを受け付けます。

## 構成

```
src/index.ts          サーバーの組み立て
src/context.ts        依存の構築（永続化・LLM・接続口・ツール・エンジン・秘書）
src/auth/             認証の設定とログイン状態（Cookie）
src/middleware/       テナント解決、利用者の確認、ロールの確認、要求のログと想定外のエラーの処理
src/routes/           エンドポイント
src/secretary/        秘書の調べものと秘書が頼んだ業務の状態、朝のブリーフの自動の用意
src/voice/            音声の中継（Gemini Live）、秘書の名乗りの指示、声を試す
src/audit/            監査ログの見せ方（人の名前・業務の言葉・CSV。仕様書 第6.6.8.1節）
src/debug/            デバッグモードの記録（メモリーだけ・本人の分だけ）と、秘書の振り分けの 1 行（仕様書 第20.4.1節）
```

## 関連文書

- 仕様書 第13章 プラットフォーム API とエコシステム
- [ADR-0002 API フレームワークに Hono を採用する](../../docs/adr/0002-api-framework-hono.md)
