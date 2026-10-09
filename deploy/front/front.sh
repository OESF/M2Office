#!/bin/bash
# @file 機械に 1 つの入口（Caddy）を、M2Office と M2Medical で分け合う（仕様書 第8.6.9節、ADR-0086）。
#
# 入口はどちらの製品にも属さない共通の置き場（/Library/M2Front）に置く。先に入れた製品が入口を作り、
# 後から入れた製品は自分の名前の設定（sites/<製品>.caddy）を置いて読み直すだけにする。どちらを先に入れても、片方を外しても、もう片方は動き続ける。
# 決まりは deploy/front/README.md。M2Medical はこのディレクトリをそのまま写して使う（写した版は M2Medical の docs/shared-from-m2office.md）。
#
# 使い方（管理者の権限で）:
#   sudo front.sh put-site <製品> <設定のファイル> --caddy <caddy の道> [--restart]   # 自分の名前の設定を置き、確かめてから読み直す
#   sudo front.sh remove-site <製品> --caddy <caddy の道>                            # 自分の名前の設定を外す
#   front.sh owner                                                                  # 遠隔の保守を持つ製品の名前（無ければ空）
#
# --restart は、Caddy に DNS の事業者のつなぎを足した直後に付ける（動いている Caddy は古い本体のままで、新しいつなぎを知らないため）。
# 試すとき: M2_FRONT_DIR で置き場を変えると、管理者の権限なしで走る。launchctl は M2_FRONT_LAUNCHCTL で差し替えられる。

set -euo pipefail

# 入口の取り決めの版。共通の Caddyfile と launchd の設定の形を変えたら上げる（新しい写しが、古い写しの書いたものを置き換える）
CONTRACT=1
FRONT=${M2_FRONT_DIR:-/Library/M2Front}
LABEL=jp.m2front.caddy
PLIST=${M2_FRONT_PLIST_DIR:-/Library/LaunchDaemons}/$LABEL.plist
LAUNCHCTL=${M2_FRONT_LAUNCHCTL:-launchctl}

die() { printf '入口: %s\n' "$*" >&2; exit 1; }
info() { printf '  入口: %s\n' "$*"; }

cmd=${1:-}; shift || true
[ -n "$cmd" ] || die '使い方: front.sh put-site|remove-site|owner …'

if [ "$cmd" = owner ]; then
  # 1 行目だけ。空白は外す
  [ -f "$FRONT/maintenance-owner" ] && head -1 "$FRONT/maintenance-owner" | tr -d '[:space:]'
  exit 0
fi

name=${1:-}; shift || true
site=''
if [ "$cmd" = put-site ]; then site=${1:-}; shift || true; fi
CADDY=''; RESTART=0
while [ $# -gt 0 ]; do
  case "$1" in
    --caddy) CADDY=${2:-}; shift ;;
    --restart) RESTART=1 ;;
    *) die "知らない指定: $1" ;;
  esac
  shift
done
[[ "$name" =~ ^[a-z][a-z0-9-]{1,30}$ ]] || die "製品の名前は英小文字で始まる英小文字・数字・ハイフンにしてください: $name"
[ -n "$CADDY" ] && [ -x "$CADDY" ] || die "caddy がありません: ${CADDY:-（指定なし）}"
# 本番は管理者の権限で走らせる（試すときは置き場を変えて走らせる）
if [ -z "${M2_FRONT_DIR:-}" ] && [ "$(id -u)" -ne 0 ]; then die '管理者の権限（sudo）で走らせてください'; fi
root_only() { [ "$(id -u)" -eq 0 ] && chown root:wheel "$@"; chmod "${MODE:-644}" "$@"; }

loaded() { "$LAUNCHCTL" print "system/$LABEL" >/dev/null 2>&1; }

