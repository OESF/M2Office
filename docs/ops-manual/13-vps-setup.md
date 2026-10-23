# 第 13 章 VPS の用意（OS の初期設定）

クラウドの形の M2Office を置く VPS（Xserver の VPS・Ubuntu）を、**M2Office を入れる前に**固める手順です。配備する技術者（提携先の技術者を含む）が行います。
仕組みの考え方は仕様書 第20.4.6節（案）にあります。この章は、その「機械」と「資源の配分」の部分を、打つ命令に落としたものです。

**目指す形: インターネットから VPS に入る口を 1 つも開けない。** 利用者の通信は、あとで入れる Cloudflare Tunnel（VPS から外向きにつなぐ）で、保守の SSH は Tailscale（同じく外向き）で通します。この章を終えると、VPS には Tailscale からしか入れなくなります。

M2Office 本体（Node.js・PostgreSQL・Caddy・cloudflared と置き場所）は、この章では入れません。セットアップの手順（`deploy/vps/setup.sh`。これから作る）でまとめて入れます。

## 1. 用意するもの

| もの | 内容 |
|---|---|
| Xserver の VPS の管理画面に入れるアカウント | 運営が持つ。作業する人に、必要な権限だけを付ける |
| SSH の鍵 | 作業する人の手元の端末で作った鍵（ed25519）。公開鍵だけを VPS に登録する |
| 接続元の IP アドレス | 作業する人の場所のもの。Tailscale に移るまでの間だけ、SSH をこの IP に限って開ける |
| Tailscale のアカウント | 運営の Tailscale（tailnet）。作業する人を招く |

手元で SSH の鍵を作るときは、次のとおりです（すでにあれば要りません）。

```bash
ssh-keygen -t ed25519 -C "<自分の名前>-m2office-vps"
```

## 2. スペックと資源の配分

いまの VPS は **3 vCPU・メモリ 2 GB・NVMe SSD 50 GB** です（仕様書 Q-255）。

| 使い道 | 考え方 |
|---|---|
| 仮稼働（見本のデータで通しの確かめ） | このスペックで動く。下の配分とスワップ 4 GB が前提 |
| 本番（顧客を入れる） | **メモリ 4 GB 以上に上げてから**入れる。録音の文字起こし・PDF の組み立て・動画の書き出しが重なると 2 GB では足りない |

M2Office を入れるときの、メモリの割り当ての目安です（セットアップの手順で設定します）。

| もの | 割り当て |
|---|---|
| PostgreSQL | 約 512 MB（`shared_buffers` 256 MB・`work_mem` 4 MB・`max_connections` 120） |
| API | 512 MB |
| ワーカー | 768 MB（重い処理は 1 つずつ） |
| 運営の API | 192 MB |
| Caddy・cloudflared・Tailscale・OS | 残り |
| スワップ | 4 GB（この章の手順 6 で置く） |

ディスク 50 GB は、始めは足ります。サイネージの素材は 1 社 2 GB まで使えるため、会社が増えたら上げます。**ディスクが 70%、メモリの平均が 75% を超える、またはスワップを毎日使うようになったら、運営に知らせてプランを上げます。**

## 3. 再インストール（Xserver の管理画面）

1. **OS は Ubuntu 24.04 LTS** を選ぶ
2. **SSH の鍵を登録して作る**（パスワードでのログインにしない）。手元の公開鍵（`~/.ssh/id_ed25519.pub` の中身）を貼る
3. **パケットフィルターを ON にし、SSH（22 番）だけを、作業する人の接続元の IP に限って開ける**。HTTP（80）・HTTPS（443）は開けない
4. 管理画面の**コンソール**（ブラウザから入れる画面）の開き方を確かめておく。SSH でも Tailscale でも入れなくなったときの、最後の入り口になる

## 4. 初めてのログインからの手順

ここからの命令は、**SSH でつないだ VPS の上で打ちます**（手元の端末では打たない）。
SSH の設定を変える手順（2・3・8）では、**いまの接続を閉じる前に、別の画面で入れることを確かめてから**次へ進みます。閉じてから入れないと分かると、コンソールで直すことになります。

### 手順 1. OS を最新にして、起動し直す

```bash
sudo apt update && sudo apt full-upgrade -y && sudo reboot
```

起動し直したら、もう一度 SSH でつなぎます。

### 手順 2. 自分の名前の利用者を作る

Xserver が `root` で作った場合は、自分の名前の利用者を作り、以後はその利用者で作業します（`<自分の名前>` は英小文字。人の名前を使い、共用の名前にしない）。

