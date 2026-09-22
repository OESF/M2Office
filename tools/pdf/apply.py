# -*- coding: utf-8 -*-
"""生成した図版（build_diagrams.py）で、specification.md の罫線の図を置き換える。

図版の数と仕様書中の図のブロック数が一致しなければ止める。
"""
import io, os, sys, unicodedata
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from build_diagrams import D
from diagrams import W

MD = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', '..', 'specification.md')
lines = io.open(MD, encoding='utf-8').read().split('\n')
BOX = set('─│┌┐└┘├┤┬┴┼▼▲◀▶')

# フェンスで囲まれたブロックを検出
blocks = []           # (開始フェンス行index, 終了フェンス行index, 本文)
inb = False; st = 0
for i, ln in enumerate(lines):
    if ln.startswith('```'):
        if not inb: inb = True; st = i
        else:
            inb = False
            body = lines[st+1:i]
            if any(set(x) & BOX for x in body):
                blocks.append((st, i))
print(f'図版ブロック数: {len(blocks)}（生成した図版: {len(D)}）')
assert len(blocks) == len(D), '数が一致しません'

# 後ろから置換する（行番号のずれを避けるため）
for idx in range(len(blocks) - 1, -1, -1):
    st, en = blocks[idx]
    new = D[idx + 1]
    lines[st+1:en] = new

io.open(MD, 'w', encoding='utf-8').write('\n'.join(lines))
print('置換完了')
