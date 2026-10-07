# ローカルの形の配備（Mac mini・Mac Studio）

会社の中の LAN の 1 台に、その会社だけの M2Office を入れるための雛形です（仕様書 第8.6.1節〜第8.6.9節、ADR-0077）。
ソースはクラウドと同じで、`npm run build:release` で作った本番の組み立て（第20.4.5節）を Mac に置き、launchd で動かします。

**いまの段階**: 本番の組み立て、入口・起動・環境変数の雛形、管理者ページの「機械」と毎晩の控えまで。署名つきの `.pkg`・導入の道具（雛形の `{{…}}` を埋める）・
同梱する実行環境（Node.js・PostgreSQL・Caddy）・更新・遠隔の保守・稼働の知らせは次の段で作ります。

## 置き場所

| 道 | 中身 |
|---|---|
| `/Library/M2Office/app/` | 本番の組み立て（`dist-release/` の中身）。`server/api.js`・`server/worker.js`・`web/`・`docs/`・`db/migrations/` |
| `/Library/M2Office/app/runtime/` | 同梱する実行環境（`node/`・`postgres/`・`caddy/`。次の段） |
| `/Library/M2Office/app/m2office.env` | 環境変数（`m2office.env.template` から作る。専用の利用者と管理者だけが読める） |
| `/Library/M2Office/app/Caddyfile` | 入口の設定（`Caddyfile.template` から作る） |
| `/Library/M2Office/front.d/` | 同じ機械の M2Medical などの入口の設定（名前で分ける。第8.6.9節） |
| `<データのディスク>/M2Office/` | データ（`postgres/`・`files/`・`logs/`・`caddy/`）。導入のときに選んだディスク（RAID など） |
| `/Library/LaunchDaemons/jp.m2office.*.plist` | 起動の設定（`launchd/` の雛形から作る） |

## 雛形の `{{…}}`

| 名前 | 中身 |
|---|---|
| `HOST` | 会社のドメインの名前（例 `office.<会社のドメイン>`）。社内の IP に向ける（第8.6.2節） |
| `SUBDOMAIN` | 入っている 1 社のサブドメイン（`M2O_ONSITE_TENANT`） |
| `APP_ROOT`・`DATA_DIR` | 上の置き場所 |
| `BACKUP_DIR` | 控えの置き場（RAID とは別のディスク。外付けのディスクか社内の別の機械。第8.6.5節） |
| `API_PORT`・`DB_PORT` | 社内の機械の中だけで使うポート（例 3101・5432） |
| `ACME_EMAIL`・`DNS_PROVIDER`・`DNS_TOKEN` | 公的な証明書を DNS で取るための連絡先と、DNS の事業者のつなぎ |
| `SECRET_KEY`・`DB_APP_PASSWORD`・`DB_OWNER_PASSWORD` | 機械の上で作る秘密の値（運営は知らない） |
| `GEMINI_API_KEY`・`GOOGLE_LOGIN_CLIENT_ID`・`GOOGLE_LOGIN_CLIENT_SECRET`・`LOCAL_LLM_MODEL` | 会社の鍵と、ローカル AI のモデル |

## 組み立てと確かめ（開発の機械で）

```bash
npm run build:release -- --install
```

組み立てたものは、開発のデータベースで次のように動かして確かめられます（開発用ログインのまま）。

```bash
cd dist-release && M2O_APP_ROOT=$PWD API_PORT=3201 node --env-file=../.env server/api.js
```

```bash
API_URL=http://localhost:3201 npm run smoke
```
