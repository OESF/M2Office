# 第 17 章 控えと復旧

この章は、クラウドの形（VPS）のデータの控えと、いざというときに戻す手順です（仕様書 第20.4.6節「控え」、ADR-0120）。
**サーバーが止まると、画面のヘルプは読めません。** この章は印刷した PDF（「8. 印刷して保管する」）で読めるようにしておきます。

手順書に無いことは、運営に確かめてから行います。迷ったら、まず止めて（データを守って）から相談します。

## 1. まず見る表（いざというとき）

| 起きたこと | まずすること | 手順 |
|---|---|---|
| 稼働状況の「社外の控え」が「取れています」以外 | 理由を読み、技術者に連絡する。データは失われていない | 3.1 |
| 「変更の記録を送れていません」 | **急ぐ**。送れない記録がたまってディスクを埋める | 3.2 |
| 更新（`update.sh`）に失敗した | 多くは自動で前の版に戻る。戻らなければ更新の前の戻す点へ | 3.3 |
| データを誤って消した・壊した（全社） | 書き込みを止め、戻す時刻を決める。**全社がその時刻に戻る** | 3.4 |
| 1 社だけのデータを戻したい | 全体は戻さない。運営と開発に相談する | 3.5 |
| VPS が壊れた・起動しない・なくした | 新しい VPS を用意して戻す | 3.6 |
| 乗っ取り・ランサムウェアを疑う | **切り離す → Google Cloud の鍵を無効にする → 新しい VPS に戻す** | 3.7 |

会社に影響が出るときは、どの場合も「障害の知らせ」（[第 14 章](14-incidents.md)）で対象の会社の管理者に知らせます。

## 2. 控えの仕組み

| 何を | どこへ | どれだけ残すか | いつ |
|---|---|---|---|
| データベースのまるごとの控え（pgBackRest） | Google Cloud Storage の東京のバケット（`pgbackrest/`） | 14 日分 | 毎晩 2 時すぎ |
| データベースの変更の記録（WAL） | 同じ | まるごとの控えと同じ期間 | 絶えず（5 分ごとに区切る） |
| ファイル（画像・書類など。restic） | 同じバケット（`restic/`） | 30 日分 | 毎晩 2 時すぎ |
| 更新の前のデータベース（`pg_dump`） | VPS の中（`/var/backups/m2office/pre-update/`。root だけが読める） | 直近の 3 回 | 更新のたび |

- データベースは、**戻せる範囲の中のどの時刻にも戻せます**。失うのは直前の数分までです
- どれも VPS の上で暗号化してから送ります。**合言葉の紙が無いと、誰も開けません**（運営も Google も）
- バケットでは、消されたものも **30 日のうちなら戻せます**（削除（復元可能））。VPS の鍵ではこの設定を変えられません
- 月に 1 回、控えが壊れていないかを自動で確かめます

### 誰が何を持つか

| もの | 持つ人 | 置き場 |
|---|---|---|
| 合言葉の紙（データベースの控え・ファイルの控え・預かった鍵を開ける鍵・バケットの名前とプロジェクトの ID） | 運営 | 金庫など。**この手順書の印刷とは別の場所** |
| Google Cloud の管理者のアカウント（2 段階の認証） | 運営 | バックアップコードも紙で保管する |
| VPS 用のサービスアカウントの鍵 | VPS の中だけ（`/etc/m2office/backup/gcs-key.json`） | 運営の端末には残さない |
| この手順書の印刷 | 運営と提携先の技術者 | すぐ手に取れる場所 |

## 3. 起きたことごとの手順

### 3.1 控えに失敗した・止まっている

稼働状況の「社外の控え」が「失敗しました」「止まっています」のとき。データは失われていません（前の控えと変更の記録は残っています）。

1. 稼働状況の表の理由を読みます
2. 技術者が VPS で確かめます

```bash
sudo m2office-backup --status
sudo journalctl -u m2office-backup --since today
sudo systemctl start m2office-backup     # 直したら、いま取り直す
```

