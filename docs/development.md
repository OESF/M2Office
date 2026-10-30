# 開発者ガイド

M2Office を手元で動かして開発するための手引きです。インストールして使うだけなら、リポジトリ直下の [README](../README.md) で足ります。
設計の正は [仕様書](../specification.md)（入口）と [spec/](../spec/) の各章、コードの書き方は [開発規約](coding-standards.md) です。
AI の開発エージェントが作業するときに守ることの要点は [CLAUDE.md](../CLAUDE.md) にあります。

## 前提

| 項目 | 内容 |
|---|---|
| Node.js | 22 以上 |
| Docker | データベース（PostgreSQL 17 と pgvector。像は `pgvector/pgvector:pg17`）の起動に使う。pgvector は知識の意味の検索に使う（無くても言葉の検索だけで動く） |
| ポート | **3100 番台**を使う（3100 画面 / 3101 API / 3102 ワーカー / 3103 ビルド確認 / 3105 DB） |

**Gemini の鍵が要ります**（`.env` の `GEMINI_API_KEY`、または会社ごとに管理者ページの「接続」で登録する鍵）。
推論が使えない会社では、秘書も業務も動かず「Gemini の接続が設定されていません」と答えます（仕様書 第20.2.4節、ADR-0030）。
推論を行わないスタブ（`LLM_PROVIDER=stub`）は、自動テスト（`npm test`・`npm run smoke`）の中だけで使います。

**Google の設定が無くても動きます**（ADR-0003）。

| 未準備のもの | 代わりに動くもの |
|---|---|
| Google の OAuth クライアント | ダミーデータを返す接続口（予定・メール・タスク・チャット） |
| Google ログイン | 利用者を選ぶだけの開発用ログイン |

ダミーで動いている間は、画面の上部に「ダミーデータで動作中」と表示されます。

## セットアップ

```bash
cp .env.example .env
npm install
npm run db:reset    # DB を起動し、スキーマ適用と初期データ投入まで行う
```

## 起動

```bash
npm run dev
```

画面・API・ワーカーが同時に立ち上がります。

| テナント | URL |
|---|---|
| 株式会社アルファ商事 | http://a.lvh.me:3100 |
| 株式会社ベータ工業 | http://b.lvh.me:3100 |

`lvh.me` は任意のサブドメインが `127.0.0.1` に解決される開発用のドメインです。
使えない環境では `http://localhost:3100/?tenant=a` でも開けます。

開くとログイン画面になります。Google ログインを設定していなければ、
**開発用ログイン**から利用者（管理者／一般利用者）を選んでください。
管理者でログインすると、上部に「管理者ページ」（`/admin`）への入口が出ます。

### 音声を試すときは HTTPS で起動する

**ブラウザは、安全な文脈（HTTPS か `localhost`）でしかマイクを使わせません。**
`http://<サブドメイン>.lvh.me` では、マイクの口がそもそも無く、許可を尋ねる画面も出ません。
ブラウザの設定では直せないため、開発用の証明書を作って HTTPS で起動します。

```bash
npm run dev:cert
```

```bash
WEB_HTTPS=true npm run dev
```

いつも HTTPS で動かすなら、`.env` に `WEB_HTTPS=true` を書けば `npm run dev` だけで HTTPS になります（画面の開発サーバーも `.env` を読みます）。
そのあと `https://<サブドメイン>.lvh.me:3100` で開きます。
`mkcert` が入っていればブラウザが信頼するため警告は出ません。
入っていなければ自己署名になり、最初の 1 回だけ「詳細設定」→「アクセスする」で通します
（`brew install mkcert && mkcert -install` を入れてから `.data/certs` を消して作り直すと、警告が出なくなります）。

### 会社（テナント）を作る

マスター管理画面（`ops.` の名前で開く運営の画面。仕様書 第23.8.15節）の「会社一覧」の「会社を作る」で作れます。手元のツールでも作れます（仕様書 第16.1.3節）。最初の運営者は `npm run ops:operator -- --email … --role admin` で作ります。そのとき出るパスキーの登録の合言葉を本人に渡します（ログインは Google とパスキー）。

```bash
npm run tenant:create -- --subdomain example --name "会社名" --domain example.co.jp --admin admin@example.co.jp
```

### 本番の組み立て

```bash
npm run build:release -- --install
```

