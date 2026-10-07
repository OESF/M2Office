#!/bin/bash
# @file ローカルの形のセットアップ（仕様書 第8.6.1節、ADR-0077）。技術者が対話で答えて、1 台の Mac に M2Office を入れる。
#
# 使い方（管理する置き場に、GitHub のリリースのタグを取ってきてから）:
#   sudo mkdir -p /Library/M2Office && sudo chown "$USER" /Library/M2Office
#   git clone --branch v0.18.0 https://github.com/OESF/M2Office.git /Library/M2Office/app
#   /Library/M2Office/app/deploy/onsite/setup.sh
#
# 何度走らせてもよい。すでにあるもの（秘密の値・データベース・会社）は作り直さず、答えを変えたところだけを直す。
# 管理者の権限（sudo）は、専用の利用者・置き場・launchd の設定を入れるときだけ使う。M2Office は専用の利用者（_m2office）で動く。
#
# 試すとき（機械を変えずに、雛形を埋めた結果だけを作る）:
#   setup.sh --render-only <出力先> --answers <KEY=値 のファイル>

set -euo pipefail

SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
REPO_DIR=$(cd "$SCRIPT_DIR/../.." && pwd)
INSTALL_DIR=${M2O_INSTALL_DIR:-$(dirname "$REPO_DIR")}
CONF="$INSTALL_DIR/setup.conf"
ENV_FILE="$INSTALL_DIR/m2office.env"
CADDYFILE="$INSTALL_DIR/Caddyfile"
SERVICE_USER=_m2office
DAEMONS=/Library/LaunchDaemons
NODE_FORMULA=node@22
PG_FORMULA=postgresql@17

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

# はい・いいえを尋ねる（既定は y か n）。
yes_no() {
  local question=$1 def=${2:-y} reply
  printf '  %s [%s]: ' "$question" "$( [ "$def" = y ] && echo 'Y/n' || echo 'y/N')"
  IFS= read -r reply
  reply=${reply:-$def}
  case "$reply" in [yY]*) return 0 ;; *) return 1 ;; esac
}

rand_hex() { openssl rand -hex "$1"; }

# m2office.env から 1 つの値を読む（管理者だけが読めるので sudo）。無ければ空。
env_value() {
  [ -f "$ENV_FILE" ] || { echo ''; return; }
  sudo grep -E "^$1=" "$ENV_FILE" 2>/dev/null | head -1 | cut -d= -f2- || true
}

