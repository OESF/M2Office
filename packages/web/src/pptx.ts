/**
 * @file PowerPoint のファイル（`.pptx`・`.ppsx`）の中を、ブラウザで数える（仕様書 第31.6.4節）。
 *
 * スライドの枚数・アニメーションの有無・スライドの縦横だけを読み、動画にする操作を、そのファイルに合わせて示すために使う。
 * ファイルはサーバーに送らず、保存しない。中のマクロや埋め込みは動かさない（ZIP の目次と XML の文字だけを読む）。
 * 推論も変換の部品も使わない。
 */

import { readDirectory, readText } from './zip.js';

/** 数えた結果。 */
export interface PptxInfo {
  slides: number;
  animations: boolean;
  /** スライドの向き（分からなければ `null`）。 */
  orientation: 'landscape' | 'portrait' | null;
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
