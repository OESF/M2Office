---
id: admin-google-chat
title: Google Chat のつなぎ方（管理者・くわしい手順）
audience: admin
category: admin
related: [admin-google-chat-trouble, admin-google-setup, admin-connectors]
group: 設定
order: 1
---
M2Office と Google Chat をつなぐ手順です。つなぐと、次の 2 つができるようになります。

| 段 | できること | 要る作業 |
|---|---|---|
| A | M2Office の通知を、従業員の Chat に届ける（朝のブリーフ・承認の依頼・社内のお知らせなど） | Chat アプリの構成・サービスアカウントの鍵・従業員ごとの許可 |
| B | 従業員が Chat から秘書に頼む（Chat アプリとの個別メッセージか、スペースでアプリに言及して書く） | 段 A に加えて、M2Office が発言を受け取る口（Cloud Pub/Sub か HTTP） |

段 A だけでも使えます。段 B は段 A が済んでから行ってください。

**この記事の読み手:** Google Cloud コンソールの画面と、Cloud Shell でコマンドを動かすことに、ある程度慣れた人を想定しています（社内の情報システムの担当、導入を手伝う人など）。所要時間は、段 A が 20〜30 分、段 B が 15〜20 分ほどです。

**先に済ませておくこと:** 「Google Workspace のつなぎ方」の手順 1〜5（プロジェクト・API・同意画面・OAuth クライアント・自分の接続）。Chat アプリは、**その OAuth クライアントと同じプロジェクト**に作ります。別のプロジェクトに作ると、従業員とアプリの個別メッセージを用意できません。

Google Cloud コンソールの画面の名前は、Google の更新で変わることがあります。見つからないときは、画面の上の検索に、この記事の「」の中の言葉を入れてください。

## 仕組み

### 流れ

```text
【段 A 通知】
M2Office ──（会社のサービスアカウントの鍵で、Chat アプリとして送る）──▶ Google Chat ──▶ 従業員とアプリの個別メッセージ

【段 B 秘書に頼む・Cloud Pub/Sub（社内のサーバー・外から届かない機械）】
従業員が書く ─▶ Google Chat ─（アドオンのアカウントで書き込む）─▶ トピック ─▶ 購読
                                                                         ▲
M2Office ─（会社のサービスアカウントで 5 秒ごとに取りに行く）──────────────┘
    └─▶ 秘書が答える ─▶ Google Chat（Chat アプリとして返す）

【段 B 秘書に頼む・HTTP（クラウド版など、外から届く M2Office）】
従業員が書く ─▶ Google Chat ─（Google の署名を付けて送る）─▶ M2Office の受け口の URL ─▶ 秘書が答える
```

### 出てくるアカウント

つまずく原因のほとんどは、**どのアカウントに、どの役割を付けるか**の取り違えです。次の 3 つを区別してください。

| アカウント | 形 | すること | 作る人 |
|---|---|---|---|
| 会社のサービスアカウント | `m2office-chat@<プロジェクト ID>.iam.gserviceaccount.com`（名前は自由） | M2Office が Chat アプリとして送る。Pub/Sub の購読を読む。鍵を M2Office に預ける | 管理者 |
| Chat アプリのアドオンのアカウント | `service-<プロジェクト番号>@gcp-sa-gsuiteaddons.iam.gserviceaccount.com` | Google Chat が、発言をトピックに書き込む。HTTP の受け口に署名を付ける | Google（自動で作る。構成の画面の「サービス アカウントのメール」に出る） |
| 従業員本人の Google の接続 | 本人の会社のアカウント | 本人とアプリの個別メッセージを、最初の 1 回だけ用意する | 本人（個人設定） |

**新しく作る Chat アプリは「Workspace アドオン」の形に決まっています。** 古い記事や他社の説明で、トピックの書き込みに `chat-api-push@system.gserviceaccount.com` を使うと書かれていることがありますが、アドオンの形の Chat アプリでは使われません。上の表の「アドオンのアカウント」に役割を付けてください。

### プロジェクト ID と番号

コマンドで使います。Cloud Shell で次を動かすと出ます（Cloud Shell は、コンソールの右上の「Cloud Shell をアクティブにする」で開く、ブラウザの中のターミナルです。手元に何も入れなくて使えます）。

