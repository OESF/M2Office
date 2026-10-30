# 第 12 章 VPS の用意（OS の初期設定）

クラウドの形の M2Office を置く VPS（Xserver の VPS・Ubuntu）を、**M2Office を入れる前に**固める手順です。配備する技術者（提携先の技術者を含む）が行います。
仕組みの考え方は仕様書 第20.4.6節にあります。この章は、その「機械」と「資源の配分」と「保守の入り口」の部分を、打つ命令に落としたものです。

**目指す形: VPS が開ける口を、HTTPS（443）・HTTP（80）・WireGuard の UDP の 3 つだけにする。** 保守の SSH は、VPS に立てる WireGuard の網からだけ通します。この章を終えると、開いている口は WireGuard だけになり、SSH には WireGuard からしか入れなくなります。80・443 は、M2Office を入れる第 13 章で開けます。

M2Office 本体（Node.js・PostgreSQL・Caddy・CrowdSec と置き場所）は、この章では入れません（第 13 章）。セットアップの手順（`deploy/vps/setup.sh`。これから作る）でまとめて入れます。

## 1. 用意するもの

| もの | 内容 |
|---|---|
| Xserver の VPS の管理画面に入れるアカウント | 運営が持つ。作業する人に、必要な権限だけを付ける |
| SSH の鍵 | 作業する人の手元の端末で作った鍵（ed25519）。公開鍵だけを VPS に登録する |
| 接続元の IP アドレス | 作業する人の場所のもの。WireGuard に移るまでの間だけ、SSH をこの IP に限って開ける |
| WireGuard のアプリ | 作業する人の手元の端末に入れる（Mac は App Store の「WireGuard」。公式のもの）。アカウントは要らない |

手元で SSH の鍵を作るときは、次のとおりです（すでにあれば要りません）。

```bash
ssh-keygen -t ed25519 -C "<自分の名前>-m2office-vps"
```

## 2. スペックと資源の配分

いまの VPS は **4 vCPU・メモリ 4 GB・NVMe SSD 150 GB** です（仕様書 Q-255）。

| 使い道 | 考え方 |
|---|---|
| 仮稼働（見本のデータで通しの確かめ） | このスペックで動かす。録音の文字起こし・PDF の組み立て・動画の書き出しが重なったときの山を測る |
| 本番（顧客を入れる） | 同じスペックで入れる。仮稼働で測った山が、下の「プランを上げる目安」を超えないことを確かめてから入れる |

M2Office を入れるときの、メモリの割り当ての目安です（セットアップの手順で設定します）。

| もの | 割り当て |
|---|---|
| PostgreSQL | 約 1.2 GB（`shared_buffers` 768 MB・`effective_cache_size` 2 GB・`work_mem` 8 MB・`maintenance_work_mem` 128 MB・`max_connections` 120） |
| API | 768 MB |
| ワーカー | 1 GB（重い処理は 1 つずつ） |
| 運営の API | 256 MB |
| 申し込みの口 | 256 MB |
| Caddy（WAF を含む）・CrowdSec・WireGuard・OS | 残り（約 0.5 GB） |
| スワップ | 4 GB（この章の手順 6 で置く） |

API・ワーカーなどの値は Node.js が使える上限で、いつも使い切るわけではありません。合わせると 4 GB をわずかに超えますが、そのぶんはスワップで一時の山を越えます。

ディスク 150 GB は、始めは十分です。サイネージの素材は 1 社 2 GB まで使え、販売の書類と取り込んだ注文書は 10 年残すため、会社が増えたら見直します。**ディスクが 70%、メモリの平均が 75% を超える、またはスワップを毎日使うようになったら、運営に知らせてプランを上げます（次はメモリ 8 GB）。**

## 3. 再インストール（Xserver の管理画面）

1. **OS は Ubuntu 26.04 LTS**（または 24.04 LTS）を選ぶ。`m2office-cloud-1` は 26.04
2. **SSH の鍵を登録して作る**（パスワードでのログインにしない）。手元の公開鍵（`~/.ssh/id_ed25519.pub` の中身）を貼る
3. **パケットフィルターを ON にし、SSH（22 番）だけを、作業する人の接続元の IP に限って開ける**。HTTP（80）・HTTPS（443）は第 13 章まで開けない。SSH は手順 8 で WireGuard に移したあと閉じる
4. 管理画面の**コンソール**（ブラウザから入れる画面）の開き方を確かめておく。SSH でも WireGuard でも入れなくなったときの、最後の入り口になる

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

