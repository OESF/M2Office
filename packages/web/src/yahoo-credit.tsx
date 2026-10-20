/**
 * @file Yahoo! JAPAN の Web API のクレジット表示（仕様書 第29.11.3節）。
 *
 * JAN から商品名を引くのに Yahoo!ショッピングの商品検索を使うときは、使う画面の下に決まった文言とリンクを出す決まりがある
 * （Yahoo!デベロッパーネットワークのクレジット表示。文言・リンク先を変えず、色を変えたり極端に小さくしたりしない）。
 */

/** 「Webサービス by Yahoo! JAPAN」のクレジット（画面の下に置く）。 */
export function YahooCredit() {
  return (
    <div className="yahoo-credit">
      {/* Begin Yahoo! JAPAN Web Services Attribution Snippet */}
      <a href="https://developer.yahoo.co.jp/sitemap/">Webサービス by Yahoo! JAPAN</a>
      {/* End Yahoo! JAPAN Web Services Attribution Snippet */}
    </div>
  );
}