```bash
gcloud config get-value project
gcloud projects describe "$(gcloud config get-value project)" --format='value(projectNumber)'
```

違うプロジェクトが出たら、`gcloud config set project <プロジェクト ID>` で切り替えます。OAuth クライアント ID（`<数字>-….apps.googleusercontent.com`）の先頭の数字が、そのプロジェクトの番号です。番号が合っているかで、同じプロジェクトかを確かめられます。

## 段 A Chat に通知を届ける

### A-1 API を有効にする

「API とサービス › ライブラリ」で「**Google Chat API**」を有効にします。Cloud Shell なら次のとおりです。

```bash
gcloud services enable chat.googleapis.com
```

### A-2 Chat アプリの構成（画面だけ）

ここだけはコマンドではできません。「Google Chat API」の画面の「**構成**」を開き、次を入れて「保存」を押します。

| 欄 | 入れるもの |
|---|---|
| アプリ名 | 例: `M2Office`。Chat で通知が届くときの送り主の名前になります |
| アバターの URL | 正方形の画像の URL（`https://` で始まるもの） |
| 説明 | 例: `社内の秘書` |
| インタラクティブ機能を有効にする | **入れる**（下を見てください） |
| 機能 | 段 B を使うなら「1:1 のメッセージを受け取る」と「スペースとグループの会話に参加する」を入れる。段 A だけなら入れなくてよい |
| 接続設定 | 空にはできません。Cloud Pub/Sub で受けるなら、B-1 の 1 で先にトピックを作って入れます。HTTP で受けるか、段 A だけを使うなら、ひとまず「HTTP エンドポイント URL」に仮の URL（例: `https://m2office.example/`）を入れておき、段 B で入れ直します |
| 公開設定 | 使う人（会社の全員か、決めた人やグループ）を入れる |

注意:

- **インタラクティブ機能は、通知を届けるだけでも要ります。** 切れていると、従業員とアプリの個別メッセージを用意するときに「Developer permission settings do not support this action」と断られます
- 「この Chat アプリを Workspace アドオンとしてビルドします」は、入ったまま外せません。そのままで構いません
- 公開設定に入っていない人には、Chat アプリが見えません。その人には通知が届きません

### A-3 サービスアカウントと鍵

Cloud Shell で次を動かします（`m2office-chat` は好きな名前に変えて構いません）。

```bash
PROJECT_ID=$(gcloud config get-value project)
gcloud iam service-accounts create m2office-chat --display-name="M2Office Chat"
gcloud iam service-accounts keys create ~/m2office-chat-key.json \
  --iam-account="m2office-chat@${PROJECT_ID}.iam.gserviceaccount.com"
cloudshell download ~/m2office-chat-key.json
```

最後の行で、鍵のファイルが手元のブラウザに保存されます。サービスアカウントに、プロジェクトの役割は要りません（Chat アプリとして送るのに役割は使いません）。

画面で行うときは、「IAM と管理 › サービス アカウント」で「サービス アカウントを作成」を押して作り、そのアカウントの「鍵」で「鍵を追加 › 新しい鍵を作成 › JSON」を押します。

「サービス アカウント キーの作成が無効になっています」と出るときは、組織のポリシー（`iam.disableServiceAccountKeyCreation`。新しい組織では `iam.managed.disableServiceAccountKeyCreation`）で止められています。Google Workspace の特権管理者が、このプロジェクトだけ外す必要があります。外せないときは、通知は画面内のお知らせで受け取ってください（業務からチャットに投稿するのは鍵が無くても使えます。Chat から秘書に頼むことはできません）。

### A-4 鍵を M2Office に預ける

1. M2Office の管理者ページ「接続 › Google Workspace」の「追加の機能」で「**Chat への通知（Chat アプリの鍵）**」を開きます
2. 「ファイルを選ぶ」で A-3 の鍵のファイルを選ぶ（または中身を貼る）と、「登録」を押せます
3. M2Office が、その鍵で Google に認証できるかを確かめてから預かります（暗号化して保存します）。「登録済み: m2office-chat@…」と出れば済みです
4. 手元と Cloud Shell の鍵のファイルを削除してください。Cloud Shell では次のとおりです

```bash
rm ~/m2office-chat-key.json
```

