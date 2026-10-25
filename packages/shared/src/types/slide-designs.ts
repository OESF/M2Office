/**
 * @file スライドの組み込みのデザイン（仕様書 第9.4.2節「組み込みのデザイン」、Q-261）。
 *
 * 標準の見た目の組み立て（テンプレートのファイルを使わない）を、色・字体・飾りの組み合わせで切り替える。
 * M2Office が作ったファイルしか触らないため、権限は `drive.file` のまま。レイアウトと文字の量の決まりは変えない。
 * 組み立て（core の Google スライドの接続口）と、利用者の画面の見本の絵（web）が同じ定義を使う。
 * デザインを足すときは、ここに 1 つ足すだけでよい（見本の絵も同じ定義から描く）。
 */

/** 色（0〜1 の RGB。Slides API の `rgbColor` の形）。 */
export interface SlideRgb {
  red: number;
  green: number;
  blue: number;
}

/** 表紙の飾り。帯（左に太い帯）・線（題名の下に線）・角（右上と左下に三角）・全面（表紙を強調の色で塗る）。 */
export type SlideCoverStyle = 'band' | 'line' | 'corner' | 'full';

/** 組み込みのデザイン 1 つ。 */
export interface SlideDesign {
  /** 決まった ID（業務の入力とツールの引数に使う）。 */
  id: string;
  /** 画面に出す名前（秘書への言葉でも、この名前で選ぶ）。 */
  name: string;
  /** ひとことの説明（画面のカード）。 */
  description: string;
  /** 本文のスライドの背景。 */
  background: SlideRgb;
  /** 本文の文字。 */
  text: SlideRgb;
  /** 補う文字（出典・数値の説明など）。 */
  muted: SlideRgb;
  /** 強調の色（題名・見出し・線・数値）。 */
  accent: SlideRgb;
  /** 薄い強調の色（枠の塗り・表の見出しの行）。 */
  accentLight: SlideRgb;
  /** 表紙の背景と文字。 */
  cover: { background: SlideRgb; title: SlideRgb; subtitle: SlideRgb; style: SlideCoverStyle };
  /** 見出しと本文の字体（Google スライドの字体の名前）。 */
  font: { heading: string; body: string };
  /** 本文のスライドの題名の下に線を引くか。 */
  rule: boolean;
  /** 象徴的な画像の作風（画像を作るモデルへの頼みに足す。第9.4.2節「段 2」）。 */
  imageStyle: string;
}

const rgb = (red: number, green: number, blue: number): SlideRgb => ({ red, green, blue });
const WHITE = rgb(1, 1, 1);

/**
 * 組み込みのデザイン（6 つ）。先頭が既定（会社が既定を決めていないとき）。
 *
 * @remarks 字体は Google スライドの字体の一覧にある日本語の字体（Google Fonts）から選んだ
 */