| よくある理由 | 直し方 |
|---|---|
| 権限が無い・鍵が違う（403・401） | Google Cloud の画面で、サービスアカウントの鍵が無効になっていないか、バケットの権限が残っているかを見る |
| バケットが見つからない（404） | バケットの名前（`/etc/m2office/backup.env`）を確かめる |
| ディスクが足りない | 稼働状況の「機械の資源」でディスクを見る。古いログを消すか、容量を足す |
| 「止まっています」（26 時間より古い） | `systemctl status m2office-backup.timer` で、時刻の仕掛けが動いているかを見る |

### 3.2 変更の記録を送れていない

**急ぎます。** 送れない変更の記録は VPS のディスクにたまり、ディスクが埋まるとデータベースが止まります。

1. 3.1 と同じく、理由を確かめて直します。送れているかは、次で確かめます

```bash
sudo -u postgres pgbackrest --stanza=m2office check
sudo tail -50 /var/log/pgbackrest/m2office-archive-push.log
```

2. すぐに直せず、ディスクが 90% を超えそうなときだけ、**運営に確かめてから**、一時的に送るのを止めます。止めている間は、どの時刻にも戻せる仕組みが途切れます

```bash
cd / && sudo -u postgres psql -c "alter system set archive_command = '/bin/true'" -c 'select pg_reload_conf()'
```

3. 直したら元に戻し、すぐにまるごとの控えを取ります

```bash
cd / && sudo -u postgres psql -c 'alter system reset archive_command' -c 'select pg_reload_conf()'
sudo systemctl start m2office-backup
```

### 3.3 更新に失敗した

`update.sh` は、組み立て・データベースの移行・動きの確かめのどれかで失敗すると、**自動で前の版と更新の前のデータベースに戻します**（[第 13 章](13-vps-m2office-setup.md) 手順 8）。記録は `/var/log/m2office/update.log` です。

自動で戻らなかった・戻した後も動かないときは、更新の前の戻す点へデータベースを戻します。戻す点の名前は、稼働状況の「社外の控え」の「更新の前の戻す点」に出ます（例: `update-v0.28.0`）。手順は 4.1 の「名前を付けた点へ」です。前の版のプログラムには、前の版のタグで `update.sh --tag <前の版>` を走らせて戻します。

### 3.4 データを誤って消した・壊した（全社を戻す）

**データベースを過去の時刻に戻すと、すべての会社がその時刻に戻ります。** その後に入れたデータは、すべての会社で消えます。戻すかどうかは運営管理者が決めます。

1. 何が・いつ起きたかを、システムログ（[第 11 章](11-system-logs.md)）と会社への聞き取りで確かめ、**起きる直前の時刻**を決めます
2. 戻す時刻が稼働状況の「データベースを戻せる範囲」の中にあるかを見ます
3. 障害の知らせ（[第 14 章](14-incidents.md)）で、止めることと、戻す時刻を知らせます
4. 4.1 の「決めた時刻へ」で戻します

### 3.5 1 社だけのデータを戻したい

全体を戻すと、ほかの会社のデータまで巻き戻ります。**1 社だけを戻す道具は、まだありません。**
運営と開発に相談します。開発は、使い捨ての VPS に控えを戻し（3.6 と同じ手順）、その会社の必要なデータだけを取り出します。

### 3.6 VPS が壊れた・なくした（新しい VPS に戻す）

用意するもの: 合言葉の紙、Google Cloud の管理者のアカウント、Xserver の管理画面、この手順書。

1. **新しい VPS を用意します**（[第 12 章](12-vps-setup.md)）
2. **Google Cloud で新しい鍵を作ります。** 古い鍵は無効にします（運営の端末で）

