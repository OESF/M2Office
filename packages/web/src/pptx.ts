/**
 * @file PowerPoint のファイル（`.pptx`・`.ppsx`）の中を、ブラウザで数える（仕様書 第31.6.4節）。
 *
 * スライドの枚数・アニメーションの有無・スライドの縦横だけを読み、動画にする操作を、そのファイルに合わせて示すために使う。
 * ファイルはサーバーに送らず、保存しない。中のマクロや埋め込みは動かさない（ZIP の目次と XML の文字だけを読む）。
 * 推論も変換の部品も使わない。
 */

/** 数えた結果。 */
export interface PptxInfo {
  slides: number;
  animations: boolean;
  /** スライドの向き（分からなければ `null`）。 */
  orientation: 'landscape' | 'portrait' | null;
}

const u16 = (d: DataView, o: number) => d.getUint16(o, true);
const u32 = (d: DataView, o: number) => d.getUint32(o, true);

/** ZIP の中のファイル 1 つ（目次の記録）。 */
interface ZipEntry { name: string; method: number; compressed: number; offset: number }

/** ZIP の目次（中央ディレクトリ）を読む。 */
function readDirectory(buf: ArrayBuffer): ZipEntry[] {
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
async function readText(buf: ArrayBuffer, e: ZipEntry): Promise<string | null> {
  const d = new DataView(buf);
  if (u32(d, e.offset) !== 0x04034b50) return null;
  const start = e.offset + 30 + u16(d, e.offset + 26) + u16(d, e.offset + 28);
  const data = new Uint8Array(buf, start, e.compressed);
  if (e.method === 0) return new TextDecoder().decode(data);
  if (e.method !== 8 || typeof DecompressionStream === 'undefined') return null;
  const stream = new Blob([data]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
  return new Response(stream).text();
}

/**
 * PowerPoint のファイルを数える。PowerPoint のファイルでなければ `null`。
 */
export async function inspectPptx(file: Blob): Promise<PptxInfo | null> {
  if (file.size > 500 * 1024 * 1024) return null;
  const buf = await file.arrayBuffer();
  const entries = readDirectory(buf);
  if (!entries.some((e) => e.name === 'ppt/presentation.xml')) return null;
  const slides = entries.filter((e) => /^ppt\/slides\/slide\d+\.xml$/.test(e.name));
  let animations = false;
  for (const s of slides) {
    const xml = await readText(buf, s).catch(() => null);
    // 動き（<p:anim…>）か、画面の切り替え（<p:transition>）があるか
    if (xml && /<p:(timing|transition)\b/.test(xml)) { animations = true; break; }
  }
  let orientation: PptxInfo['orientation'] = null;
  const pres = entries.find((e) => e.name === 'ppt/presentation.xml');
  const xml = pres ? await readText(buf, pres).catch(() => null) : null;
  const m = xml ? /<p:sldSz[^>]*\bcx="(\d+)"[^>]*\bcy="(\d+)"/.exec(xml) : null;
  if (m) orientation = Number(m[2]) > Number(m[1]) ? 'portrait' : 'landscape';
  return { slides: slides.length, animations, orientation };
}