`dist-release/` に、API とワーカーを 1 つずつのファイルにまとめたもの・画面・実行中に読むファイルを組み立てます（仕様書 第20.4.5節）。
クラウドのコンテナと、ローカルの形（社内の Mac。仕様書 第8.6.1節）の両方の元になります。ローカルの形は、技術者が GitHub のリリースのタグを取ってきて、対話式の `deploy/onsite/setup.sh` で入れます（手順は [deploy/onsite/README.md](../deploy/onsite/README.md)）。M2Medical と同じ機械に入れるときの入口の取り決めは [deploy/front/README.md](../deploy/front/README.md)。クラウドの形（Xserver の VPS。仕様書 第20.4.6節）は `deploy/vps/setup.sh` で入れます（手順は [deploy/vps/README.md](../deploy/vps/README.md)）。

## 動作確認

```bash
npm test        # ファイルヘッダー・ヘルプの記事の確認と単体テスト（DB 不要）
npm run smoke   # 通しの確認（npm run dev を起動した状態で）
SMOKE_EXTERNAL=1 npm run smoke   # 外部の MCP サーバ（DeepWiki）への実際の問い合わせも確かめる
npm run eval:contract-review     # 契約書チェックの評価（本物の推論。--yes で回す。費用がかかる。仕様書 第28.15節）
npm run eval:knowledge-search    # 知識の意味の検索の評価（本物の埋め込み。--yes で回す。仕様書 第11.7.6.5節）
```

通しの確認では、とくに**承認ゲートで中断し、承認後に別のワーカーが
再開して完了する**経路（仕様書 第24.3.2節の段階 5 と 7）を検証します。
あわせて次も確認します。

| 項目 | 内容 |
|---|---|
| 分離 | テナント・権限区画・利用者本人の範囲 |
| エージェント | AG-01（送信しない）・AG-02・AG-03（招待の前に依頼者本人が承認）・AG-04・AG-05（定時実行から本人へ通知） |
| 承認 | 指定された者（ロール、または依頼者本人）以外は承認できない |
| ログイン | Cookie の属性、CSRF、他テナントへの持ち込み、ログアウト |
| データベース | 条件なしの SELECT で他社の行が見えない、他社の行を書けない、監査ログを書き換えられない |
| 管理者ページ | 業務の無効化、入力の検証、最後の管理者の保護、登録した規程を AG-04 が見つける |
| 個人設定 | 本人だけに効く、受け取らない通知は届かない |
| ファイル | 形式の偽装を拒否、本人だけが取り出せる、他社から見えない |
| ダッシュボード | 中身を含まない、一般利用者は見られない、削減時間の記録、他社の業務が出ない |
| ヘルプ | 役割による出し分け、業務の説明の自動生成、使い方と社内規程の区別、問い合わせ番号 |
| 拡張機能 | 導入していない会社で使えない、同意なしで導入できない、「こんにちは」→「Hello World」、他社に現れない、削除で使えない |
| Google Workspace のツール | 探す・読む・表にまとめる、引数の誤りで止まる、送信は承認のあとだけ、会社が求める権限の一覧 |
| スライドの作成 | 見本の調査の明示、8 ページの構成の検証と成果物、既定のテンプレートの記録、外部送信の注意がヘルプに出る |
| 権限区画の割当 | グループに入ると区画に入れる、外すと出る、管理者への通知、出入りの記録、他社から見えない |
| グループと利用範囲 | 範囲の外の人のメニュー・秘書・ヘルプ・定時実行・起動から外れる、グループに入ると使える、個人の指定、依頼後に外れたら止める、グループの削除で開かない |
| グループの名前で共有 | グループに合う Chat のスペースを名前で見つけて覚える、管理者だけが確かめられる、メンバーの数とグループとの違いを出す、秘書への会話で覚え直す・忘れる |
| 持ち運べる拡張機能 | プログラムを含むファイルを拒否、取り込んだものは他社に見えない、同意して導入すると動く、スイッチで無効・有効、監査ログ、コネクタ（DeepWiki）、会社の接続（MCP）の登録・危険度の変更・削除 |

## 拡張機能（業務の追加）

拡張機能は、業務エージェント（手順）とコネクタ（外部のサービスの MCP サーバへの接続）をまとめたものです。
**1 つのファイル（`.m2ext`）で持ち運べ**、管理者ページの「拡張機能」で取り込み、スイッチで有効と無効を切り替えます。
作り方は **[開発者マニュアル](developer/README.md)** にあります。