```bash
gcloud iam service-accounts keys list --iam-account=m2office-backup@<プロジェクトの ID>.iam.gserviceaccount.com --managed-by=user
gcloud iam service-accounts keys disable <古い鍵の ID> --iam-account=m2office-backup@<プロジェクトの ID>.iam.gserviceaccount.com
gcloud iam service-accounts keys create m2office-backup-key.json --iam-account=m2office-backup@<プロジェクトの ID>.iam.gserviceaccount.com
```

3. **M2Office を入れます**（[第 13 章](13-vps-m2office-setup.md) 手順 2・3）。このとき、**社外の控えのバケットの名前は空のまま**進めます（先に答えると、空のデータベースで控えの置き場を作ろうとして失敗します）
4. **止めて、鍵と設定を置きます**

```bash
sudo systemctl stop m2office-api m2office-worker m2office-ops
sudo install -d -m 750 -o root -g postgres /etc/m2office/backup /etc/pgbackrest
sudo install -m 640 -o root -g postgres ~/m2office-backup-key.json /etc/m2office/backup/gcs-key.json && rm ~/m2office-backup-key.json
sudo install -d -m 770 -o postgres -g postgres /var/log/pgbackrest /var/spool/pgbackrest
sudo nano /etc/pgbackrest/pgbackrest.conf
```

`pgbackrest.conf` には次を書きます。`<…>` は紙の値です。

```ini
[global]
repo1-type=gcs
repo1-gcs-bucket=<バケットの名前>
repo1-gcs-key=/etc/m2office/backup/gcs-key.json
repo1-gcs-key-type=service
repo1-path=/pgbackrest
repo1-cipher-type=aes-256-cbc
repo1-cipher-pass=<データベースの控えの合言葉>
repo1-retention-full-type=time
repo1-retention-full=14
compress-type=zst
start-fast=y
process-max=2
log-level-console=warn
log-level-file=info

[m2office]
pg1-path=/var/lib/postgresql/17/main
```

```bash
sudo chown root:postgres /etc/pgbackrest/pgbackrest.conf && sudo chmod 640 /etc/pgbackrest/pgbackrest.conf
```

5. **データベースを戻します**（4.1。いちばん新しい時点へ）
6. **預かった鍵を開ける鍵を戻します。** `/etc/m2office/m2office.env` の `M2OFFICE_SECRET_KEY=` を、紙の値に書き換えます

```bash
sudo nano /etc/m2office/m2office.env
```

7. **ファイルを戻します**（4.2）。その前に `/etc/m2office/backup.env` を作ります

```bash
sudo nano /etc/m2office/backup.env && sudo chmod 600 /etc/m2office/backup.env
```

```ini
RESTIC_REPOSITORY=gs:<バケットの名前>:/restic
RESTIC_PASSWORD=<ファイルの控えの合言葉>
RESTIC_CACHE_DIR=/var/cache/m2office-restic
GOOGLE_PROJECT_ID=<プロジェクトの ID>
GOOGLE_APPLICATION_CREDENTIALS=/etc/m2office/backup/gcs-key.json
M2O_FILES_DIR=/var/lib/m2office/files
```

8. **セットアップを走らせ直します。** 今度はバケットの名前・プロジェクトの ID を答え、鍵の場所は空のまま Enter（置いた鍵を使う）。紙の合言葉と鍵がそのまま使われ、データベースの利用者の合言葉が新しい設定にそろい、控えが再び動き出します

```bash
/opt/m2office/app/deploy/vps/setup.sh
```

9. **名前を新しい VPS に向けます。** IP アドレスが変わったら、DNS（Xserver）の `m2office.net` と `*.m2office.net` を新しい IP に向け、運営者の端末の WireGuard と hosts を直します（[第 12 章](12-vps-setup.md)・[第 13 章](13-vps-m2office-setup.md)）
10. **確かめます**（5 章）

### 3.7 乗っ取り・ランサムウェアを疑う

**乗っ取られた VPS を直して使い続けません。** 新しい VPS に、乗っ取られる前の時刻で戻します。

