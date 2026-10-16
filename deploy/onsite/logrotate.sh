#!/bin/bash
# M2Office の機械のログのファイルの入れ替え（仕様書 第16.10.2節）。launchd（jp.m2office.logrotate）が週に 1 回、管理者の権限で呼ぶ。
#
# launchd は API・ワーカー・データベースの標準出力のファイルを追記で開いたままにしている。名前を変えて入れ替えると、
# 書き込みが古いファイルに続いてしまう（macOS の newsyslog には、写して空にする指定が無い）。
# そこで、写して空にする: いまの中身を「名前.0」に写して圧縮し、元のファイルは名前を変えずに空にする（続きは頭から書かれる）。
# 4 世代（4 週）を残す。入口のアクセスログ（caddy.log）は Caddy が自分で 28 日分に入れ替える。
#
# 使い方: logrotate.sh <ログの置き場>
set -u
DIR=${1:?ログの置き場を渡してください}
KEEP=4
for name in api.log worker.log postgres.log maintenance.log update.log; do
  f="$DIR/$name"
  [ -s "$f" ] || continue
  # 古い世代を 1 つずつ後ろへ送り、いちばん古いものを消す
  rm -f "$f.$((KEEP - 1)).gz"
  for ((i = KEEP - 2; i >= 0; i--)); do
    [ -f "$f.$i.gz" ] && mv "$f.$i.gz" "$f.$((i + 1)).gz"
  done
  # 写して空にする（持ち主と権限はそのまま）
  cp -p "$f" "$f.0" && : > "$f" && gzip -f "$f.0"
  printf '%s %s を入れ替えました\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$name"
done
