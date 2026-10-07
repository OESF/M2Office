# ローカルの形の導入（Mac mini・Mac Studio）

会社の中の LAN の 1 台に、その会社だけの M2Office を入れる手順です（仕様書 第8.6.1節〜第8.6.9節、ADR-0077）。
**入れるのは技術者（運営かパートナーの SIer）です。** 利用者が自分で入れることは想定していません。
画面はすべて Web なので、Mac のアプリの形（`.pkg`）にはしません。GitHub のリリースのタグを取ってきて、対話式のスクリプトで入れます。

## 前もって用意するもの

| もの | 内容 |
|---|---|
| Mac | macOS。管理者の利用者でログインできること。ローカル AI を使うなら、メモリーの多い Mac Studio など（Q-159） |
| Homebrew | https://brew.sh の手順で入れておく。Node.js 22・PostgreSQL 17 と pgvector・Caddy は、セットアップのスクリプトが尋ねてから入れる |
| ディスク | データの置き場（RAID など）と、**RAID とは別の**控えの置き場（外付けのディスクか社内の別の機械。第8.6.5節） |
| 名前 | 会社のドメインの名前（例 `office.<会社のドメイン>`）。公開の DNS に、機械の社内の IP を返す A レコードを書く（第8.6.2節） |
| DNS の鍵 | 公的な証明書を DNS で取るための、DNS の事業者の API の鍵（Cloudflare・Route 53 など。caddy-dns に対応しているもの） |
| Google | 会社の Google Workspace の管理者の協力。会社の OAuth クライアント（「内部」）を作る。後から管理者ページの「接続」でも入れられる |
| ローカル AI | 使うなら、OpenAI 互換の口で動かしておく（例 Ollama の `http://127.0.0.1:11434/v1`）。埋め込みのモデル（768 次元。例 EmbeddingGemma）も入れると、知識の意味の検索に使える |

## 入れる

```bash
sudo mkdir -p /Library/M2Office && sudo chown "$USER" /Library/M2Office
git clone --branch v0.18.0 https://github.com/OESF/M2Office.git /Library/M2Office/app   # リリースのタグ（setup.sh は v0.18.0 から）
/Library/M2Office/app/deploy/onsite/setup.sh
```

- 会社ごとの手直しが要るときは、GitHub で fork し、その fork から取ってくる。
- 取ってくるのは**リリースのタグ**（`v` で始まる版）。開発中の枝は入れない（スクリプトが確かめる）。
- `setup.sh` は `sudo` を付けずに、管理者の利用者で走らせる。要るところだけ `sudo` を使う。

聞かれること:

| 区分 | 尋ねること |
|---|---|
| 会社と名前 | 会社の名前・会社の短い名前（サブドメイン）・Google Workspace のドメイン・最初の管理者のメールアドレス・M2Office を開く名前 |
| 証明書 | 形（`name`: DNS で公的な証明書。標準 ／ `ip`: 機械の認証局。Google を使わない会社だけ）・DNS の事業者と鍵・連絡先 |
| 置き場 | データの置き場・控えの置き場・API とデータベースのポート |
| AI | ローカル AI の口とモデル・埋め込みのモデル・Gemini の鍵（外部の AI を使う会社だけ） |
| Google のログイン | 会社の OAuth クライアントの ID とシークレット（後でもよい） |
| 更新 | 署名を確かめる鍵のファイル（`allowed_signers`）・夜に自動で更新するか・時刻 |

スクリプトが行うこと: 前提のソフトを入れる → 秘密の値を機械の上で作る（運営は知らない）→ 専用の利用者 `_m2office` を作る →
設定のファイルを雛形から作る → データベースを作り pgvector を有効にする → 本番の組み立て → データベースの移行 → 会社と最初の管理者を作る →
launchd で動かす → 動きを確かめる（API・ワーカー・入口と証明書・ローカル AI）→ 残りの作業と、紙の「戻すための控え」に書く秘密の値を出す。

**何度走らせてもよい。** 答えは `setup.conf` に残り、次に走らせたときの既定になる。秘密の値・データベース・会社は作り直さない。
答えを変えたいとき（控えの置き場を足す・Google のクライアントを入れるなど）は、走らせ直して変えたところだけを答える。

## 置き場所

| 道 | 中身 |
|---|---|
| `/Library/M2Office/app/` | GitHub から取ってきたプログラム（技術者の利用者のもの）。`dist-release/` に本番の組み立て |
| `/Library/M2Office/m2office.env` | 環境変数と秘密の値（root と `_m2office` だけが読める） |
| `/Library/M2Office/Caddyfile` | 入口の設定（DNS の鍵を含むため root だけが読める） |
| `/Library/M2Office/setup.conf` | 答えの控え（秘密の値は入れない。`update.sh` も読む） |
| `/Library/M2Office/allowed_signers` | 更新のタグの署名を確かめる鍵（入れたときのものに固定する） |
| `/Library/M2Office/front.d/` | 同じ機械の M2Medical などの入口の設定（名前で分ける。第8.6.9節） |
| `<データの置き場>/` | `postgres/`・`files/`・`logs/`・`caddy/`・`machine/`（`_m2office` のもの） |
| `/Library/LaunchDaemons/jp.m2office.*.plist` | 起動の設定（`launchd/` の雛形から作る。api・worker・postgres・caddy と、自動の更新の update） |

## 更新

```bash
sudo /Library/M2Office/app/deploy/onsite/update.sh           # いちばん新しいリリースのタグを入れる
sudo /Library/M2Office/app/deploy/onsite/update.sh --check   # 新しいタグがあるかだけを見る
sudo /Library/M2Office/app/deploy/onsite/update.sh --tag v0.19.0
```

- タグの**署名を確かめてから**入れる（運営の SSH の署名。`git verify-tag`）。鍵が入っていない機械では、手で `--allow-unsigned` を付けたときだけ入れる。自動の更新は鍵が要る。
- 流れ: 控えを取る → 止める → タグに切り替えて組み立て直す → データベースの移行 → 動かす → 確かめる。失敗したら前のタグと更新の前の控えに戻す。
- 結果は管理者ページの「機械」の「更新」に出る。失敗したら会社の管理者に知らせが届く。会社の管理者は「機械」で自動の更新を延ばせる。
- `brew upgrade caddy` をすると、Caddy に足した DNS の事業者のつなぎが外れる。そのときは `setup.sh` を走らせ直す（足し直す）。

## 運営: リリースのタグに署名する

ローカルの形の機械は、署名のあるタグだけを自動で入れる。運営は SSH の鍵でタグに署名する。

```bash
git config gpg.format ssh
git config user.signingkey ~/.ssh/<署名の鍵>.pub
git tag -s v0.19.0 -m "Version 0.19.0 — …"
```

機械に入れる `allowed_signers` は、`<メールアドレス> namespaces="git" <公開鍵>` の 1 行。導入のときに技術者が入れ、`setup.sh` が `/Library/M2Office/allowed_signers` に固定する。

## 試す（開発の機械で）

雛形を埋めた結果だけを作って確かめられる（機械は変えない）。単体テスト（`npm test`）が同じことを行う。

```bash
deploy/onsite/setup.sh --render-only /tmp/m2o-onsite --answers <KEY=値 のファイル>
```

本番の組み立ては、開発のデータベースで次のように動かして確かめられる（開発用ログインのまま）。

```bash
npm run build:release -- --install
cd dist-release && M2O_APP_ROOT=$PWD API_PORT=3201 node --env-file=../.env server/api.js
API_URL=http://localhost:3201 npm run smoke
```
