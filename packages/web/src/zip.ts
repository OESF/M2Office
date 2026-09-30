/**
 * @file ZIP の中を、ブラウザで読む（目次と、無圧縮か deflate のファイル）。PowerPoint のファイルを数え、HTML の素材の ZIP を開くのに使う。
 *
 * 暗号化や ZIP64 は扱わない。中のプログラムは動かさない。展開は `DecompressionStream` で行う。
 */

const u16 = (d: DataView, o: number) => d.getUint16(o, true);
const u32 = (d: DataView, o: number) => d.getUint32(o, true);

/** ZIP の中のファイル 1 つ（目次の記録）。 */
export interface ZipEntry { name: string; method: number; compressed: number; offset: number }

/** ZIP の目次（中央ディレクトリ）を読む。 */
export function readDirectory(buf: ArrayBuffer): ZipEntry[] {
  const d = new DataView(buf);
  // 目次の終わりの記録（PK\x05\x06）を後ろから探す
  let end = -1;
  for (let i = buf.byteLength - 22; i >= Math.max(0, buf.byteLength - 65_557); i--) {
    if (u32(d, i) === 0x06054b50) { end = i; break; }
  }
  if (end < 0) return [];
  const count = u16(d, end + 10);
  let at = u32(d, end + 16);
  const out: ZipEntry[] = [];
  const dec = new TextDecoder();
  for (let n = 0; n < count && at + 46 <= buf.byteLength; n++) {
    if (u32(d, at) !== 0x02014b50) break;
    const method = u16(d, at + 10);
    const compressed = u32(d, at + 20);
    const nameLen = u16(d, at + 28);
    const extraLen = u16(d, at + 30);
    const commentLen = u16(d, at + 32);
    const offset = u32(d, at + 42);
    out.push({ name: dec.decode(new Uint8Array(buf, at + 46, nameLen)), method, compressed, offset });
    at += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}

/** ZIP の中のファイル 1 つを文字として読む（無圧縮か deflate だけ）。 */
export async function readText(buf: ArrayBuffer, e: ZipEntry): Promise<string | null> {
  const d = new DataView(buf);
  if (u32(d, e.offset) !== 0x04034b50) return null;
  const start = e.offset + 30 + u16(d, e.offset + 26) + u16(d, e.offset + 28);
  const data = new Uint8Array(buf, start, e.compressed);
  if (e.method === 0) return new TextDecoder().decode(data);
  if (e.method !== 8 || typeof DecompressionStream === 'undefined') return null;
  const stream = new Blob([data]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
  return new Response(stream).text();
}


/** ZIP の中のファイル 1 つを中身として読む（無圧縮か deflate だけ）。 */
export async function readBytes(buf: ArrayBuffer, e: ZipEntry): Promise<Uint8Array | null> {
  const d = new DataView(buf);
  if (u32(d, e.offset) !== 0x04034b50) return null;
  const start = e.offset + 30 + u16(d, e.offset + 26) + u16(d, e.offset + 28);
  const data = new Uint8Array(buf, start, e.compressed);
  if (e.method === 0) return data.slice();
  if (e.method !== 8 || typeof DecompressionStream === 'undefined') return null;
  const stream = new Blob([data]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}
