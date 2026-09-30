# -*- coding: utf-8 -*-
"""Markdown（仕様書・開発者マニュアル）を印刷用 HTML に変換する。

使い方: python build.py <入力の Markdown> <出力の HTML>

仕様書は章ごとのファイルに分けてある。入口（specification.md）の include の行の順につないでから変換する。
"""
import io, os, re, sys, html, datetime
import markdown

SRC = sys.argv[1]
OUT = sys.argv[2]

raw = io.open(SRC, encoding='utf-8').read()

# 章ごとのファイルをつなぐ（仕様書 第0.3節 約束 6、ADR-0041）。
# 入口の Markdown に `<!-- include: spec/01-background.md -->` の行があれば、その位置にそのファイルを入れる。
# パスは入口のファイルからの相対。書いてあるファイルが無ければ止める（章の抜けた PDF を作らない）
def expand_includes(text, base):
    def load(m):
        path = os.path.join(base, m.group(1).strip())
        if not os.path.exists(path):
            sys.exit(f'読む順番にあるファイルがありません: {m.group(1).strip()}')
        return io.open(path, encoding='utf-8').read()
    return re.sub(r'^<!--\s*include:\s*(.+?)\s*-->\n?', load, text, flags=re.M)

raw = expand_includes(raw, os.path.dirname(os.path.abspath(SRC)))

# YAML frontmatter を取り出す
meta = {}
m = re.match(r'^---\n(.*?)\n---\n', raw, re.S)
body = raw
if m:
    for line in m.group(1).split('\n'):
        if ':' in line and not line.startswith(' '):
            k, v = line.split(':', 1)
            meta[k.strip()] = v.strip()
    body = raw[m.end():]

# 先頭の H1 と引用ブロックは表紙に回すので本文から除去する
body = re.sub(r'^#\s+.*?\n(\n>.*?\n)*', '', body, count=1, flags=re.S)

md = markdown.Markdown(extensions=['tables', 'fenced_code', 'toc', 'sane_lists', 'attr_list'],
                       extension_configs={'toc': {'toc_depth': '2-3'}})
content = md.convert(body)
toc = md.toc

title    = meta.get('title', 'specification')
version  = meta.get('version', '')
updated  = meta.get('updated', '')
owner    = meta.get('owner', '')
# 表紙の作成者の見出しと、担当（監修のお願いのように、利用する会社が出す資料で使う）
owner_label = meta.get('owner_label', '作成')
contact  = meta.get('contact', '')
status   = meta.get('status', '')
subtitle = meta.get('subtitle', '中小企業向け AI エージェントシステム')
version_text = f'{version}（{status}）' if status else version

