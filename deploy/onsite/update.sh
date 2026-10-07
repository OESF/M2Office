#!/bin/bash
# @file ローカルの形の更新（仕様書 第8.6.4節、ADR-0077）。署名つきのリリースのタグを取ってきて、組み立て直して入れる。
#
# 使い方:
#   sudo deploy/onsite/update.sh                  # いちばん新しいリリースのタグを入れる（技術者が手で）
#   sudo deploy/onsite/update.sh --tag v0.19.0    # 決めたタグを入れる
#   sudo deploy/onsite/update.sh --check          # 新しいタグがあるかだけを見る
#   sudo deploy/onsite/update.sh --allow-unsigned # 署名の鍵が入っていない機械で、手で入れる（自動では使えない）
#   （夜の自動の更新は launchd が --auto で呼ぶ。会社の管理者が「機械」で止めていれば飛ばす）
#
# 流れ: タグを取る → 署名を確かめる → 控えを取る → 止める → 切り替えて組み立て直す → データベースの移行 → 動かす → 確かめる。
# 確かめに失敗したら、前のタグと更新の前の控えに戻し、結果を「機械」の置き場の update.json に書く（ワーカーが会社の管理者に知らせる）。

set -uo pipefail

# 走っている間に自分自身（リポジトリの中のこのファイル）が入れ替わるため、写しに移って走る
if [ -z "${M2O_UPDATE_COPY:-}" ]; then
  copy=$(mktemp -t m2o-update); cp "$0" "$copy"
  M2O_UPDATE_COPY=1 exec /bin/bash "$copy" "$@"
fi

AUTO=0; CHECK=0; ALLOW_UNSIGNED=0; WANT=''; CONF=''
while [ $# -gt 0 ]; do
  case "$1" in
    --auto) AUTO=1 ;;
    --check) CHECK=1 ;;
    --allow-unsigned) ALLOW_UNSIGNED=1 ;;
    --tag) WANT=${2:-}; shift ;;
    --config) CONF=${2:-}; shift ;;
    *) echo "知らない指定: $1" >&2; exit 2 ;;
  esac
  shift
done
[ "$(id -u)" -eq 0 ] || { echo '管理者の権限（sudo）で走らせてください' >&2; exit 1; }
CONF=${CONF:-/Library/M2Office/setup.conf}
[ -f "$CONF" ] || { echo "答えのファイルがありません: $CONF（先に setup.sh を走らせてください）" >&2; exit 1; }
# shellcheck disable=SC1090
. "$CONF"

