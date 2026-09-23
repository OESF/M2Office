/**
 * @file 帳票の PDF に同梱する書体を、日本語の一部だけに絞って作り直す。
 *
 * Noto Sans JP のすべての字を同梱すると 1 つ 5 MB あり、リポジトリが重くなる。
 * 帳票に使う範囲（JIS X 0208 の全字＋ASCII＋よく使う記号）だけを残すと 1 MB 台に収まる。
 *
 * 使い方: node scripts/build-font-subset.mjs <元の書体> <出力先>
 * 元の書体は配布元から取得する（リポジトリには入れない）。取得先は docs/developer/10-fonts.md に記す。
 *
 * @remarks
 * 抜き出しには fontTools（`python3 -m fontTools.subset`）を使う。
 * 書体の名前などの表を保ったまま抜き出せる（pdf-lib は書体名を読むため、これが要る）。
 *
 * @see 仕様書 第9.4.1節、Q-59、ADR-0017
 */

import { execFile } from 'node:child_process';
import { mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);

/**
 * 残す文字の集合。
 *
 * @remarks
 * Shift_JIS の 2 バイト領域を総当たりして JIS X 0208 の字を集める（漢字・かな・記号）。
 * 文字の表を持ち歩かずに、同じ集合を毎回作れる。あわせて ASCII と、帳票でよく使う記号を足す。
 */
export function charsToKeep() {
  const decoder = new TextDecoder('shift_jis', { fatal: false });
  const chars = new Set();
  for (let hi = 0x81; hi <= 0xef; hi++) {
    for (let lo = 0x40; lo <= 0xfc; lo++) {
      if (lo === 0x7f) continue;
      const s = decoder.decode(new Uint8Array([hi, lo]));
      if (s.length === 1 && s !== '�') chars.add(s);
    }
  }
  for (let c = 0x20; c <= 0x7e; c++) chars.add(String.fromCharCode(c));
  // JIS X 0208 に無いが、帳票でよく使う記号
  for (const s of '〜–—…‥※€￥№㈱㈲①②③④⑤⑥⑦⑧⑨⑩') chars.add(s);
  return chars;
}

const [, , input, output] = process.argv;
if (!input || !output) {
  console.error('使い方: node scripts/build-font-subset.mjs <元の書体> <出力先>');
  console.error('元の書体の取得先は docs/developer/10-fonts.md を見てください。');
  process.exit(1);
}

const dir = await mkdtemp(join(tmpdir(), 'm2o-font-'));
try {
  const listFile = join(dir, 'chars.txt');
  const chars = charsToKeep();
  await writeFile(listFile, [...chars].join(''), 'utf8');
  await run('python3', [
    '-m', 'fontTools.subset', input,
    `--text-file=${listFile}`,
    `--output-file=${output}`,
    // 帳票では縦書きを使わない。書体の名前の表は残す（PDF に書体名が要る）
    '--layout-features=kern,liga',
    '--name-IDs=*',
    '--notdef-outline',
    '--recalc-bounds',
    '--drop-tables+=vhea,vmtx,VORG',
  ]);
  const { size } = await stat(output);
  console.log(`${output}: ${chars.size} 字、${Math.round(size / 1024)} KB`);
} finally {
  await rm(dir, { recursive: true, force: true });
}