CSS = """
@page { size: A4; margin: 18mm 16mm 18mm 16mm; }
* { box-sizing: border-box; }
html { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
body {
  font-family: "Hiragino Kaku Gothic ProN", "Hiragino Sans", "Noto Sans CJK JP", sans-serif;
  font-size: 9.5pt; line-height: 1.75; color: #1a1a1a; margin: 0;
  text-align: justify; word-break: normal; line-break: strict;
}
/* 表紙 */
.cover { height: 247mm; display: flex; flex-direction: column; justify-content: center;
         page-break-after: always; text-align: left; }
.cover .rule { width: 56px; height: 4px; background: #0f766e; margin-bottom: 28px; }
.cover h1 { font-size: 30pt; line-height: 1.35; margin: 0 0 10px; border: none; padding: 0; }
.cover .sub { font-size: 11pt; color: #555; margin-bottom: 40px; }
.cover dl { font-size: 10pt; margin: 0; color: #333; }
.cover dt { float: left; width: 90px; clear: left; color: #777; }
.cover dd { margin: 0 0 6px 90px; }
/* 目次 */
.toc { page-break-after: always; }
.toc h2 { font-size: 16pt; border: none; margin: 0 0 16px; padding: 0; page-break-before: auto; }
.toc ul { list-style: none; padding-left: 0; margin: 0; }
.toc ul ul { padding-left: 1.4em; }
.toc li { margin: 3px 0; font-size: 9.5pt; line-height: 1.6; }
.toc ul ul li { font-size: 8.5pt; color: #555; }
.toc a { color: #1a1a1a; text-decoration: none; }
/* 見出し */
h1, h2, h3, h4, h5 { font-weight: 600; line-height: 1.4; text-align: left; }
h2 { font-size: 17pt; margin: 0 0 18px; padding: 0 0 8px; border-bottom: 2.5px solid #0f766e;
     page-break-before: always; page-break-after: avoid; }
h3 { font-size: 12.5pt; margin: 22px 0 9px; padding-left: 9px; border-left: 4px solid #0f766e;
     page-break-after: avoid; }
h4 { font-size: 10.5pt; margin: 16px 0 7px; color: #0f766e; page-break-after: avoid; }
h5 { font-size: 10pt; margin: 14px 0 6px; color: #334155; page-break-after: avoid; }
p { margin: 8px 0; orphans: 2; widows: 2; }
strong { font-weight: 600; }
/* 表 */
table { border-collapse: collapse; width: 100%; margin: 12px 0; font-size: 8.5pt;
        page-break-inside: auto; }
thead { display: table-header-group; }
tr { page-break-inside: avoid; page-break-after: auto; }
th, td { border: 1px solid #c8cdd2; padding: 5px 7px; text-align: left; vertical-align: top;
         line-height: 1.6; }
th { background: #eef2f3; font-weight: 600; }
tbody tr:nth-child(even) { background: #fafbfb; }
/* コード・図版
   罫線素片は Menlo の半角幅で描き、日本語は 120% に拡大した和文フォントを当てて
   「和文 1 文字 = 欧文 2 文字」の桁を合わせる。 */
@font-face {
  font-family: 'MonoJPFallback';
  src: local('Noto Sans Mono CJK JP Regular'), local('NotoSansMonoCJKjp-Regular'),
       local('Hiragino Kaku Gothic ProN W3');
  size-adjust: 120.41%;
}
pre { font-family: Menlo, 'MonoJPFallback', monospace;
      font-size: 8.5pt; line-height: 1.2; background: #f6f8f8; border: 1px solid #dfe5e5;
      border-radius: 3px; padding: 10px 12px; white-space: pre; overflow: hidden;
      page-break-inside: avoid; margin: 12px 0;
      font-kerning: none; font-variant-ligatures: none; letter-spacing: 0;
      font-feature-settings: 'kern' 0, 'liga' 0, 'calt' 0, 'palt' 0; }
code { font-family: Menlo, 'MonoJPFallback', monospace; font-size: 8.5pt;
       background: #f0f3f3; padding: 1px 4px; border-radius: 2px; }
pre code { background: none; padding: 0; font-size: inherit; }
/* 引用・リスト・区切り */
blockquote { border-left: 3px solid #0f766e; background: #f5f9f9; margin: 12px 0;
             padding: 8px 14px; color: #33413f; font-size: 9pt; page-break-inside: avoid; }
ul, ol { margin: 8px 0; padding-left: 1.6em; }
li { margin: 3px 0; }
hr { display: none; }
a { color: #0f766e; text-decoration: none; }
"""

# 図の無い文書（開発者マニュアル）では、はみ出すコードの行を折り返す。
# 仕様書は図の桁を保つため折り返さない（はみ出さない幅で図を書いている）
if meta.get('wrap_code') == 'true':
    CSS += "pre { white-space: pre-wrap; overflow-wrap: anywhere; text-align: left; }\n"

doc = f"""<!DOCTYPE html>
<html lang="ja"><head><meta charset="utf-8">
<title>{html.escape(title)}</title>
<style>{CSS}</style></head><body>
<section class="cover">
  <div class="rule"></div>
  <h1>{html.escape(title)}</h1>
  <div class="sub">{html.escape(subtitle)}</div>
  <dl>
    <dt>版</dt><dd>{html.escape(version_text)}</dd>
    <dt>最終更新</dt><dd>{html.escape(updated)}</dd>
    <dt>{html.escape(owner_label)}</dt><dd>{html.escape(owner)}</dd>
    {f'<dt>担当</dt><dd>{html.escape(contact)}</dd>' if contact else ''}
  </dl>
</section>
<section class="toc"><h2>目次</h2>{toc}</section>
{content}
</body></html>"""

io.open(OUT, 'w', encoding='utf-8').write(doc)
print('HTML 生成:', OUT, f'({len(doc):,} バイト)')
