# クラウドの形の導入（Xserver の VPS）

多くの会社が入るクラウドの形の M2Office を、Xserver の VPS（Ubuntu 24.04 か 26.04 LTS）に入れる手順と雛形です（仕様書 第20.4.6節、ADR-0113）。
第 1 弾は **VPS だけで守ります**。入口は Caddy（Let's Encrypt の証明書・Coraza の WAF）、攻撃する相手を止めるのは CrowdSec、保守の SSH と運営の画面は VPS に立てた WireGuard の網からだけ通します。
大量の通信の攻撃を受けたときは、Cloudflare をあとから前に置きます（`CLOUDFLARE_FRONT=yes`）。

手順の全体は運営のマニュアルにあります。

| 章 | 中身 |
|---|---|
| [第 13 章 VPS の用意](../../docs/ops-manual/13-vps-setup.md) | OS の固め・スワップ・WireGuard（`setup.sh` の前に終える） |
| [第 14 章 M2Office のセットアップ](../../docs/ops-manual/14-vps-m2office-setup.md) | 入口の守りの考え方と、`setup.sh` の走らせ方 |

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
| `Caddyfile.template` | 入口。会社のサブドメイン（On-Demand TLS。払い出した名前だけ証明書を取る）・運営の画面（WireGuard の網からだけ）・紹介のページと Google からの戻り |
| `cloudflare-front.caddy` | Cloudflare を前に置いたときに、Cloudflare 以外からの通信を断る段 |
| `m2office.env.template` | 環境変数（`/etc/m2office/m2office.env`。root と `m2office` だけが読める） |
| `systemd/*.service` | API・ワーカー・運営の API。メモリの上限と守りの設定つき |
| `crowdsec/acquis-m2office.yaml` | CrowdSec に Caddy のアクセスのログを読ませる設定 |

雛形の埋め方は、ローカルの形と同じ `deploy/onsite/render.mjs` を使います。機械を変えずに埋めた結果だけを見るときは、次のようにします。

```bash
deploy/vps/setup.sh --render-only <出力先> --answers <KEY=値 のファイル>
```

## 置き場所

| 道 | 中身 |
|---|---|
| `/opt/m2office/app` | 取ってきたリリースのタグ。組み立ては `dist-release/` |
| `/etc/m2office/` | 環境変数（`m2office.env`）と答え（`setup.conf`） |
| `/var/lib/m2office/` | ファイル（`files/`）・機械の様子（`machine/`）・紹介のページ（`site/`） |
| `/var/log/m2office/` | アプリのログ |
| `/var/log/caddy/` | 入口のアクセスのログと WAF の記録（CrowdSec が読む） |

## まだ入れていないもの

控え（pgBackRest・restic）と、夜の自動の更新（`update.sh`）は、まだこの雛形にありません。仕様書 第20.4.6節の「控え」「更新」に沿って足します。
