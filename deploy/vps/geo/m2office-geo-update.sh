#!/bin/bash
# @file 国で通信を止める（クラウドの形の VPS。仕様書 第20.4.6節「国で通信を止める」、Q-284）。
#
# 5 つの地域インターネットレジストリが公開する割り当ての一覧（delegated-*-extended-latest）から、止める国の IPv4・IPv6 の範囲を取り出し、
# nftables の表 m2office_geo に入れる。相手が止める国なら入ってくる通信を黙って断り、宛先が止める国なら出ていく通信を断る。
# 機械の中（lo）と WireGuard の網（wg0）は見ない。表の入れ替えは 1 回の nft の処理で行い、入れ替えの間も守りを外さない。
# 取れない・検査の値（md5）が合わない・範囲が前の半分より少ないときは、前の一覧を使い続ける（空や壊れた一覧で守りが外れるのを防ぐ）。
#
# 使い方（root で。setup.sh が /usr/local/sbin/m2office-geo-update に入れ、systemd のタイマーが週に 1 回呼ぶ）:
#   m2office-geo-update             # 一覧を取り直して表を入れ替える
#   m2office-geo-update --load      # 前に作った表を入れる（起動のとき。取りに行かない）
#   m2office-geo-update --status    # 止める国・範囲の数・止めた数を出す
#
# 試すとき（機械を変えない）:
#   m2office-geo-update --from-dir <一覧の置き場> --render <出力する nft のファイル>
#   （置き場には delegated-<名前>-extended-latest と、あれば .md5 を置く。M2O_GEO_CONF・M2O_GEO_DIR で設定と置き場を替えられる）

set -euo pipefail

CONF=${M2O_GEO_CONF:-/etc/m2office/geo.conf}
DIR=${M2O_GEO_DIR:-/var/lib/m2office/geo}
TABLE=m2office_geo
RIRS='apnic=https://ftp.apnic.net/stats/apnic/delegated-apnic-extended-latest
ripencc=https://ftp.ripe.net/pub/stats/ripencc/delegated-ripencc-extended-latest
arin=https://ftp.arin.net/pub/stats/arin/delegated-arin-extended-latest
lacnic=https://ftp.lacnic.net/pub/stats/lacnic/delegated-lacnic-extended-latest
afrinic=https://ftp.afrinic.net/pub/stats/afrinic/delegated-afrinic-extended-latest'

log() { printf '%s %s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$*"; }
# ファイルの md5（Linux は md5sum、手元の試しの macOS は md5）
md5_of() { if command -v md5sum >/dev/null 2>&1; then md5sum "$1" | cut -d' ' -f1; else md5 -q "$1"; fi; }
fail() { log "失敗: $*。前の一覧を使い続けます"; exit 1; }

MODE=update; FROM_DIR=''; RENDER=''
while [ $# -gt 0 ]; do
  case "$1" in
    --load) MODE=load ;;
    --status) MODE=status ;;
    --from-dir) FROM_DIR=${2:?置き場を指定してください}; shift ;;
    --render) RENDER=${2:?出力するファイルを指定してください}; shift ;;
    *) echo "知らない指定: $1" >&2; exit 2 ;;
  esac
  shift
done

BLOCK_COUNTRIES=''; GEO_ALLOW=''
# shellcheck disable=SC1090
[ -f "$CONF" ] && . "$CONF"
COUNTRIES=$(printf '%s' "$BLOCK_COUNTRIES" | tr -d '[:space:]' | tr '[:lower:]' '[:upper:]' | sed -e 's/^,*//' -e 's/,*$//' -e 's/,,*/,/g')

# 止めた数（前に入れた表の数え）
counter() { nft list counter inet "$TABLE" "$1" 2>/dev/null | grep -oE 'packets [0-9]+' | awk '{print $2}' || true; }

if [ "$MODE" = status ]; then
  if ! nft list table inet "$TABLE" >/dev/null 2>&1; then echo '国で通信を止める表は入っていません'; exit 0; fi
  echo "止める国: $(cat "$DIR/countries" 2>/dev/null || echo '不明')"
  echo "範囲の数: $(cat "$DIR/count" 2>/dev/null || echo '不明')（$(date -r "$DIR/geo.nft" '+%Y-%m-%d %H:%M' 2>/dev/null || echo '不明') に作った一覧）"
  echo "止めた数（入れてから）: 入ってくる通信 $(counter in_blocked) 件・出ていく通信 $(counter out_blocked) 件"
  exit 0
