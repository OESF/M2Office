# 同梱している書体

帳票の PDF（`pdf.render`）に埋め込む書体です。仕様書 第9.4.1節・Q-59・ADR-0017 で決めました。

| ファイル | 内容 |
|---|---|
| `NotoSansJP-Regular.ttf` | Noto Sans JP 通常。日本語の一部だけに絞ったもの |
| `NotoSansJP-Bold.ttf` | Noto Sans JP 太字。同上 |
| `OFL.txt` | SIL Open Font License 1.1（Noto Sans JP のライセンス） |

## 絞り込みの範囲

**JIS X 0208 の全字（漢字・かな・記号）＋ ASCII ＋ 帳票でよく使う記号**です。
Shift_JIS の 2 バイト領域を総当たりして集めるため、NEC・IBM の拡張（髙・﨑など、人名でよく使う異体字）も入ります。

範囲の外の字（𠮷・鷗・㐂・絵文字など）は、帳票では `〓` に置き換わります。
置き換わった字は `pdf.render` の結果（`replacedCharacters`）で返すので、黙って消えることはありません。

Shift_JIS の読み方が Windows 流（cp932）なので、JIS の正式な対応の字（マイナス記号「−」U+2212・「‖」・「¢」「£」「¬」）は入っていません。
描く前に、書体にある同じ形の字（「－」U+FF0D・「∥」・「￠」「￡」「￢」）へ置き換えます（`packages/core/src/files/font-chars.ts`）。

**全字（1 つ 5 MB）を同梱するとリポジトリが重くなるため、この範囲に絞っています**（1 つ約 2.3 MB）。

## 作り直しかた

元の書体はリポジトリに入れません。作り直すときは、次の手順で取得して絞り込みます。
`python3` と fontTools（`pip install fonttools`）が要ります。

```bash
curl -sL -o /tmp/NotoSansJP-Regular.ttf https://raw.githubusercontent.com/expo/google-fonts/master/font-packages/noto-sans-jp/400Regular/NotoSansJP_400Regular.ttf
node scripts/build-font-subset.mjs /tmp/NotoSansJP-Regular.ttf assets/fonts/NotoSansJP-Regular.ttf
```

太字は `700Bold/NotoSansJP_700Bold.ttf` を同じ手順で絞り込み、`NotoSansJP-Bold.ttf` として置きます。
作り直したら `npm test`（`packages/core/test/pdf-render.test.ts`）で、日本語を読み返せることを確かめてください。

**TrueType を使います。** OpenType（CFF）を埋め込むと、PDF の読み取り側（pdf.js）が字形の警告を出しました（ADR-0017）。
