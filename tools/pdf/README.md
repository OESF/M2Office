# 仕様書の PDF 生成

`specification.md` から印刷用の PDF を作ります。

## 前提

| 項目 | 内容 |
|---|---|
| Python | 3.9 以上 |
| python-markdown | `pip install markdown` |
| Google Chrome | PDF の書き出しに使う（macOS の既定の場所を想定） |
| フォント | ヒラギノ角ゴ ProN、Noto Sans Mono CJK JP |

## 使い方

```bash
python3 tools/pdf/build.py specification.md /tmp/specification.html
"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
  --headless=new --disable-gpu --no-sandbox --no-pdf-header-footer \
  --run-all-compositor-stages-before-draw --virtual-time-budget=25000 \
  --print-to-pdf=specification.pdf "file:///tmp/specification.html"
```

生成された `specification.pdf` は版管理の対象外です（生成物のため）。

## ファイル

| ファイル | 役割 |
|---|---|
| `build.py` | Markdown を印刷用 HTML に変換する。表紙・目次・CSS を含む |
| `diagrams.py` | アスキーアートを桁を揃えて組むための補助 |
| `build_diagrams.py` | 仕様書に載せる図版の定義 |
| `apply.py` | 組み直した図版を `specification.md` へ反映する |

## 組版で気をつけている点

| 項目 | 対応 |
|---|---|
| 和文と欧文の桁合わせ | 罫線素片は Menlo（半角）、和文は 120.41% に拡大して 2 : 1 に揃える |
| 縦線の途切れ | コードブロックの行間を 1.2 に詰める |
| 文字送りのずれ | `font-kerning: none` などでカーニングを無効にする |
| 表のページ跨ぎ | ヘッダー行を各ページで繰り返す |

図版を追加・変更するときは `build_diagrams.py` に定義を足し、`apply.py` で反映します。
桁は自動で揃うため、手で数える必要はありません。
