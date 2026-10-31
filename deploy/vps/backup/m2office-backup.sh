#!/bin/bash
# @file クラウドの形の社外の控え（仕様書 第20.4.6節「控え」、ADR-0120）。データベースを pgBackRest で、ファイルを restic で、Google Cloud Storage の東京へ送る。
#
# setup.sh が /usr/local/sbin/m2office-backup に入れ、m2office-backup.timer が毎晩 1 回呼ぶ。管理者の権限で走らせる。
#   m2office-backup            毎晩の控え（データベースのまるごと・ファイル）。月が変わって初めての回は、壊れていないかも確かめる
#   m2office-backup --check    壊れていないかだけを確かめる
#   m2office-backup --status   最後の結果を表示する（失敗か 26 時間より古ければ 1 で終わる。見張りの道具から呼ぶ）
#
# データベースの変更の記録（WAL）は、PostgreSQL が archive_command で絶えず送る（この台本は呼ばない）。
# 結果は /var/lib/m2office/machine/cloud-backup.json に書き、運営の画面の「稼働状況」に出す。合言葉と鍵は引数やログに出さない。

set -uo pipefail

BACKUP_ENV=/etc/m2office/backup.env
STANZA=m2office
STATUS_FILE=/var/lib/m2office/machine/cloud-backup.json
# restic の残し方（ファイル。30 日分）
KEEP=(--keep-daily 30)
CHECK_SUBSET=5%

[ "$(id -u)" -eq 0 ] || { echo '管理者の権限（sudo）で走らせてください' >&2; exit 1; }

now() { date -u +%Y-%m-%dT%H:%M:%SZ; }
# 理由は最後の 2 行だけを短くして残す（合言葉は restic も pgBackRest も出さない）
reason() { tail -n 2 "$1" | tr '\n"\\' '  ' | cut -c1-300; }

status() {
  if [ ! -f "$STATUS_FILE" ]; then echo '社外の控え: まだ取っていません'; exit 1; fi
  node -e '
    const s = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
    const age = (Date.now() - Date.parse(s.at)) / 3600000;
    console.log(`社外の控え: ${s.ok ? "取れました" : "失敗しました"}（${s.at}。データベース ${s.database.ok ? "済み" : "失敗"}・ファイル ${s.files.ok ? "済み" : "失敗"}）`);
    if (s.check) console.log(`壊れていないかの確かめ: ${s.check.ok ? "通りました" : "失敗しました"}（${s.check.at}）`);
    const inv = s.inventory;
    if (inv && inv.database) console.log(`データベース: まるごとの控え ${inv.database.count} 回。${inv.database.oldest ?? "—"} から後に戻せる`);
    if (inv && inv.files) console.log(`ファイル: ${inv.files.count} 回（${inv.files.oldest ?? "—"} 〜 ${inv.files.newest ?? "—"}）`);
    process.exit(s.ok && age < 26 ? 0 : 1);
  ' "$STATUS_FILE"
}

[ "${1:-}" = --status ] && status

[ -f "$BACKUP_ENV" ] || { echo "社外の控えの設定（${BACKUP_ENV}）がありません。setup.sh で入れてください" >&2; exit 1; }
set -a
# shellcheck disable=SC1090
. "$BACKUP_ENV"
set +a
: "${M2O_FILES_DIR:?}"

work=$(mktemp -d); trap 'rm -rf "$work"' EXIT
prev_check=''
[ -f "$STATUS_FILE" ] && prev_check=$(node -e 'const s = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")); process.stdout.write(s.check ? s.check.at : "")' "$STATUS_FILE" 2>/dev/null || true)

# 壊れていないかを確かめる（restic は中身の一部を読み戻し、pgBackRest は控えと WAL を読む）
check() {
  local ok=true err=''
  restic check --read-data-subset="$CHECK_SUBSET" >"$work/rc" 2>&1 || { ok=false; err="ファイル: $(reason "$work/rc")"; }
  sudo -u postgres pgbackrest --stanza="$STANZA" verify >"$work/pv" 2>&1 || { ok=false; err="${err:+$err ／ }データベース: $(reason "$work/pv")"; }
  printf '{"at":"%s","ok":%s,"error":%s}' "$(now)" "$ok" "$( [ -n "$err" ] && printf '"%s"' "$err" || echo null)"
}

write_status() {
  local tmp="$STATUS_FILE.tmp"
  printf '%s\n' "$1" > "$tmp" && chmod 644 "$tmp" && mv "$tmp" "$STATUS_FILE"
}

if [ "${1:-}" = --check ]; then
  c=$(check)
  if [ -f "$STATUS_FILE" ]; then
    write_status "$(node -e 'const s = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")); s.check = JSON.parse(process.argv[2]); process.stdout.write(JSON.stringify(s))' "$STATUS_FILE" "$c")"
  fi
  echo "$c"
  node -e 'process.exit(JSON.parse(process.argv[1]).ok ? 0 : 1)' "$c"
  exit $?
