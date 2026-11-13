/**
 * @file クラシックのテーマに貼る CSS と、テーマの設定で変える所（仕様書 第46.7節・段 2、Q-355・Q-356）。
 *
 * M2Office はサイトを書き換えない（追加 CSS もテーマの設定も REST に出ていない）。人が「追加 CSS」に貼る文を作る。
 * CSS は決まった形に直した値（`normalizeDesign`）だけから組み立てる（外から来た文を CSS に入れない）。外部の読み込みは
 * `fonts.googleapis.com` の書体だけ（Q-355）。印の注釈で囲み、作り直したときに差し替えやすくする。
 */

import type { CompanyDesignTokens } from '@m2office/shared';
import { fontStack, mix } from './tokens.js';
import type { SiteDesignSignals } from './site-signals.js';

/** 貼る CSS と手順。 */
export interface SiteCss {
  /** 読んだテーマの名前。 */
  theme: string | null;
  /** テーマの作り（`theme.json` を持てばブロック）。 */
  kind: 'classic' | 'block' | 'unknown';
  /** そのテーマに合わせた CSS か（色の変数を上書きする）。 */
  tuned: boolean;
  css: string;
  /** 人が行う手順。 */
  steps: string[];
  notes: string[];
}

/** 囲みの印。 */
export const SITE_CSS_BEGIN = '/* M2Office 会社の見た目 ここから';
export const SITE_CSS_END = '/* M2Office 会社の見た目 ここまで */';

/** Google Fonts にある書体（読み込みを足すもの）。 */
const GOOGLE_FONTS = new Set([
  'Noto Sans JP', 'Noto Serif JP', 'M PLUS 1p', 'M PLUS Rounded 1c', 'Zen Kaku Gothic New', 'Zen Maru Gothic', 'Zen Old Mincho', 'BIZ UDPGothic', 'BIZ UDPMincho',
  'Kosugi Maru', 'Sawarabi Gothic', 'Sawarabi Mincho', 'Shippori Mincho', 'Kiwi Maru', 'Murecho', 'IBM Plex Sans JP',
  'Inter', 'Lato', 'Roboto', 'Open Sans', 'Montserrat', 'Poppins', 'Source Sans 3', 'Noto Sans', 'Work Sans', 'DM Sans', 'Nunito', 'Playfair Display', 'Merriweather',
]);

/** Google Fonts の読み込み（無ければ空）。 */
export function googleFontsImport(t: CompanyDesignTokens): string {
  const fams = [...new Set([t.typography.latin, t.typography.headingJa, t.typography.bodyJa])].filter((f) => GOOGLE_FONTS.has(f));
  if (!fams.length) return '';
  const weights = [...new Set([t.typography.bodyWeight, t.typography.headingWeight])].sort((a, b) => a - b).join(';');
  return `@import url("https://fonts.googleapis.com/css2?${fams.map((f) => `family=${f.replace(/ /g, '+')}:wght@${weights}`).join('&')}&display=swap");`;
}

const isLightning = (s: SiteDesignSignals | null) => !!s && (s.theme === 'lightning' || s.theme?.startsWith('lightning') || s.variables.some((v) => v.name === '--vk-color-primary'));

/**
 * 会社の見た目から、そのサイトのテーマに合わせた CSS と手順を作る。
 *
 * @param signals サイトの手がかり（読めなければ `null` で、一般の上書きにする）
 */
export function siteCssFor(t: CompanyDesignTokens, signals: SiteDesignSignals | null, version?: number): SiteCss {
  const c = t.colors;
  const body = fontStack(t.typography.bodyJa, t.typography.latin);
  const heading = fontStack(t.typography.headingJa, t.typography.latin);
  const radius = t.shape.button === 'pill' ? '999px' : t.shape.button === 'square' ? '0' : `${t.shape.radiusMedium}px`;
  const imp = googleFontsImport(t);
  const lightning = isLightning(signals);
  // 印の注釈を先に置き、@import はその次（注釈は @import の前に置ける。囲みごと差し替えられるように）
  const lines: string[] = [`${SITE_CSS_BEGIN}${version ? `（第 ${version} 版）` : ''}。作り直したら、ここから「ここまで」を差し替えてください */`];
  if (imp) lines.push(imp);
  if (lightning) {
    // Lightning（G3）の色の変数（2026-11-13 に、公開の CSS で名前を確かめた）
    lines.push(':root {',
      `  --vk-color-primary: ${c.primary};`, `  --vk-color-primary-dark: ${mix(c.primary, '#000000', 0.15)};`, `  --vk-color-primary-vivid: ${mix(c.primary, '#ffffff', 0.12)};`,
      `  --vk-color-text-body: ${c.text};`, `  --vk-color-text-header: ${c.text};`, `  --vk-color-text-meta: ${c.muted};`, `  --vk-color-text-light: ${c.muted};`,
      `  --vk-color-text-link: ${c.link};`, `  --vk-color-text-link-hover: ${mix(c.link, '#000000', 0.15)};`, `  --vk-color-link-text: ${c.link};`, `  --vk-color-link-text-hover: ${mix(c.link, '#000000', 0.15)};`,
      `  --vk-color-border-hr: ${c.border};`, `  --vk-color-border-image: ${c.border};`, `  --vk-color-footer-bg: ${c.surface};`,
      `  --vk-size-radius: ${t.shape.radiusMedium}px;`, `  --vk-size-text: ${t.typography.baseSize}px;`,
      '}');
  }
  lines.push(
    `body { font-family: ${body}; color: ${c.text}; }`,
    `h1, h2, h3, h4, h5, h6 { font-family: ${heading}; font-weight: ${t.typography.headingWeight}; }`,
    `a { color: ${c.link}; }`,
    `a:hover { color: ${mix(c.link, '#000000', 0.15)}; }`,
    `button, input[type="submit"], .btn-primary, .wp-block-button__link, .wp-element-button { background-color: ${c.primary}; border-color: ${c.primary}; color: ${c.onPrimary}; border-radius: ${radius}; }`,
    SITE_CSS_END,
  );
  const kind: SiteCss['kind'] = signals?.themeJson === true ? 'block' : signals?.themeJson === false ? 'classic' : 'unknown';
  const steps = [
    ...(lightning ? [`WordPress の管理画面の「外観 › カスタマイズ」で、Lightning の色の設定のキーカラーを ${c.primary} にする（テーマが出す色と、下の CSS をそろえるため）`] : []),
    '「外観 › カスタマイズ › 追加 CSS」の**いちばん上**に、下の CSS を貼る。前に貼った「M2Office 会社の見た目」の囲みがあれば、その囲みと差し替える',
    '「公開」を押し、トップのページと記事のページで見た目を確かめる。崩れたら、貼った囲みを消せば元に戻る',
  ];
  const notes = [
    ...(imp ? ['書体を Google Fonts から読み込みます。読み込むと、サイトを見た人の IP アドレスが Google に届きます。避けるときは、先頭の @import の行を消してください（端末にある書体で出ます）'] : []),
    ...(lightning ? [] : [`${signals?.theme ? `テーマ「${signals.theme}」` : 'このテーマ'}に合わせた色の変数が分からないので、本文・見出し・リンク・ボタンだけを上書きします。ヘッダーやフッターの色は、テーマの設定で直してください`]),
    ...(kind === 'block' ? ['このサイトはブロックのテーマです。「サイトの見た目を会社の見た目にして」と頼めば、承認の後に M2Office が全体のスタイルに入れます'] : []),
  ];
  return { theme: signals?.theme ?? null, kind, tuned: lightning, css: lines.join('\n'), steps, notes };
}