登録のときに確かめるのは「鍵が本物か」だけです。Chat アプリの構成が正しいかは、次の A-5 で分かります。

### A-5 従業員が Chat の受け取りを入れる

従業員がそれぞれ行います。管理者も、まず自分で行って確かめてください。

1. M2Office の個人設定の「通知」で「**Chat（本人への個別メッセージ）**」を入れます
2. 「Chat に届けるには Google の許可を 1 つ足します」と出たら「**Google の許可を足す**」を押し、Google の画面で許可します（Chat の個別メッセージを用意する許可です。最初の 1 回だけ要ります）
3. 戻って「Chat に届けます」と出れば済みです。Google Chat の一覧に、A-2 のアプリ名との会話ができています
4. 届く種類は、同じ画面の「Chat に送る種類」で選べます。既定では、夜（21:00〜翌 7:00）と会社の営業日でない日には Chat に送らず、明けたら 1 通にまとめて送ります

**確かめ方:** 何か通知が出たとき（朝のブリーフなど）に、Chat に届くかを見ます。届かないときは「Google Chat がつながらないとき（管理者）」の記事を見てください。

## 段 B Chat から秘書に頼む

### 受け口を選ぶ

M2Office が Chat の発言を受け取る口を、どちらか 1 つ選びます。

| 形 | 向いている所 | 要るもの |
|---|---|---|
| Cloud Pub/Sub | 社内のサーバー・Mac など、外（インターネット）から M2Office に届かない所。ルーターの設定も要らない | トピックと購読。費用はほぼかかりません（Pub/Sub には毎月の無料の枠があり、Chat の発言の量なら収まります） |
| HTTP | クラウド版など、外から M2Office の画面のアドレスに届く所 | M2Office が作る受け口の URL |

どちらでも、秘書の答えは Chat アプリとして返します。スペースでは、言及した本人にだけ見える形で返します。Chat の中では承認しません（承認の画面へのリンクを返します）。

### B-1 Cloud Pub/Sub で受ける

順番が大事です。トピックを先に作り、構成にトピックを入れて保存してから、役割を付けます。

**1. API とトピック・購読を作る（Cloud Shell）**

```bash
gcloud services enable pubsub.googleapis.com
gcloud pubsub topics create m2office-chat
gcloud pubsub subscriptions create m2office-chat-sub --topic=m2office-chat
```

画面で行うときは、「Pub/Sub › トピック」で「トピックを作成」を押し、「デフォルトのサブスクリプションを追加する」を入れたまま作ります（購読の名前は `<トピック名>-sub` になります）。

**2. 構成の接続設定を Pub/Sub にする（画面）**

「Google Chat API › 構成」の「接続設定」で「**Cloud Pub/Sub**」を選び、トピックの名前を `projects/<プロジェクト ID>/topics/m2office-chat` の形で入れて保存します。同じ所に「**サービス アカウントのメール**」が出ます。`service-<プロジェクト番号>@gcp-sa-gsuiteaddons.iam.gserviceaccount.com` の形であることを確かめてください。

**3. 2 つの役割を付ける（Cloud Shell）**

```bash
PROJECT_ID=$(gcloud config get-value project)
PROJECT_NUMBER=$(gcloud projects describe "$PROJECT_ID" --format='value(projectNumber)')
# Google Chat がトピックに書き込めるようにする（アドオンのアカウント）
gcloud pubsub topics add-iam-policy-binding m2office-chat \
  --member="serviceAccount:service-${PROJECT_NUMBER}@gcp-sa-gsuiteaddons.iam.gserviceaccount.com" \
  --role="roles/pubsub.publisher"
# M2Office が購読を読めるようにする（会社のサービスアカウント）
gcloud pubsub subscriptions add-iam-policy-binding m2office-chat-sub \
  --member="serviceAccount:m2office-chat@${PROJECT_ID}.iam.gserviceaccount.com" \
  --role="roles/pubsub.subscriber"
```

1 つ目で「does not exist」と断られたら、手順 2 の構成を保存できていないか、プロジェクトが違います。構成の画面の「サービス アカウントのメール」をそのまま `--member="serviceAccount:<そのアドレス>"` に入れてください。

