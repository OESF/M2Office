/**
 * @file 販促物の作成（内蔵の拡張。仕様書 第41章）の型と決まり。
 *
 * ポップ・チラシ・パンフレット・案内・ポスター・ショップカードを、M2Office の型と組み版で作る。字は M2Office が組み、
 * 生成 AI には文字の無い画像だけを作らせる。印刷の発注とお金は扱わない（第41.7節）。
 */

/** 販促物の作成の拡張機能の ID。 */
export const PRINT_DESIGNS_EXTENSION_ID = 'print-designs';

/** 作る物の種類（第41.3節。値札は第41.18節）。 */
export type PrintKind = 'pop' | 'flyer' | 'brochure' | 'notice' | 'poster' | 'card' | 'tags';

/** 種類の名前。 */
export const PRINT_KIND_LABELS: Record<PrintKind, string> = {
  pop: 'ポップ', flyer: 'チラシ', brochure: 'パンフレット', notice: '案内', poster: 'ポスター', card: 'ショップカード', tags: '値札',
};

/** 紙の大きさ（第41.3節）。 */
export type PrintSize = 'A6' | 'A5' | 'A4' | 'A3' | 'A2' | 'B5' | 'B2' | 'postcard' | 'card' | 'A4-3fold' | 'A4-2fold';

/** 大きさの名前と、仕上がりの寸法（mm。縦長の向き。三つ折り・二つ折りは広げた横長）。 */
export const PRINT_SIZES: Record<PrintSize, { label: string; w: number; h: number }> = {
  A6: { label: 'A6', w: 105, h: 148 },
  A5: { label: 'A5', w: 148, h: 210 },
  A4: { label: 'A4', w: 210, h: 297 },
  A3: { label: 'A3', w: 297, h: 420 },
  A2: { label: 'A2', w: 420, h: 594 },
  B5: { label: 'B5', w: 182, h: 257 },
  B2: { label: 'B2', w: 515, h: 728 },
  postcard: { label: 'はがき', w: 100, h: 148 },
  card: { label: 'ショップカード（名刺の大きさ）', w: 91, h: 55 },
  'A4-3fold': { label: 'A4 三つ折り', w: 297, h: 210 },
  'A4-2fold': { label: 'A4 二つ折り', w: 297, h: 210 },
};

/** 種類ごとに使える大きさ（はじめの値は先頭）。 */
export const PRINT_KIND_SIZES: Record<PrintKind, PrintSize[]> = {
  pop: ['A6', 'A5', 'postcard'],
  flyer: ['A4', 'B5'],
  brochure: ['A4-3fold', 'A4-2fold'],
  notice: ['A4', 'A3'],
  poster: ['A3', 'A2', 'B2'],
  card: ['card'],
  // 値札は A4 に名刺の大きさの札を 10 枚（第41.18節）
  tags: ['A4'],
};

/** 文面（第41.4節）。言われていない値段・期間・条件は空にする。 */
export interface PrintCopy {
  /** 見出し */
  headline: string;
  /** ひとこと（見出しの下の短い文） */
  sub: string;
  /** 本文（箇条は改行で分ける） */
  body: string;
  /** 期間・日時（「3/1（土）〜3/15（土）」） */
  period: string;
  /** 値段・割引（「全品 10% オフ」「450 円」） */
  price: string;
  /** 注意書き（「一部対象外の商品があります」） */
  note: string;
  /** QR にする URL（任意。会社の Web サイトなど） */
  qrUrl: string;
  /**
   * 同じ型で何枚も作るときの 1 枚ごとの文面（第41.19.1節）。空なら 1 枚。
   * 1 枚ごとに見出し・ひとこと・値段を差し替え、本文・期間・注意書き・QR は共通にする。
   */
  pieces: PrintPiece[];
}

/** 何枚も作るときの 1 枚分（第41.19.1節）。 */
export interface PrintPiece {
  headline: string;
  sub: string;
  price: string;
}

/** 空の文面。 */
export const EMPTY_PRINT_COPY: PrintCopy = { headline: '', sub: '', body: '', period: '', price: '', note: '', qrUrl: '', pieces: [] };

/** 点検の印（第41.6節）。断定しない。 */
export interface PrintCheck {
  kind: 'typo' | 'weekday' | 'contact' | 'law' | 'image' | 'readability' | 'fit' | 'price';
  /** 確かめてほしいこと（1 文） */
  message: string;
}

/** 点検の種類の名前。 */
export const PRINT_CHECK_LABELS: Record<PrintCheck['kind'], string> = {
  typo: '誤字', weekday: '日付と曜日', contact: '連絡先', law: '表示の決まり', image: '画像', readability: '読みやすさ', fit: '文の長さ', price: '値段',
};

/** 画像の出どころ（第41.5節）。 */
export type PrintImageSource = 'none' | 'ai' | 'photo';