```bash
adduser <自分の名前> && usermod -aG sudo <自分の名前>
```

`root` に登録した公開鍵を、新しい利用者に写します。

```bash
install -d -m 700 -o <自分の名前> -g <自分の名前> /home/<自分の名前>/.ssh && install -m 600 -o <自分の名前> -g <自分の名前> /root/.ssh/authorized_keys /home/<自分の名前>/.ssh/authorized_keys
```

**別の画面で `ssh <自分の名前>@<VPS の IP>` を試し、入れて `sudo -v` が通ることを確かめます。**

### 手順 3. SSH を固める

`root` でのログインと、パスワードでのログインを禁止します。

```bash
printf 'PermitRootLogin no\nPasswordAuthentication no\nKbdInteractiveAuthentication no\n' | sudo tee /etc/ssh/sshd_config.d/10-hardening.conf && sudo sshd -t && sudo systemctl reload ssh
```

`sshd -t` が何も出さなければ、設定は正しい形です。**別の画面で、自分の名前の利用者で入れることを確かめます**（`root` では入れなくなっていることも確かめる）。

### 手順 4. ファイアウォール（ufw）

入ってくる通信を既定で断り、SSH だけを残します（SSH は手順 8 で閉じます）。

```bash
sudo ufw default deny incoming && sudo ufw default allow outgoing && sudo ufw allow OpenSSH && sudo ufw enable
```

`sudo ufw status verbose` で、`Default: deny (incoming)` と `22/tcp ALLOW IN` だけが出ることを確かめます。

### 手順 5. セキュリティの更新を自動にする

Ubuntu のサーバーは、セキュリティの更新を自動で入れる仕組み（`unattended-upgrades`）が最初から入っています。動いていることを確かめ、再起動が要る更新のときに**夜中の 4 時半**に自動で起動し直すようにします（M2Office の夜の自動の更新（3 時）と重ねないため）。

```bash
printf 'Unattended-Upgrade::Automatic-Reboot "true";\nUnattended-Upgrade::Automatic-Reboot-Time "04:30";\n' | sudo tee /etc/apt/apt.conf.d/52m2office-reboot
```

```bash
cat /etc/apt/apt.conf.d/20auto-upgrades
```

`APT::Periodic::Update-Package-Lists "1";` と `APT::Periodic::Unattended-Upgrade "1";` が出れば有効です。出なければ `sudo dpkg-reconfigure -plow unattended-upgrades` で「はい」を選びます。

### 手順 6. スワップを 4 GB 置く

メモリが 2 GB のため、一時の山を越えるスワップが要ります。

```bash
sudo fallocate -l 4G /swapfile && sudo chmod 600 /swapfile && sudo mkswap /swapfile && sudo swapon /swapfile && echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab
```

メモリが残っている間はスワップを使わないようにします。

```bash
echo 'vm.swappiness=10' | sudo tee /etc/sysctl.d/99-m2office.conf && sudo sysctl --system
```

`free -h` の `Swap:` が `4.0Gi` になっていることを確かめます。

### 手順 7. 名前・時間帯・時刻・記録の残し方

機械の名前を決め、時間帯を日本時間にします（ログを読みやすくするため。M2Office 自体は日本時間を自分で計算するので、どちらでも動きます）。

```bash
sudo hostnamectl set-hostname m2office-cloud-1 && sudo timedatectl set-timezone Asia/Tokyo && timedatectl status
```

`System clock synchronized: yes` と `NTP service: active` が出ることを確かめます。

systemd の記録（ログ）を、起動し直しても消えないように残し、**28 日分・1 GB まで**にします（仕様書 第16.10.2節）。

```bash
sudo mkdir -p /etc/systemd/journald.conf.d && printf '[Journal]\nStorage=persistent\nSystemMaxUse=1G\nMaxRetentionSec=28day\n' | sudo tee /etc/systemd/journald.conf.d/m2office.conf && sudo systemctl restart systemd-journald
```

### 手順 8. Tailscale を入れ、SSH の入り口を移す

```bash
curl -fsSL https://tailscale.com/install.sh | sh && sudo tailscale up --ssh
```

出た URL を開き、運営の Tailscale のアカウントで機械を登録します。そのあと、Tailscale の管理画面で次を行います。

| 設定 | 内容 |
|---|---|
| 鍵の期限 | この機械の「Disable key expiry」を入れる（入れないと、約 180 日で切れて入れなくなる） |
| 入れる人（ACL） | 運営と提携先の技術者だけが、この機械にだけ SSH できるようにする（`ssh` の規則で、入れる人と利用者の名前を限る） |
| 名前 | 機械の名前（`m2office-cloud-1`）で引けるようにする（MagicDNS） |

