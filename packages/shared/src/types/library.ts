/**
 * @file 資料（内蔵の拡張。仕様書 第44章）の型と決まり。
 *
 * 本体は本人の Google ドライブに置き、M2Office は探すための目録だけを持つ（第44.5節・第44.9節）。
 * 全文は持たない。中身を聞かれたら、そのときドライブから読む（Q-310）。
 */

/** 拡張機能の ID（ソースの名前）。 */
export const LIBRARY_EXTENSION_ID = 'library';

/** 資料の会社の設定。既定は切りで、管理者が入れる（Q-313）。 */
export interface LibrarySettings {
  enabled: boolean;
}

/** 資料の会社の設定の既定。 */
export const DEFAULT_LIBRARY_SETTINGS: LibrarySettings = { enabled: false };

/** 資料の決まり（第44.5節・第44.6節・第44.11節）。 */
export const LIBRARY_LIMITS = {
  /** ドライブに置く 1 ファイルの上限（Q-311） */
  placeBytes: 100 * 1024 * 1024,
  /** 中身を読む 1 ファイルの上限（Q-311） */
  readBytes: 25 * 1024 * 1024,
  /** PDF を読むページの上限（Q-311） */
  pdfPages: 50,
  /** これを超える件数をまとめて入れるときだけ、費用の目安を確かめる（第44.11節） */
  confirmCount: 500,
  /** AI に渡す文字の上限 */
  readChars: 30_000,
  /** 秘書に返す中身の文字の上限 */
  answerChars: 20_000,
  titleChars: 120,
  typeChars: 40,
  counterpartyChars: 100,
  summaryChars: 400,
  keywordCount: 20,
  keywordChars: 40,
  /** 元のフォルダの名前の上限 */
  folderChars: 200,
  /** 探す言葉の文字の上限 */
  queryChars: 300,
  /** 一覧の 1 ページの件数 */
  pageSize: 50,
  /** 読み取りに失敗してもやり直す回数 */
  attempts: 6,
} as const;

/** 資料の入口（第44.3節）。 */
export type LibraryEntry = 'pc' | 'run' | 'picker' | 'chat' | 'mail';

/** 入口の呼び名（画面の絞り込み）。 */
export const LIBRARY_ENTRY_LABELS: Record<LibraryEntry, string> = {
  pc: 'PC', run: 'M2Office', picker: 'ドライブ', chat: '秘書', mail: 'メール',
};

/** 読み取りの様子（第44.14節）。 */
export type LibraryReadState = 'pending' | 'done' | 'unreadable' | 'too_large' | 'paused';

/** 資料の形式。読めない形式でも、置いて名前と種類で探せる（第44.6節）。 */
export type LibraryFormat =
  | 'pdf' | 'docx' | 'xlsx' | 'pptx' | 'csv' | 'text' | 'png' | 'jpeg' | 'heic' | 'webp' | 'gif' | 'tiff'
  | 'doc' | 'xls' | 'ppt' | 'zip' | 'google' | 'other';

/** 形式の呼び名（一覧の印）。 */
export const LIBRARY_FORMAT_LABELS: Record<LibraryFormat, string> = {
  pdf: 'PDF', docx: 'Word', xlsx: 'Excel', pptx: 'PowerPoint', csv: 'CSV', text: 'テキスト',
  png: '画像', jpeg: '画像', heic: '画像', webp: '画像', gif: '画像', tiff: '画像',
  doc: 'Word', xls: 'Excel', ppt: 'PowerPoint', zip: 'Zip', google: 'Google', other: 'ファイル',
};

/** 資料の入口の記録（第44.14節）。 */
export interface LibraryOrigin {
  entry: LibraryEntry;
  folder: string;
  sender: string;
  subject: string;
  at: string;
}

