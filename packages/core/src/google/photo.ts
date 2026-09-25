/**
 * @file 本人の Google のプロフィール写真を取り込む（仕様書 第6.5.1.1節）。
 *
 * Google の利用者情報が返す写真の URL から、画像を取ってくる。
 * **受け取った URL をそのまま取りに行かない。** `https` で、Google の画像の置き場だけに限る。
 */

/** 取り込む写真の大きさの上限（バイト）。 */
export const MAX_PHOTO_BYTES = 1024 * 1024;

/** 取りに行ってよい置き場（Google の画像の置き場）。 */
const PHOTO_HOST = /(^|\.)googleusercontent\.com$/i;

/**
 * 写真の URL が、取りに行ってよいものかを返す。
 *
 * @remarks
 * Google の利用者情報の値であっても、サーバーから任意の場所へ要求を出させる入口になりうる。
 * `https` で、Google の画像の置き場（`*.googleusercontent.com`）だけを許す。
 * 利用者名・パスワード付きの URL や、ポートを指定した URL は許さない。
 */
export function isGooglePhotoUrl(url: string): boolean {
  let u: URL;
  try { u = new URL(url); } catch { return false; }
  return u.protocol === 'https:' && PHOTO_HOST.test(u.hostname) && !u.username && !u.password && !u.port;
}

/**
 * 写真を取ってくる。
 *
 * @param url Google の利用者情報の `picture`
 * @param fetchImpl テストで差し替える
 * @returns 画像（PNG・JPEG）。取れない・形式が違う・大きすぎる・許されない URL なら `null`。**例外は投げない**
 *
 * @remarks
 * 取れなくてもログインや接続を止めないため、失敗はすべて `null` で返す（第6.5.1.1節「取れないとき」）。
 * 転送（リダイレクト）は追わない。追うと、許した置き場の外へ連れ出されうる。
 */
export async function fetchGooglePhoto(
  url: string, fetchImpl: typeof fetch = fetch,
): Promise<{ mime: 'image/png' | 'image/jpeg'; bytes: Uint8Array } | null> {
  if (!isGooglePhotoUrl(url)) return null;
  try {
    const res = await fetchImpl(url, { redirect: 'error', signal: AbortSignal.timeout(10_000) });
    if (!res.ok) return null;
    const declared = Number(res.headers.get('content-length') ?? '0');
    if (declared > MAX_PHOTO_BYTES) return null;
    const bytes = new Uint8Array(await res.arrayBuffer());
    if (bytes.byteLength === 0 || bytes.byteLength > MAX_PHOTO_BYTES) return null;
    // 見出し（content-type）を信じず、中身の先頭の印で形式を見る
    const starts = (...sig: number[]) => sig.every((b, i) => bytes[i] === b);
    if (starts(0x89, 0x50, 0x4e, 0x47)) return { mime: 'image/png', bytes };
    if (starts(0xff, 0xd8, 0xff)) return { mime: 'image/jpeg', bytes };
    return null;
  } catch {
    return null;
  }
}