fi

if [ "$MODE" = load ]; then
  if [ -z "$COUNTRIES" ] || [ "$COUNTRIES" = NONE ]; then nft delete table inet "$TABLE" 2>/dev/null || true; exit 0; fi
  [ -f "$DIR/geo.nft" ] || { log '前に作った一覧がありません。取り直します'; exec "$0"; }
  nft -f "$DIR/geo.nft"
  log "国で通信を止める表を入れました（$(cat "$DIR/countries" 2>/dev/null)・範囲 $(cat "$DIR/count" 2>/dev/null)）"
  exit 0
fi

# 止める国が無ければ、表を外して終える
if [ -z "$COUNTRIES" ] || [ "$COUNTRIES" = NONE ]; then
  [ -n "$RENDER" ] && { : > "$RENDER"; exit 0; }
  nft delete table inet "$TABLE" 2>/dev/null || true
  rm -f "$DIR/geo.nft" "$DIR/count" "$DIR/countries"
  log '止める国がないので、国で通信を止める表を外しました'
  exit 0
fi
IFS=, read -ra CCS <<< "$COUNTRIES"
for c in "${CCS[@]}"; do [[ "$c" =~ ^[A-Z]{2}$ ]] || fail "国の記号の形が違います: $c"; done

work=$(mktemp -d); trap 'rm -rf "$work"' EXIT

# 1. 一覧を取る（または置き場から読む）。検査の値（md5）で確かめる
while IFS='=' read -r name url; do
  file="delegated-$name-extended-latest"
  if [ -n "$FROM_DIR" ]; then
    [ -f "$FROM_DIR/$file" ] || fail "$file がありません"
    cp "$FROM_DIR/$file" "$work/$file"
    [ -f "$FROM_DIR/$file.md5" ] && cp "$FROM_DIR/$file.md5" "$work/$file.md5"
  else
    ok=0
    # 一覧と検査の値の取り出しの間に、レジストリの側で一覧が新しくなることがあるので、合わなければ 1 回だけ取り直す
    for _ in 1 2; do
      curl -fsS --max-time 180 -o "$work/$file" "$url" && curl -fsS --max-time 60 -o "$work/$file.md5" "$url.md5" || continue
      want=$(grep -oE '[0-9a-f]{32}' "$work/$file.md5" | head -1)
      [ -n "$want" ] && [ "$(md5_of "$work/$file")" = "$want" ] && { ok=1; break; }
      sleep 30
    done
    [ "$ok" = 1 ] || fail "$name の一覧を取れないか、検査の値が合いません"
  fi
  if [ -f "$work/$file.md5" ]; then
    want=$(grep -oE '[0-9a-f]{32}' "$work/$file.md5" | head -1)
    [ "$(md5_of "$work/$file")" = "$want" ] || fail "$name の一覧の検査の値が合いません"
  fi
done <<< "$RIRS"

# 2. 止める国の範囲を取り出す。IPv4 は「始まり-終わり」（数が 2 の累乗でないことがあるため）、IPv6 は「始まり/長さ」
cat "$work"/delegated-*-extended-latest | awk -F'|' -v ccs="$COUNTRIES" -v out4="$work/v4" -v out6="$work/v6" '
  function ip2n(ip,  a) { split(ip, a, "."); return ((a[1] * 256 + a[2]) * 256 + a[3]) * 256 + a[4] }
  function n2ip(n) { return int(n / 16777216) "." int(n / 65536) % 256 "." int(n / 256) % 256 "." n % 256 }
  BEGIN { n = split(ccs, list, ","); for (i = 1; i <= n; i++) want[list[i]] = 1 }
  /^#/ || NF < 7 { next }
  !($2 in want) { next }
  $7 != "allocated" && $7 != "assigned" { next }
  $3 == "ipv4" { s = ip2n($4); print $4 "-" n2ip(s + $5 - 1) > out4; next }
  $3 == "ipv6" { print $4 "/" $5 > out6 }