/** 目録の 1 件。 */
export interface LibraryItem {
  id: string;
  ownerId: string;
  driveFileId: string | null;
  driveUrl: string | null;
  /** M2Office がドライブに置いたファイルか（削除でごみ箱へ移すのはこれだけ。第44.5節）。 */
  placed: boolean;
  originalName: string;
  format: LibraryFormat;
  mime: string;
  sizeBytes: number;
  entry: LibraryEntry;
  /** AI の題名。読めなければ空（画面は元の名前を出す）。 */
  title: string;
  docType: string;
  counterparty: string;
  contactId: string | null;
  /** 書類の日付。読めなければ `null`（推測で埋めない）。 */
  docDate: string | null;
  receivedAt: string;
  summary: string;
  keywords: string[];
  readState: LibraryReadState;
  /** 読めなかった理由・読み取りの断り。 */
  readNote: string;
  /** 読んだ範囲（「先頭 50 ページ」など）。全部読めたら空。 */
  readScope: string;
  /** 人が直した項目。 */
  edited: string[];
  createdAt: string;
  updatedAt: string;
}

/** 1 件の詳しい形。 */
export interface LibraryItemDetail extends LibraryItem {
  origins: LibraryOrigin[];
}

/** 目録の絞り込み（第44.7節）。 */
export interface LibraryFilter {
  q?: string;
  /** 言い換え（秘書が考える。第11.7.7.0節）。 */
  words?: string[];
  docType?: string;
  counterparty?: string;
  year?: number;
  entry?: LibraryEntry;
  offset?: number;
  limit?: number;
}

/** 絞り込みの選択肢。 */
export interface LibraryFacets {
  docTypes: string[];
  counterparties: string[];
  years: number[];
}

/** 読み取りの進み具合（第44.11節）。 */
export interface LibraryProgress {
  /** 読む順番を待っている件数。 */
  pending: number;
  /** 上限で止まっている件数。 */
  paused: number;
  /**
   * 読めない理由。`none` は AI が設定されていない、`platform` は運営の鍵（資料は運営の鍵では動かさない。第44.11節）。
   * 読める状態なら `null`。
   */
  blocked: 'none' | 'platform' | null;
}

/** 表示する題名。AI の題名が無ければ元の名前。 */
export const libraryTitleOf = (i: Pick<LibraryItem, 'title' | 'originalName'>): string => i.title || i.originalName;

/** 資料の画面のパス。 */
export const libraryPath = (id?: string | null): string => (id ? `/library/${encodeURIComponent(id)}` : '/library');

/** 取り込まない名前（OS やアプリが勝手に作るもの。第44.3節）。 */
const JUNK_NAME = /^(\.ds_store|thumbs\.db|desktop\.ini|\.localized|icon\r?)$|^~\$|^\._/i;

/** 資料でないものの拡張子（実行ファイルとスクリプト。第44.3節）。 */
const REFUSED_EXT = new Set([
  'exe', 'msi', 'bat', 'cmd', 'com', 'scr', 'pif', 'cpl', 'dll', 'sys', 'lnk', 'vbs', 'vbe', 'js', 'mjs', 'cjs', 'jse', 'ws', 'wsf', 'wsh', 'ps1', 'psm1',
  'sh', 'bash', 'zsh', 'csh', 'ksh', 'command', 'app', 'dmg', 'pkg', 'deb', 'rpm', 'apk', 'ipa', 'jar', 'war', 'class', 'py', 'pyc', 'rb', 'pl', 'php', 'so', 'dylib', 'bin',
]);

/**
 * 取り込まないファイルか（第44.3節）。
 *
 * @param name ファイルの名前
 * @returns 取り込まないなら `true`
 *
 * @remarks 画面（入れる前に数える）と API（受け取ったとき）の両方で同じ決まりを使う。中身の先頭の確かめは API が行う
 */
export function isRefusedLibraryName(name: string): boolean {
  const base = name.split(/[\\/]/).pop() ?? '';
  if (!base || JUNK_NAME.test(base)) return true;
  const dot = base.lastIndexOf('.');
  return dot >= 0 && REFUSED_EXT.has(base.slice(dot + 1).toLowerCase());
}