1. **切り離す**: Xserver の管理画面で VPS を止める（またはパケットフィルターで外からの通信を全部止める）。証拠のため、VPS は消さずに残します
2. **Google Cloud の鍵を無効にする**（運営の端末で。3.6 の 2 の `keys disable`）。乗っ取った人が控えを消し続けられないようにします
3. **控えが消されていないかを見る**。消されていれば、乗っ取られた時刻より後に消されたものを戻します（数分かかります）

```bash
gcloud storage ls --soft-deleted --recursive 'gs://<バケットの名前>/**' | head
gcloud storage restore 'gs://<バケットの名前>/**' --async --deleted-after-time=<乗っ取られた時刻。例 2026-11-01T01:00:00Z>
gcloud storage operations describe <Created: の後の名前> --format='value(done)'
```

4. **新しい VPS に戻す**（3.6）。データベースは、**乗っ取られる前の時刻**へ戻します（4.1 の「決めた時刻へ」）
5. **鍵と合言葉を入れ替える**: Google のログインの OAuth クライアントの秘密、Gemini の鍵、WireGuard の鍵、運営者のパスキー（必要なら）。控えの合言葉が漏れた恐れがあれば、運営と相談する
6. **知らせる**: 障害の知らせ（[第 14 章](14-incidents.md)）で会社に知らせます。個人情報が漏れた恐れがあれば、個人情報保護委員会への報告と本人への通知が要るかを、運営が判断します（報告は速やかに。おおむね 3〜5 日のうちに速報）
7. **記録する**: 気づいた時刻・したこと・戻した時刻を残します（6 章）

## 4. 戻す手順

### 4.1 データベース（pgBackRest）

止めてから戻します。`--delta` は、いまあるファイルを使って違うところだけを書き換えます。

```bash
sudo systemctl stop m2office-api m2office-worker m2office-ops
sudo systemctl stop postgresql
```

いずれか 1 つを走らせます。

```bash
# いちばん新しい時点へ（VPS をなくしたとき）
sudo -u postgres pgbackrest --stanza=m2office --delta restore
# 決めた時刻へ（日本時間なら +09 を付ける）
sudo -u postgres pgbackrest --stanza=m2office --delta --type=time --target="2026-11-01 10:00:00+09" --target-action=promote restore
# 名前を付けた点へ（更新の前。名前は稼働状況の「更新の前の戻す点」）
sudo -u postgres pgbackrest --stanza=m2office --delta --type=name --target=update-<版> --target-action=promote restore
```

- `--target-action=promote` を**必ず付けます**。付けないと、戻した後も読むだけの状態で止まります
- 戻せる時刻は、稼働状況の「データベースを戻せる範囲」の中だけです。控えの一覧は `sudo -u postgres pgbackrest --stanza=m2office info` で見られます

```bash
sudo systemctl start postgresql
cd / && sudo -u postgres psql -tAc 'select pg_is_in_recovery()'    # f になるまで待つ（変更の記録を読み終えるまで数分かかることがある）
sudo systemctl start m2office-api m2office-worker m2office-ops
sudo systemctl start m2office-backup     # 戻した後の新しいまるごとの控えを取る
```

### 4.2 ファイル（restic）

```bash
sudo bash -c 'set -a; . /etc/m2office/backup.env; restic snapshots'
sudo bash -c 'set -a; . /etc/m2office/backup.env; restic restore latest --target /var/tmp/m2o-restore'
sudo rsync -a /var/tmp/m2o-restore/var/lib/m2office/files/ /var/lib/m2office/files/ && sudo chown -R m2office:m2office /var/lib/m2office/files
sudo rm -rf /var/tmp/m2o-restore
```

- `latest` の代わりに、`restic snapshots` の ID（8 文字）で前の回を選べます
- データベースを過去の時刻に戻したときは、ファイルもその時刻の前の回を選びます（ファイルは毎晩の回だけです）

### 4.3 更新の前のデータベース（VPS の中の控え）

社外の控えが使えないときの、もう 1 つの道です。更新の直前の状態だけに戻せます。

