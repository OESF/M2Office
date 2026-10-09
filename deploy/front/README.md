# 同じ機械の入口の取り決め（M2Office と M2Medical）

1 台の Mac に M2Office と M2Medical を一緒に入れるときの取り決めです（仕様書 第8.6.9節、ADR-0086）。
**このディレクトリは共通の部品です。** M2Medical はここをそのまま写して使い、写した版を M2Medical の `docs/shared-from-m2office.md` に残します。
直すときは M2Office で直し、取り決めの形（共通の Caddyfile・launchd の設定）を変えたら `front.sh` の `CONTRACT` を上げます。

## 考え方

- **入口（Caddy）は機械に 1 つ。どちらの製品にも属さない共通の置き場**（`/Library/M2Front`）に置く。
- **先に入れた製品が入口を作り、後から入れた製品は自分の名前の設定を 1 つ置くだけ。** どちらを先に入れても同じ形になり、片方を外しても、もう片方は動き続ける。
- 名前で分け、**ポートで分けない**（Cookie はポートで分かれず、ログインが混ざるため）。同じ社内の IP に、2 つの名前（例 `office.<会社のドメイン>` と `medical.<会社のドメイン>`）を向ける。
- 入口のほかは、すべて製品ごとに分ける（データベース・データの置き場・OS の利用者・控えと鍵・更新）。ローカル AI だけを 1 つ両方で使う。

## 置き場所

| 道 | 中身 | 書く人 |
|---|---|---|
| `/Library/M2Front/Caddyfile` | 共通の Caddyfile。`sites/*.caddy` を読み込むだけで、全体の設定の段（`{ … }`）は持たない | `front.sh`（手で書き換えない） |
| `/Library/M2Front/CONTRACT` | 取り決めの版（整数）。新しい写しは、古い写しが書いた共通の設定を置き換える。古い写しは、新しいものを置き換えない | `front.sh` |
| `/Library/M2Front/sites/<製品>.caddy` | 製品ごとの名前・証明書・振り分け（M2Office は `m2office.caddy`、M2Medical は `m2medical.caddy`）。DNS の鍵を含むため root だけが読める | 各製品のセットアップ（`front.sh put-site`） |
| `/Library/M2Front/maintenance-owner` | 遠隔の保守を開けられる製品の名前（1 行。下の「遠隔の保守」） | M2Medical のセットアップ |
| `/Library/M2Front/data`・`config` | Caddy の証明書と状態（root だけ） | Caddy |
| `/Library/M2Front/logs/caddy-run.log` | 入口の起動のログ | Caddy |
| `/Library/LaunchDaemons/jp.m2front.caddy.plist` | 入口の起動の設定（root で動かす。443 番を受けるため） | `front.sh` |

## 各製品のセットアップがすること

1. Homebrew の `caddy` を入れ、自分の DNS の事業者のつなぎが無ければ `caddy add-package` で足す（足したら次の手順で `--restart` を付ける）。
2. 自分の名前の設定（1 つ以上のサイトの段だけ）を作り、`sudo front.sh put-site <製品> <ファイル> --caddy <caddy の道>` で置く。
   `front.sh` は、共通の入口が無ければ作り、全体を `caddy validate` で確かめてから読み直す。**確かめに失敗したら前の設定に戻す**（自分の誤りで、もう片方の製品の入口を止めない）。
3. 外すときは `sudo front.sh remove-site <製品> --caddy <caddy の道>`。受ける名前が無くなれば入口を止める。

### 名前の設定に書くこと・書かないこと

| 書く | 書かない |
|---|---|
| 自分の名前のサイトの段（`office.<会社のドメイン> { … }`） | 全体の設定の段（`{ email … }` など）。メールアドレスは `tls <メールアドレス> { dns … }` の形でサイトの段の中に書く |
| 証明書（名前の形は DNS-01、IP の形は `tls internal`） | もう片方の製品の名前 |
| 自分の API とファイルへの振り分け（`127.0.0.1:<自分のポート>`） | 80 番・443 番以外の待ち受け |

**IP の形（機械の認証局）は、その製品だけを入れる機械でしか使えない。** 同じ IP に 2 つの製品を名前なしで並べられないため。一緒に入れるときは、両方とも名前の形にする。

## 製品ごとに分けるもの

| もの | M2Office | M2Medical（M2Medical の仕様書で決める） |
|---|---|---|
| 置き場 | `/Library/M2Office` | `/Library/M2Medical` など。`/Library/M2Office` と `/Library/M2Front` の中に書かない |
| OS の利用者 | `_m2office` | 自分の専用の利用者 |
| launchd の名前 | `jp.m2office.*` | `jp.m2medical.*` など。`jp.m2office.*` と `jp.m2front.*` を使わない |
| 機械の中のポート | API 3101・データベース 5433（既定） | ぶつからないものを使う |
| データベース | 自分の PostgreSQL（データの置き場・ポート・利用者を分ける） | 同じ |
| 控えと鍵 | 自分で取り、鍵も分ける | 同じ |
| 更新 | 自分の `update.sh`。入口と Caddy には触れない | 同じ。夜の自動の更新の時刻は、M2Office（既定 3 時）とずらす |

## ローカル AI

- 1 つ（例 Ollama の `http://127.0.0.1:11434/v1`）を両方で使う。どちらの製品の更新も、ローカル AI を止めたり入れ替えたりしない。
- 機械のメモリーは、両方の利用と AI のモデルを合わせて見積もる（仕様書 Q-159）。

## 遠隔の保守

Tailscale の保守のトンネルを開けると、技術者は**機械全体**に入れる。患者の情報がある機械では、守りの厳しい側に合わせる。

- **M2Medical がある機械では、遠隔の保守を開けられるのは M2Medical の管理者だけにする。**
- M2Medical のセットアップは、遠隔の保守を入れるかどうかにかかわらず、`/Library/M2Front/maintenance-owner` に `M2Medical` と書く（1 行。読めるように 644）。
- M2Office は、このファイルにほかの製品の名前があれば、
  - セットアップで遠隔の保守を尋ねず、Tailscale を登録しない
  - 開け閉めの見回り（`jp.m2office.maintenance`）を入れていても、Tailscale に触れない（M2Medical が開けたトンネルを閉じない）
  - 管理者ページの「機械」に「M2Medical の管理者が開けます」と出し、開けるボタンを出さない
- Tailscale の常駐（`tailscaled`）は機械に 1 つ。登録と開け閉めは、遠隔の保守を持つ製品だけが行う。

## M2Medical の側で行うこと（M2Medical の作業）

1. このディレクトリ（`deploy/front/`）を写す。
2. セットアップで、自分の名前の設定を作って `front.sh put-site m2medical …` で置く。
3. セットアップで `/Library/M2Front/maintenance-owner` に `M2Medical` と書く。
4. 上の「製品ごとに分けるもの」に従って、置き場・利用者・launchd の名前・ポートを決める。
5. 遠隔の保守の開け閉めは、M2Medical の管理者の画面と見回りで行う（M2Office の `deploy/onsite/maintenance.sh` を写してよい）。

## 試す

`M2_FRONT_DIR` で置き場を変えると、管理者の権限なしで走る（機械は変えない）。単体テスト（`npm test`）が、偽の `caddy` と `launchctl` で確かめる。

```bash
M2_FRONT_DIR=/tmp/front M2_FRONT_PLIST_DIR=/tmp/front-plist M2_FRONT_LAUNCHCTL=/usr/bin/true \
  deploy/front/front.sh put-site m2office <設定のファイル> --caddy <caddy の道>
```