| サンプル | 置き場所 | 内容 |
|---|---|---|
| あいさつ | [extensions/hello-world](../extensions/hello-world/) | 「こんにちは」に「Hello World」と返す、いちばん小さい例 |
| リポジトリ調査（DeepWiki） | [extensions/deepwiki-research](../extensions/deepwiki-research/) | コネクタ（MCP）で DeepWiki に質問し、答えを資料に残す |
| スライドの作成（見本） | [extensions/research-slides](../extensions/research-slides/) | 公式の「スライドの作成」と同じ動きを SKILL.md で書いた見本 |
| 契約書チェック | [extensions/contract-review](../extensions/contract-review/) | 契約書を読み、注意したい点・修正の案・交渉の進め方の案をまとめる公式の拡張機能（仕様書 第28章）。前の版を渡せば、相手の修正版で変わったところを挙げる。観点の補助資料と学ばない業務の印を使う |
| 週報の下書き | [examples/extensions/weekly-report](../examples/extensions/weekly-report/) | 予定と ToDo から週報を下書きする。ファイルにして取り込む自社専用の例 |

```bash
npm run ext:validate                                # 拡張機能を検証する
npm run ext:pack examples/extensions/weekly-report  # 持ち運べるファイル（.m2ext）を作る
```

`extensions/`（公式の配布元）は API とワーカーの起動時に読み込まれます。
管理者ページから取り込んだファイルは、取り込んだ時点でその会社だけで使えます（再起動は要りません）。

## ログ

API とワーカーは、アプリログを標準出力へ書きます（開発規約 第7章）。
`npm run dev` のターミナルに、`[api]`・`[worker]` の印つきで流れます。

| レベル | 出るもの |
|---|---|
| `error` | 想定外の例外、API の 500 |
| `warn` | 承認ゲートがツールを止めた、実行の失敗、定時実行の見送り |
| `info` | 起動と停止、API の要求 1 件ごと（画面が数秒ごとに読み直す要求は、成功して速いものを書かない）、実行の開始・完了・承認待ち |
| `debug` | ステップの開始と終了、ツールの呼び出し |

量を減らしたいときは `.env` で `LOG_LEVEL=warn` などにします。画面の読み直し（お知らせ・実行の一覧など）も 1 件ずつ見たいときは `LOG_POLLS=true` にします。
API の応答には `X-Request-Id` が付き、同じ値がログの `requestId` に残ります。
エラーの問い合わせを受けたら、この ID でログを探せます。

`info` から上は、データベース（表 `system_logs`）にも書き、28 日で入れ替えます（仕様書 第16.10節）。
ローカルの形では会社の管理者が管理者ページの「機械」で、クラウドの形では運営がマスター管理画面の「システムログ」で、見てダウンロードし、証拠を保全できます。
監査ログ（誰が何をしたか）はこれとは別で、データベースに残り、管理者ページで見られます。

## 構成

```
packages/
  shared/   型定義と定数。画面・API・ワーカーが共通で参照する
  core/     ドメインロジック。実行エンジン、承認、ツール、秘書、LLM 抽象化層
  api/      公開 API（Hono）。画面も外部アプリも同じ API を経由する
  worker/   ジョブ実行の常駐プロセス。承認による中断と再開を担う
  web/      ワークスペース（Vite + React の SPA）
db/migrations/   スキーマ
scripts/         DB 操作と動作確認
docs/            開発規約・リリース規定・設計判断記録
```

依存の向きは [docs/coding-standards.md](coding-standards.md) 第3章に従います。
**`core` に HTTP やフレームワークを持ち込まないこと。**

## 設定

