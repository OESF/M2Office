/**
 * @file 顔写真を送る前に縮める（仕様書 第30.5.4節）。
 *
 * 写真の向き（撮ったときの傾き）を直し、長い辺を決まった大きさに縮めて JPEG にする。
 * 送る量を小さくし、元の写真に含まれる位置などの情報（Exif）も送らない。
 */

/**
 * 写真を縮めて JPEG にする。
 *
 * @param maxSide 縮めた後の長い辺（画素）。まとめて取り込むときは、名札の文字を読めるよう大きめにする

 * @throws 画面で読めない形式（HEIC を読めない環境など）のとき
 */
export async function shrinkPhoto(file: Blob, maxSide = 640): Promise<Blob> {
  const bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' }).catch(() => {
    throw new Error('この写真は読めません。JPEG か PNG にしてください');
  });
  const scale = Math.min(1, maxSide / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(bitmap.width * scale));
  canvas.height = Math.max(1, Math.round(bitmap.height * scale));
  canvas.getContext('2d')!.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close();
  return new Promise((resolve, reject) => canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('写真を縮められませんでした'))), 'image/jpeg', 0.85));
}

/** 顔写真の URL（入れ直すと `v` が変わり、古い写真を見せない）。 */
export const hrPhotoUrl = (employeeId: string, photoAt: string) => `/v1/hr-photos/${encodeURIComponent(employeeId)}?v=${encodeURIComponent(photoAt)}`;
