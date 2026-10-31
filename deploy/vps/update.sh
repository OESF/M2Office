#!/bin/bash
# @file クラウドの形の更新（Xserver の VPS。仕様書 第20.4.6節「更新」、ADR-0113）。リリースのタグを取ってきて、組み立て直して入れる。
#
# 使い方（技術者が VPS の上で。管理者の権限で走らせる）:
#   sudo /opt/m2office/app/deploy/vps/update.sh --check                          # 新しいタグがあるかだけを見る
#   sudo /opt/m2office/app/deploy/vps/update.sh --tag v0.21.0 --allow-unsigned  # 決めたタグを入れる（署名を始める v1.0 までは --allow-unsigned を付ける）
#   sudo /opt/m2office/app/deploy/vps/update.sh --allow-unsigned                 # いちばん新しいリリースのタグを入れる
#
# 流れ: タグを取る → 署名を確かめる → 控えを取る → 止める → 切り替えて組み立て直す → データベースの移行 → 動かす → 確かめる。
# 確かめに失敗したら、前の版と更新の前の控えに戻す。夜の自動の更新は、タグへの署名を始める v1.0 から入れる（第20.4.6節）。
# 社外の控えの置き場を決めるまでは、更新の前の控え（pg_dump）を VPS の中に取る（直近の 3 回。root だけが読める）。

set -uo pipefail

# 走っている間に自分自身（リポジトリの中のこのファイル）が入れ替わるため、置き場を覚えてから写しに移って走る
if [ -z "${M2O_UPDATE_COPY:-}" ]; then
  repo=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
  copy=$(mktemp -t m2o-update.XXXXXX); cp "$0" "$copy"
  M2O_UPDATE_COPY=1 M2O_REPO_DIR="$repo" exec /bin/bash "$copy" "$@"
fi

CHECK=0; ALLOW_UNSIGNED=0; WANT=''
while [ $# -gt 0 ]; do
  case "$1" in
    --check) CHECK=1 ;;
    --allow-unsigned) ALLOW_UNSIGNED=1 ;;
    --tag) WANT=${2:-}; shift ;;
    *) echo "知らない指定: $1" >&2; exit 2 ;;
  esac
  shift
done
[ "$(id -u)" -eq 0 ] || { echo '管理者の権限（sudo）で走らせてください' >&2; exit 1; }

REPO_DIR=$M2O_REPO_DIR
ENV_FILE=/etc/m2office/m2office.env
ALLOWED_SIGNERS=/etc/m2office/allowed_signers
BACKUP_DIR=/var/backups/m2office/pre-update
LOG_FILE=/var/log/m2office/update.log
SERVICE_USER=m2office
PG_BIN=/usr/lib/postgresql/17/bin
SERVICES='m2office-api m2office-worker m2office-ops'
API_PORT=$(grep -E '^API_PORT=' "$ENV_FILE" | cut -d= -f2-); API_PORT=${API_PORT:-3101}
OPS_PORT=$(grep -E '^OPS_PORT=' "$ENV_FILE" | cut -d= -f2-); OPS_PORT=${OPS_PORT:-3102}
OWNER=$(stat -c %U "$REPO_DIR")