| 変数 | 既定 | 意味 |
|---|---|---|
| `WEB_PORT` | 3100 | 画面の開発サーバー |
| `API_PORT` | 3101 | API |
| `M2O_LISTEN_HOST` | 127.0.0.1 | API と運営の API が待ち受けるアドレス。どの配備の形でも機械の中だけにし、外からは Caddy が受ける（仕様書 第20.4.6節）。ほかの機械から直接受けるときだけ変える |
| `WORKER_PORT` | 3102 | ワーカー（health 用。現時点では未使用） |
| `DB_PORT` | 3105 | PostgreSQL |
| `DATABASE_URL` | — | アプリの接続先。**`m2office_app` ロール**（所有者でなく RLS を迂回できない） |
| `MIGRATION_DATABASE_URL` | — | スキーマ変更と初期データの投入に使う所有者のロール |
| `FILE_STORAGE_DIR` | `.data/files` | ファイルの置き場（開発用） |
| `BASE_DOMAIN` | lvh.me | 開発用のベースドメイン |
| `LLM_PROVIDER` | gemini | `gemini`。`stub` は自動テスト（`npm run smoke`）専用で、推論を行わない |
| `GEMINI_API_KEY` | — | 運営の鍵。無ければ、会社ごとに登録した鍵だけで動く（どちらも無い会社では秘書も業務も動かない）。マスター管理画面の「設定 › AI」で入れた鍵があれば、そちらが優先する（1 分以内に替わる。仕様書 第23.8.14節） |
| `YAHOO_CLIENT_ID` | — | JAN から商品名を引く Yahoo!ショッピングの商品検索の Client ID の運営の既定（会社が管理者ページの在庫管理の設定で入れていなければこれを使う。無ければ使わない。使うと JAN から商品名を引く画面の下にクレジットを出す。仕様書 第29.11.3節） |
| `MODEL_FAST` | `gemini-3.5-flash-lite` | 振り分け・分類・その場の学習と要約。安いものを既定にする（仕様書 第20.2.2節） |
| `MODEL_STANDARD` | `gemini-3.5-flash-lite` | 業務のステップ・秘書の対話・文字の読み取り |
| `MODEL_ADVANCED` | `gemini-3.8-flash` | 難しい計画・長文の分析（いまは使っていない） |
| `MODEL_RESEARCH` | `MODEL_STANDARD` と同じ | Web の調査（`web.research`） |
| `MODEL_IMAGE` | `gemini-nano-banana-2.1` | 画像を作るモデル（コラムのカバーとサイネージの挿絵・販促物の画像。Nano Banana 2.1。それまでの `gemini-3.1-flash-image` は 2026-10-29 に終了） |
| `MODEL_VIDEO` | `veo-3.1-lite-generate-preview` | コラムのサイネージ用の 8 秒の動画（720p。仕様書 第32.18.6節） |
| `MODEL_VIDEO_LONG` | `veo-3.1-fast-generate-preview` | コラムのサイネージ用の 15 秒の動画（8 秒を作り 7 秒延長する。延長できるモデルにする） |
| `MODEL_TTS` | `gemini-3.8-flash-tts` | コラムのナレーション付きスライドの読み上げ（仕様書 第32.18.6節 段 3） |
| `FFMPEG_PATH` | `ffmpeg`（`PATH` のもの） | ナレーション付きスライドを MP4 にまとめる ffmpeg。**M2Office には同梱しない**（ライセンスのため）。クラウドは組み立てで、ローカルの形は `setup.sh` が Homebrew で入れる。無い機械ではナレーション付きスライドを作れない |
| `MODEL_FALLBACK` | — | 推論が混雑・障害などで失敗したときに最初に試す退避先。未設定なら、ほかの役割のモデルに退避する（同じ鍵の中だけ。仕様書 第20.2.5節） |
| `MODEL_LIVE` | `gemini-3.1-flash-live-preview` | 音声の対話（Gemini Live） |
| `USD_JPY` | 155 | 費用を円で示すときの為替（概算） |
| `GOOGLE_LOGIN_CLIENT_ID` / `GOOGLE_LOGIN_CLIENT_SECRET` | — | Google ログインに使う**運営の** OAuth クライアント（仕様書 第16.1.1節）。求める権限は openid・email・profile だけ。未設定なら Google ログインは無効 |
| `GOOGLE_LOGIN_REDIRECT_URI` | `http://localhost:<API_PORT>/v1/oauth/google/login-callback` | Google に登録する戻り先。**運営のホスト 1 本**（第16.1.2節） |
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` | — | Google 連携（会社ごとの OAuth クライアント。管理者ページで登録する。ここは開発の既定値としてのみ使う） |
| `CANVA_CLIENT_ID` ／ `CANVA_CLIENT_SECRET` | なし | 販促物の作成の Canva とのつなぎ。運営が Canva に公開のつなぎを登録し、審査を通してから入れる。無ければ Canva のことは出さない（仕様書 第41.19.3節） |
| `CANVA_OAUTH_REDIRECT_URI` | `GOOGLE_OAUTH_REDIRECT_URI` と同じホストの `/v1/oauth/canva/callback` | Canva から戻る先。Canva のつなぎに登録する |
| `CANVA_MOCK` | なし | `true` で Canva の代わりに見本を使う（開発と自動テスト。外には何も送らない） |
| `CONNECTION_OAUTH_REDIRECT_URI` | `GOOGLE_OAUTH_REDIRECT_URI` と同じホストの `/v1/oauth/connection/callback` | 認証の要る会社の接続（Slack など）で相手から戻る先。管理者ページに出し、相手のアプリに登録する。**Slack は https だけを認める**（仕様書 第12.11.6節） |
| `WEB_HTTPS` | false | 開発で音声を試すときに true。**ブラウザは安全な文脈でしかマイクを使わせない**（`npm run dev:cert` で証明書を作る） |
| `CONNECTOR_MODE` | mock | `mock`（ダミーデータ）または `google`（Gmail とカレンダーを本物で動かす。ほかのサービスは「準備中」と断る。仕様書 第14.3.4節） |
| `CONNECTOR_MOCK_TENANTS` | （なし） | **開発だけ。** `google` のとき、見本のまま動かす会社のテナント ID（カンマ区切り）。smoke の会社を見本に保つ（例: `t-alpha,t-beta`）。本番で設定すると起動を拒否する |
| `OPS_PORT`・`OPS_DATABASE_URL` | 3102・開発の既定 | マスター管理画面の API（別のプロセス）のポートと、運営の専用のロール `m2office_ops` の接続。本番では `OPS_DATABASE_URL` が必須（仕様書 第23.8.15節） |
| `OPS_GOOGLE_REDIRECT_URI`・`OPS_GOOGLE_DOMAIN`・`OPS_SESSION_TTL_HOURS` | `http://localhost:<OPS_PORT>/v1/ops/auth/callback`・（なし）・12 | 運営者の Google のログインの戻り先（運営の OAuth クライアントに足して登録する）・運営者にできるドメイン・ログイン状態の時間 |
| `DEMO_SUBDOMAIN` | （なし） | 体験版の入口の名前（`demo` なら `demo.<BASE_DOMAIN>`、開発は `demo.localhost`）。空なら体験版を使わない。API と運営の API が読む（仕様書 第23.3.2節） |
| `AUTH_DEV_LOGIN` | false | 開発用ログインを許す。`.env.example` では true |
| `AUTH_DEV_HEADERS` | false | `X-Tenant`・`X-User` ヘッダーでの指定を許す。動作確認用 |
| `M2O_DEBUG` | false | デバッグモード。画面の上に「Debug mode」を出し、音声・秘書の振り分け・失敗した呼び出しと画面から呼んだ API を記録して見せる（メモリーだけに持つ。仕様書 第20.4.1節） |
| `SESSION_TTL_HOURS` | 168 | ログイン状態の有効時間 |
| `M2OFFICE_SECRET_KEY` | （開発は固定の鍵） | 秘密の値（Gemini の鍵・OAuth のシークレット・利用者のトークン）を暗号化する鍵（AES-256-GCM。ADR-0007）。本番では必須 |
| `M2OFFICE_SECRET_KEY_OLD` | （なし） | 前の鍵（カンマで複数）。読むときだけ使う。鍵を入れ替えたら、`npm run secrets:rotate` で残りを今の鍵で暗号化し直す（仕様書 第16.11.3節 G-10） |
| `HOSTING_PROVIDER`・`HOSTING_LOCATION` | （なし） | インフラ事業者の名前と置き場。管理者ページの「データの渡し先」に出す。空なら「運営が設定していません」と出す（仕様書 第16.11.3節 G-3） |
| `SECURITY_CONTACT` | （なし） | 脆弱性の報告の窓口（`/.well-known/security.txt`。RFC 9116）の連絡先。`mailto:` か `https:` の URL をカンマで複数。空なら出さない（仕様書 第16.11.3節 G-11） |
| `COOKIE_SECURE` | false | HTTPS で配信する環境では true |
| `SCHEDULE_INTERVAL_MS` | 15000 | 定時実行の見回り間隔 |
| `SCHEDULE_REPLY_INTERVAL_MS` | 900000 | 社外の参加者を含む日程調整で、相手の返事を見る間隔（仕様書 第9.5.3.1節） |
| `PROACTIVE_INTERVAL_MS` | 600000 | 秘書の先回り（会議の直前の準備・前日の移動の知らせ）の見回り間隔（仕様書 第10.12節） |
| `INVENTORY_WATCH_HOUR` | 7 | 在庫の毎朝の見直しを始める時刻（日本時間の時。この時刻を過ぎたら 1 日 1 回。仕様書 第29.14節） |
| `CARD_PURGE_INTERVAL_MS` | 3600000 | 期限を過ぎた名刺（ごみ箱に 30 日・読み取れなかったもの 4 週）を消す見回りの間隔（仕様書 第27.7節） |
| `SECURITY_INTERVAL_MS` | 300000 | 不正の兆し（大量の持ち出し・ログインの攻撃・権限の変化・ありえない並び）の見回りの間隔。朝 7 時を過ぎたら前の日の数のまとめも送る（仕様書 第16.8節） |
| `SIGNATURE_INTERVAL_MS` | 3600000 | 名刺を交換した相手のメールの署名を見て、名刺を新しくする見回りの間隔（仕様書 第27.6.1節） |
| `GOOGLE_CONTACTS_INTERVAL_MS` | 600000 | Google の連絡先に入れた名刺が直されたら写し、自動で入れる名刺を入れる見回りの間隔（仕様書 第27.15節） |
| `INQUIRY_INTERVAL_MS` | 900000 | 問い合わせの期限と手つかずを知らせ、古い原文を消す見回りの間隔（仕様書 第33.17節） |
| `INQUIRY_MAIL_INTERVAL_MS` | 300000 | 問い合わせの窓口のアカウントのメールを読む間隔（仕様書 第33.18節） |
| `COMPETITOR_INTERVAL_MS` | 10000 | 競合の分析の作業（探す・読む）と定期の見回りの番を見る間隔（仕様書 第36.18節・第36.19節） |
| `ANNOUNCEMENT_INTERVAL_MS` | 60000 | お知らせの予約の時刻と期間の後を見回る間隔（仕様書 第35.17節） |
| `CONTRACT_INTERVAL_MS` | 3600000 | 契約の解約の申し出の期限（60・30・7 日前）と終わりの知らせ、自動更新の繰り越しを見る間隔（仕様書 第38.6節） |
| `SUBSIDY_INTERVAL_MS` | 3600000 | 補助金・助成金の月の調べもの（毎月 1 日の 8 時を過ぎたら）と、「気になる」にした制度の締め切り（14・3 日前）の知らせと、公募の変更の読み直し（毎日 8 時を過ぎたら）を見る間隔（仕様書 第39.7節・第39.18節） |
| `PROFILE_INTERVAL_MS` | 600000 | 本人の像（秘書がまとめた本人についての文）を作る・作り直すかを見る間隔（仕様書 第11.13.1節） |
| `EFFECT_INTERVAL_MS` | 600000 | 効果のレポート（毎月 1 日 7 時を過ぎたら先月の分を作って管理者に知らせる。25 か月を過ぎたものを消す）を見る間隔（仕様書 第6.7.13節） |
| `WEB_REVIEW_INTERVAL_MS` | 60000 | Webの分析の月の便り（毎月 3 日）と、直すべき所の見回り（週に 1 回・今すぐチェック）を見る間隔（仕様書 第34.18節・第34.19節） |
| `COLUMN_PLAN_INTERVAL_MS` | 60000 | コラムの予約・予定表の先回りと飛ばす回・週に 1 回のテーマ案を見る間隔（仕様書 第32.18.4節） |
| `PAGESPEED_API_KEY` | （なし） | PageSpeed Insights の運営の鍵。無ければ鍵なしの回数の範囲で呼ぶ（Q-174） |
| `CRAWLER_CONTACT_URL` | （なし） | 競合の分析・コラムの似すぎの確かめで相手のサイトを読むときに、名乗りに添える問い合わせ先の URL（仕様書 第36.7節） |
| `M2O_DEPLOYMENT` | cloud | 配備の形。`cloud`（多数の会社・サブドメイン）か `onsite`（社内の 1 台に 1 社だけ。ローカルの形）（仕様書 第8.6節） |
| `M2O_ONSITE_TENANT` | （なし） | ローカルの形で入っている 1 社のサブドメイン。アドレスにかかわらずこの会社に決める |
| `AI_MONTHLY_LIMIT_JPY` | （なし） | 運営が AI の費用をまとめて払う会社の、AI の利用の月の上限（円）の既定と、管理者が上げられる上限。無ければ上限なし。自社の鍵の会社には効かない（仕様書 第6.6.2節）。マスター管理画面で決めれば、そちらが優先する |
| `M2O_BACKUP_DIR` | （なし） | ローカルの形の控えの置き場（RAID とは別のディスク）。あれば毎晩控えを取り、毎月戻せるかを確かめる（仕様書 第8.6.5節） |
| `M2O_OFFSITE_REPOSITORY`・`M2O_OFFSITE_PASSWORD`・`M2O_OFFSITE_ACCESS_KEY_ID`・`M2O_OFFSITE_SECRET_ACCESS_KEY`・`M2O_OFFSITE_REGION`・`M2O_RESTIC_BIN` | （なし） | ローカルの形の社外の控え。会社が契約した S3 互換の置き場（`s3:https://…`）・暗号化の合言葉（機械の上で作り、紙の控えに書く）・置き場の鍵・地域・restic の道。そろったときだけ、毎晩の控えの後に restic で暗号化して送る（仕様書 第8.6.5節） |
| `M2O_MACHINE_ADMIN_ID`・`M2O_MACHINE_ADMIN_PASSWORD_HASH`・`M2O_MACHINE_ADMIN_TOTP` | （なし） | ローカルの形の機械の管理者（`/machine`）の ID・合言葉の控え（scrypt）・認証アプリの確認コードの種（base32）。導入のときに setup.sh が作る。3 つがそろったときだけ使える（仕様書 第8.6.3節） |
| `M2O_PG_BIN` ／ `M2O_PG_DOCKER` | （なし） | 控えに使う PostgreSQL の道具のある場所（同梱した実行環境）。開発ではデータベースのコンテナの名前（`m2office-db`）を `M2O_PG_DOCKER` に渡すと、その中の道具を使う |
| `M2O_MACHINE_DIR` | `.data/machine` | ローカルの形の「機械」の様子の知らせ（ワーカーの知らせ）を置く場所（仕様書 第8.6.7節） |
| `M2O_LOG_DIR` | （なし） | ローカルの形の機械のログのファイルの置き場（`<データの置き場>/logs`）。「機械」でダウンロードし、証拠保全に入れる（仕様書 第16.10節）。セットアップと更新が入れる |
| `M2O_APP_ROOT` | （リポジトリの根） | 実行中に読むファイル（ヘルプ・マニュアル・フォント・拡張機能・版の番号）の置き場所の根。本番の組み立て（`npm run build:release`）では組み立てたものの根を渡す（仕様書 第20.4.5節） |
| `LOCAL_LLM_URL` | （なし） | ローカル AI の OpenAI 互換の口（例: `http://127.0.0.1:11434/v1`）。ローカルの方針の会社が使う（仕様書 第16.3.7.1節） |
| `LOCAL_LLM_MODEL` | （なし） | ローカル AI のモデル。`LOCAL_LLM_MODEL_FAST`・`_STANDARD`・`_ADVANCED` で役割ごとに変えられる |
| `LOCAL_LLM_KEY`・`LOCAL_LLM_TIMEOUT_MS` | （なし）・300000 | ローカル AI の口が鍵を求めるときの鍵と、1 回の問い合わせを待つ時間 |
| `LOCAL_LLM_EMBED_MODEL` | （なし） | ローカル AI の埋め込みのモデル（768 次元。例: EmbeddingGemma）。無ければ、ローカルの方針の会社の知識は言葉の検索だけで探す（仕様書 第11.7.6節） |
| `MEMORY_SEMANTIC` | on | 秘書が本人の記憶と会話の要約を意味で探すか（秘書の成長の段 2。pgvector と埋め込みを持つ推論が要る。仕様書 第11.13.4節） |
| `KNOWLEDGE_SEMANTIC` | 本番 off・それ以外 on | 知識の意味の検索を使うか。本番は評価（仕様書 第11.7.6.5節）で採用の条件を満たしたと確かめてから `on` にする |
| `KNOWLEDGE_EMBED_INTERVAL_MS` | 30000 | 知識の節の埋め込み（意味での検索の準備）を作る見回りの間隔。1 回に 32 節まで（仕様書 第11.7.6.1節） |
| `RETENTION_INTERVAL_MS` | 本番 600000 / 開発 15000 | Google から取得したデータの保持期間の見回り間隔（仕様書 第14.3.2節） |
| `LOG_LEVEL` | 開発 debug / 本番 info | アプリログのレベル（`error`・`warn`・`info`・`debug`） |
| `LOG_POLLS` | false | `true` で、画面が数秒ごとに読み直す要求（お知らせ・承認・実行・業務の一覧・秘書の調べもの）も 1 件ずつ記録する。既定は、成功して 1 秒より速く返ったものを書かない |
| `LOG_FORMAT` | 開発 pretty / 本番 json | アプリログの形式 |

