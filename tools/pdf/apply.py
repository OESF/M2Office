# -*- coding: utf-8 -*-
import io, sys, unicodedata
sys.path.insert(0, '/private/tmp/claude-501/-Users-miuramasataka-project-M2Office/61c7ce7b-6a08-4cea-b39c-a69f3484b280/scratchpad/pdf')
from build_diagrams import D
from diagrams import W

MD = '/Users/miuramasataka/project/M2Office/specification.md'
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
