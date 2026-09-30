/**
 * @file 画像の種類と縦横を、中身の先頭から読む（仕様書 第31.6.1節）。PNG と JPEG だけ。
 *
 * 画像を解かず、PNG の `IHDR` と JPEG の `SOF` の記録だけを読む。拡張子や画面から来た値を信じない。
 */

/** 読んだ結果。PNG・JPEG でなければ `null`。 */
export type ImageSize = { mime: 'image/png' | 'image/jpeg'; width: number; height: number } | null;

/**
 * 画像の種類と縦横を返す。
 *
 * @param head 中身の先頭（JPEG の `SOF` が後ろにあることがあるため、64 KB ほど渡す）
 */
export function imageSize(head: Uint8Array): ImageSize {
  const b = head;
  if (b.length >= 24 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) {
    const w = ((b[16]! << 24) >>> 0) + (b[17]! << 16) + (b[18]! << 8) + b[19]!;
    const h = ((b[20]! << 24) >>> 0) + (b[21]! << 16) + (b[22]! << 8) + b[23]!;
    return w > 0 && h > 0 ? { mime: 'image/png', width: w, height: h } : null;
  }
  if (b.length >= 4 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) {
    let at = 2;
    while (at + 9 < b.length) {
      if (b[at] !== 0xff) { at++; continue; }
      const marker = b[at + 1]!;
      // 印の間を埋める 0xff は飛ばす
      if (marker === 0xff) { at++; continue; }
      // 長さを持たない印
      if (marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd7) || marker === 0x01) { at += 2; continue; }
      const len = (b[at + 2]! << 8) + b[at + 3]!;
      // SOF0〜SOF15（DHT・JPG・DAC の C4・C8・CC を除く）
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        const h = (b[at + 5]! << 8) + b[at + 6]!;
        const w = (b[at + 7]! << 8) + b[at + 8]!;
        return w > 0 && h > 0 ? { mime: 'image/jpeg', width: w, height: h } : null;
      }
      if (marker === 0xda) break;
      at += 2 + len;
    }
    return null;
  }
  return null;
}