# ---- 答えのファイルから雛形を埋める（--render-only でも本番でも使う） ----
render_all() {
  local answers=$1 out=$2 node=$3
  mkdir -p "$out/launchd"
  "$node" "$SCRIPT_DIR/render.mjs" "$answers" "$SCRIPT_DIR/m2office.env.template" "$out/m2office.env"
  "$node" "$SCRIPT_DIR/render.mjs" "$answers" "$SCRIPT_DIR/Caddyfile.template" "$out/Caddyfile"
  local f
  for f in "$SCRIPT_DIR"/launchd/*.plist; do
    "$node" "$SCRIPT_DIR/render.mjs" "$answers" "$f" "$out/launchd/$(basename "$f")"
  done
}

# 入口の TLS の段（名前の形は DNS で公的な証明書、IP の形は機械の認証局）。
tls_block() {
  if [ "$TLS_MODE" = ip ]; then
    printf '\\ttls internal'
  else
    printf '\\ttls {\\n\\t\\tdns %s %s\\n\\t}' "$DNS_PROVIDER" "$DNS_TOKEN"
  fi
}

# ---- 試すとき ----
if [ "${1:-}" = "--render-only" ]; then
  out=${2:?出力先を指定してください}
  [ "${3:-}" = "--answers" ] || die '--answers <ファイル> を指定してください'
  answers=${4:?答えのファイルを指定してください}
  render_all "$answers" "$out" "${NODE_BIN:-node}"
  echo "雛形を埋めました: $out"
  exit 0
fi

# ---- 0. 前提 ----
say 'M2Office ローカルの形のセットアップ'
[ "$(uname -s)" = Darwin ] || die 'macOS で走らせてください'
[ "$(id -u)" -ne 0 ] || die '管理者の権限（sudo）を付けずに、管理者の利用者で走らせてください。要るところだけ sudo を使います'
command -v git >/dev/null || die 'git がありません（xcode-select --install で入ります）'
info "置き場: $INSTALL_DIR"
info "プログラム: $REPO_DIR"
TAG=$(git -C "$REPO_DIR" describe --tags --exact-match 2>/dev/null || true)
if [ -z "$TAG" ]; then
  warn 'リリースのタグではない版を入れようとしています（開発中の枝）。本番ではタグを取ってきてください'
  yes_no 'このまま続けますか' n || exit 1
else
  info "版: $TAG"
fi
sudo -v

# これまでの答え（2 回目から既定にする）
if [ -f "$CONF" ]; then
  # shellcheck disable=SC1090
  . "$CONF"
  info 'これまでの答えを既定にします'
fi

# ---- 1. 尋ねる ----
say '1. 会社と名前'
ask COMPANY_NAME '会社の名前' "${COMPANY_NAME:-}"
ask SUBDOMAIN '会社の短い名前（英小文字・数字・ハイフン、3 文字以上）' "${SUBDOMAIN:-office}"
ask GW_DOMAIN 'Google Workspace のドメイン（例 example.co.jp）' "${GW_DOMAIN:-}"
ask ADMIN_EMAIL '最初の管理者のメールアドレス' "${ADMIN_EMAIL:-}"
ask HOST 'M2Office を開く名前（社内の IP に向ける。例 office.example.co.jp）' "${HOST:-office.${GW_DOMAIN}}"

say '2. 証明書（社内でも HTTPS にします。仕様書 第8.6.2節）'
info 'name: 公的な証明書を DNS で取る（標準。Google のログインが使える）'
info 'ip  : 機械が自分で証明書を出す（Google を使わない会社だけ。端末ごとにルートの証明書を入れる）'
ask TLS_MODE '形（name か ip）' "${TLS_MODE:-name}"
if [ "$TLS_MODE" = name ]; then
  ask DNS_PROVIDER 'DNS の事業者（caddy-dns の名前。例 cloudflare・route53・gandi）' "${DNS_PROVIDER:-cloudflare}"
  ask DNS_TOKEN 'DNS の事業者の API の鍵' "$(env_value DNS_TOKEN_SAVED)" secret
  ask ACME_EMAIL '証明書の連絡先のメールアドレス' "${ACME_EMAIL:-$ADMIN_EMAIL}"
else
  DNS_PROVIDER=''; DNS_TOKEN=''
  ask ACME_EMAIL '証明書の連絡先のメールアドレス（ip の形でも書く）' "${ACME_EMAIL:-$ADMIN_EMAIL}"
fi

say '3. データと控えの置き場'
info 'データは RAID などのディスクに。控えは RAID とは別のディスク（外付けか社内の別の機械）に置きます（第8.6.5節）'
ask DATA_DIR 'データの置き場' "${DATA_DIR:-$INSTALL_DIR/data}"
ask BACKUP_DIR '控えの置き場（空なら控えを取りません）' "${BACKUP_DIR:-}"
ask API_PORT 'API のポート（機械の中だけで使う）' "${API_PORT:-3101}"
ask DB_PORT 'データベースのポート（機械の中だけで使う）' "${DB_PORT:-5433}"

say '4. AI'
info 'ローカル AI（社内の機械で動かす言語モデル。OpenAI 互換の口）を使うなら、その口とモデルを入れます'
ask LOCAL_LLM_URL 'ローカル AI の口（使わないなら空）' "${LOCAL_LLM_URL:-http://127.0.0.1:11434/v1}"
if [ -n "$LOCAL_LLM_URL" ]; then
  ask LOCAL_LLM_MODEL 'ローカル AI のモデル' "${LOCAL_LLM_MODEL:-}"
  ask LOCAL_LLM_EMBED_MODEL '埋め込みのモデル（768 次元。例 embeddinggemma。無ければ空）' "${LOCAL_LLM_EMBED_MODEL:-}"
else
  LOCAL_LLM_MODEL=''; LOCAL_LLM_EMBED_MODEL=''
fi
ask GEMINI_API_KEY 'Gemini の鍵（外部の AI を使う会社だけ。後から管理者ページでも入れられる）' "$(env_value GEMINI_API_KEY)" secret

say '5. Google のログイン（会社の OAuth クライアント。後から管理者ページの「接続」でも入れられる）'
info "戻り先: https://$HOST/v1/oauth/google/login-callback と https://$HOST/v1/oauth/google/callback"
ask GOOGLE_LOGIN_CLIENT_ID 'クライアント ID（後で入れるなら空）' "$(env_value GOOGLE_LOGIN_CLIENT_ID)"
ask GOOGLE_LOGIN_CLIENT_SECRET 'クライアントのシークレット' "$(env_value GOOGLE_LOGIN_CLIENT_SECRET)" secret

say '6. 更新（仕様書 第8.6.4節）'
info '署名つきのリリースのタグを夜に見に行き、あれば入れます。署名を確かめる鍵（allowed_signers）が要ります'
def_signers=${ALLOWED_SIGNERS_SOURCE:-}
[ -z "$def_signers" ] && [ -f "$SCRIPT_DIR/allowed_signers" ] && def_signers="$SCRIPT_DIR/allowed_signers"
ask ALLOWED_SIGNERS_SOURCE '署名を確かめる鍵のファイル（無ければ空。自動の更新は切ります）' "$def_signers"
AUTO_UPDATE=no
if [ -n "$ALLOWED_SIGNERS_SOURCE" ]; then
  [ -f "$ALLOWED_SIGNERS_SOURCE" ] || die "鍵のファイルがありません: $ALLOWED_SIGNERS_SOURCE"
  yes_no '夜に自動で更新しますか' y && AUTO_UPDATE=yes
fi
ask UPDATE_HOUR '自動の更新の時刻（時。0〜23）' "${UPDATE_HOUR:-3}"

say '答えの確かめ'
info "会社: $COMPANY_NAME（$SUBDOMAIN）／ ドメイン: $GW_DOMAIN ／ 管理者: $ADMIN_EMAIL"
info "名前: https://$HOST ／ 証明書: $TLS_MODE ${DNS_PROVIDER:+（$DNS_PROVIDER）}"
info "データ: $DATA_DIR ／ 控え: ${BACKUP_DIR:-（取らない）}"
info "ローカル AI: ${LOCAL_LLM_URL:-（使わない）} ${LOCAL_LLM_MODEL} ／ Gemini の鍵: $( [ -n "$GEMINI_API_KEY" ] && echo 入れる || echo 入れない)"
info "自動の更新: $AUTO_UPDATE（${UPDATE_HOUR} 時）"
yes_no 'この答えで入れますか' y || exit 1

# ---- 2. 前提のソフト（Homebrew） ----
say '前提のソフトを確かめます'
command -v brew >/dev/null || die 'Homebrew がありません。https://brew.sh の手順で入れてから走らせ直してください'
missing=''
for f in "$NODE_FORMULA" "$PG_FORMULA" pgvector caddy; do
  brew list --versions "$f" >/dev/null 2>&1 || missing="$missing $f"
done
if [ -n "$missing" ]; then
  info "足りないもの:$missing"
  yes_no 'Homebrew で入れますか' y || die '前提のソフトが足りません'
  # shellcheck disable=SC2086
  brew install $missing
fi
NODE_BIN="$(brew --prefix "$NODE_FORMULA")/bin/node"
NPM_DIR="$(brew --prefix "$NODE_FORMULA")/bin"
PG_BIN="$(brew --prefix "$PG_FORMULA")/bin"
CADDY_BIN="$(brew --prefix caddy)/bin/caddy"
info "Node.js $("$NODE_BIN" --version) ／ PostgreSQL $("$PG_BIN/postgres" --version | awk '{print $3}') ／ Caddy $("$CADDY_BIN" version | awk '{print $1}')"
if [ "$TLS_MODE" = name ] && ! "$CADDY_BIN" list-modules 2>/dev/null | grep -q "^dns.providers.$DNS_PROVIDER\$"; then
  info "Caddy に DNS の事業者（$DNS_PROVIDER）のつなぎを足します"
  "$CADDY_BIN" add-package "github.com/caddy-dns/$DNS_PROVIDER"
fi

# ---- 3. 秘密の値（機械の上で作る。運営は知らない） ----
SECRET_KEY=$(env_value M2OFFICE_SECRET_KEY)
DB_OWNER_PASSWORD=$(env_value DB_OWNER_PASSWORD_SAVED)
DB_APP_PASSWORD=$(env_value DB_APP_PASSWORD_SAVED)
[ -n "$SECRET_KEY" ] || SECRET_KEY=$(rand_hex 32)
[ -n "$DB_OWNER_PASSWORD" ] || DB_OWNER_PASSWORD=$(rand_hex 24)
[ -n "$DB_APP_PASSWORD" ] || DB_APP_PASSWORD=$(rand_hex 24)

# ---- 4. 専用の利用者と置き場 ----
say '専用の利用者と置き場を用意します'
if ! dscl . -read "/Groups/$SERVICE_USER" >/dev/null 2>&1; then
  gid=400; while dscl . -list /Groups PrimaryGroupID | awk '{print $2}' | grep -qx "$gid"; do gid=$((gid + 1)); done
  sudo dscl . -create "/Groups/$SERVICE_USER" PrimaryGroupID "$gid"
  sudo dscl . -create "/Groups/$SERVICE_USER" RealName 'M2Office'
fi
gid=$(dscl . -read "/Groups/$SERVICE_USER" PrimaryGroupID | awk '{print $2}')
if ! dscl . -read "/Users/$SERVICE_USER" >/dev/null 2>&1; then
  uid=400; while dscl . -list /Users UniqueID | awk '{print $2}' | grep -qx "$uid"; do uid=$((uid + 1)); done
  sudo dscl . -create "/Users/$SERVICE_USER"
  sudo dscl . -create "/Users/$SERVICE_USER" UniqueID "$uid"
  sudo dscl . -create "/Users/$SERVICE_USER" PrimaryGroupID "$gid"
  sudo dscl . -create "/Users/$SERVICE_USER" UserShell /usr/bin/false
  sudo dscl . -create "/Users/$SERVICE_USER" NFSHomeDirectory /var/empty
  sudo dscl . -create "/Users/$SERVICE_USER" RealName 'M2Office'
  sudo dscl . -create "/Users/$SERVICE_USER" IsHidden 1
  info "専用の利用者 $SERVICE_USER を作りました"
fi
for d in postgres files logs caddy machine; do sudo mkdir -p "$DATA_DIR/$d"; done
sudo chown -R "$SERVICE_USER:$SERVICE_USER" "$DATA_DIR"
sudo chmod 700 "$DATA_DIR/postgres"
if [ -n "$BACKUP_DIR" ]; then sudo mkdir -p "$BACKUP_DIR" && sudo chown "$SERVICE_USER:$SERVICE_USER" "$BACKUP_DIR"; fi
sudo mkdir -p "$INSTALL_DIR/front.d"
ALLOWED_SIGNERS=''
if [ -n "$ALLOWED_SIGNERS_SOURCE" ]; then
  ALLOWED_SIGNERS="$INSTALL_DIR/allowed_signers"
  # 鍵は入れたときのものに固定する（リポジトリの中のものが差し替えられても、更新で使わない）
  sudo install -m 644 -o root -g wheel "$ALLOWED_SIGNERS_SOURCE" "$ALLOWED_SIGNERS"
fi

# ---- 5. 設定のファイル ----
say '設定のファイルを作ります'
RELEASE_DIR="$REPO_DIR/dist-release"
work=$(mktemp -d); chmod 700 "$work"
trap 'rm -rf "$work"' EXIT
answers="$work/answers"
{
  for k in INSTALL_DIR REPO_DIR RELEASE_DIR ENV_FILE CADDYFILE DATA_DIR BACKUP_DIR API_PORT DB_PORT HOST SUBDOMAIN ACME_EMAIL \
    NODE_BIN PG_BIN CADDY_BIN LOCAL_LLM_URL LOCAL_LLM_MODEL LOCAL_LLM_EMBED_MODEL GEMINI_API_KEY GOOGLE_LOGIN_CLIENT_ID \
    GOOGLE_LOGIN_CLIENT_SECRET SECRET_KEY DB_APP_PASSWORD DB_OWNER_PASSWORD UPDATE_HOUR; do
    printf '%s=%s\n' "$k" "${!k}"
  done
  printf 'TLS_BLOCK=%s\n' "$(tls_block)"
} > "$answers"
render_all "$answers" "$work/out" "$NODE_BIN"
# 秘密の値の控え（次に走らせたときに作り直さないため。M2Office は読まない名前）
{
  printf '\n# setup.sh が次に走らせたときに使う控え（M2Office は読まない）\n'
  printf 'DB_OWNER_PASSWORD_SAVED=%s\nDB_APP_PASSWORD_SAVED=%s\n' "$DB_OWNER_PASSWORD" "$DB_APP_PASSWORD"
  [ -n "$DNS_TOKEN" ] && printf 'DNS_TOKEN_SAVED=%s\n' "$DNS_TOKEN"
} >> "$work/out/m2office.env"
sudo install -m 640 -o root -g "$SERVICE_USER" "$work/out/m2office.env" "$ENV_FILE"
sudo install -m 600 -o root -g wheel "$work/out/Caddyfile" "$CADDYFILE"
# 答えの控え（秘密の値は入れない。update.sh も読む）
conf="$work/setup.conf"
{
  printf '# M2Office ローカルの形の答え（setup.sh が書く。秘密の値は m2office.env にだけ置く）\n'
  for k in COMPANY_NAME SUBDOMAIN GW_DOMAIN ADMIN_EMAIL HOST TLS_MODE DNS_PROVIDER ACME_EMAIL DATA_DIR BACKUP_DIR API_PORT DB_PORT \
    LOCAL_LLM_URL LOCAL_LLM_MODEL LOCAL_LLM_EMBED_MODEL ALLOWED_SIGNERS_SOURCE ALLOWED_SIGNERS AUTO_UPDATE UPDATE_HOUR \
    INSTALL_DIR REPO_DIR RELEASE_DIR ENV_FILE NODE_BIN NPM_DIR PG_BIN CADDY_BIN SERVICE_USER; do
    printf "%s='%s'\n" "$k" "$(printf '%s' "${!k}" | sed "s/'/'\\\\''/g")"
  done
} > "$conf"
sudo install -m 644 -o root -g wheel "$conf" "$CONF"
printf '{"auto":%s,"signed":%s,"hour":%s}\n' "$( [ "$AUTO_UPDATE" = yes ] && echo true || echo false)" \
  "$( [ -n "$ALLOWED_SIGNERS" ] && echo true || echo false)" "$UPDATE_HOUR" > "$work/update-settings.json"
sudo install -m 644 -o "$SERVICE_USER" -g "$SERVICE_USER" "$work/update-settings.json" "$DATA_DIR/machine/update-settings.json"

# launchd の設定を入れて（入れ直して）動かす
load_daemon() {
  local label=$1
  sudo install -m 644 -o root -g wheel "$work/out/launchd/$label.plist" "$DAEMONS/$label.plist"
  sudo launchctl bootout "system/$label" >/dev/null 2>&1 || true
  sudo launchctl bootstrap system "$DAEMONS/$label.plist"
}

# ---- 6. データベース ----
say 'データベースを用意します'
if ! sudo test -f "$DATA_DIR/postgres/PG_VERSION"; then
  pw="$work/pw"; printf '%s' "$DB_OWNER_PASSWORD" > "$pw"; sudo chown "$SERVICE_USER" "$pw"
  sudo -u "$SERVICE_USER" "$PG_BIN/initdb" -D "$DATA_DIR/postgres" -U m2office --auth=scram-sha-256 --pwfile="$pw" -E UTF8 --locale=C >/dev/null
  sudo rm -f "$pw"
  info 'データベースを作りました'
fi
load_daemon jp.m2office.postgres
for _ in $(seq 1 30); do "$PG_BIN/pg_isready" -h 127.0.0.1 -p "$DB_PORT" >/dev/null 2>&1 && break; sleep 1; done
"$PG_BIN/pg_isready" -h 127.0.0.1 -p "$DB_PORT" >/dev/null || die "データベースが起動しません（$DATA_DIR/logs/postgres.log を見てください）"
export PGPASSWORD=$DB_OWNER_PASSWORD
psql() { "$PG_BIN/psql" -h 127.0.0.1 -p "$DB_PORT" -U m2office -v ON_ERROR_STOP=1 -qtA "$@"; }
[ "$(psql -d postgres -c "select 1 from pg_database where datname = 'm2office'")" = 1 ] || psql -d postgres -c 'create database m2office'
if psql -d m2office -c 'create extension if not exists vector' >/dev/null 2>&1; then
  info 'pgvector を有効にしました（知識の意味の検索）'
else
  warn 'pgvector を有効にできませんでした。知識は言葉の検索だけで動きます（brew install pgvector を確かめてください）'
fi
unset PGPASSWORD

# ---- 7. 組み立てと移行と会社 ----
say '本番の組み立てを作ります（数分かかります）'
(cd "$REPO_DIR" && PATH="$NPM_DIR:$PATH" npm ci --no-audit --no-fund >/dev/null && PATH="$NPM_DIR:$PATH" npm run build:release -- --install >/dev/null)
info "組み立てました: $RELEASE_DIR"
as_service() { sudo -u "$SERVICE_USER" env PATH="$NPM_DIR:/usr/bin:/bin" "$NODE_BIN" --env-file="$ENV_FILE" "$@"; }
say 'データベースの形を最新にします'
as_service "$REPO_DIR/scripts/migrate.mjs" | tail -1
as_service "$REPO_DIR/scripts/create-tenant.mjs" --subdomain "$SUBDOMAIN" --name "$COMPANY_NAME" --domain "$GW_DOMAIN" --admin "$ADMIN_EMAIL" | tail -2

# ---- 8. 動かす ----
say 'M2Office を動かします'
for label in jp.m2office.api jp.m2office.worker jp.m2office.caddy; do load_daemon "$label"; done
if [ "$AUTO_UPDATE" = yes ]; then
  load_daemon jp.m2office.update
else
  sudo launchctl bootout system/jp.m2office.update >/dev/null 2>&1 || true
  sudo rm -f "$DAEMONS/jp.m2office.update.plist"
fi

# ---- 9. 動きを確かめる ----
say '動きを確かめます'
ok=0
for _ in $(seq 1 60); do curl -fsS "http://127.0.0.1:$API_PORT/health" >/dev/null 2>&1 && { ok=1; break; }; sleep 1; done
[ "$ok" = 1 ] && info 'API: 動いています' || warn "API が答えません（$DATA_DIR/logs/api.log を見てください）"
sleep 5
if sudo test -f "$DATA_DIR/machine/worker.json"; then info 'ワーカー: 動いています'; else warn "ワーカーの知らせがまだありません（$DATA_DIR/logs/worker.log を見てください）"; fi
ok=0
insecure=''; [ "$TLS_MODE" = ip ] && insecure=-k
for _ in $(seq 1 24); do
  # shellcheck disable=SC2086
  curl -fsS --max-time 5 --resolve "$HOST:443:127.0.0.1" $insecure "https://$HOST/health" >/dev/null 2>&1 && { ok=1; break; }
  sleep 5
done
[ "$ok" = 1 ] && info "入口と証明書: https://$HOST で開けます" || warn "入口がまだ答えません。証明書を取るのに時間がかかることがあります（$DATA_DIR/logs/caddy-run.log を見てください）"
if [ -n "$LOCAL_LLM_URL" ]; then
  curl -fsS --max-time 5 "$LOCAL_LLM_URL/models" >/dev/null 2>&1 && info 'ローカル AI: 答えます' || warn "ローカル AI が答えません（$LOCAL_LLM_URL）"
fi

say '入れ終わりました'
info "開く: https://$HOST （最初の管理者 $ADMIN_EMAIL で Google のログイン）"
info "設定: $ENV_FILE（管理者だけが読める）／ 答え: $CONF ／ ログ: $DATA_DIR/logs"
info '残りの作業:'
info "  - DNS: $HOST を、この機械の社内の IP に向ける（公開の DNS に A レコード。ルーターの DNS リバインディングの対策も確かめる）"
info '  - ルーター: DHCP の予約で、この機械にいつも同じ IP を割り当てる'
[ -z "$GOOGLE_LOGIN_CLIENT_ID" ] && info '  - Google: 会社の OAuth クライアントを作り、管理者ページの「接続」で入れる'
[ -z "$BACKUP_DIR" ] && info '  - 控え: 控えの置き場を決めて、setup.sh を走らせ直す'
[ "$AUTO_UPDATE" = no ] && info '  - 更新: 署名を確かめる鍵が入るまで、自動の更新は切っています（手で update.sh を走らせる）'
if yes_no '紙の「戻すための控え」に書き写す秘密の値を、いま画面に出しますか' n; then
  info "M2OFFICE_SECRET_KEY: $SECRET_KEY"
  info "データベースの所有者の合言葉: $DB_OWNER_PASSWORD"
  info '書き写したら画面を消してください。運営はこれを持ちません'
fi