メモリ 4 GB で、録音の文字起こしや PDF の組み立てが重なったときの一時の山を越えるため、スワップを置きます。すでにスワップがあるか、先に `swapon --show` で確かめます（何も出なければ無い）。

```bash
sudo fallocate -l 4G /swapfile && sudo chmod 600 /swapfile && sudo mkswap /swapfile && sudo swapon /swapfile && echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab
```

すでに `/swapfile` があり 4 GB より小さいとき（Xserver のイメージでは 2 GB のことがある）は、上の命令の代わりに、止めてから大きさを変えます。`/etc/fstab` の行はそのまま使えるので足しません（`grep swapfile /etc/fstab` で 1 行だけあることを確かめる）。

```bash
sudo swapoff /swapfile && sudo fallocate -l 4G /swapfile && sudo chmod 600 /swapfile && sudo mkswap /swapfile && sudo swapon /swapfile
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

### 手順 8. WireGuard を立て、SSH の入り口を移す

この手順の前に、下の「WireGuard の考え方」を読んでください。保守を受け持つ人は、仕組みと守るところを分かっている必要があります。

#### WireGuard の考え方

**WireGuard は、Linux に入っている VPN の仕組みです。** VPS と保守の人の端末だけの、暗号化した小さな網を作ります。アカウントも契約も要りません。

| 項目 | 内容 |
|---|---|
| 網のアドレス | 網の中だけで使うアドレスを決める。VPS は `10.66.0.1`、保守の人の端末は `10.66.0.2` から 1 人 1 つ |
| 鍵 | VPS と端末が、それぞれ秘密の鍵と公開の鍵の組を持つ。相手の**公開の鍵**を登録し合った端末どうしだけがつながる。秘密の鍵はその端末から出さない |
| 開ける口 | VPS は UDP の 1 つの口（**51820 番**）だけを開ける。**登録した鍵を持たない相手には何も返事をしない**ため、外からは口があることも分からない |
| 通るもの | 端末から VPS の網のアドレス（`10.66.0.1`）あての通信だけを網に通す。ふだんのインターネットの通信は、今までどおり網を通らない |

**M2Office で使う理由。** VPS の SSH（22 番）をインターネットに開けると、世界中から総当たりを受けます。WireGuard の網からだけ SSH を受けるようにすれば、鍵を登録した人の端末からしか SSH に届きません。マスター管理画面（`ops`）も、この網からだけ開けます（第 13 章）。

| 比べるもの | WireGuard（自前） | Tailscale（使わない） |
|---|---|---|
| 契約 | 要らない | 商用は有料（1 人ごとの月額） |
| 人の足し・外し | VPS の設定を手順の命令で書き換える | 管理画面で行う |
| 中身 | 同じ WireGuard の方式で暗号化する | 同じ（Tailscale は WireGuard の上に管理の仕組みを足したもの） |

保守の人が増えて鍵の管理が手間になったら、Tailscale などに移すことを考えます（仕様書 第20.4.6節）。

**保守で守ること。**

| 項目 | 内容 |
|---|---|
| 鍵は人ごと | 1 人 1 つの鍵と 1 つの網のアドレス。共用の鍵を作らない。誰にどのアドレスを渡したかを、作業の記録に残す |
| 秘密の鍵 | 端末の秘密の鍵は、その端末から出さない（メールやチャットに貼らない）。VPS の秘密の鍵（`/etc/wireguard/server.key`）は `root` だけが読める |
| 外す | 担当を外れた人は、その日のうちに VPS の設定から外す（下の「人を外す」） |
| 端末をなくした | その人の鍵をすぐ外し、新しい鍵で登録し直す |
| 最後の入り口 | WireGuard でも入れないときは、**Xserver の管理画面のコンソール**で入る（本章の 3）。SSH の口を閉じる前に、開き方を必ず確かめておく |

#### VPS に WireGuard を立てる

WireGuard を入れ、VPS の鍵の組を作ります。

```bash
sudo apt install -y wireguard && sudo sh -c 'umask 077; wg genkey > /etc/wireguard/server.key; wg pubkey < /etc/wireguard/server.key > /etc/wireguard/server.pub' && sudo cat /etc/wireguard/server.pub
```

最後に出た 1 行が **VPS の公開の鍵**です。手元の端末の設定で使うので控えます（公開の鍵は人に見られてもかまいません）。

網の設定のファイルを作ります。

```bash
sudo sh -c 'umask 077; printf "[Interface]\nAddress = 10.66.0.1/24\nListenPort = 51820\nPrivateKey = %s\n" "$(cat /etc/wireguard/server.key)" > /etc/wireguard/wg0.conf'
```

WireGuard を起動し、機械が起きたときにも起動するようにします。

```bash
sudo systemctl enable --now wg-quick@wg0 && sudo wg show
```

`interface: wg0` と `listening port: 51820` が出れば動いています。

WireGuard の口を開けます。機械のファイアウォールで UDP 51820 を許し、**Xserver の管理画面のパケットフィルターにも UDP 51820 を許す規則を足します**（項目の名前は管理画面で確かめてください）。

```bash
sudo ufw allow 51820/udp && sudo ufw status verbose
```

#### 手元の端末を登録する

1. 手元の WireGuard のアプリで「空のトンネルを追加」を選ぶ。アプリが端末の鍵の組を作り、**端末の公開の鍵**を表示する
2. トンネルの名前を `m2office-cloud-1` にし、設定を次のように書く（`PrivateKey` の行はアプリが入れたものをそのまま残す）

```
[Interface]
PrivateKey = （アプリが入れたもの）
Address = 10.66.0.2/32

