# -*- coding: utf-8 -*-
"""生成した図版（build_diagrams.py）で、仕様書（specification.md と spec/ の各章）の罫線の図を置き換える。

図版の数と仕様書中の図のブロック数が一致しなければ止める。
"""
import io, os, re, sys, unicodedata
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from build_diagrams import D
from diagrams import W

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', '..')
BOX = set('─│┌┐└┘├┤┬┴┼▼▲◀▶')

# 仕様書は章ごとのファイルに分けてある（ADR-0041）。入口の読む順番に従って、各章のファイルを順に見る
index = io.open(os.path.join(ROOT, 'specification.md'), encoding='utf-8').read()
files = [os.path.join(ROOT, f) for f in re.findall(r'^<!--\s*include:\s*(.+?)\s*-->', index, flags=re.M)]
docs = [(f, io.open(f, encoding='utf-8').read().split('\n')) for f in files]

# フェンスで囲まれたブロックを検出（ファイルをまたいで通し番号を振る）
blocks = []           # (ファイルの番号, 開始フェンス行index, 終了フェンス行index)
for n, (_, lines) in enumerate(docs):
    inb = False; st = 0
    for i, ln in enumerate(lines):
        if ln.startswith('```'):
            if not inb: inb = True; st = i
            else:
                inb = False
                body = lines[st+1:i]
                if any(set(x) & BOX for x in body):
                    blocks.append((n, st, i))
print(f'図版ブロック数: {len(blocks)}（生成した図版: {len(D)}）')
assert len(blocks) == len(D), '数が一致しません'

# 後ろから置換する（行番号のずれを避けるため）
for idx in range(len(blocks) - 1, -1, -1):
    n, st, en = blocks[idx]
    docs[n][1][st+1:en] = D[idx + 1]

for f, lines in docs:
    io.open(f, 'w', encoding='utf-8').write('\n'.join(lines))
print('置換完了')