MACHINE_DIR="$DATA_DIR/machine"
NOW=$(date -u +%Y-%m-%dT%H:%M:%SZ)
OWNER=$(stat -f %Su "$REPO_DIR")
log() { printf '%s %s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$*"; }
as_owner() { sudo -H -u "$OWNER" env PATH="$NPM_DIR:/usr/bin:/bin:/usr/sbin:/sbin" "$@"; }
git_() { as_owner git -C "$REPO_DIR" "$@"; }

# 結果を update.json に足す（新しい 10 回分を残す）
record() {
  local result=$1 from=$2 to=$3 error=${4:-}
  "$NODE_BIN" -e '
    const fs = require("fs"); const [file, at, result, from, to, error] = process.argv.slice(1);
    let d = { history: [] }; try { d = JSON.parse(fs.readFileSync(file, "utf8")); } catch {}
    const r = { at, from, to, result, ...(error ? { error } : {}) };
    if (result === "none") d.checkedAt = at; else d.history = [...(d.history ?? []), r].slice(-10);
    fs.writeFileSync(file, JSON.stringify(d));
  ' "$MACHINE_DIR/update.json" "$NOW" "$result" "$from" "$to" "$error"
  chown "$SERVICE_USER:$SERVICE_USER" "$MACHINE_DIR/update.json" 2>/dev/null || true
}

# 自動の更新は、会社の管理者が止めている間は飛ばす
if [ "$AUTO" = 1 ]; then
  [ "${AUTO_UPDATE:-no}" = yes ] || { log '自動の更新は切っています'; exit 0; }
  held=$("$NODE_BIN" -e 'try { const h = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")); process.stdout.write(h.until && Date.parse(h.until) > Date.now() ? h.until : ""); } catch {}' "$MACHINE_DIR/update-hold.json")
  [ -z "$held" ] || { log "会社の管理者が $held まで止めています"; exit 0; }
fi

FROM=$(git_ describe --tags --exact-match HEAD 2>/dev/null || git_ rev-parse --short HEAD)
log "いまの版: $FROM"
git_ fetch --tags --force --quiet origin || { record failed "$FROM" '' 'リリースのタグを取れませんでした'; log 'タグを取れませんでした'; exit 1; }
TO=${WANT:-$(git_ tag -l 'v[0-9]*' --sort=-v:refname | grep -E '^v[0-9]+\.[0-9]+\.[0-9]+$' | head -1)}
[ -n "$TO" ] || { log 'リリースのタグがありません'; exit 0; }
if [ "$TO" = "$FROM" ]; then
  log "新しい版はありません（$FROM）"
  [ "$AUTO" = 1 ] && record none "$FROM" "$TO"
  exit 0
fi
log "新しい版: $TO"
[ "$CHECK" = 1 ] && exit 0

# 署名を確かめる（鍵は setup.sh が入れたときのものに固定している）
if [ -n "${ALLOWED_SIGNERS:-}" ] && [ -f "$ALLOWED_SIGNERS" ]; then
  if ! git_ -c gpg.format=ssh -c "gpg.ssh.allowedSignersFile=$ALLOWED_SIGNERS" verify-tag "$TO" >/dev/null 2>&1; then
    record failed "$FROM" "$TO" 'タグの署名を確かめられませんでした'
    log "タグ $TO の署名を確かめられません。入れません"; exit 1
  fi
  log '署名を確かめました'
elif [ "$AUTO" = 1 ] || [ "$ALLOW_UNSIGNED" = 0 ]; then
  record failed "$FROM" "$TO" '署名を確かめる鍵が入っていません'
  log '署名を確かめる鍵が入っていません。手で入れるときは --allow-unsigned を付けてください'; exit 1
else
  log '注意: 署名を確かめずに入れます（--allow-unsigned）'
fi

# 控え（データベース）。直近の 3 回を残す
OWNER_URL=$(grep -E '^MIGRATION_DATABASE_URL=' "$ENV_FILE" | cut -d= -f2-)
mkdir -p "${BACKUP_DIR:-$DATA_DIR}/pre-update"
DUMP="${BACKUP_DIR:-$DATA_DIR}/pre-update/$(date +%Y%m%d-%H%M%S)-$FROM.dump"
"$PG_BIN/pg_dump" -Fc -f "$DUMP" "$OWNER_URL" || { record failed "$FROM" "$TO" '更新の前の控えを取れませんでした'; log '控えを取れません。入れません'; exit 1; }
ls -1t "$(dirname "$DUMP")"/*.dump 2>/dev/null | tail -n +4 | xargs rm -f
log "控えを取りました: $DUMP"

daemon() { launchctl "$1" system "/Library/LaunchDaemons/$2.plist" >/dev/null 2>&1 || launchctl "$1" "system/$2" >/dev/null 2>&1 || true; }
stop_app() { launchctl bootout system/jp.m2office.api >/dev/null 2>&1 || true; launchctl bootout system/jp.m2office.worker >/dev/null 2>&1 || true; }
start_app() { daemon bootstrap jp.m2office.api; daemon bootstrap jp.m2office.worker; }
build() {
  git_ checkout --quiet --detach "$1" && (cd "$REPO_DIR" && as_owner npm ci --no-audit --no-fund >/dev/null 2>&1 && as_owner npm run build:release -- --install >/dev/null 2>&1)
}
migrate() { sudo -u "$SERVICE_USER" env PATH="$NPM_DIR:/usr/bin:/bin" "$NODE_BIN" --env-file="$ENV_FILE" "$REPO_DIR/scripts/migrate.mjs" >/dev/null; }
healthy() {
  local i
  for i in $(seq 1 60); do curl -fsS "http://127.0.0.1:$API_PORT/health" >/dev/null 2>&1 && return 0; sleep 2; done
  return 1
}
rollback() {
  local why=$1
  log "失敗しました（$why）。前の版 $FROM に戻します"
  stop_app
  build "$FROM" || log '前の版の組み立てにも失敗しました。技術者が手で戻してください'
  "$PG_BIN/pg_restore" --clean --if-exists --no-owner -d "$OWNER_URL" "$DUMP" >/dev/null 2>&1 || log '控えの戻しで警告がありました'
  start_app
  if healthy; then record rolled-back "$FROM" "$TO" "$why"; log "前の版 $FROM に戻しました"
  else record failed "$FROM" "$TO" "$why。前の版に戻しても動きません"; log '前の版に戻しても動きません。技術者が手で確かめてください'; fi
  exit 1
}

stop_app
log "$TO に切り替えて組み立てます"
build "$TO" || rollback '組み立てに失敗しました'
migrate || rollback 'データベースの移行に失敗しました'
start_app
healthy || rollback '新しい版が動きませんでした'
record updated "$FROM" "$TO"
log "$TO を入れました"
