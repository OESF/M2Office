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
削除は、その区画の知識（`countKnowledgeInCompartment()`）と業務（会社から見える定義の `compartment`）が残っていれば 409 で断ります。

### 音声の中継（WebSocket）

`/v1/secretary/voice` は WebSocket で、ブラウザと音声の提供者のあいだを中継します（仕様書 第10.5.5節、ADR-0018）。
Hono の外側（Node のサーバーの `upgrade`）で受け、ログイン状態の Cookie（動作確認では開発用ヘッダー）で相手を確かめます。
停止中の会社では開けません。送りは 16 kHz、受けは 24 kHz の PCM で、**音はどこにも書き出しません**。
終わったときに、聞こえた文字と応答を会話ログへ 1 往復として残します。

音声の相手には道具を 2 つ渡します（仕様書 第10.5.7節）。`ask_secretary` は本人の依頼を**画面の入力と同じ取次**（`Secretary.respond`）に渡し、
答えを音声の相手へ返します。**声で返すのが基本**で、答えが大きいとき（`needsCanvas`）だけ画面へ `{ type: 'secretary', request, reply }` を送り、
秘書のキャンバスに根拠や業務を開くボタンと一緒に出します（仕様書 第6.2.0節）。音声の相手には `shown_on_screen` で出したかを伝えます。
`show_on_canvas` は、本人に「画面に出して」と頼まれたときに、直前の答え（または頼まれたもの）を画面へ送ります。直前の答えは対話の間だけ持ちます。
終わった調べものも、大きければ画面へ送ります。業務は音声では実行しません。取次の 1 件ずつは会話ログに残しません（対話の終わりにまとめて残すため）。

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
| `GET /v1/me` | テナント・利用者・CSRF トークン・接続の状態・本人のアバターの URL（`photo`。無ければ `null`）・サーバーの版（`serverVersion`。画面の版との食い違いの判定に使う。仕様書 第6.1.1.1節） |
| `GET /v1/me/photo` | 本人のアバター（Google のプロフィール写真）。**本人の写真だけ**を返し、利用者の ID は受け取らない。`nosniff` と読み込みを禁じる CSP を付ける（仕様書 第6.5.1.1節） |
| `GET /v1/agents` | 利用できるエージェントと入力スキーマ |
| `POST /v1/jobs` | ジョブを作成し待ち行列へ入れる。実行はワーカーが担う |
| `GET /v1/jobs` | **本人が依頼した**実行の一覧 |
| `GET /v1/runs/:id` | 実行の詳細。依頼者本人と、その実行に自分が判断できる承認がある人だけが見られる（仕様書 第6.2.1節）。ほかの人には 404 |
| `POST /v1/runs/:id/cancel` | 実行の中止（仕様書 第9.3.1節）。**依頼した本人だけ**。承認する人は 403、終わった実行は 409。作りかけの文書のリンクを返す |
| `GET /v1/approvals` | 本人のロールで判断できる承認待ち |
| `POST /v1/approvals/:id` | 承認または却下。ロールが無ければ 403 |
| `POST /v1/secretary` | 秘書への依頼。どの層で答えたかを返す。`fileId` で手元のファイルを 1 つ渡せる（仕様書 第10.10節）。**ファイルが付いていれば、この応答の中では読まず、調べものとして後ろへ回す**（第10.11節）。返る `lookup` は受け付けであって結果ではない |
| `GET /v1/secretary/lookups` | 後ろへ回した調べものの状態。動いているものは進み具合、終わったものは答えと「伝えたか」を返す（第10.11.6節） |
| `POST /v1/secretary/lookups/claim` | **まだ伝えていない調べものを受け取る**（第10.11.7節「持ち越し」）。読むだけの口ではなく、返したものは「伝えた」として記録される。受け取ったら必ず画面に出すこと |
| `GET /v1/notifications` | 本人宛の通知 |
| `POST /v1/notifications/:id/read` | 既読にする |
| `GET /v1/schedules` | 本人の定時実行 |
| `POST /v1/schedules` | 定時実行を作る（毎日／毎週） |
| `PATCH /v1/schedules/:id` | 停止・再開、規則の変更 |
| `POST /v1/schedules/:id/trigger` | 次の回を今にする（動作確認用） |
| `GET /v1/admin/usage` | 管理者: エージェント別の利用量 |
| `GET /v1/admin/runs` | 管理者: 全利用者の実行の状態（中身は返さない） |
| `GET /v1/admin/runs/:id` | 管理者: 実行 1 件の**状態だけ**。段の表示名と状態・失敗の理由・費用・削減時間まで。**入力・段の入出力・成果物は返さない**（仕様書 第6.6.8節、不変則 I-10） |
| `GET /v1/admin/users` | 管理者: 利用者の一覧 |
| `GET /v1/admin/audit-events` | 管理者: 監査ログ |
| `GET /v1/admin/connectors` | 管理者: 接続の状態（Google Workspace が本物か見本か、LLM の提供者）。画面からは使っていない（仕様書 第6.6.3.0節）。後方互換のために残す |
| `GET /v1/admin/connections` | 管理者: 接続の設定（Gemini の契約の形態・鍵の登録の有無・モデル、Google の OAuth クライアント・リダイレクト URI・求める許可・従業員の接続状況）。秘密の値は返さない |
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
| `GET /v1/oauth/google/callback` | Google からの戻り（ログイン不要。state で照合する） |
| `GET /v1/admin/google-permissions` | 管理者: この会社の業務が求める Google の権限と段階（制限付きかどうか）、使うツールと業務 |
| `GET /v1/admin/extensions` | 管理者: 拡張機能の一覧（公式・自社専用）、構成要素、必要な権限の説明、導入と有効・無効の状態 |
| `POST /v1/admin/extensions/import` | 管理者: `.m2ext` を取り込む（本文はファイルのバイト列。5 MB まで）。検証を通らなければ `problems` を返す |
| `POST /v1/admin/extensions/:id/install` | 管理者: 同意して導入（本文に `consent: true`）。導入すると有効になる |
| `PUT /v1/admin/extensions/:id/enabled` | 管理者: 有効・無効の切り替え（本文に `enabled`）。権限が増えた版は 409 |
| `POST /v1/admin/extensions/:id/connectors/:connectorId/check` | 管理者: コネクタの接続の確認（宣言したツールが提供されているか） |
| `GET /v1/admin/extensions/:id/connectors/:connectorId/tools/:tool/impact` | 管理者: そのツールを止めると使えなくなる業務の名前と、飛ばす定時実行の数（仕様書 第6.6.3.1節） |
| `PUT /v1/admin/extensions/:id/connectors/:connectorId/tools/:tool/enabled` | 管理者: コネクタのツールを 1 つ、有効または無効にする。止めたツールを使う業務はメニュー・秘書・定時実行・API から消える。動いている実行は止めない |
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
| `GET /v1/admin/dashboard/live` | 管理者: ダッシュボードの「いま」（数値・業務の流れ・承認の滞留・出来事・本人と秘書の 1 組）。中身は返さない |
| `GET /v1/admin/dashboard/people/:userId/photo` | 管理者: 人の状態に添える本人のプロフィール写真。**個人名で表示する会社の、停止していない利用者のものだけ**（仕様書 第6.7.4.4節） |
| `GET /v1/admin/dashboard/people/:userId/secretary-avatar` | 管理者: その人の秘書のアバター（本人が上げた画像）。**本人が個人設定に登録した画像だけ**を返し、ファイルの ID は受け取らない。同じく個人名で表示する会社だけ |
| `GET /v1/admin/dashboard/stats?days=1\|7\|30` | 管理者: ダッシュボードの集計（日ごと・時間帯・業務ごと・秘書の層・削減時間） |
| `GET /v1/admin/settings` | 管理者: 会社の設定（会社情報・自社の書き方・自動化ポリシー・業務の有効化） |
| `PUT /v1/admin/settings/:section` | 管理者: 設定の 1 区分を保存（`company`・`writingStyle`・`automation`・`agents`・`effect`・`slides`・`knowledge`・`privacy`。`knowledge` は言い換え、`privacy` は Google から取得したデータを残す日数） |
| `POST /v1/admin/users` | 管理者: 利用者の招待（Workspace のドメインのみ） |
| `PATCH /v1/admin/users/:id` | 管理者: 表示名・ロール・状態（管理者が 0 人になる変更は 409） |
| `GET /v1/admin/knowledge` | 管理者: 組織知識の一覧 |
| `POST /v1/admin/knowledge` | 管理者: 新規の登録。ID を発行して 201 で返す（ADR-0019） |
| `PUT /v1/admin/knowledge/:id` | 管理者: 更新（`new` を指すと新規）。本文を節に分け、分けた節を返す（50 万字まで） |
| `GET /v1/admin/knowledge/:id/sections` | 管理者: 1 件の知識の節（見出しの経路と字数） |
| `DELETE /v1/admin/knowledge/:id` | 管理者: 削除 |
| `GET /v1/me/settings` | 本人の個人設定 |
| `PUT /v1/me/settings/:section` | 個人設定の 1 区分を保存（`profile`・`secretary`・`notifications`・`menu`） |
| `PATCH /v1/me/profile` | 表示名の変更 |
| `GET /v1/me/sessions` | ログイン中の端末 |
| `DELETE /v1/me/sessions/:id` | 端末を個別にログアウト |
| `GET /v1/me/usage` | 本人の利用状況 |
| `GET /v1/me/memories` | 本人が秘書に覚えられていること（`source` が `learned` なら秘書が会話から自分で覚えたもの。仕様書 第11.5.2節） |
| `PATCH /v1/me/memories/:id` | 覚えていることを本人が直す（`{ text }`）。認証情報・覚えない言葉・200 字超は 400。秘書が覚えた文を直すと、元の文は再び覚えない |
| `DELETE /v1/me/memories/:id` | 1 件を消す。秘書が覚えた文を消すと、同じ文は再び覚えない |
| `DELETE /v1/me/memories` | すべて消す |
| `GET /v1/help/articles` | ヘルプの記事の一覧（役割と有効な業務で出し分け） |
| `GET /v1/help/articles/:id` | 記事の本文。見られない記事は 404 |
| `GET /v1/help/search?q=` | 記事の検索 |
| `GET /v1/help/agents/:agentId` | 業務の説明（定義から自動で作る） |
| `GET /v1/onboarding/tour` | 本人の初回の案内の状態 |
| `POST /v1/onboarding/tour` | 案内を見終えた記録。`{ "reset": true }` で見直し |
| `GET /v1/onboarding/checklist` | 管理者: 初期設定のチェックリスト |
| `POST /v1/onboarding/checklist/notified` | 管理者: 従業員へ知らせたことの記録 |
| `POST /v1/files` | ファイルの受け取り（multipart の `file`。10 MB まで） |
| `GET /v1/files/:id` | メタデータ。所有者と承認者のみ |
| `GET /v1/files/:id/content` | 中身。必ず保存させる（`attachment`） |

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
```

## 関連文書

- 仕様書 第13章 プラットフォーム API とエコシステム
- [ADR-0002 API フレームワークに Hono を採用する](../../docs/adr/0002-api-framework-hono.md)