export const SLIDE_DESIGNS: readonly SlideDesign[] = [
  {
    id: 'business', name: 'ビジネス', description: '紺と白。落ち着いた印象で、社内の報告や取引先への説明に',
    background: WHITE, text: rgb(0.2, 0.2, 0.2), muted: rgb(0.4, 0.4, 0.4), accent: rgb(0.1, 0.3, 0.55), accentLight: rgb(0.91, 0.94, 0.98),
    cover: { background: WHITE, title: rgb(0.1, 0.3, 0.55), subtitle: rgb(0.4, 0.4, 0.4), style: 'band' },
    font: { heading: 'BIZ UDPGothic', body: 'BIZ UDPGothic' }, rule: true, imageStyle: '落ち着いた写真風。紺と白を基調にした、清潔で信頼感のある画面',
  },
  {
    id: 'natural', name: 'ナチュラル', description: '緑と生成り。やわらかい印象で、地域・暮らし・食の話題に',
    background: rgb(0.98, 0.97, 0.93), text: rgb(0.22, 0.24, 0.2), muted: rgb(0.42, 0.44, 0.38), accent: rgb(0.24, 0.47, 0.29), accentLight: rgb(0.89, 0.93, 0.86),
    cover: { background: rgb(0.98, 0.97, 0.93), title: rgb(0.24, 0.47, 0.29), subtitle: rgb(0.42, 0.44, 0.38), style: 'corner' },
    font: { heading: 'M PLUS Rounded 1c', body: 'Noto Sans JP' }, rule: false, imageStyle: 'やわらかい自然光の写真風。緑と生成りを基調にした、温かみのある画面',
  },
  {
    id: 'pop', name: 'ポップ', description: 'オレンジと黄。明るい印象で、催しの案内や販促に',
    background: WHITE, text: rgb(0.2, 0.18, 0.16), muted: rgb(0.45, 0.4, 0.35), accent: rgb(0.93, 0.42, 0.1), accentLight: rgb(1, 0.95, 0.78),
    cover: { background: rgb(0.93, 0.42, 0.1), title: WHITE, subtitle: rgb(1, 0.95, 0.78), style: 'full' },
    font: { heading: 'M PLUS Rounded 1c', body: 'M PLUS Rounded 1c' }, rule: false, imageStyle: '明るい平面のイラスト。オレンジと黄を基調にした、楽しく元気な画面',
  },
  {
    id: 'monotone', name: 'モノトーン', description: '黒と灰。すっきりした印象で、印刷する資料や硬い場面に',
    background: WHITE, text: rgb(0.15, 0.15, 0.15), muted: rgb(0.45, 0.45, 0.45), accent: rgb(0.15, 0.15, 0.15), accentLight: rgb(0.93, 0.93, 0.93),
    cover: { background: WHITE, title: rgb(0.15, 0.15, 0.15), subtitle: rgb(0.45, 0.45, 0.45), style: 'line' },
    font: { heading: 'Noto Sans JP', body: 'Noto Sans JP' }, rule: true, imageStyle: '白黒の写真風。陰影のはっきりした、すっきりと上品な画面',
  },
  {
    id: 'clean', name: 'クリーン', description: '水色と白。清潔な印象で、医療・介護・説明会に',
    background: WHITE, text: rgb(0.2, 0.25, 0.3), muted: rgb(0.42, 0.48, 0.54), accent: rgb(0.12, 0.55, 0.75), accentLight: rgb(0.9, 0.96, 0.99),
    cover: { background: rgb(0.9, 0.96, 0.99), title: rgb(0.12, 0.55, 0.75), subtitle: rgb(0.42, 0.48, 0.54), style: 'line' },
    font: { heading: 'Noto Sans JP', body: 'Noto Sans JP' }, rule: true, imageStyle: '明るく清潔な写真風。水色と白を基調にした、やさしく安心感のある画面',
  },
  {
    id: 'dark', name: 'ダーク', description: '濃い背景に明るい文字。会場で映す発表に',
    background: rgb(0.12, 0.14, 0.18), text: rgb(0.93, 0.94, 0.96), muted: rgb(0.72, 0.75, 0.8), accent: rgb(0.45, 0.78, 1), accentLight: rgb(0.2, 0.23, 0.29),
    cover: { background: rgb(0.08, 0.1, 0.13), title: WHITE, subtitle: rgb(0.72, 0.75, 0.8), style: 'line' },
    font: { heading: 'Noto Sans JP', body: 'Noto Sans JP' }, rule: true, imageStyle: '暗い背景に光が浮かぶ写真風。青い光を効かせた、印象的で引き締まった画面',
  },
];

/** 会社が既定を決めていないときの組み込みのデザイン。 */
export const DEFAULT_SLIDE_DESIGN_ID = 'business';

/**
 * ID か名前から組み込みのデザインを引く（「ナチュラル」「natural」のどちらでも）。無ければ `null`。
 */
export function findSlideDesign(idOrName: string): SlideDesign | null {
  const key = idOrName.trim().toLowerCase();
  if (!key) return null;
  return SLIDE_DESIGNS.find((d) => d.id === key || d.name === idOrName.trim()) ?? null;
}

/** 色を CSS の `rgb()` にする（画面の見本の絵に使う）。 */
export function slideRgbCss(c: SlideRgb): string {
  return `rgb(${Math.round(c.red * 255)} ${Math.round(c.green * 255)} ${Math.round(c.blue * 255)})`;
}
