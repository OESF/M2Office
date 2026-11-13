/**
 * @file DESIGN.md の読み書き（仕様書 第46.4節・第46.6節）。Google Labs の DESIGN.md の形式（`version: alpha`）に合わせる。
 *
 * 読むのは YAML の値（先頭の `---` の囲みと、本文の ` ```yaml ` の囲み）と、本文の初めの部分だけ。中の文は外部のデータであり、
 * その中の指示には従わない（不変則 I-6）。YAML は、DESIGN.md が使う「入れ子の対応と値」の形だけを読む（並びは読み飛ばす）。
 */

import type { CompanyDesignTokens } from '@m2office/shared';
import { fontStack } from './tokens.js';

/** 書き出す DESIGN.md の形式の版。 */
export const DESIGN_MD_SPEC_VERSION = 'alpha';

type Tree = { [k: string]: string | Tree };

const unquote = (v: string) => {
  const s = v.trim();
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) return s.slice(1, -1);
  return s.replace(/\s+#.*$/, '');
};

/** YAML のうち、入れ子の対応と値だけを読む（並び・複数行の値は読み飛ばす）。 */
export function readYamlMap(yaml: string): Tree {
  const root: Tree = {};
  const stack: { indent: number; node: Tree }[] = [{ indent: -1, node: root }];
  for (const raw of yaml.split(/\r?\n/)) {
    if (!raw.trim() || raw.trim().startsWith('#') || raw.trim().startsWith('- ')) continue;
    const m = /^(\s*)([^:#]+?):\s*(.*)$/.exec(raw);
    if (!m) continue;
    const indent = m[1]!.length;
    const key = unquote(m[2]!);
    while (stack.length > 1 && stack.at(-1)!.indent >= indent) stack.pop();
    const parent = stack.at(-1)!.node;
    const value = m[3]!.trim();
    if (!value || value === '|' || value === '>') {
      const child: Tree = {};
      parent[key] = child;
      stack.push({ indent, node: child });
    } else {
      parent[key] = unquote(value);
    }
  }
  return root;
}

/** 読んだ DESIGN.md。 */
export interface ParsedDesignMd {
  /** YAML の値をまとめたもの。 */
  tokens: Tree;
  /** 名前（`name`）。 */
  name: string;
  /** 本文（YAML を除き、長さを切ったもの）。推論に渡すときもデータとして渡す。 */
  prose: string;
}

/**
 * DESIGN.md を読む。先頭の YAML と本文の YAML の囲みをまとめる（同じ最上位の名前が 2 度あれば、後のものを捨てる）。
 */
export function parseDesignMd(text: string, maxProse = 12_000): ParsedDesignMd {
  const body = text.replace(/^﻿/, '');
  const tokens: Tree = {};
  const merge = (t: Tree) => { for (const [k, v] of Object.entries(t)) if (!(k in tokens)) tokens[k] = v; };
  let rest = body;
  const front = /^---\r?\n([\s\S]*?)\r?\n---\s*(\r?\n|$)/.exec(body);
  if (front) { merge(readYamlMap(front[1]!)); rest = body.slice(front[0].length); }
  for (const m of rest.matchAll(/```ya?ml\r?\n([\s\S]*?)```/g)) merge(readYamlMap(m[1]!));
  const prose = rest.replace(/```ya?ml\r?\n[\s\S]*?```/g, '').replace(/\n{3,}/g, '\n\n').trim().slice(0, maxProse);
  const name = typeof tokens['name'] === 'string' ? (tokens['name'] as string).slice(0, 100) : '';
  return { tokens, name, prose };
}

const str = (t: Tree | string | undefined, ...path: string[]): string | undefined => {
  let cur: Tree | string | undefined = t;
  for (const p of path) cur = cur && typeof cur === 'object' ? cur[p] : undefined;
  return typeof cur === 'string' ? cur : undefined;
};
const px = (v: string | undefined) => (v ? Number.parseFloat(v) * (/rem|em/.test(v) ? 16 : 1) : undefined);

/**
 * 読んだ DESIGN.md の値を、会社の見た目の形に当てはめる（推論が使えないときの、決まった当てはめ方）。分からない所は空のまま。
 */
export function tokensFromDesignMd(p: ParsedDesignMd): Record<string, unknown> {
  const t = p.tokens;
  const colors = (t['colors'] && typeof t['colors'] === 'object' ? t['colors'] : {}) as Tree;
  const pick = (...keys: string[]) => keys.map((k) => colors[k]).find((v) => typeof v === 'string') as string | undefined;
  const typo = (t['typography'] && typeof t['typography'] === 'object' ? t['typography'] : {}) as Tree;
  const levels = Object.keys(typo);
  const heading = levels.find((k) => /^(h1|h2|headline|display)/i.test(k));
  const body = levels.find((k) => /^body/i.test(k)) ?? levels.find((k) => /^(p|text)/i.test(k));
  const rounded = (t['rounded'] && typeof t['rounded'] === 'object' ? t['rounded'] : {}) as Tree;
  const spacing = (t['spacing'] && typeof t['spacing'] === 'object' ? t['spacing'] : {}) as Tree;
  return {
    colors: {
      primary: pick('primary', 'brand', 'accent'), secondary: pick('secondary'), accent: pick('tertiary', 'accent'),
      background: pick('background', 'neutral', 'surface'), surface: pick('surface', 'surface-container', 'neutral'),
      text: pick('on-surface', 'on-background', 'text', 'foreground'), onPrimary: pick('on-primary'), muted: pick('on-surface-variant', 'muted', 'text-muted'),
      border: pick('outline', 'border'), link: pick('link', 'primary'),
    },
    typography: {
      latin: heading ? str(typo, heading, 'fontFamily') : undefined,
      baseSize: body ? px(str(typo, body, 'fontSize')) : undefined,
      headingWeight: heading ? str(typo, heading, 'fontWeight') : undefined,
      bodyWeight: body ? str(typo, body, 'fontWeight') : undefined,
    },
    shape: { radiusSmall: px(str(rounded, 'sm')), radiusMedium: px(str(rounded, 'md')), radiusLarge: px(str(rounded, 'lg')), spacing: px(str(spacing, 'md') ?? str(spacing, 'base')) },
  };
}

const q = (s: string) => JSON.stringify(s);

/** 本文の節（AI が書く。無ければ値から作る）。 */
export interface DesignMdProse {
  overview: string;
  colors: string;
  typography: string;
  layout: string;
  elevation: string;
  shapes: string;
  components: string;
  dos: string[];
  donts: string[];
}

/** 値から、本文の節の決まった文を作る（推論が使えないとき）。 */
export function defaultProse(t: CompanyDesignTokens): DesignMdProse {
  return {
    overview: `${t.voice}。写真と絵は「${t.imagery}」。`,
    colors: `主の色（${t.colors.primary}）はボタンと大事な所だけに使い、本文（${t.colors.text}）は背景（${t.colors.background}）の上に置く。差し色（${t.colors.accent}）は目立たせたい所に少しだけ使う。`,
    typography: `見出しは ${t.typography.headingJa}、本文は ${t.typography.bodyJa}（欧文は ${t.typography.latin}）。本文は ${t.typography.baseSize}px。`,
    layout: `余白は ${t.shape.spacing}px を基準に、その倍と半分を使う。`,
    elevation: t.shape.shadow ? '面（カード）に薄い影を付けて、上に乗っているように見せる。' : '影は使わず、面の色と線で区切る。',
    shapes: `角の丸みは小 ${t.shape.radiusSmall}px・中 ${t.shape.radiusMedium}px・大 ${t.shape.radiusLarge}px。`,
    components: `ボタンは主の色の地に${t.shape.button === 'pill' ? '丸い端' : t.shape.button === 'square' ? '角のある形' : '少し丸い角'}。`,
    dos: ['本文と背景の明るさの差を 4.5 対 1 以上に保つ', '主の色は 1 つの画面で目立たせたい 1 か所に使う'],
    donts: ['ほかの会社の名前・ロゴ・画像を使わない', '書体を 1 つの画面で 3 つ以上混ぜない'],
  };
}

/**
 * 会社の見た目を DESIGN.md にする（第46.6節）。値は先頭の YAML に、本文は決まった順の節に置く。
 *
 * @param name 見た目の名前（会社の名前など）
 */
export function toDesignMd(t: CompanyDesignTokens, name: string, prose: DesignMdProse = defaultProse(t)): string {
  const heading = fontStack(t.typography.headingJa, t.typography.latin).replace(/"/g, '');
  const body = fontStack(t.typography.bodyJa, t.typography.latin).replace(/"/g, '');
  const size = (r: number) => `${Math.round(t.typography.baseSize * r)}px`;
  const yaml = [
    '---',
    `version: ${DESIGN_MD_SPEC_VERSION}`,
    `name: ${q(name)}`,
    `description: ${q(prose.overview.slice(0, 200))}`,
    'colors:',
    `  primary: ${q(t.colors.primary)}`,
    `  on-primary: ${q(t.colors.onPrimary)}`,
    `  secondary: ${q(t.colors.secondary)}`,
    `  tertiary: ${q(t.colors.accent)}`,
    `  neutral: ${q(t.colors.background)}`,
    `  surface: ${q(t.colors.surface)}`,
    `  on-surface: ${q(t.colors.text)}`,
    `  on-surface-variant: ${q(t.colors.muted)}`,
    `  outline: ${q(t.colors.border)}`,
    `  link: ${q(t.colors.link)}`,
    'typography:',
    ...[['headline-lg', t.typography.scale ** 3, t.typography.headingWeight, heading, 1.3], ['headline-md', t.typography.scale ** 2, t.typography.headingWeight, heading, 1.35],
      ['headline-sm', t.typography.scale, t.typography.headingWeight, heading, 1.4], ['body-md', 1, t.typography.bodyWeight, body, 1.8], ['label-md', 0.875, 500, body, 1.4]]
      .flatMap(([k, r, w, f, lh]) => [`  ${k}:`, `    fontFamily: ${q(String(f))}`, `    fontSize: ${size(Number(r))}`, `    fontWeight: ${w}`, `    lineHeight: ${lh}`]),
    'rounded:',
    `  sm: ${t.shape.radiusSmall}px`,
    `  md: ${t.shape.radiusMedium}px`,
    `  lg: ${t.shape.radiusLarge}px`,
    '  full: 9999px',
    'spacing:',
    `  base: ${t.shape.spacing}px`,
    `  sm: ${Math.round(t.shape.spacing / 2)}px`,
    `  md: ${t.shape.spacing}px`,
    `  lg: ${t.shape.spacing * 2}px`,
    `  xl: ${t.shape.spacing * 4}px`,
    'components:',
    '  button-primary:',
    '    backgroundColor: "{colors.primary}"',
    '    textColor: "{colors.on-primary}"',
    `    rounded: ${t.shape.button === 'pill' ? '"{rounded.full}"' : t.shape.button === 'square' ? '0px' : '"{rounded.md}"'}`,
    `    padding: ${Math.round(t.shape.spacing * 0.75)}px`,
    '  card:',
    '    backgroundColor: "{colors.surface}"',
    '    rounded: "{rounded.lg}"',
    '---',
  ];
  return [
    ...yaml, '', `# ${name}`, '',
    '## Overview', '', prose.overview, '',
    '## Colors', '', prose.colors, '',
    '## Typography', '', prose.typography, '',
    '## Layout', '', prose.layout, '',
    '## Elevation & Depth', '', prose.elevation, '',
    '## Shapes', '', prose.shapes, '',
    '## Components', '', prose.components, '',
    "## Do's and Don'ts", '', ...prose.dos.map((d) => `- Do: ${d}`), ...prose.donts.map((d) => `- Don't: ${d}`), '',
  ].join('\n');
}