'
touch "$work/v4" "$work/v6"
c4=$(wc -l < "$work/v4" | tr -d ' '); c6=$(wc -l < "$work/v6" | tr -d ' ')
total=$((c4 + c6))
[ "$total" -gt 0 ] || fail '止める国の範囲が 1 つもありません'
prev=$(cat "$DIR/count" 2>/dev/null | grep -oE '^[0-9]+' || echo 0)
# 前と同じ国のときだけ比べる（国を外したときは減ってよい）
if [ "$(cat "$DIR/countries" 2>/dev/null)" = "$COUNTRIES" ] && [ "$prev" -gt 0 ] && [ $((total * 2)) -lt "$prev" ]; then
  fail "範囲の数が前の半分より少なくなりました（前 ${prev}・今回 ${total}）"
fi

# 3. 通す相手（GEO_ALLOW。カンマで区切ったアドレスか範囲）
allow4=''; allow6=''
for a in $(printf '%s' "$GEO_ALLOW" | tr ',' ' '); do
  if [[ "$a" == *:* ]]; then allow6+="$a, "; elif [[ "$a" =~ ^[0-9./-]+$ ]]; then allow4+="$a, "; else fail "通す相手の形が違います: $a"; fi
done

# 4. nftables の表を作る（空の表を足してから消し、作り直す。1 回の処理なので、途中で守りが外れない）
elements() { sed 's/$/,/' "$1" | tr '\n' ' ' | sed 's/, $//'; }
nftfile="$work/geo.nft"
{
  echo "table inet $TABLE"
  echo "delete table inet $TABLE"
  echo "table inet $TABLE {"
  echo "  counter in_blocked { }"
  echo "  counter out_blocked { }"
  echo "  set block4 { type ipv4_addr; flags interval; auto-merge;"
  [ "$c4" -gt 0 ] && echo "    elements = { $(elements "$work/v4") }"
  echo "  }"
  echo "  set block6 { type ipv6_addr; flags interval; auto-merge;"
  [ "$c6" -gt 0 ] && echo "    elements = { $(elements "$work/v6") }"
  echo "  }"
  echo "  set allow4 { type ipv4_addr; flags interval; auto-merge;"
  [ -n "$allow4" ] && echo "    elements = { ${allow4%, } }"
  echo "  }"
  echo "  set allow6 { type ipv6_addr; flags interval; auto-merge;"
  [ -n "$allow6" ] && echo "    elements = { ${allow6%, } }"
  echo "  }"
  echo "  chain input {"
  echo "    type filter hook input priority -10; policy accept;"
  echo '    iif "lo" accept'
  echo '    iifname "wg0" accept'
  echo '    ip saddr @allow4 accept'
  echo '    ip6 saddr @allow6 accept'
  echo '    ip saddr @block4 counter name "in_blocked" drop'
  echo '    ip6 saddr @block6 counter name "in_blocked" drop'
  echo "  }"
  echo "  chain output {"
  echo "    type filter hook output priority -10; policy accept;"
  echo '    oif "lo" accept'
  echo '    oifname "wg0" accept'
  echo '    ip daddr @allow4 accept'
  echo '    ip6 daddr @allow6 accept'
  # 出ていく通信は、待たせずにすぐ失敗させる（アプリは「取得できなかった」と出す）
  echo '    ip daddr @block4 counter name "out_blocked" reject with icmpx admin-prohibited'
  echo '    ip6 daddr @block6 counter name "out_blocked" reject with icmpx admin-prohibited'
  echo "  }"
  echo "}"
} > "$nftfile"

if [ -n "$RENDER" ]; then
  cp "$nftfile" "$RENDER"
  echo "$COUNTRIES $c4 $c6"
  exit 0
fi

nft -c -f "$nftfile" || fail 'nftables が表を受け付けません'
before_in=$(counter in_blocked); before_out=$(counter out_blocked)
[ -n "$before_in" ] && log "前の一覧で止めた数: 入ってくる通信 ${before_in} 件・出ていく通信 ${before_out:-0} 件"
nft -f "$nftfile"
install -d -m 750 "$DIR"
install -m 640 "$nftfile" "$DIR/geo.nft"
echo "${total}（IPv4 ${c4}・IPv6 ${c6}）" > "$DIR/count"
echo "$COUNTRIES" > "$DIR/countries"
log "国で通信を止める表を入れ替えました（${COUNTRIES}・IPv4 ${c4}・IPv6 ${c6}）"