log() { printf '%s %s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$*" | tee -a "$LOG_FILE"; }
as_owner() { sudo -H -u "$OWNER" "$@"; }
git_() { as_owner git -C "$REPO_DIR" "$@"; }

FROM=$(git_ describe --tags --exact-match HEAD 2>/dev/null || git_ rev-parse --short HEAD)
log "いまの版: $FROM"
git_ fetch --tags --force --quiet origin || { log 'リリースのタグを取れませんでした'; exit 1; }
TO=${WANT:-$(git_ tag -l 'v[0-9]*' --sort=-v:refname | grep -E '^v[0-9]+\.[0-9]+\.[0-9]+$' | head -1)}
[ -n "$TO" ] || { log 'リリースのタグがありません'; exit 0; }
git_ rev-parse --verify --quiet "refs/tags/$TO" >/dev/null || { log "タグ $TO がありません"; exit 1; }
if [ "$TO" = "$FROM" ]; then log "新しい版はありません（${FROM}）"; exit 0; fi
log "入れる版: $TO"
[ "$CHECK" = 1 ] && exit 0

# 署名を確かめる（鍵は導入のときに固定した一覧。v1.0 から）
if [ -f "$ALLOWED_SIGNERS" ]; then
  git_ -c gpg.format=ssh -c "gpg.ssh.allowedSignersFile=$ALLOWED_SIGNERS" verify-tag "$TO" >/dev/null 2>&1 \
    || { log "タグ $TO の署名を確かめられません。入れません"; exit 1; }
  log '署名を確かめました'
elif [ "$ALLOW_UNSIGNED" = 0 ]; then
  log '署名を確かめる鍵が入っていません。v1.0 より前のタグは --allow-unsigned を付けて入れてください'; exit 1
else
  log '注意: 署名を確かめずに入れます（--allow-unsigned）'
fi

# 更新の前の控え（データベース）。会社の全データなので root だけが読める置き場に取り、直近の 3 回を残す。
# 控えを取る間だけ umask 077 にし、すぐ戻す（戻さずに組み立てると、m2office がプログラムを読めなくなる。2026-10-29 に実機で起きた）
umask 077
mkdir -p "$BACKUP_DIR"; chmod 700 "$(dirname "$BACKUP_DIR")" "$BACKUP_DIR"
DUMP="$BACKUP_DIR/$(date +%Y%m%d-%H%M%S)-$FROM.dump"
OWNER_URL=$(grep -E '^MIGRATION_DATABASE_URL=' "$ENV_FILE" | cut -d= -f2-)
# パスワードはコマンドの引数に出さず（ps で見えるため）、環境の変数で渡す
OWNER_PASS=$(node -e 'process.stdout.write(decodeURIComponent(new URL(process.argv[1]).password))' "$OWNER_URL")
OWNER_NOPASS=$(node -e 'const u = new URL(process.argv[1]); u.password = ""; process.stdout.write(u.toString())' "$OWNER_URL")
PGPASSWORD="$OWNER_PASS" "$PG_BIN/pg_dump" -Fc -f "$DUMP" "$OWNER_NOPASS" || { log '更新の前の控えを取れません。入れません'; exit 1; }
ls -1t "$BACKUP_DIR"/*.dump 2>/dev/null | tail -n +4 | xargs -r rm -f
umask 022
log "控えを取りました: $DUMP"
# 社外の控えを入れていれば、戻す点に名前を付けて変更の記録を区切って送る（第20.4.6節「控え」の「更新の前」。pgBackRest の --type=name で、この時点に戻せる）
if [ -f /etc/pgbackrest/pgbackrest.conf ]; then
  if (cd / && sudo -u postgres psql -qtA -d m2office -c "select pg_create_restore_point('update-$TO')" -c 'select pg_switch_wal()' >/dev/null 2>&1); then
    lsn=$(cd / && sudo -u postgres psql -qtA -c 'select pg_current_wal_lsn()' 2>/dev/null)
    log "戻す点を記録しました: update-${TO}（${lsn}）"
    # 運営の画面の「社外の控え」に出す（第23.8.7節「控えの様子」。直近の 20 件）
    node -e '
      const fs = require("fs"); const [f, name, lsn] = process.argv.slice(1);
      let a = []; try { a = JSON.parse(fs.readFileSync(f, "utf8")); } catch {}
      a.push({ name, at: new Date().toISOString(), lsn: lsn || null });
      fs.writeFileSync(f + ".tmp", JSON.stringify(a.slice(-20)) + "\n"); fs.chmodSync(f + ".tmp", 0o644); fs.renameSync(f + ".tmp", f);
    ' /var/lib/m2office/machine/restore-points.json "update-$TO" "$lsn" || log '注意: 戻す点を運営の画面に出すファイルに書けませんでした'
  else
    log '注意: 戻す点を記録できませんでした（社外の控えの変更の記録は送り続けます）'
  fi
fi

stop_app() { systemctl stop $SERVICES; }
start_app() { systemctl start $SERVICES; }
# 切り替えと組み立ては、ほかの利用者（m2office）も読める権限で作り、前に読めなくなったファイルも読めるように戻す
build() {
  as_owner bash -c 'umask 022 && cd "$1" && git checkout --quiet --detach "$2" && npm ci --no-audit --no-fund >/dev/null 2>&1 && npm run build:release -- --install >/dev/null 2>&1' _ "$REPO_DIR" "$1" \
    && as_owner chmod -R go+rX "$REPO_DIR"
}
migrate() { (cd / && sudo -u "$SERVICE_USER" node --env-file="$ENV_FILE" "$REPO_DIR/scripts/migrate.mjs" >/dev/null); }
healthy() {
  local i
  for i in $(seq 1 60); do
    curl -fsS "http://127.0.0.1:$API_PORT/health" >/dev/null 2>&1 && curl -fsS "http://127.0.0.1:$OPS_PORT/health" >/dev/null 2>&1 \
      && systemctl is-active --quiet m2office-worker && return 0
    sleep 2
  done
  return 1
}
rollback() {
  local why=$1
  log "失敗しました（${why}）。前の版 $FROM に戻します"
  stop_app
  build "$FROM" || log '前の版の組み立てにも失敗しました。技術者が手で戻してください'
  PGPASSWORD="$OWNER_PASS" "$PG_BIN/pg_restore" --clean --if-exists --no-owner -d "$OWNER_NOPASS" "$DUMP" >/dev/null 2>&1 || log '控えの戻しで警告がありました'
  start_app
  if healthy; then log "前の版 $FROM に戻しました"; else log '前の版に戻しても動きません。技術者が手で確かめてください'; fi
  exit 1
}

# 止めている間は、Caddy が「ただいま更新中です」を返す
stop_app
log "$TO に切り替えて組み立てます"
build "$TO" || rollback '組み立てに失敗しました'
migrate || rollback 'データベースの移行に失敗しました'
start_app
healthy || rollback '新しい版が動きませんでした'
log "$TO を入れました"
# 雛形（Caddy・systemd・設定のファイル）が変わった版では、setup.sh で入れ直す
if ! git_ diff --quiet "$FROM" "$TO" -- deploy/vps 2>/dev/null; then
  log "注意: この版で deploy/vps の雛形が変わっています。$REPO_DIR/deploy/vps/setup.sh を走らせ直してください（前の答えのまま Enter で進めます）"
fi