`AUTH_DEV_LOGIN`・`AUTH_DEV_HEADERS`・`M2O_DEBUG` は、`NODE_ENV=production` で有効にすると起動を拒否します。

API とワーカーは起動時にリポジトリ直下の `.env` を読みます（Node.js の `--env-file-if-exists`）。

## 公開の前の点検

このリポジトリ（`OESF/M2Office`）をそのまま公開しています（仕様書 第22.5節、ADR-0060）。push したものはすぐ誰でも読めるため、push の前に点検を通します。
お客様に合わせる部分とお客様のデータは公開しません。

```bash
npm run publish:check                          # push の前の点検（秘密の値・見本でないメールアドレス・出してはならない言葉・依存のライセンス）
npm run security:check                         # 依存の既知の脆弱性の点検（「高」以上で失敗。仕様書 第16.11.3節 G-11）
npm run secrets:rotate                         # 暗号の鍵の入れ替えの後に、前の鍵の値を今の鍵で暗号化し直す（--check で数えるだけ。G-10）
npm run publish:export -- ../m2office-export   # 履歴を含めたくない配布物を作るときだけ。点検を通してから、空のフォルダに書き出す
```

出してはならない言葉は、公開しないリポジトリ（既定は `../M2Office-private/publish-denylist.txt`。`M2O_PUBLISH_DENYLIST` で変えられる）に
ハッシュだけで置きます。言葉を足すときは `node scripts/check-publish.mjs --hash` に 1 行ずつ渡し、出た行を追記します。

