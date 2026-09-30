# 仕様書・開発者マニュアルの PDF 生成

`specification.md` と開発者マニュアル（`docs/developer/*.md`）から印刷用の PDF を作ります。

仕様書は章ごとのファイル（`spec/`）に分けてあります（ADR-0041）。`build.py` は入口の `specification.md` にある
`<!-- include: spec/… -->` の行の順に各章をつないでから変換するため、使い方は分ける前と同じです。

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

## 開発者マニュアルを 1 冊の PDF にする

```bash
npm run docs:manual-pdf    # → docs/developer/developer-manual.pdf
```

Markdown は章ごとに分けたまま保守し、配布と通読のときだけ 1 本にまとめます。
`build_manual.py` が次を行ってから `build.py` と Chrome で PDF にします。

| 処理 | 内容 |
|---|---|
| つなぐ | README（「はじめに」）と `01-`〜`09-` の章を番号順につなぐ。章を足せば自動で入る |
| 見出し | 1 段下げて、章ごとに改ページする |
| リンク | 章どうしのリンクは PDF の中のリンクに、リポジトリのファイルへのリンクはパスの表記に直す |
| コード | はみ出す行を折り返す（仕様書は図の桁を保つため折り返さない） |

生成された `developer-manual.pdf` も版管理の対象外です。

## ファイル

| ファイル | 役割 |
|---|---|
| `build.py` | Markdown を印刷用 HTML に変換する。表紙・目次・CSS を含む |
| `build_manual.py` | 開発者マニュアルの各章を 1 冊にまとめて PDF にする |
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

**注意（仕様書 第 0.26.0 版以降）**: その後に加えた図（マスター管理画面・ダッシュボードなど）は、
`build_diagrams.py` を通さず、仕様書に直接書いています（桁は文字幅を計算して揃えています）。
`apply.py` は仕様書の図の数と定義の数が一致しないと止まるため、**いまは使いません**。
PDF を作るだけなら、上の「使い方」の 2 つのコマンドで足ります。
図を直すときは、罫線素片以外に幅の曖昧な文字（`●` `○` `□` `→` `…` など）を使わないでください。
PDF の書体では全角で描かれ、桁がずれます。

## ユーザーマニュアル（人事・給与・在庫管理）を 1 冊の PDF にする

```bash
npm run docs:hr-manual-pdf          # → docs/manual/hr-payroll/hr-payroll-manual.pdf
npm run docs:inventory-manual-pdf   # → docs/manual/inventory/inventory-manual.pdf
```

`build_manual.py` の最初の引数でマニュアルを選びます（`developer`・`hr-payroll`・`inventory`）。つなぎ方は開発者マニュアルと同じで、
`docs/manual/<名前>/` の README（「はじめに」）と `01-`〜`10-` の章を番号順につなぎます。印刷ではチェックリストの `[ ]` を `□` にします。