[Peer]
PublicKey = （VPS の公開の鍵）
Endpoint = （VPS の IP アドレス）:51820
AllowedIPs = 10.66.0.1/32
PersistentKeepalive = 25
```

`Address` は人ごとに `10.66.0.2`・`10.66.0.3` と 1 つずつ変えます。`AllowedIPs` を `10.66.0.1/32` にすると、VPS あての通信だけが網を通ります。

マスター管理画面だけを使う運営者（提携会社の人を含む。第 2 章）の端末も、同じ手順で登録します。網に入ると SSH の入り口にも届きますが、SSH は登録した鍵の人しか入れないので、画面だけを使う人の SSH の鍵は VPS に登録しません。

3. VPS に、その端末を登録する（`<端末の公開の鍵>` と `<名前>` と `<日付>` を入れる）

```bash
printf '\n[Peer]\n# <名前>（<日付> 追加）\nPublicKey = <端末の公開の鍵>\nAllowedIPs = 10.66.0.2/32\n' | sudo tee -a /etc/wireguard/wg0.conf && sudo bash -c 'wg syncconf wg0 <(wg-quick strip wg0)' && sudo wg show
```

4. 手元のアプリでトンネルを「有効」にし、手元の端末から VPS に届くか確かめる

```bash
ping -c 3 10.66.0.1
```

`sudo wg show` の `latest handshake` に時刻が出ていれば、つながっています。

#### SSH を WireGuard の網からだけにする

まず、WireGuard の網から SSH を受ける規則を足します。

```bash
sudo ufw allow in on wg0 to any port 22 proto tcp
```

**いまの SSH はつないだまま**、手元の別の画面で、WireGuard を通して入れることを確かめます。

```bash
ssh <自分の名前>@10.66.0.1
```

入れたら、インターネットからの SSH を閉じます。Xserver の管理画面のパケットフィルターで SSH（22 番）の規則を消し、VPS の上でも閉じます。

```bash
sudo ufw delete allow OpenSSH && sudo ufw status verbose
```

手順 4 で `22/tcp` として開けた場合は、「存在しない規則」と出ます。そのときは `sudo ufw delete allow 22/tcp` で消します。どちらで消しても、WireGuard の網からの規則（`22/tcp on wg0`）は残ります。

`sudo ufw status verbose` で、受け入れる規則が `51820/udp` と `22/tcp on wg0` の 2 つだけであることを確かめます。

手元の `~/.ssh/config` に次を足すと、`ssh m2office-cloud-1` で入れます。

```
Host m2office-cloud-1
  HostName 10.66.0.1
  User <自分の名前>
