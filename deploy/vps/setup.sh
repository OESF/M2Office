#!/bin/bash
# @file クラウドの形のセットアップ（Xserver の VPS・Ubuntu 24.04。仕様書 第20.4.6節、ADR-0113）。技術者が対話で答えて、VPS に M2Office を入れる。
#
# 前提: 運営のマニュアル 第 13 章（VPS の用意）を終えていること（SSH は WireGuard の網から・ufw・自動の更新・スワップ）。
#
# 使い方（管理する置き場に、GitHub のリリースのタグを取ってきてから）:
#   sudo mkdir -p /opt/m2office && sudo chown "$USER" /opt/m2office
#   git clone --branch <リリースのタグ> https://github.com/OESF/M2Office.git /opt/m2office/app
#   /opt/m2office/app/deploy/vps/setup.sh
#
# 何度走らせてもよい。すでにあるもの（秘密の値・データベース）は作り直さず、答えを変えたところだけを直す。
# 管理者の権限（sudo）は、ソフト・専用の利用者・置き場・systemd・Caddy の設定を入れるときだけ使う。M2Office は専用の利用者（m2office）で動く。
#
# 試すとき（機械を変えずに、雛形を埋めた結果だけを作る）:
#   setup.sh --render-only <出力先> --answers <KEY=値 のファイル>

set -euo pipefail

SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
REPO_DIR=$(cd "$SCRIPT_DIR/../.." && pwd)
RENDER="$SCRIPT_DIR/../onsite/render.mjs"
ETC_DIR=/etc/m2office
CONF="$ETC_DIR/setup.conf"
ENV_FILE="$ETC_DIR/m2office.env"
RELEASE_DIR="$REPO_DIR/dist-release"
DATA_DIR=/var/lib/m2office
LOG_DIR=/var/log/m2office
CADDY_LOG_DIR=/var/log/caddy
SITE_DIR=/var/lib/m2office/site
SERVICE_USER=m2office
NODE_MAJOR=24
PG_MAJOR=17
API_PORT=3101
OPS_PORT=3102
WG_NETWORK_DEFAULT=10.66.0.0/24
WG_PORT=51820

say() { printf '\n\033[1m%s\033[0m\n' "$*"; }
info() { printf '  %s\n' "$*"; }
warn() { printf '  \033[33m注意:\033[0m %s\n' "$*"; }
die() { printf '\n\033[31mエラー:\033[0m %s\n' "$*" >&2; exit 1; }

# 答えを尋ねる。ask 変数名 "問い" 既定 [secret]
ask() {
  local name=$1 question=$2 def=${3:-} secret=${4:-} reply
  if [ -n "$secret" ]; then
    local shown=''; [ -n "$def" ] && shown='（入っています。変えないなら Enter）'
    printf '  %s%s: ' "$question" "$shown"
    IFS= read -rs reply; printf '\n'
  else
    printf '  %s [%s]: ' "$question" "$def"
    IFS= read -r reply
  fi
  [ -z "$reply" ] && reply=$def
  printf -v "$name" '%s' "$reply"
}

rand_hex() { openssl rand -hex "$1"; }

# m2office.env から 1 つの値を読む（root と m2office だけが読めるので sudo）。無ければ空。
env_value() {
  sudo test -f "$ENV_FILE" || { echo ''; return; }
  sudo grep -E "^$1=" "$ENV_FILE" 2>/dev/null | head -1 | cut -d= -f2- || true
}

