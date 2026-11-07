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
  /** メールの送り主と件名の上限（入口の記録） */
  senderChars: 200,
  subjectChars: 200,
  /** 探す言葉の文字の上限 */
  queryChars: 300,
  /** 一覧の 1 ページの件数 */
  pageSize: 50,
  /** 読み取りに失敗してもやり直す回数 */
  attempts: 6,
} as const;

/** メールの添付の取り込みの決まり（第44.4節）。 */
export const LIBRARY_MAIL_LIMITS = {
  /** 新しいメールを見る間隔（分。第42.13.1節と同じ） */
  newMailMinutes: 15,
  /** 過去のメールを 1 人 1 日に見る通数（案） */
  backfillPerDay: 500,
  /** 過去のメールを 1 回の見回りで見る通数 */
  backfillBatch: 25,
  /** 新しいメールを 1 回に見る通数の上限 */
  newMailMax: 200,
  /** 過去のメールを見る範囲の初め（年。決定）と、1 回で広げる幅 */
  backfillYears: 1,
  /** これより小さい画像は取り込まない（署名やアイコン） */
  smallImageBytes: 10 * 1024,
  /** 1 通から取り込む添付の数の上限 */
  partsPerMessage: 20,
} as const;

/** メールの添付の取り込みの様子（本人ごと。第44.4節）。 */
export interface LibraryMailState {
  enabled: boolean;
  /** 新しいメールを最後に見た時刻。 */
  checkedAt: string | null;
  /** 過去のメールを見る範囲（初めと終わり）。 */
  backFrom: string | null;
  backUntil: string | null;
  /** 範囲の中を見終えたか。 */
  backDone: boolean;
  /** これまでに見た通数と、資料に入れた件数。 */
  scanned: number;
  imported: number;
  /** 最後に Gmail を読めなかった理由。読めていれば空。 */
  error: string;
}

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
  /** 共有の範囲（第44.8節）。 */
  shareScope: LibraryShareScope;
  /** 会社の知識にしたなら、その知識の ID と日時（第44.8節）。 */
  knowledgeId: string | null;
  verifiedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

/** 共有の範囲（第44.8節）。 */
export type LibraryShareScope = 'self' | 'group' | 'company';

/** 共有の範囲の呼び名。 */
export const LIBRARY_SHARE_LABELS: Record<LibraryShareScope, string> = { self: '自分だけ', group: 'グループ', company: '会社で共有' };

/** 一覧と 1 件で返す形。`mine` が偽なら、共有された他人の資料（見るだけ）。 */
export interface LibraryItemView extends LibraryItem {
  mine: boolean;
  /** 他人の資料なら、持ち主の名前。 */
  ownerName: string | null;
}

/** 1 件の詳しい形。 */
export interface LibraryItemDetail extends LibraryItem {
  origins: LibraryOrigin[];
}

/** 1 件の画面に出す形（共有の相手と、ほかの版。第44.8節）。 */
export interface LibraryItemPage extends LibraryItemDetail {
  mine: boolean;
  ownerName: string | null;
  /** 共有したグループの名前（持ち主にだけ返す）。 */
  sharedGroups: string[];
  /** 題名・取引先・種類が同じで中身が違う資料（新しい順）。 */
  versions: { id: string; title: string; docDate: string | null; receivedAt: string }[];
}

/** 共有の結果（第44.8節）。`held` は機微なものとして止めた理由（もう一度頼まれたら共有する）。 */
export type LibraryShareResult =
  | { item: LibraryItem; scope: LibraryShareScope; people: number }
  | { held: string }
  | { error: string };

/** OKF の書き出しの様子（本人ごと。第44.16節）。 */
export interface LibraryOkfState {
  enabled: boolean;
  writtenAt: string | null;
  files: number;
  error: string;
}

/** OKF で書き出し直す間隔（第44.16節「週に 1 回」）。 */
export const LIBRARY_OKF_INTERVAL_MS = 7 * 86_400_000;

/** 機微な資料らしい言葉（第44.8節。会社で共有の前に止める・会社の知識にしない）。 */
const SENSITIVE = /(給与|給料|賃金|賞与|源泉徴収|年末調整|人事評価|人事考課|人事|評価|査定|個人番号|マイナンバー|健康診断|診断書|履歴書|職務経歴|雇用契約|身分証|住民票|扶養)/;

/**
 * 機微な資料らしいか（第44.8節）。題名・種類・語・元の名前・要約を見る。推論は使わない。
 *
 * @returns 理由（当たった言葉を含む）。当たらなければ `null`
 */
export function librarySensitiveReason(i: Pick<LibraryItem, 'title' | 'docType' | 'keywords' | 'originalName' | 'summary'>): string | null {
  const hit = SENSITIVE.exec([i.title, i.docType, ...i.keywords, i.originalName, i.summary].join('\n'));
  return hit ? `「${hit[1]}」に関わる資料のようです` : null;
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