**手元の端末から、Tailscale を通して入れることを確かめます。**

```bash
ssh <自分の名前>@m2office-cloud-1
```

入れたら、**インターネットからの SSH を閉じます。** Xserver の管理画面のパケットフィルターで SSH の規則を消し、VPS の上でも閉じます。

```bash
sudo ufw delete allow OpenSSH && sudo ufw status verbose
```

`sudo ufw status verbose` で、受け入れる規則が 1 つも無い（`Default: deny (incoming)` だけ）ことを確かめます。Tailscale の通信は外向きなので、閉じても入れます。

### 手順 9. 作業の記録を残す

`sudo` での操作と、大事なファイルの変更を記録します。提携先の作業の記録にもなり、運営が月に 1 回見ます（仕様書 第20.4.6節「提携先の権限と記録」）。

```bash
sudo apt install -y auditd
```

```bash
printf -- '-w /etc/sudoers -p wa -k sudoers\n-w /etc/sudoers.d/ -p wa -k sudoers\n-w /etc/ssh/sshd_config.d/ -p wa -k sshd\n-a always,exit -F arch=b64 -S execve -F euid=0 -F auid>=1000 -F auid!=-1 -k root-commands\n' | sudo tee /etc/audit/rules.d/m2office.rules && sudo augenrules --load
```

M2Office の設定の置き場（`/etc/m2office`）の見張りは、セットアップの手順で足します。記録は `sudo ausearch -k root-commands --start today` で見られます。

## 5. 終わったら確かめること

| # | 確かめること | 命令 | よい結果 |
|---|---|---|---|
| 1 | 入ってくる通信を受けていない | `sudo ufw status verbose` | 受け入れる規則が無い |
| 2 | 外から SSH できない | 手元から `ssh <VPS の IP>`（Tailscale を通さずに） | つながらない（時間切れ） |
| 3 | Tailscale から入れる | 手元から `ssh <自分の名前>@m2office-cloud-1` | 入れる |
| 4 | パスワードと root で入れない | `sudo sshd -T` の出力の `permitrootlogin` と `passwordauthentication` の行 | どちらも `no` |
| 5 | スワップがある | `free -h` | `Swap:` が `4.0Gi` |
| 6 | 自動の更新が動いている | `systemctl is-active unattended-upgrades` | `active` |
| 7 | 時刻が合っている | `timedatectl status` | `System clock synchronized: yes` |
| 8 | 作業の記録が残る | `sudo auditctl -l` | 手順 9 の規則が並ぶ |
| 9 | 待ち受けている口が無い | `sudo ss -tlnp` | 外向きの口（`0.0.0.0`・`[::]`）で待ち受けているのは `sshd` だけ（ufw とパケットフィルターで閉じてある）。Tailscale は `100.` で始まるアドレスだけ |

結果を作業の記録（日時・作業した人・確かめた結果）に残し、運営に報告します。

## 6. うまくいかないとき

| 症状 | まず確かめること |
|---|---|
| SSH で入れなくなった | Xserver の管理画面のコンソールで入り、`/etc/ssh/sshd_config.d/10-hardening.conf` と `sudo ufw status` を確かめる。直したら `sudo systemctl reload ssh` |
| Tailscale で入れない | 管理画面で機械が「Connected」か、鍵の期限が切れていないか、ACL に自分が入っているか。VPS の上では `sudo tailscale status` |
| メモリが足りず遅い | `free -h` と `top`。スワップを毎日使っていれば、運営に知らせてプランを上げる |
| 自動の再起動が困る時間に起きた | `/etc/apt/apt.conf.d/52m2office-reboot` の時刻を確かめる（M2Office の更新の 3 時と重ねない） |

手順書に無いことは、行う前に運営に確かめてください（仕様書 第20.4.6節「役割の分担」）。

## 7. この章でまだ入れないもの

次のものは、M2Office のセットアップの手順でまとめて入れます。版と設定をそろえるためです。

| もの | 入れる時 |
|---|---|
| Node.js（24 系。セキュリティの修正の下限以上） | セットアップの手順 |
| PostgreSQL 17 と pgvector | セットアップの手順 |
| Caddy・cloudflared（Cloudflare Tunnel） | セットアップの手順と、Cloudflare の設定 |
| 置き場所（`/opt/m2office`・`/var/lib/m2office`・`/etc/m2office`）と動かす利用者 `m2office` | セットアップの手順 |
| 控え（pgBackRest・restic） | セットアップの手順 |