# 共通の Caddyfile と launchd の設定を書く（無いか、取り決めの版が古いときだけ）
ensure_front() {
  mkdir -p "$FRONT/sites" "$FRONT/logs" "$FRONT/data" "$FRONT/config"
  MODE=755 root_only "$FRONT" "$FRONT/sites" "$FRONT/logs"
  MODE=700 root_only "$FRONT/data" "$FRONT/config"
  local have=0
  [ -f "$FRONT/CONTRACT" ] && have=$(tr -dc '0-9' < "$FRONT/CONTRACT")
  [ "${have:-0}" -gt "$CONTRACT" ] && { info "より新しい取り決め（版 ${have}）で作られています。共通の設定はそのまま使います"; return 0; }
  [ "${have:-0}" -eq "$CONTRACT" ] && [ -f "$FRONT/Caddyfile" ] && [ -f "$PLIST" ] && return 0
  cat > "$FRONT/Caddyfile" <<'CADDY'
# 機械に 1 つの入口（M2Office と M2Medical の共通の部品。仕様書 第8.6.9節）。front.sh が書く。手で書き換えない。
# 製品ごとの名前・証明書・振り分けは sites/<製品>.caddy に置く（1 製品 1 ファイル。全体の設定の段はどの製品も書かない）
import sites/*.caddy
CADDY
  MODE=644 root_only "$FRONT/Caddyfile"
  mkdir -p "$(dirname "$PLIST")"
  cat > "$PLIST" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<!-- 機械に 1 つの入口（M2Office と M2Medical の共通。仕様書 第8.6.9節）。443 番を受けるため root で動かす。front.sh が書く -->
<plist version="1.0">
<dict>
	<key>Label</key>
	<string>$LABEL</string>
	<key>ProgramArguments</key>
	<array>
		<string>$CADDY</string>
		<string>run</string>
		<string>--config</string>
		<string>$FRONT/Caddyfile</string>
	</array>
	<key>EnvironmentVariables</key>
	<dict>
		<key>XDG_DATA_HOME</key>
		<string>$FRONT/data</string>
		<key>XDG_CONFIG_HOME</key>
		<string>$FRONT/config</string>
	</dict>
	<key>RunAtLoad</key>
	<true/>
	<key>KeepAlive</key>
	<true/>
	<key>StandardOutPath</key>
	<string>$FRONT/logs/caddy-run.log</string>
	<key>StandardErrorPath</key>
	<string>$FRONT/logs/caddy-run.log</string>
</dict>
</plist>
PLIST
  MODE=644 root_only "$PLIST"
  printf '%s\n' "$CONTRACT" > "$FRONT/CONTRACT"
  MODE=644 root_only "$FRONT/CONTRACT"
  # 取り決めが変わったら、動いている入口を新しい設定で動かし直す
  if loaded; then "$LAUNCHCTL" bootout "system/$LABEL" >/dev/null 2>&1 || true; fi
  info "共通の入口を用意しました（${FRONT}）"
}

# 動かす（動いていなければ起動、動いていれば読み直す）
apply() {
  local any
  any=$(find "$FRONT/sites" -name '*.caddy' -type f | head -1)
  if [ -z "$any" ]; then
    # 名前が 1 つも無ければ止めておく（どの名前も受けない入口を動かしておかない）
    if loaded; then "$LAUNCHCTL" bootout "system/$LABEL" >/dev/null 2>&1 || true; fi
    info '受ける名前が無いので、入口を止めました'
    return 0
  fi
  if ! loaded; then
    "$LAUNCHCTL" bootstrap system "$PLIST"
    info '入口を動かしました'
  elif [ "$RESTART" = 1 ]; then
    "$LAUNCHCTL" kickstart -k "system/$LABEL"
    info '入口を動かし直しました'
  else
    "$CADDY" reload --config "$FRONT/Caddyfile" --adapter caddyfile >/dev/null 2>&1 \
      || "$LAUNCHCTL" kickstart -k "system/$LABEL"
    info '入口の設定を読み直しました'
  fi
}

case "$cmd" in
  put-site)
    [ -f "$site" ] || die "設定のファイルがありません: $site"
    # 先に自分の設定だけを確かめる（読み込みは全部をつないで読むため、括弧の閉じ忘れが、もう片方の製品のファイルの誤りとして出てしまう）
    if ! out=$("$CADDY" validate --config "$site" --adapter caddyfile 2>&1); then
      die "設定を確かめられませんでした（置いていません）: $(printf '%s' "$out" | grep -v '"level":"info"' | tail -2)"
    fi
    ensure_front
    target="$FRONT/sites/$name.caddy"
    prev=''
    if [ -f "$target" ]; then prev=$(mktemp); cp -p "$target" "$prev"; fi
    cp "$site" "$target"
    # DNS の鍵を含むため root だけが読める
    MODE=600 root_only "$target"
    # 全体を確かめてから読み直す（自分の設定の誤りで、もう片方の製品の入口まで止めない）
    if ! out=$("$CADDY" validate --config "$FRONT/Caddyfile" --adapter caddyfile 2>&1); then
      if [ -n "$prev" ]; then cp -p "$prev" "$target"; else rm -f "$target"; fi
      [ -n "$prev" ] && rm -f "$prev"
      die "設定を確かめられませんでした。前の設定に戻しました: $(printf '%s' "$out" | tail -3)"
    fi
    [ -n "$prev" ] && rm -f "$prev"
    apply
    ;;
  remove-site)
    rm -f "$FRONT/sites/$name.caddy"
    [ -f "$FRONT/Caddyfile" ] && apply
    ;;
  *) die "知らない指示: $cmd" ;;
esac
