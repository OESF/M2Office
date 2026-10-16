/**
 * @file 会議の題名を比べる形（仕様書 第9.5.2.1節）。自動の議事録と Meet の接続口が同じ比べ方を使う。
 */

/** 会議の題名を比べる形（日付の添え書き・空白・括弧の中を除く）。 */
export function meetingTitleKey(title: string): string {
  return title.normalize('NFKC').replace(/（\d{1,2}\/\d{1,2}）$/, '').replace(/[（(][^）)]*[）)]/g, '').replace(/\s+/g, '').toLowerCase();
}