```

#### 人を足す・外す

| 操作 | 行うこと |
|---|---|
| 足す | 上の「手元の端末を登録する」を、その人に 2 を、VPS で 3 を行う。網のアドレスは、まだ使っていない次の番号にする。SSH で入る人なら、手順 2 のとおり自分の名前の利用者も作る |
| 運営者（画面だけ） | マスター管理画面だけを使う運営者も同じく足す。VPS の利用者は作らない（SSH には入れない） |
| 外す | `/etc/wireguard/wg0.conf` からその人の `[Peer]` の 4 行を消し（`sudo nano /etc/wireguard/wg0.conf`）、`sudo bash -c 'wg syncconf wg0 <(wg-quick strip wg0)'` で効かせる。VPS の利用者も消す（`sudo deluser --remove-home <名前>`） |
| 記録 | 足した・外した日と人と網のアドレスを、作業の記録に残す |

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
| 1 | 入ってくる通信を限っている | `sudo ufw status verbose` | 受け入れる規則が `51820/udp` と `22/tcp on wg0` だけ |
| 2 | 外から SSH できない | 手元で WireGuard を切って `ssh <VPS の IP>` | つながらない（時間切れ） |
| 3 | WireGuard から入れる | 手元で WireGuard を入れて `ssh <自分の名前>@10.66.0.1` | 入れる |
| 4 | パスワードと root で入れない | `sudo sshd -T` の出力の `permitrootlogin` と `passwordauthentication` の行 | どちらも `no` |
| 5 | スワップがある | `free -h` | `Swap:` が `4.0Gi` |
| 6 | 自動の更新が動いている | `systemctl is-active unattended-upgrades` | `active` |
| 7 | 時刻が合っている | `timedatectl status` | `System clock synchronized: yes` |
| 8 | 作業の記録が残る | `sudo auditctl -l` | 手順 9 の規則が並ぶ |
| 9 | 待ち受けている口が無い | `sudo ss -tulnp` | 外向きの口（`0.0.0.0`・`[::]`）で待ち受けているのは `sshd`（ufw とパケットフィルターで WireGuard の網だけに限ってある）と WireGuard の UDP 51820 だけ |
| 10 | 鍵の登録 | `sudo wg show` | 登録した人の数だけ `peer` が並び、知らない鍵が無い |

結果を作業の記録（日時・作業した人・確かめた結果）に残し、運営に報告します。

## 6. うまくいかないとき

| 症状 | まず確かめること |
|---|---|
| SSH で入れなくなった | Xserver の管理画面のコンソールで入り、`/etc/ssh/sshd_config.d/10-hardening.conf` と `sudo ufw status` を確かめる。直したら `sudo systemctl reload ssh` |
| WireGuard でつながらない | 手元のアプリでトンネルが有効か。VPS の上で `sudo wg show`（自分の `peer` があるか・`latest handshake` が出るか）と `sudo systemctl status wg-quick@wg0`。Xserver のパケットフィルターに UDP 51820 があるか。どうしても入れなければ、Xserver の管理画面のコンソールで入る |
| メモリが足りず遅い | `free -h` と `top`。スワップを毎日使っていれば、運営に知らせてプランを上げる |
| 自動の再起動が困る時間に起きた | `/etc/apt/apt.conf.d/52m2office-reboot` の時刻を確かめる（M2Office の更新の 3 時と重ねない） |

手順書に無いことは、行う前に運営に確かめてください（仕様書 第20.4.6節「役割の分担」）。

## 7. この章でまだ入れないもの

次のものは、M2Office のセットアップの手順でまとめて入れます。版と設定をそろえるためです。

| もの | 入れる時 |
|---|---|
| Node.js（24 系。セキュリティの修正の下限以上） | セットアップの手順 |
| PostgreSQL 17 と pgvector | セットアップの手順 |
| Caddy（Let's Encrypt の証明書・WAF）・CrowdSec と、80・443 を開けること | セットアップの手順と、Xserver の DNS の設定（第 13 章） |
| 置き場所（`/opt/m2office`・`/var/lib/m2office`・`/etc/m2office`）と動かす利用者 `m2office` | セットアップの手順 |
| 控え（pgBackRest・restic） | セットアップの手順 |
