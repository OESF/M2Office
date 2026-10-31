# クラウドの形の導入（Xserver の VPS）

多くの会社が入るクラウドの形の M2Office を、Xserver の VPS（Ubuntu 24.04 か 26.04 LTS）に入れる手順と雛形です（仕様書 第20.4.6節、ADR-0113）。
第 1 弾は **VPS だけで守ります**。入口は Caddy（Let's Encrypt の証明書・Coraza の WAF）、攻撃する相手を止めるのは CrowdSec、保守の SSH と運営の画面は VPS に立てた WireGuard の網からだけ通します。
大量の通信の攻撃を受けたときは、Cloudflare をあとから前に置きます（`CLOUDFLARE_FRONT=yes`）。

手順の全体は運営のマニュアルにあります。

| 章 | 中身 |
|---|---|
| [第 12 章 VPS の用意](../../docs/ops-manual/12-vps-setup.md) | OS の固め・スワップ・WireGuard（`setup.sh` の前に終える） |
| [第 13 章 M2Office のセットアップ](../../docs/ops-manual/13-vps-m2office-setup.md) | 入口の守りの考え方と、`setup.sh` の走らせ方 |

## 入れる

```bash
sudo mkdir -p /opt/m2office && sudo chown "$USER" /opt/m2office
git clone --branch <リリースのタグ> https://github.com/OESF/M2Office.git /opt/m2office/app
/opt/m2office/app/deploy/vps/setup.sh
```

- `setup.sh` は `sudo` を付けずに、自分の名前の利用者で走らせる。要るところだけ `sudo` を使う。
- 取ってくるのは**リリースのタグ**（`v` で始まる版）。開発中の枝は入れない（スクリプトが確かめる）。
- 何度走らせてもよい。答えは `/etc/m2office/setup.conf` に残り、次の既定になる。秘密の値とデータベースは作り直さない。

## ファイル

| ファイル | 中身 |
|---|---|
| `setup.sh` | ソフト（Node.js 24・PostgreSQL 17 と pgvector・Caddy と Coraza・CrowdSec）を公式の置き場から入れ、専用の利用者 `m2office`・置き場・秘密の値・データベース・組み立て・移行・systemd・Caddy・CrowdSec を用意して、80・443 を開け、動きを確かめる |
| `Caddyfile.template` | 入口。会社のサブドメイン（On-Demand TLS。払い出した名前だけ証明書を取る）・運営の画面（WireGuard の網からだけ）・紹介のページ（公開前の確認のあいだは BASIC 認証）と Google からの戻り |
| `cloudflare-front.caddy` | Cloudflare を前に置いたときに、Cloudflare 以外からの通信を断る段 |
| `m2office.env.template` | 環境変数（`/etc/m2office/m2office.env`。root と `m2office` だけが読める） |
| `systemd/*.service` | API・ワーカー・運営の API。メモリの上限と守りの設定つき |
| `crowdsec/acquis-m2office.yaml` | CrowdSec に Caddy のアクセスのログを読ませる設定 |
| `geo/m2office-geo-update.sh` | 国で通信を止める（既定は中国・ロシア・北朝鮮）。地域インターネットレジストリの一覧から nftables の表 `m2office_geo` を作り、入ってくる通信と出ていく通信を断る。`setup.sh` が `/usr/local/sbin/m2office-geo-update` に入れる |
| `geo/*.service`・`geo/*.timer` | 起動のときに表を入れる（`m2office-geo`）・週に 1 回一覧を取り直す（`m2office-geo-update`） |
| `update.sh` | リリースのタグを入れる更新。控え（`pg_dump`）→ 社外の控えに戻す点を記録 → 止める → 切り替えて組み立て直す → 移行 → 動かす → 確かめる。失敗したら前の版と控えに戻す |
| `backup/m2office-backup.sh` | 社外の控え（Google Cloud Storage の東京。仕様書 第20.4.6節「控え」、ADR-0120）。データベースを pgBackRest で（まるごと。14 日分）、ファイルを restic で（30 日分）送り、月に 1 回壊れていないかを確かめる。結果は `/var/lib/m2office/machine/cloud-backup.json`（運営の画面の「稼働状況」）。`--status` で最後の結果、`--check` で確かめだけ。`setup.sh` が `/usr/local/sbin/m2office-backup` に入れる |
| `backup/*.service`・`backup/*.timer` | 毎晩 2 時すぎに社外の控えを取る（`m2office-backup`） |

雛形の埋め方は、ローカルの形と同じ `deploy/onsite/render.mjs` を使います。機械を変えずに埋めた結果だけを見るときは、次のようにします。

```bash
deploy/vps/setup.sh --render-only <出力先> --answers <KEY=値 のファイル>
```

## 置き場所

| 道 | 中身 |
|---|---|
| `/opt/m2office/app` | 取ってきたリリースのタグ。組み立ては `dist-release/` |
| `/etc/m2office/` | 環境変数（`m2office.env`）と答え（`setup.conf`）。社外の控えの設定（`backup.env`。root だけ）と鍵（`backup/gcs-key.json`） |
| `/etc/pgbackrest/pgbackrest.conf` | データベースの控えの設定（暗号化の合言葉を含む。root と postgres だけ） |
| `/etc/postgresql/17/main/conf.d/m2office-archive.conf` | 変更の記録（WAL）を絶えず送る設定 |
| `/var/lib/m2office/` | ファイル（`files/`）・機械の様子（`machine/`） |
| `/var/www/m2office-site/` | 紹介のページ（`m2office.net`・`www`） |
| `/var/backups/m2office/pre-update/` | 更新の前の控え（直近の 3 回。root だけが読める） |
| `/var/log/m2office/` | アプリのログと更新の記録（`update.log`） |
| `/var/log/caddy/` | 入口のアクセスのログと WAF の記録（CrowdSec が読む） |

## 更新する

```bash
sudo /opt/m2office/app/deploy/vps/update.sh --check
sudo /opt/m2office/app/deploy/vps/update.sh --tag <リリースのタグ> --allow-unsigned
```

- タグへの署名を始める v1.0 までは、`--allow-unsigned` を付けて技術者が手で入れる。v1.0 からは `/etc/m2office/allowed_signers` の鍵で署名を確かめ、夜の自動の更新も入れる。
- 雛形（`deploy/vps/`）が変わった版では、入れた後に `setup.sh` を走らせ直すよう示す。

## 社外の控え

Google Cloud Storage の東京に送ります。用意と戻し方は運営のマニュアル 第 13 章 手順 9 と「控えから戻す」です。`setup.sh` でバケットの名前を空のままにすると入れません。

## まだ入れていないもの

夜の自動の更新は v1.0 から入れます。
