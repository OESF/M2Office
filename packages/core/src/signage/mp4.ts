/**
 * @file MP4 の入れ物の中の記録を読み、映像の符号（H.264 か）・長さ・縦横を確かめる（仕様書 第31.6.1節）。
 *
 * サーバーで動画を作り直さない（第31.18節）。中身の映像は解かず、入れ物の箱（box）の見出しと、
 * `moov` の中の記録（`mvhd` の長さ・`stsd` の最初の見本の種類と縦横）だけを読む。
 * 大きな動画を丸ごと記憶に載せないよう、必要な所だけを読む関数を受け取る。
 */

/** 動画の中身の必要な所だけを読む関数（`offset` から `length` バイト。終わりを越えたら短く返す）。 */
export type ReadAt = (offset: number, length: number) => Promise<Uint8Array>;

/** 読んだ結果。 */
export type Mp4Info =
  | { ok: true; codec: string; durationMs: number; width: number; height: number }
  | { ok: false; reason: string };

/** H.264 の見本の種類（`avc1`・`avc3`）。 */
const H264 = new Set(['avc1', 'avc3']);
/** 中を読む箱。 */
const CONTAINERS = new Set(['moov', 'trak', 'mdia', 'minf', 'stbl']);

const u32 = (b: Uint8Array, o: number) => ((b[o]! << 24) >>> 0) + (b[o + 1]! << 16) + (b[o + 2]! << 8) + b[o + 3]!;
const u16 = (b: Uint8Array, o: number) => (b[o]! << 8) + b[o + 1]!;
const typeOf = (b: Uint8Array, o: number) => String.fromCharCode(b[o]!, b[o + 1]!, b[o + 2]!, b[o + 3]!);

/** 箱の見出し（大きさ・種類・中身の始まり）。 */
interface BoxHead { type: string; start: number; size: number; body: number }

/** `from` から `to` までに並ぶ箱の見出しを読む。 */
async function boxes(read: ReadAt, from: number, to: number): Promise<BoxHead[]> {
  const out: BoxHead[] = [];
  let at = from;
  while (at + 8 <= to && out.length < 10_000) {
    const h = await read(at, 16);
    if (h.length < 8) break;
    let size = u32(h, 0);
    const type = typeOf(h, 4);
    let body = at + 8;
    if (size === 1) {
      if (h.length < 16) break;
      // 64 ビットの大きさ（上の 32 ビットが 0 でなければ、扱える大きさを超える）
      if (u32(h, 8) !== 0) break;
      size = u32(h, 12);
      body = at + 16;
    } else if (size === 0) {
      size = to - at;
    }
    if (size < body - at || at + size > to) break;
    out.push({ type, start: at, size, body });
    at += size;
  }
  return out;
}

/**
 * MP4 の入れ物を読み、映像が H.264 か・長さ・縦横を返す。
 *
 * @param read 中身の必要な所を読む関数
 * @param total 中身の大きさ（バイト）
 * @remarks `moov` がファイルの終わりにある動画でも、箱の見出しをたどって読む。映像の箱が無い・H.264 でない・長さが読めないものは `ok: false`
 */
export async function readMp4(read: ReadAt, total: number): Promise<Mp4Info> {
  const top = await boxes(read, 0, total);
  if (top[0]?.type !== 'ftyp') return { ok: false, reason: 'MP4 の動画ではありません' };
  const moov = top.find((b) => b.type === 'moov');
  if (!moov) return { ok: false, reason: '動画の記録（moov）がありません' };
  if (moov.size > 64 * 1024 * 1024) return { ok: false, reason: '動画の記録が大きすぎます' };
  const bytes = await read(moov.start, moov.size);
  if (bytes.length < moov.size) return { ok: false, reason: '動画の記録を読めませんでした' };

  let timescale = 0;
  let duration = 0;
  let codec = '';
  let width = 0;
  let height = 0;
  // 記憶の上の moov を、箱ごとにたどる
  const walk = (from: number, to: number, inVideo: boolean) => {
    let at = from;
    let video = inVideo;
    const kids: { type: string; body: number; end: number }[] = [];
    while (at + 8 <= to) {
      let size = u32(bytes, at);
      const type = typeOf(bytes, at + 4);
      let body = at + 8;
      if (size === 1) { size = u32(bytes, at + 12); body = at + 16; }
      if (size < 8 || at + size > to) break;
      kids.push({ type, body, end: at + size });
      at += size;
    }
    // 見本の種類は、映像の手渡し（hdlr が vide）のある mdia の中のものだけを見る
    const hdlr = kids.find((k) => k.type === 'hdlr');
    if (hdlr && typeOf(bytes, hdlr.body + 8) === 'vide') video = true;
    for (const k of kids) {
      if (k.type === 'mvhd') {
        const version = bytes[k.body]!;
        if (version === 1) { timescale = u32(bytes, k.body + 20); duration = u32(bytes, k.body + 24) * 2 ** 32 + u32(bytes, k.body + 28); }
        else { timescale = u32(bytes, k.body + 12); duration = u32(bytes, k.body + 16); }
      } else if (k.type === 'stsd' && video && !codec) {
        // stsd: 版と印（4）・数（4）のあとに、最初の見本の箱（大きさ 4・種類 4・…・横 2・縦 2）
        const entry = k.body + 8;
        if (entry + 36 <= k.end) {
          codec = typeOf(bytes, entry + 4);
          width = u16(bytes, entry + 32);
          height = u16(bytes, entry + 34);
        }
      } else if (CONTAINERS.has(k.type)) {
        walk(k.body, k.end, video);
      }
    }
    // mdia を出たら、次の trak では映像かどうかを決め直す
    if (hdlr) video = inVideo;
  };
  walk(8, bytes.length, false);

  if (!codec) return { ok: false, reason: '映像が入っていません' };
  if (!H264.has(codec)) return { ok: false, reason: `映像の形式が H.264 ではありません（${codec}）。H.264 の MP4 にして渡してください` };
  if (!timescale || !duration) return { ok: false, reason: '動画の長さを読めませんでした' };
  return { ok: true, codec, durationMs: Math.round((duration / timescale) * 1000), width, height };
}