```bash
sudo ls -lt /var/backups/m2office/pre-update/
```

`update.sh` が失敗したときに自動で使うものです。手で使うときは、技術者が運営に確かめてから `pg_restore --clean --if-exists --no-owner` で戻します。

## 5. 戻した後に確かめること

- [ ] `curl -fsS http://127.0.0.1:3101/health` と `curl -fsS http://127.0.0.1:3102/health` が応える
- [ ] マスター管理画面の稼働状況で、ワーカーが「動いています」、待ち行列が詰まっていない
- [ ] 会社一覧の会社の数と、主な会社の最後の利用の日時が、戻した時刻と合う
- [ ] 1 社の画面で、画像や書類（ファイル）が開ける
- [ ] 会社の管理者に、Google の接続が「接続中」のままかを確かめてもらう（開けないなら、預かった鍵を開ける鍵が戻っていない。3.6 の 6）
- [ ] 稼働状況の「社外の控え」が「取れています」になり、「変更の記録」の最後に送った時刻が新しい
- [ ] 障害の知らせで、終わったことを会社に知らせた

## 6. 記録

起きたことごとに、次を残します（運営の決めた置き場に。提携先は報告書に）。

| 項目 | 例 |
|---|---|
| 気づいた日時と、気づいたきっかけ | 2026-11-01 09:10、稼働状況の「失敗しました」 |
| 影響（会社・止まった時間・失ったデータ） | 全社、40 分、10:00〜10:05 の入力 |
| したことと、それぞれの時刻 | 10:12 停止、10:20 決めた時刻へ戻す…… |
| 戻した時刻・使った控え | 10:00（`--type=time`）、ファイルは 11/1 2:05 の回 |
| 原因と、繰り返さないための手当て | |

## 7. 戻す練習

| 練習 | 間隔 | 誰が | 何をする |
|---|---|---|---|
| 新しい VPS に戻す | 3 か月に 1 回 | 提携先の技術者 | 使い捨ての VPS に 3.6 の手順で戻し、5 章の確かめをする。終わったら使い捨ての VPS を消し、その鍵を無効にする |
| ソフト削除から戻す | 年に 1 回 | 運営 | バケットの試しの置き場で、消したものを時刻を付けて戻す |
| 合言葉の紙の確かめ | 年に 1 回 | 運営 | 紙の合言葉で控えを開けるかを、練習の中で確かめる |

練習のたびに、この手順書と違ったところを直します。

2026-10-31 に、本物のバケットで restic の控え・戻し・ソフト削除からの戻しを確かめました。**pgBackRest で戻す手順と、新しい VPS に戻す手順（3.6）は、まだ通していません。** 最初の練習で確かめて、この章を直します。

## 8. 印刷して保管する

画面のヘルプは、サーバーが動いているときしか読めません。次の 2 つを PDF にして印刷し、手元に置きます。

| 印刷するもの | 作り方 | 中身 |
|---|---|---|
| 控えと復旧の手順書（薄い） | `npm run docs:ops-recovery-pdf`（`docs/ops-manual/ops-recovery.pdf`） | この章と、第 12 章・第 13 章（新しい VPS を用意して入れる手順） |
| 運営者マニュアル（全部） | `npm run docs:ops-manual-pdf`（`docs/ops-manual/ops-manual.pdf`） | すべての章 |

- 表紙に、対応する仕様書の版と作った日が入ります。**リリースのたびに作り直し**、この章・第 12 章・第 13 章が変わった版では刷り直して、古い印刷は捨てます
- 合言葉の紙とは**別の場所**に置きます（両方を一度になくさないように）
- 下の連絡先の表は、印刷してから手で書き込みます

### 連絡先（印刷したら書き込む）

| 相手 | 名前 | 電話・メール |
|---|---|---|
| 運営管理者 | | |
| 提携先の技術者（24 時間） | | |
| Xserver（VPS・DNS）のサポート | | |
| Google Cloud の請求先の管理者 | | |
