# -*- coding: utf-8 -*-
"""アスキーアートを桁を揃えて生成する。
   罫線素片・矢印は半角幅（Menlo で描画）、和文は全角幅として計算する。"""
import unicodedata

def W(s):
    return sum(2 if unicodedata.east_asian_width(c) in 'WF' else 1 for c in s)

def pad(s, n):
    d = n - W(s)
    return s + ' ' * max(d, 0)

def at(*pairs):
    """(列, 文字列) を指定位置に配置した 1 行を作る。"""
    out = ''
    for col, text in pairs:
        out = pad(out, col) + text
    return out

def frame(inner, left, fill, right, junctions=()):
    """罫線行。junctions は内部の列位置（1〜inner）と文字の組。"""
    cells = [fill] * inner
    for col, ch in junctions:
        cells[col - 1] = ch
    return left + ''.join(cells) + right

def rowline(inner, cells):
    """cells = [(文字列, 幅), ...]。区切りは │。"""
    parts = [pad(t, wd) for t, wd in cells]
    return '│' + '│'.join(parts) + '│'

def textrow(inner, s):
    return '│' + pad(s, inner) + '│'

def sidebyside(boxes, gaps):
    """複数のボックス（行のリスト）を横に並べる。"""
    h = max(len(b) for b in boxes)
    boxes = [b + [' ' * W(b[0])] * (h - len(b)) for b in boxes]
    out = []
    for i in range(h):
        line = ''
        for j, b in enumerate(boxes):
            if j: line += ' ' * gaps[j - 1]
            line += b[i]
        out.append(line)
    return out

def simplebox(contents, inner=None, pad_side=1):
    if inner is None:
        inner = max(W(c) for c in contents) + pad_side * 2
    p = ' ' * pad_side
    out = ['┌' + '─' * inner + '┐']
    out += [textrow(inner, p + c) for c in contents]
    out += ['└' + '─' * inner + '┘']
    return out

def ctr(col, text):
    """text の中心が col に来るような (開始列, text) を返す。"""
    return (max(col - W(text) // 2, 0), text)

def runto(prefix, col, fill='─', tail=''):
    """prefix の後ろを fill で col まで伸ばし、tail を付ける。"""
    cur = W(prefix)
    return prefix + fill * max(col - cur, 0) + tail
