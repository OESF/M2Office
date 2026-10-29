/**
 * @file 運営者のヘルプ（仕様書 第23.8.16節、Q-282）。運営者マニュアル（`docs/ops-manual/`）の Markdown を章として読む。
 *
 * 画面のヘルプ用に別の文章は持たず、マニュアルをそのまま使う（二重に持つと食い違うため）。
 * `README.md` を「はじめに」、`NN-名前.md` を章とし、ファイルの名前の順に並べる。本文の「第 N 章」は、その章を開くリンクにする。
 * 外へは見に行かない。読めない章があっても飛ばして、残りを出す。
 */

import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/** 運営者マニュアルの 1 章。 */
export interface OpsManualChapter {
  /** ファイルの名前から `.md` を除いたもの（`03-tenants`）。はじめには `intro`。 */
  id: string;
  /** 章の題（いちばん上の見出し。例: `第 3 章 会社一覧と会社を作る`）。 */
  title: string;
  /** 題を除いた本文（Markdown）。 */
  body: string;
}

/** 章の一覧の 1 行（本文を除く）。 */
export type OpsManualEntry = Pick<OpsManualChapter, 'id' | 'title'>;

/** はじめに（`README.md`）の章の ID。 */
export const OPS_MANUAL_INTRO = 'intro';

/**
 * 本文の「第 N 章」を、その章を開くリンク（`[第 N 章](NN-名前.md)`）にする。コードの囲みと、すでにリンクの中の文字は変えない。
 *
 * @param byNumber 章の番号から ID への対応
 * @param self この章の ID（自分の章へはリンクしない）
 */
export function linkChapters(body: string, byNumber: ReadonlyMap<number, string>, self: string): string {
  let inCode = false;
  return body.split('\n').map((line) => {
    if (line.startsWith('```')) { inCode = !inCode; return line; }
    if (inCode) return line;
    // リンクの文字（[…]）とコード（`…`）の中は飛ばし、残りの「第 N 章」だけを置き換える
    return line.split(/(\[[^\]]*\]\([^)]*\)|`[^`]*`)/).map((part, i) => (i % 2 === 1 ? part : part.replace(/第 (\d+) 章/g, (m, n: string) => {
      const id = byNumber.get(Number(n));
      return id && id !== self ? `[${m}](${id}.md)` : m;
    }))).join('');
  }).join('\n');
}

/**
 * 運営者マニュアルを読む。
 *
 * @param dir マニュアルの置き場（リポジトリと本番の組み立てでは `docs/ops-manual`）
 * @returns はじめに・章の順。置き場が無ければ空
 */
export function loadOpsManual(dir: string): OpsManualChapter[] {
  let files: string[];
  try { files = readdirSync(dir).filter((f) => f === 'README.md' || /^\d{2}-.+\.md$/.test(f)).sort(); } catch { return []; }
  const raw = files.flatMap((f) => {
    try { return [{ file: f, text: readFileSync(join(dir, f), 'utf8') }]; } catch { return []; }
  });
  const idOf = (f: string) => (f === 'README.md' ? OPS_MANUAL_INTRO : f.replace(/\.md$/, ''));
  const byNumber = new Map(raw.filter((r) => r.file !== 'README.md').map((r) => [Number(r.file.slice(0, 2)), idOf(r.file)] as const));
  const chapters = raw.map(({ file, text }) => {
    const m = /^# (.+)\n/.exec(text);
    const id = idOf(file);
    return { id, title: file === 'README.md' ? 'はじめに' : (m?.[1]?.trim() ?? id), body: linkChapters(m ? text.slice(m[0].length) : text, byNumber, id).trim() };
  });
  // はじめにを先頭に
  return [...chapters.filter((c) => c.id === OPS_MANUAL_INTRO), ...chapters.filter((c) => c.id !== OPS_MANUAL_INTRO)];
}

/**
 * 章を文字で絞り込む（題と本文。大文字と小文字は区別しない）。空の文字ならすべて。
 */
export function searchOpsManual(chapters: readonly OpsManualChapter[], q: string): OpsManualEntry[] {
  const words = q.trim().toLowerCase().split(/\s+/).filter(Boolean);
  return chapters
    .filter((c) => words.every((w) => c.title.toLowerCase().includes(w) || c.body.toLowerCase().includes(w)))
    .map(({ id, title }) => ({ id, title }));
}