## 関連文書

| 文書 | 内容 |
|---|---|
| [specification.md](../specification.md)・[spec/](../spec/) | システム仕様の全体。入口と、1 章 1 ファイルの各章 |
| [CLAUDE.md](../CLAUDE.md) | 開発時に守ること（要点） |
| [実装状況](implementation-status.md) | いま入っている機能と、まだのもの |
| [google-setup.md](google-setup.md) | Google Workspace と Google Cloud の設定手順 |
| [coding-standards.md](coding-standards.md) | コードの書き方、JSDoc、README |
| [release-process.md](release-process.md) | バージョンとリリース（作業は `/release` スキル） |
| [CHANGELOG.md](../CHANGELOG.md) | 版ごとの変更（開発者向け） |
| [adr/](adr/) | 設計判断の記録 |
| [help/](help/) | ヘルプセンターに出す公式の記事（書き方は help/README.md） |
| [developer/](developer/README.md) | 開発者マニュアル（拡張機能・業務エージェント・コネクタの作り方） |
| [manual/hr-payroll/](manual/hr-payroll/README.md) | 人事・給与のユーザーマニュアル（`npm run docs:hr-manual-pdf` で PDF） |
| [manual/inventory/](manual/inventory/README.md) | 在庫管理のユーザーマニュアル（`npm run docs:inventory-manual-pdf` で PDF） |
| [ops-manual/](ops-manual/README.md) | マスター管理画面の運営者マニュアル（運営者向け。画面の「ヘルプ」にも出る。`npm run docs:ops-manual-pdf` で PDF） |
| manual/*/manual.json | 業務のマニュアルをヘルプで章ごとに読むための名前と、どの内蔵の拡張のものか（仕様書 第6.10.7.3節。書き方は help/README.md） |
| [LICENSE](../LICENSE)・[NOTICE](../NOTICE) | ライセンス（Apache License 2.0）と著作権の表示 |