画面で行うときは、「Pub/Sub › トピック」でトピックを選び、「権限」でアドオンのアカウントに「**Pub/Sub パブリッシャー**」を、「サブスクリプション」で購読を選び、会社のサービスアカウントに「**Pub/Sub サブスクライバー**」を付けます。

**4. M2Office に購読を入れる**

管理者ページの「Chat への通知（Chat アプリの鍵）」の「Chat で秘書に頼む」に、購読の名前を `projects/<プロジェクト ID>/subscriptions/m2office-chat-sub` の形で入れ、「保存」を押します。M2Office が 5 秒ごとに取りに行きます。

### B-2 HTTP で受ける

1. 管理者ページの「Chat への通知（Chat アプリの鍵）」の「Chat で秘書に頼む」で「**受け口の URL を作る**」を押します。URL は**このときだけ**出ます。すぐにコピーしてください
2. 「Google Chat API › 構成」の「接続設定」で「**HTTP エンドポイント URL**」を選び、1 の URL を貼ります
3. 「認証オーディエンス」は「**HTTP エンドポイント URL**」を選び、保存します

URL が分からなくなったら「受け口の URL を作り直す」を押し、構成に貼り直してください。作り直すと、前の URL は使えなくなります。URL には鍵が入っています。人に見せないでください。

### B-3 確かめる

1. 段 A の A-5 を済ませた人が、Google Chat のアプリ（A-2 のアプリ名）との会話に「今日の予定は？」などと書きます
2. 1 分ほどで秘書が答えれば済みです。M2Office の画面の秘書の会話の記録にも残ります
3. スペースで使うときは、スペースにアプリを追加し、`@M2Office`（アプリ名）と言及して書きます。言及の無い発言は、Google の決まりでアプリに届きません（秘書が人どうしの会話に割り込むことはありません）

答えが来ないときは「Google Chat がつながらないとき（管理者）」の記事を見てください。

## まとめて動かすとき（Cloud Shell）

段 A の A-3 と、段 B の B-1 のコマンドを 1 つにまとめたものです。**A-2 の構成（接続設定を Cloud Pub/Sub にし、トピックの名前を入れて保存）を済ませてから**動かしてください。

```bash
set -e
PROJECT_ID=$(gcloud config get-value project)
PROJECT_NUMBER=$(gcloud projects describe "$PROJECT_ID" --format='value(projectNumber)')
SA="m2office-chat@${PROJECT_ID}.iam.gserviceaccount.com"
gcloud services enable chat.googleapis.com pubsub.googleapis.com
gcloud iam service-accounts create m2office-chat --display-name="M2Office Chat"
gcloud pubsub topics create m2office-chat
gcloud pubsub subscriptions create m2office-chat-sub --topic=m2office-chat
gcloud pubsub topics add-iam-policy-binding m2office-chat \
  --member="serviceAccount:service-${PROJECT_NUMBER}@gcp-sa-gsuiteaddons.iam.gserviceaccount.com" \
  --role="roles/pubsub.publisher"
gcloud pubsub subscriptions add-iam-policy-binding m2office-chat-sub \
  --member="serviceAccount:${SA}" --role="roles/pubsub.subscriber"
gcloud iam service-accounts keys create ~/m2office-chat-key.json --iam-account="$SA"
echo "トピック: projects/${PROJECT_ID}/topics/m2office-chat"
echo "購読:     projects/${PROJECT_ID}/subscriptions/m2office-chat-sub"
cloudshell download ~/m2office-chat-key.json
```

鍵を M2Office に預けたら（A-4）、`rm ~/m2office-chat-key.json` で消してください。

## 設定を変える・やめるとき

| したいこと | すること |
|---|---|
| 鍵を替える | A-3 で新しい鍵を作り、A-4 で登録し直す。古い鍵は「IAM と管理 › サービス アカウント › 鍵」で削除する。購読の設定はそのまま残ります |
| 通知をやめる | 管理者ページの「Chat への通知（Chat アプリの鍵）」で「削除」を押す。通知は画面内のお知らせに戻ります |
| Chat から頼むのをやめる | HTTP は受け口の URL を「削除」。Pub/Sub は購読の欄を空にして「保存」。構成の「機能」の 2 つを外してもかまいません |
| 一人だけやめる | 本人が個人設定の「通知」で「Chat（本人への個別メッセージ）」を外す |