/** 1 つの版（案も版の 1 つ。第41.13節）。 */
export interface PrintVersion {
  id: string;
  designId: string;
  /** 版の番号（1 から。3 案は 1〜3） */
  no: number;
  /** 案か（選ぶ前の 3 案） */
  proposal: boolean;
  template: string;
  /** 配色の組み合わせ（0〜2） */
  palette: number;
  /** 主の色（`#rrggbb`） */
  color: string;
  /** 見出しの大きさの倍率（会話の「もっと大きく」で変える。0.7〜1.4） */
  headlineScale: number;
  copy: PrintCopy;
  image: PrintImageSource;
  /** 生成 AI で作った画像か（保存の印。第41.5節） */
  aiImage: boolean;
  checks: PrintCheck[];
  /** この版を作った頼み（「見出しをもっと大きく」など。最初の案は空） */
  instruction: string;
  createdBy: string;
  createdAt: string;
}

/** 1 つの物（第41.8節）。 */
export interface PrintDesign {
  id: string;
  title: string;
  kind: PrintKind;
  size: PrintSize;
  /** 選んだ版（案を選ぶ前は `null`） */
  currentVersionId: string | null;
  /** 掲示の期間（YYYY-MM-DD。無ければ下書き） */
  postFrom: string | null;
  postTo: string | null;
  /** 置き場所（「レジ横」など） */
  place: string;
  /** 外した日時（期間が終わって外したとき） */
  removedAt: string | null;
  /** 作った頼み（作り直しに使う） */
  request: string;
  /** 元にした物（作り直したとき） */
  remadeFrom: string | null;
  createdBy: string;
  createdByName: string;
  createdAt: string;
  updatedAt: string;
  /** 店頭サイネージに流しているか（第41.18節） */
  signage: PrintSignage;
  /** Canva で仕上げているデザイン（第41.19.3節）。取り込んでいなければ `null` */
  canva: PrintCanvaLink | null;
}

/** Canva に取り込んだデザイン（第41.19.3節）。 */
export interface PrintCanvaLink {
  designId: string;
  /** Canva の編集の画面（30 日で切れる） */
  editUrl: string;
  /** 取り込んだ版の番号 */
  versionNo: number;
  at: string;
}

/** Canva で直した版の型の名前（会話の直し・文面の直し・入稿用の PDF を作れない）。 */
export const CANVA_TEMPLATE = 'canva';

/** サイネージの状態（`waiting` は掲示の始まりを待っている）。 */
export type PrintSignageState = 'none' | 'waiting' | 'on';

/** 店頭サイネージに流している様子（第41.18節）。 */
export interface PrintSignage {
  state: PrintSignageState;
  /** 流している画面の名前 */
  screens: string[];
  /** 流した（待ち始めた）日時 */
  at: string | null;
}

/** 流していない。 */
export const NO_PRINT_SIGNAGE: PrintSignage = { state: 'none', screens: [], at: null };

/** 掲示の状態（期間から求める。第41.8節）。 */
export type PrintState = 'draft' | 'upcoming' | 'posted' | 'ended' | 'removed';

/** 状態の名前。 */
export const PRINT_STATE_LABELS: Record<PrintState, string> = {
  draft: '下書き', upcoming: 'これから', posted: '掲示中', ended: '期間が終わった', removed: '外した',
};

/** 物の状態（純粋な関数）。 */
export function printStateOf(d: Pick<PrintDesign, 'postFrom' | 'postTo' | 'removedAt'>, today: string): PrintState {
  if (d.removedAt) return 'removed';
  if (!d.postFrom && !d.postTo) return 'draft';
  if (d.postFrom && today < d.postFrom) return 'upcoming';
  if (d.postTo && today > d.postTo) return 'ended';
  return 'posted';
}

/** 会社の設定。 */
export interface PrintDesignSettings {
  enabled: boolean;
}

/** 販促物の作成は既定で切り（第41.2節）。 */
export const DEFAULT_PRINT_DESIGN_SETTINGS: PrintDesignSettings = { enabled: false };

/** 決まり。 */
export const PRINT_LIMITS = {
  /** 案の数 */
  proposals: 3,
  /** 1 つの物の版の上限（古いものから消す） */
  versionsMax: 30,
  /** 文面の長さ */
  headlineMax: 40,
  subMax: 60,
  bodyMax: 1200,
  periodMax: 60,
  priceMax: 40,
  noteMax: 120,
  /** 頼みの長さ */
  requestMax: 1000,
  placeMax: 40,
  /** 見出しの倍率の幅 */
  headlineScaleMin: 0.7,
  headlineScaleMax: 1.4,
  /** 値札の 1 枚のシートの札の数と、1 つの物の品目の上限（第41.18節） */
  tagsPerSheet: 10,
  tagsMax: 30,
  /** 同じ型で何枚も作るときの上限（第41.19.1節） */
  piecesMax: 10,
} as const;

/** API が返す 1 つの物（物と、掲示の状態と、版。3 案も版）。 */
export interface PrintDesignDetailView {
  design: PrintDesign;
  state: PrintState;
  versions: PrintVersion[];
  /** つなげる先を、いま使えるか（API が添える。第41.18節） */
  links?: {
    signage: boolean; announcements: boolean; drive?: boolean;
    /** Canva（`none`: 運営が設定していない、`connect`: 本人がつないでいない、`ready`: 使える。第41.19.3節） */
    canva?: 'none' | 'connect' | 'ready';
  };
}

/** 画面の道（1 つの物）。 */
export const printDesignPath = (id: string) => `/print-designs/${encodeURIComponent(id)}`;