# ---- 答えのファイルから雛形を埋める（--render-only でも本番でも使う） ----
render_all() {
  local answers=$1 out=$2 node=$3
  mkdir -p "$out/systemd"
  "$node" "$RENDER" "$answers" "$SCRIPT_DIR/m2office.env.template" "$out/m2office.env"
  "$node" "$RENDER" "$answers" "$SCRIPT_DIR/Caddyfile.template" "$out/Caddyfile"
  "$node" "$RENDER" "$answers" "$SCRIPT_DIR/crowdsec/acquis-m2office.yaml" "$out/acquis-m2office.yaml"
  local f
  for f in "$SCRIPT_DIR"/systemd/*.service; do
    "$node" "$RENDER" "$answers" "$f" "$out/systemd/$(basename "$f")"
  done
}

# Cloudflare を前に置くかどうかで、Caddyfile に入れる段を決める（第20.4.6節「Cloudflare をあとから前に置く」）
cloudflare_parts() {
  if [ "${CLOUDFLARE_FRONT:-no}" = yes ]; then
    CLOUDFLARE_SNIPPET=$(sed 's/\t/\\t/g' "$SCRIPT_DIR/cloudflare-front.caddy" | awk '{printf "%s\\n", $0}')
    CLOUDFLARE_GLOBAL='\tservers {\n\t\ttrusted_proxies static 173.245.48.0/20 103.21.244.0/22 103.22.200.0/22 103.31.4.0/22 141.101.64.0/18 108.162.192.0/18 190.93.240.0/20 188.114.96.0/20 197.234.240.0/22 198.41.128.0/17 162.158.0.0/15 104.16.0.0/13 104.24.0.0/14 172.64.0.0/13 131.0.72.0/22 2400:cb00::/32 2606:4700::/32 2803:f800::/32 2405:b500::/32 2405:8100::/32 2a06:98c0::/29 2c0f:f248::/32\n\t\tclient_ip_headers CF-Connecting-IP\n\t}'
  else
    # Cloudflare を前に置いていないときは、何も断らない段にする（どのサイトも同じ import のままにするため）
    CLOUDFLARE_SNIPPET='(cloudflare_only) {\n\tvars cloudflare_front no\n}'
    CLOUDFLARE_GLOBAL=''
  fi
}

if [ "${1:-}" = --render-only ]; then
  out=${2:?出力先を指定してください}; [ "${3:-}" = --answers ] || die '--answers <ファイル> を指定してください'
  answers=${4:?答えのファイルを指定してください}
  # 答えのファイルに CLOUDFLARE_FRONT があれば、その値で Cloudflare の段を作る
  CLOUDFLARE_FRONT=$(grep -E '^CLOUDFLARE_FRONT=' "$answers" | cut -d= -f2- || true)
  cloudflare_parts
  tmp=$(mktemp); cp "$answers" "$tmp"
  # 答えのファイルの終わりに改行が無くても、足す行が前の行につながらないようにする
  printf '\n' >> "$tmp"
  printf "CLOUDFLARE_SNIPPET='%s'\nCLOUDFLARE_GLOBAL='%s'\n" "$CLOUDFLARE_SNIPPET" "$CLOUDFLARE_GLOBAL" >> "$tmp"
  render_all "$tmp" "$out" "$(command -v node)"
  rm -f "$tmp"
  echo "雛形を埋めました: $out"
  exit 0
fi

# ---- 1. 確かめる ----
say 'M2Office（クラウドの形）を VPS に入れます'
[ "$(id -u)" -ne 0 ] || die 'root では走らせないでください。自分の名前の利用者で走らせます（要るところだけ sudo を使います）'
. /etc/os-release
[ "${ID:-}" = ubuntu ] && [ "${VERSION_ID:-}" = 24.04 ] || die "Ubuntu 24.04 で走らせてください（いま: ${PRETTY_NAME:-不明}）"
sudo -v || die 'sudo が使えません'
tag=$(git -C "$REPO_DIR" describe --tags --exact-match 2>/dev/null || true)
[[ "$tag" == v* ]] || die "リリースのタグ（v で始まる版）を取ってきてください（いま: $(git -C "$REPO_DIR" rev-parse --short HEAD)）"
info "入れる版: $tag"
sudo ufw status | grep -q 'Status: active' || die 'ufw が有効ではありません。先に運営のマニュアル 第 13 章を終えてください'
ip link show wg0 >/dev/null 2>&1 || die 'WireGuard（wg0）がありません。先に運営のマニュアル 第 13 章の手順 8 を終えてください'

# ---- 2. 尋ねる（前の答えを既定にする） ----
sudo mkdir -p "$ETC_DIR" && sudo chmod 750 "$ETC_DIR"
# shellcheck disable=SC1090
sudo test -f "$CONF" && eval "$(sudo cat "$CONF")"
say '答えてください（[ ] の中が既定です）'
ask BASE_DOMAIN '会社のサブドメインの親のドメイン' "${BASE_DOMAIN:-m2office.net}"
ask ACME_EMAIL '証明書（Let'"'"'s Encrypt）の連絡先のメールアドレス' "${ACME_EMAIL:-}"
ask OPS_GOOGLE_DOMAIN 'マスター管理画面に入れる Google Workspace のドメイン' "${OPS_GOOGLE_DOMAIN:-}"
ask WG_NETWORK 'WireGuard の網（運営の画面を開ける範囲）' "${WG_NETWORK:-$WG_NETWORK_DEFAULT}"
ask WAF_ENGINE 'WAF の動き（DetectionOnly: 記録だけ ／ On: 止める）' "${WAF_ENGINE:-DetectionOnly}"
ask CLOUDFLARE_FRONT 'Cloudflare を前に置くか（大量の通信の攻撃を受けたときだけ yes）' "${CLOUDFLARE_FRONT:-no}"
GEMINI_API_KEY=$(env_value GEMINI_API_KEY)
ask GEMINI_API_KEY 'Gemini の API の鍵（後でもよい）' "$GEMINI_API_KEY" secret
GOOGLE_LOGIN_CLIENT_ID=$(env_value GOOGLE_LOGIN_CLIENT_ID)
ask GOOGLE_LOGIN_CLIENT_ID 'Google のログインの OAuth クライアントの ID（後でもよい）' "$GOOGLE_LOGIN_CLIENT_ID"
GOOGLE_LOGIN_CLIENT_SECRET=$(env_value GOOGLE_LOGIN_CLIENT_SECRET)
ask GOOGLE_LOGIN_CLIENT_SECRET 'そのシークレット' "$GOOGLE_LOGIN_CLIENT_SECRET" secret
[[ "$BASE_DOMAIN" =~ ^[a-z0-9.-]+\.[a-z]+$ ]] || die "ドメインの形が違います: $BASE_DOMAIN"
[[ "$ACME_EMAIL" == *@* ]] || die '証明書の連絡先のメールアドレスを入れてください'
[ "$WAF_ENGINE" = DetectionOnly ] || [ "$WAF_ENGINE" = On ] || die 'WAF の動きは DetectionOnly か On です'
[ "$CLOUDFLARE_FRONT" = no ] || [ "$CLOUDFLARE_FRONT" = yes ] || die 'Cloudflare を前に置くかは yes か no です'
# 秘密の値でない答えだけを残す（次の既定）
printf "BASE_DOMAIN='%s'\nACME_EMAIL='%s'\nOPS_GOOGLE_DOMAIN='%s'\nWG_NETWORK='%s'\nWAF_ENGINE='%s'\nCLOUDFLARE_FRONT='%s'\n" \
  "$BASE_DOMAIN" "$ACME_EMAIL" "$OPS_GOOGLE_DOMAIN" "$WG_NETWORK" "$WAF_ENGINE" "$CLOUDFLARE_FRONT" | sudo tee "$CONF" >/dev/null
sudo chmod 600 "$CONF"

# ---- 3. ソフトを入れる（公式の置き場から。版の大きな数を固定する） ----
say 'ソフトを入れます（初めては数分かかります）'
sudo apt-get update -qq
sudo apt-get install -y -qq ca-certificates curl gnupg openssl git ffmpeg restic pgbackrest debian-keyring debian-archive-keyring apt-transport-https >/dev/null
if ! command -v node >/dev/null || [ "$(node -p 'process.versions.node.split(".")[0]')" != "$NODE_MAJOR" ]; then
  curl -fsSL "https://deb.nodesource.com/setup_${NODE_MAJOR}.x" | sudo -E bash - >/dev/null
  sudo apt-get install -y -qq nodejs >/dev/null
fi
info "Node.js: $(node -v)"
if ! dpkg -s "postgresql-$PG_MAJOR" >/dev/null 2>&1; then
  sudo apt-get install -y -qq postgresql-common >/dev/null
  sudo /usr/share/postgresql-common/pgdg/apt.postgresql.org.sh -y >/dev/null
  sudo apt-get install -y -qq "postgresql-$PG_MAJOR" "postgresql-$PG_MAJOR-pgvector" >/dev/null
fi
info "PostgreSQL: $(cd / && sudo -u postgres psql -tAc 'show server_version' | cut -d' ' -f1)"
if ! command -v caddy >/dev/null; then
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | sudo gpg --dearmor --yes -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' | sudo tee /etc/apt/sources.list.d/caddy-stable.list >/dev/null
  sudo apt-get update -qq && sudo apt-get install -y -qq caddy >/dev/null
fi
# WAF（Coraza）を組み込んだ Caddy にする。apt の更新で部品の無い Caddy に戻らないよう止める（Caddy の更新は caddy upgrade で行う）
if ! caddy list-modules 2>/dev/null | grep -q '^http.handlers.waf$'; then
  sudo caddy add-package github.com/corazawaf/coraza-caddy/v2 >/dev/null
fi
sudo apt-mark hold caddy >/dev/null
info "Caddy: $(caddy version | cut -d' ' -f1)（WAF を組み込み）"
if ! command -v cscli >/dev/null; then
  curl -fsSL https://install.crowdsec.net | sudo sh >/dev/null
  sudo apt-get install -y -qq crowdsec crowdsec-firewall-bouncer-nftables >/dev/null
fi
sudo cscli collections install crowdsecurity/caddy >/dev/null 2>&1 || true
info "CrowdSec: $(cscli version 2>&1 | grep -m1 -i version | awk '{print $NF}')"

# ---- 4. 専用の利用者と置き場 ----
say '専用の利用者と置き場を用意します'
id "$SERVICE_USER" >/dev/null 2>&1 || sudo useradd --system --home "$DATA_DIR" --shell /usr/sbin/nologin "$SERVICE_USER"
sudo install -d -m 750 -o "$SERVICE_USER" -g "$SERVICE_USER" "$DATA_DIR" "$DATA_DIR/files" "$DATA_DIR/machine" "$LOG_DIR"
sudo install -d -m 755 -o root -g root "$SITE_DIR"
sudo install -d -m 750 -o caddy -g caddy "$CADDY_LOG_DIR"
if [ ! -f "$SITE_DIR/index.html" ]; then
  printf '<!doctype html><meta charset="utf-8"><title>M2Office</title><p>M2Office</p>\n' | sudo tee "$SITE_DIR/index.html" >/dev/null
fi

# ---- 5. 秘密の値（機械の上で作る。前に作ったものは変えない） ----
SECRET_KEY=$(env_value M2OFFICE_SECRET_KEY); [ -n "$SECRET_KEY" ] || SECRET_KEY=$(rand_hex 32)
DB_OWNER_PASSWORD=$(env_value MIGRATION_DATABASE_URL | sed -E 's#^postgres://[^:]+:([^@]+)@.*#\1#'); [ -n "$DB_OWNER_PASSWORD" ] || DB_OWNER_PASSWORD=$(rand_hex 24)
DB_APP_PASSWORD=$(env_value DATABASE_URL | sed -E 's#^postgres://[^:]+:([^@]+)@.*#\1#'); [ -n "$DB_APP_PASSWORD" ] || DB_APP_PASSWORD=$(rand_hex 24)
DB_OPS_PASSWORD=$(env_value OPS_DATABASE_URL | sed -E 's#^postgres://[^:]+:([^@]+)@.*#\1#'); [ -n "$DB_OPS_PASSWORD" ] || DB_OPS_PASSWORD=$(rand_hex 24)

# ---- 6. 設定のファイルを雛形から作る ----
say '設定のファイルを作ります'
work=$(mktemp -d); trap 'rm -rf "$work"' EXIT
cloudflare_parts
answers="$work/answers"
umask 077
cat > "$answers" <<ANSWERS
BASE_DOMAIN=$BASE_DOMAIN
ACME_EMAIL=$ACME_EMAIL
OPS_GOOGLE_DOMAIN=$OPS_GOOGLE_DOMAIN
WG_NETWORK=$WG_NETWORK
WAF_ENGINE=$WAF_ENGINE
CLOUDFLARE_FRONT=$CLOUDFLARE_FRONT
CLOUDFLARE_SNIPPET='$CLOUDFLARE_SNIPPET'
CLOUDFLARE_GLOBAL='$CLOUDFLARE_GLOBAL'
GEMINI_API_KEY=$GEMINI_API_KEY
GOOGLE_LOGIN_CLIENT_ID=$GOOGLE_LOGIN_CLIENT_ID
GOOGLE_LOGIN_CLIENT_SECRET=$GOOGLE_LOGIN_CLIENT_SECRET
SECRET_KEY=$SECRET_KEY
DB_OWNER_PASSWORD=$DB_OWNER_PASSWORD
DB_APP_PASSWORD=$DB_APP_PASSWORD
DB_OPS_PASSWORD=$DB_OPS_PASSWORD
RELEASE_DIR=$RELEASE_DIR
DATA_DIR=$DATA_DIR
LOG_DIR=$LOG_DIR
CADDY_LOG_DIR=$CADDY_LOG_DIR
SITE_DIR=$SITE_DIR
API_PORT=$API_PORT
OPS_PORT=$OPS_PORT
ANSWERS
umask 022
render_all "$answers" "$work/out" "$(command -v node)"
sudo install -m 640 -o root -g "$SERVICE_USER" "$work/out/m2office.env" "$ENV_FILE"
info "設定: $ENV_FILE"

# ---- 7. データベース ----
say 'データベースを用意します'
# postgres の利用者は自分の家の置き場に入れないので、/ から走らせる
pg() { (cd / && sudo -u postgres psql -v ON_ERROR_STOP=1 -qtA "$@"); }
if [ "$(pg -c "select 1 from pg_roles where rolname = 'm2office'")" != 1 ]; then
  pg -c "create role m2office login createrole password '$DB_OWNER_PASSWORD'"
else
  pg -c "alter role m2office login createrole password '$DB_OWNER_PASSWORD'"
fi
[ "$(pg -c "select 1 from pg_database where datname = 'm2office'")" = 1 ] || pg -c 'create database m2office owner m2office encoding utf8'
# 拡張は管理者の権限で入れる（移行の「create extension if not exists」は入っていれば何もしない）
pg -d m2office -c 'create extension if not exists vector' -c 'create extension if not exists btree_gist'
info 'データベース m2office（127.0.0.1 だけ）'

# ---- 8. 組み立てと移行 ----
say '本番の組み立てを作ります（数分かかります）'
(cd "$REPO_DIR" && npm ci --no-audit --no-fund >/dev/null && npm run build:release -- --install >/dev/null)
info "組み立てました: $RELEASE_DIR"
say 'データベースの形を最新にします'
sudo -u "$SERVICE_USER" node --env-file="$ENV_FILE" "$REPO_DIR/scripts/migrate.mjs" | tail -1

# ---- 9. 動かす ----
say 'M2Office を動かします'
for f in "$work"/out/systemd/*.service; do sudo install -m 644 "$f" "/etc/systemd/system/$(basename "$f")"; done
sudo systemctl daemon-reload
for s in m2office-api m2office-worker m2office-ops; do sudo systemctl enable "$s" >/dev/null 2>&1; sudo systemctl restart "$s"; done
sudo install -m 644 "$work/out/Caddyfile" /etc/caddy/Caddyfile
sudo -u caddy caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile >/dev/null 2>&1 || die 'Caddy の設定が通りません（sudo -u caddy caddy validate --config /etc/caddy/Caddyfile で理由を見てください）'
sudo systemctl enable caddy >/dev/null 2>&1; sudo systemctl reload-or-restart caddy
sudo install -d -m 755 /etc/crowdsec/acquis.d
sudo install -m 644 "$work/out/acquis-m2office.yaml" /etc/crowdsec/acquis.d/m2office.yaml
sudo systemctl restart crowdsec
# 80・443 を開ける（WireGuard の UDP と、網の中の SSH は第 13 章で開けてある）
sudo ufw allow 80/tcp >/dev/null && sudo ufw allow 443/tcp >/dev/null

# ---- 10. 確かめる ----
say '動きを確かめます'
ok=0
for _ in $(seq 1 60); do curl -fsS "http://127.0.0.1:$API_PORT/health" >/dev/null 2>&1 && { ok=1; break; }; sleep 1; done
[ "$ok" = 1 ] && info 'API: 動いています' || warn 'API が答えません（journalctl -u m2office-api -n 50 を見てください）'
curl -fsS "http://127.0.0.1:$OPS_PORT/health" >/dev/null 2>&1 && info '運営の API: 動いています' || warn '運営の API が答えません（journalctl -u m2office-ops -n 50）'
systemctl is-active --quiet m2office-worker && info 'ワーカー: 動いています' || warn 'ワーカーが動いていません（journalctl -u m2office-worker -n 50）'
systemctl is-active --quiet caddy && info 'Caddy: 動いています' || warn 'Caddy が動いていません（journalctl -u caddy -n 50）'
systemctl is-active --quiet crowdsec && info 'CrowdSec: 動いています' || warn 'CrowdSec が動いていません（journalctl -u crowdsec -n 50）'
if ss -tln | grep -E "0\.0\.0\.0:($API_PORT|$OPS_PORT)|\[::\]:($API_PORT|$OPS_PORT)" >/dev/null; then
  warn 'API が機械の外でも待ち受けています（M2O_LISTEN_HOST を確かめてください）'
else
  info 'API と運営の API は 127.0.0.1 だけで待ち受けています'
fi

say '残りの作業'
info "1. Xserver の DNS に、${BASE_DOMAIN}・www・*.$BASE_DOMAIN の A の記録（この VPS の IP）を作る"
info '2. Xserver の管理画面のパケットフィルターで、TCP 80・443 を開ける（UDP 51820 は第 13 章で開けてある）'
info "3. 開けたら https://$BASE_DOMAIN を開いて確かめる。運営者の端末の hosts に「10.66.0.1 ops.${BASE_DOMAIN}」を足し、WireGuard を入れて https://ops.$BASE_DOMAIN を開く"
info '4. Google のログインの OAuth クライアントに、戻り先（m2office.env の GOOGLE_LOGIN_REDIRECT_URI）を登録する'
[ "$WAF_ENGINE" = DetectionOnly ] && info '5. WAF は記録だけです。誤りが無いことを確かめたら、WAF の動きを On にして走らせ直す'
info '控え（pgBackRest・restic）と夜の自動の更新は、まだこの命令では入れません（運営のマニュアル 第 14 章）'
