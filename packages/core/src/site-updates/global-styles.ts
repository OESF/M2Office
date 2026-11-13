/**
 * @file 会社の見た目を、ブロックのテーマの全体のスタイルに入れる（仕様書 第46.7節・段 3、Q-357）。
 *
 * いまの全体のスタイルに、会社の見た目の色の組・書体・見出し・リンク・ボタン・角の丸みを足した形を作る。ほかの値は変えない。
 * テーマの切り替えとテーマのファイルは扱わない。入れるのは承認の後で、前の値を持って元に戻せるようにする。
 */

import type { CompanyDesignTokens, SiteEditPageResult } from '@m2office/shared';
import { fontStack } from '../design/tokens.js';
import { readGlobalStyles, writeGlobalStyles, type SiteGlobalStyles } from './wordpress.js';
import type { WordPressAuth } from '../columns/wordpress.js';

type Obj = Record<string, unknown>;

/** 全体のスタイルの直し（置き場の形）。 */
export interface StoredGlobalStylesAction {
  op: 'globalStyles'; kind: 'global-styles'; id: string; title: string; link: string;
  before: { settings: Obj; styles: Obj }; after: { settings: Obj; styles: Obj };
  /** 使った会社の見た目の版と、見本の画像（M2Office のファイル）。 */
  designVersion: number; previewFileId: string | null; lines: string[];
  result: SiteEditPageResult; reason: string;
}

const isObj = (v: unknown): v is Obj => !!v && typeof v === 'object' && !Array.isArray(v);

/** 深く足す（`b` の値で上書きし、ほかは残す）。 */
export function deepMerge(a: Obj, b: Obj): Obj {
  const out: Obj = { ...a };
  for (const [k, v] of Object.entries(b)) out[k] = isObj(v) && isObj(a[k]) ? deepMerge(a[k] as Obj, v) : v;
  return out;
}

/** 比べるための並びを決めた JSON。 */
const stable = (v: unknown): string => (Array.isArray(v) ? `[${v.map(stable).join(',')}]`
  : isObj(v) ? `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${stable(v[k])}`).join(',')}}` : JSON.stringify(v ?? null));

/** 同じ値か（キーの並びに関わらず）。 */
export const sameStyles = (a: unknown, b: unknown) => stable(a) === stable(b);

const PALETTE_SLUG = 'm2o-';

/**
 * いまの全体のスタイルに、会社の見た目を足した形を作る。色の組は M2Office の分（`m2o-` で始まる）だけを差し替える。
 */
export function stylesWithDesign(cur: SiteGlobalStyles, t: CompanyDesignTokens): { settings: Obj; styles: Obj } {
  const c = t.colors;
  const named: [string, string, string][] = [['primary', '主の色', c.primary], ['secondary', '副の色', c.secondary], ['accent', '差し色', c.accent], ['background', '背景', c.background], ['surface', '面', c.surface], ['text', '本文', c.text]];
  const colorSettings = isObj(cur.settings['color']) ? cur.settings['color'] as Obj : {};
  const palette = isObj(colorSettings['palette']) ? colorSettings['palette'] as Obj : {};
  const custom = (Array.isArray(palette['custom']) ? palette['custom'] as Obj[] : []).filter((p) => !String(p['slug'] ?? '').startsWith(PALETTE_SLUG));
  const settings = deepMerge(cur.settings, { color: { palette: { custom: [...custom, ...named.map(([slug, name, color]) => ({ slug: `${PALETTE_SLUG}${slug}`, name, color }))] } } });
  const radius = t.shape.button === 'pill' ? '999px' : t.shape.button === 'square' ? '0px' : `${t.shape.radiusMedium}px`;
  const styles = deepMerge(cur.styles, {
    color: { background: c.background, text: c.text },
    typography: { fontFamily: fontStack(t.typography.bodyJa, t.typography.latin), fontSize: `${t.typography.baseSize}px` },
    elements: {
      link: { color: { text: c.link } },
      heading: { color: { text: c.text }, typography: { fontFamily: fontStack(t.typography.headingJa, t.typography.latin), fontWeight: String(t.typography.headingWeight) } },
      button: { color: { background: c.primary, text: c.onPrimary }, border: { radius } },
    },
  });
  return { settings, styles };
}

/** 承認の画面に出す、何が変わるかの行。 */
export function globalStylesLines(t: CompanyDesignTokens, theme: string): string[] {
  return [
    `テーマ「${theme}」の全体のスタイルに、会社の見た目を入れる（サイトのすべてのページの見た目が変わります）`,
    `色: 主の色 ${t.colors.primary}・本文 ${t.colors.text}・背景 ${t.colors.background}・リンク ${t.colors.link}`,
    `書体: 見出し ${t.typography.headingJa}・本文 ${t.typography.bodyJa}（欧文 ${t.typography.latin}）・本文 ${t.typography.baseSize}px`,
    `ボタン: ${t.shape.button === 'pill' ? '丸い端' : t.shape.button === 'square' ? '角' : `角の丸み ${t.shape.radiusMedium}px`}`,
  ];
}

/** 承認された直しを入れる。直し案の後に WordPress で変えられていれば上書きしない。 */
export async function applyGlobalStyles(wp: WordPressAuth, a: StoredGlobalStylesAction): Promise<StoredGlobalStylesAction> {
  const cur = await readGlobalStyles(wp);
  if ('error' in cur) return { ...a, result: 'failed', reason: cur.error };
  if (cur.id !== a.id || !sameStyles({ settings: cur.settings, styles: cur.styles }, a.before)) {
    return { ...a, result: 'conflict', reason: '直し案を作った後に、WordPress で全体のスタイルが変えられていました' };
  }
  const err = await writeGlobalStyles(wp, a.id, a.after);
  return err ? { ...a, result: 'failed', reason: err } : { ...a, result: 'applied', reason: '' };
}

/** 入れた直しを元に戻す直しにする。入れた後に変えられていれば戻さない。 */
export async function revertGlobalStyles(wp: WordPressAuth, a: StoredGlobalStylesAction): Promise<StoredGlobalStylesAction | { blocked: string }> {
  const cur = await readGlobalStyles(wp);
  if ('error' in cur) return { blocked: `サイトの全体のスタイル（${cur.error}）` };
  if (!sameStyles({ settings: cur.settings, styles: cur.styles }, a.after)) return { blocked: 'サイトの全体のスタイル（入れた後に WordPress で変えられています）' };
  return { ...a, before: a.after, after: a.before, previewFileId: null, lines: ['サイトの全体のスタイルを、会社の見た目を入れる前に戻す'], result: 'pending', reason: '' };
}