fi

started=$(now)
# データベース: まるごとの控え。残す長さ（14 日）を過ぎた古い控えと WAL は、pgBackRest が自分で消す
db_ok=true; db_err=null
if ! sudo -u postgres pgbackrest --stanza="$STANZA" --type=full backup >"$work/pb" 2>&1; then
  db_ok=false; db_err="\"$(reason "$work/pb")\""
fi
# ファイル: 変わったところだけを送り、30 日を過ぎた回を消す
files_ok=true; files_err=null; snapshot=null
if restic backup --json --tag m2office --host m2office "$M2O_FILES_DIR" >"$work/rb" 2>"$work/rbe"; then
  snapshot=$(node -e '
    const lines = require("fs").readFileSync(process.argv[1], "utf8").trim().split("\n").reverse();
    for (const l of lines) { try { const j = JSON.parse(l); if (j.message_type === "summary") { process.stdout.write(JSON.stringify(j.snapshot_id ?? null)); process.exit(0); } } catch {} }
    process.stdout.write("null");
  ' "$work/rb")
  restic forget --tag m2office --group-by host,tags "${KEEP[@]}" --prune >"$work/rf" 2>&1 || { files_ok=false; files_err="\"古い控えを消せません: $(reason "$work/rf")\""; }
else
  files_ok=false; files_err="\"$(reason "$work/rbe")\""
fi

# 月が変わって初めての回の後に、壊れていないかを確かめる（日本時間の月で数える）
month() { TZ=Asia/Tokyo date -d "$1" +%Y-%m 2>/dev/null; }
check_json=null
if [ -n "$prev_check" ] && [ "$(month "$prev_check")" = "$(TZ=Asia/Tokyo date +%Y-%m)" ]; then
  check_json=$(node -e 'process.stdout.write(JSON.stringify(JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")).check ?? null))' "$STATUS_FILE")
elif $db_ok && $files_ok; then
  check_json=$(check)
fi

# 置き場にあるもの（運営の画面の「戻せる範囲」と控えの数。第23.8.7節「控えの様子」）。読めなければその分を null にする
sudo -u postgres pgbackrest --stanza="$STANZA" info --output=json >"$work/pi" 2>/dev/null || : >"$work/pi"
restic snapshots --json --tag m2office >"$work/rs" 2>/dev/null || : >"$work/rs"
restic stats --mode raw-data --json >"$work/rst" 2>/dev/null || : >"$work/rst"
inventory=$(node -e '
  const fs = require("fs");
  const rd = (f) => { try { return JSON.parse(fs.readFileSync(f, "utf8")); } catch { return null; } };
  const iso = (s) => new Date(s * 1000).toISOString();
  const [pi, rs, rst, repo, project] = [rd(process.argv[1]), rd(process.argv[2]), rd(process.argv[3]), process.argv[4], process.argv[5]];
  const st = Array.isArray(pi) ? pi.find((s) => s.name === "m2office") : null;
  const b = st && Array.isArray(st.backup) ? st.backup : [];
  // いちばん古いまるごとの控えが終わった時刻から後に戻せる
  const database = st ? { count: b.length, oldest: b.length ? iso(b[0].timestamp.stop) : null, newest: b.length ? iso(b[b.length - 1].timestamp.stop) : null,
    bytes: b.reduce((n, x) => n + ((x.info && x.info.repository && x.info.repository.delta) || 0), 0) } : null;
  const snaps = Array.isArray(rs) ? rs.map((s) => new Date(s.time).toISOString()).sort() : null;
  const files = snaps ? { count: snaps.length, oldest: snaps[0] || null, newest: snaps[snaps.length - 1] || null, bytes: rst && typeof rst.total_size === "number" ? rst.total_size : null } : null;
  const m = /^gs:([^:]+):/.exec(repo || "");
  process.stdout.write(JSON.stringify({ location: m ? { kind: "gcs", bucket: m[1], project: project || null } : null, database, files }));
' "$work/pi" "$work/rs" "$work/rst" "${RESTIC_REPOSITORY:-}" "${GOOGLE_PROJECT_ID:-}" 2>/dev/null || echo null)

ok=false; $db_ok && $files_ok && ok=true
write_status "$(printf '{"at":"%s","startedAt":"%s","ok":%s,"database":{"ok":%s,"error":%s},"files":{"ok":%s,"error":%s,"snapshot":%s},"check":%s,"inventory":%s}' \
  "$(now)" "$started" "$ok" "$db_ok" "$db_err" "$files_ok" "$files_err" "$snapshot" "$check_json" "$inventory")"
if $ok; then echo '社外の控えを取りました'; exit 0; fi
echo '社外の控えに失敗しました' >&2
cat "$STATUS_FILE" >&2
exit 1
