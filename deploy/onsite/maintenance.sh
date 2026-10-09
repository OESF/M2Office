#!/bin/bash
# @file 遠隔の保守のトンネル（Tailscale）を開け閉めする（仕様書 第8.6.4節「遠隔の保守」）。launchd が管理者の権限で 30 秒ごとに呼ぶ。
#
# 会社の管理者が管理者ページの「機械」で開けた印を見て、期限まで開け、切れたら閉じる。ふだんは閉じている。
# 運営は自分で開けられない（印は会社の管理者だけが書ける）。開けた回と話した相手は maintenance.json に残し、ワーカーが監査ログに写す。
# 同じ機械の M2Medical が遠隔の保守を持つとき（/Library/M2Front/maintenance-owner）は、トンネルに触れない。
#
# 使い方: sudo deploy/onsite/maintenance.sh --config /Library/M2Office/setup.conf

set -uo pipefail
CONF=/Library/M2Office/setup.conf
[ "${1:-}" = "--config" ] && CONF=${2:-$CONF}
[ "$(id -u)" -eq 0 ] || { echo '管理者の権限（sudo）で走らせてください' >&2; exit 1; }
# shellcheck disable=SC1090
. "$CONF"
[ "${MAINTENANCE:-no}" = yes ] || exit 0
DIR="$DATA_DIR/machine"
TS="$TAILSCALE_BIN"
status=$(mktemp -t m2o-ts); trap 'rm -f "$status"' EXIT
"$TS" status --json > "$status" 2>/dev/null || echo '{}' > "$status"
running=0
grep -q '"BackendState": *"Running"' "$status" && running=1
# 同じ機械のほかの製品（M2Medical）が遠隔の保守を持つなら、トンネルに触れない（その製品が開けたトンネルを閉じない。第8.6.9節）
owner=$(head -1 "${FRONT_DIR:-/Library/M2Front}/maintenance-owner" 2>/dev/null | tr -d '[:space:]')
foreign=0
[ -n "$owner" ] && [ "$owner" != M2Office ] && foreign=1
action=$(M2O_MAINT_FOREIGN=$foreign "$NODE_BIN" "$(dirname "$0")/maintenance-state.mjs" "$DIR" "$running" "$status") || exit 1
[ "$foreign" = 1 ] && action=none
chown "$SERVICE_USER:$SERVICE_USER" "$DIR/maintenance.json" 2>/dev/null || true
case "$action" in
  up) "$TS" up --hostname "m2o-$SUBDOMAIN" --ssh --accept-dns=false && echo "$(date '+%F %T') 遠隔の保守を開けました" ;;
  down) "$TS" down && echo "$(date '+%F %T') 遠隔の保守を閉じました" ;;
esac
