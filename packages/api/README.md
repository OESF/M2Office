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

### 音声の中継（WebSocket）

`/v1/secretary/voice` は WebSocket で、ブラウザと音声の提供者のあいだを中継します（仕様書 第10.5.5節、ADR-0018）。
Hono の外側（Node のサーバーの `upgrade`）で受け、ログイン状態の Cookie（動作確認では開発用ヘッダー）で相手を確かめます。
停止中の会社では開けません。送りは 16 kHz、受けは 24 kHz の PCM で、**音はどこにも書き出しません**。
終わったときに、聞こえた文字と応答を会話ログへ 1 往復として残します。

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
OAuth クライアントが整うまでは、`GET /v1/auth/google/start` は 503 を返し、
開発用ログイン（`POST /v1/auth/dev-login`）で動かします。
開発用の手段は `NODE_ENV=production` で有効にすると起動を拒否します。

## 主なエンドポイント

| メソッド・パス | 内容 |
|---|---|
| `GET /health` | 生存確認。テナント不要 |
| `GET /v1/auth/providers` | 使えるログイン手段。認証不要 |
| `POST /v1/auth/dev-login` | 開発用ログイン。認証不要 |
| `POST /v1/auth/logout` | ログアウト |
| `GET /v1/me` | テナント・利用者・CSRF トークン・接続の状態 |
| `GET /v1/agents` | 利用できるエージェントと入力スキーマ |
| `POST /v1/jobs` | ジョブを作成し待ち行列へ入れる。実行はワーカーが担う |
| `GET /v1/jobs` | **本人が依頼した**実行の一覧 |
| `GET /v1/runs/:id` | 実行の詳細。依頼者本人と、その実行に自分が判断できる承認がある人だけが見られる（仕様書 第6.2.1節）。ほかの人には 404 |
| `GET /v1/approvals` | 本人のロールで判断できる承認待ち |
| `POST /v1/approvals/:id` | 承認または却下。ロールが無ければ 403 |
| `POST /v1/secretary` | 秘書への依頼。どの層で答えたかを返す |
| `GET /v1/notifications` | 本人宛の通知 |
| `POST /v1/notifications/:id/read` | 既読にする |
| `GET /v1/schedules` | 本人の定時実行 |
| `POST /v1/schedules` | 定時実行を作る（毎日／毎週） |
| `PATCH /v1/schedules/:id` | 停止・再開、規則の変更 |
| `POST /v1/schedules/:id/trigger` | 次の回を今にする（動作確認用） |
| `GET /v1/admin/usage` | 管理者: エージェント別の利用量 |
| `GET /v1/admin/runs` | 管理者: 全利用者の実行の状態（中身は返さない） |
| `GET /v1/admin/users` | 管理者: 利用者の一覧 |
| `GET /v1/admin/audit-events` | 管理者: 監査ログ |
| `GET /v1/admin/connectors` | 管理者: 接続の状態 |
| `GET /v1/admin/connections` | 管理者: 接続の設定（Gemini の契約の形態・鍵の登録の有無・モデル、Google の OAuth クライアント・リダイレクト URI・求める許可・従業員の接続状況）。秘密の値は返さない |
| `PUT /v1/admin/connections/gemini` | 管理者: Gemini の設定（`mode`・`apiKey`（渡したときだけ上書き）・`models`）。鍵は暗号化して保存 |
| `DELETE /v1/admin/connections/gemini/key` | 管理者: 自社の鍵を削除（運営一括に戻る） |
| `POST /v1/admin/connections/gemini/test` | 管理者: 接続の確認（`kind`: `text` か `live`） |
| `PUT /v1/admin/connections/google` | 管理者: 会社の OAuth クライアント（`clientId`・`clientSecret`）。シークレットは暗号化して保存 |
| `GET /v1/admin/connections/google/impact` | 管理者: OAuth クライアントを消す（クライアント ID を替える）と影響する人数と業務の件数 |
| `DELETE /v1/admin/connections/google` | 管理者: OAuth クライアントの登録を消す。接続している全員の接続を消し、Google を使う動いている途中の業務を止める（仕様書 第6.5.2.1節）。クライアント ID を替える `PUT` も同じ |
| `GET /v1/me/google` | 本人: Google 連携の状況（業務の言葉の許可の一覧。トークンは返さない） |
| `POST /v1/me/google/connect` | 本人: 接続を始める（Google の同意の画面の URL を返す。state と PKCE つき） |
| `POST /v1/me/google/check` | 本人: 許可の状況を Google に問い合わせ直す |
| `GET /v1/me/google/impact` | 本人: 取り消すと止まる業務と、飛ばす定時実行の数 |
| `DELETE /v1/me/google` | 本人: 接続を取り消す（Google 側の許可も取り消し、トークンを消す）。Google を使う動いている途中の業務を止め、終わった実行の中身を消す（仕様書 第6.5.2.1節・第14.3.2節） |
| `GET /v1/oauth/google/callback` | Google からの戻り（ログイン不要。state で照合する） |
| `GET /v1/admin/google-permissions` | 管理者: この会社の業務が求める Google の権限と段階（制限付きかどうか）、使うツールと業務 |
| `GET /v1/admin/extensions` | 管理者: 拡張機能の一覧（公式・自社専用）、構成要素、必要な権限の説明、導入と有効・無効の状態 |
| `POST /v1/admin/extensions/import` | 管理者: `.m2ext` を取り込む（本文はファイルのバイト列。5 MB まで）。検証を通らなければ `problems` を返す |
| `POST /v1/admin/extensions/:id/install` | 管理者: 同意して導入（本文に `consent: true`）。導入すると有効になる |
| `PUT /v1/admin/extensions/:id/enabled` | 管理者: 有効・無効の切り替え（本文に `enabled`）。権限が増えた版は 409 |
| `POST /v1/admin/extensions/:id/connectors/:connectorId/check` | 管理者: コネクタの接続の確認（宣言したツールが提供されているか） |
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
| `GET /v1/admin/dashboard/live` | 管理者: ダッシュボードの「いま」（数値・業務の流れ・承認の滞留・出来事）。中身は返さない |
| `GET /v1/admin/dashboard/stats?days=1\|7\|30` | 管理者: ダッシュボードの集計（日ごと・時間帯・業務ごと・秘書の層・削減時間） |
| `GET /v1/admin/settings` | 管理者: 会社の設定（会社情報・自社の書き方・自動化ポリシー・業務の有効化） |
| `PUT /v1/admin/settings/:section` | 管理者: 設定の 1 区分を保存（`company`・`writingStyle`・`automation`・`agents`・`effect`・`slides`・`knowledge`・`privacy`。`knowledge` は言い換え、`privacy` は Google から取得したデータを残す日数） |
| `POST /v1/admin/users` | 管理者: 利用者の招待（Workspace のドメインのみ） |
| `PATCH /v1/admin/users/:id` | 管理者: 表示名・ロール・状態（管理者が 0 人になる変更は 409） |
| `GET /v1/admin/knowledge` | 管理者: 組織知識の一覧 |
| `PUT /v1/admin/knowledge/:id` | 管理者: 登録（`new`）・更新。本文を節に分け、分けた節を返す（50 万字まで） |
| `GET /v1/admin/knowledge/:id/sections` | 管理者: 1 件の知識の節（見出しの経路と字数） |
| `DELETE /v1/admin/knowledge/:id` | 管理者: 削除 |
| `GET /v1/me/settings` | 本人の個人設定 |
| `PUT /v1/me/settings/:section` | 個人設定の 1 区分を保存（`profile`・`secretary`・`notifications`・`menu`） |
| `PATCH /v1/me/profile` | 表示名の変更 |
| `GET /v1/me/sessions` | ログイン中の端末 |
| `DELETE /v1/me/sessions/:id` | 端末を個別にログアウト |
| `GET /v1/me/usage` | 本人の利用状況 |
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
