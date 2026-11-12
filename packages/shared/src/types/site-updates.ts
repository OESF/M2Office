/**
 * @file サイトの更新（内蔵の拡張。仕様書 第45章）の型と決まり。
 *
 * 会社の WordPress のいまある固定ページと投稿を、秘書に頼んで直す。直す前と後を並べて承認し、入れた後に公開のページで確かめる。
 * 直す前の本文を 90 日持ち、元に戻せる（Q-332）。
 */

/** 拡張機能の ID（ソースの名前）。 */
export const SITE_UPDATES_EXTENSION_ID = 'site-updates';

/** サイトの更新の会社の設定。既定は切りで、管理者が入れる（Q-330）。 */
export interface SiteUpdatesSettings {
  enabled: boolean;
  /** 依頼した本人の承認の後に、管理者の承認も加える（第45.6節、Q-331。`adminAlsoWhen` の `siteUpdates.adminApproval`）。 */
  adminApproval: boolean;
}

/** サイトの更新の会社の設定の既定。 */
export const DEFAULT_SITE_UPDATES_SETTINGS: SiteUpdatesSettings = { enabled: false, adminApproval: false };

/** サイトの更新の決まり（第45.7節・第45.8節）。 */
export const SITE_UPDATE_LIMITS = {
  /** 1 回の頼みで直すページの上限 */
  maxPages: 10,
  /** 直す前の本文を持つ日数（Q-332） */
  keepDays: 90,
  /** 頼みの長さの上限 */
  requestChars: 1000,
} as const;

/** 直しの状態。 */
export type SiteEditStatus = 'awaiting' | 'applied' | 'partial' | 'failed' | 'rejected' | 'reverted';

/** 直しの状態の、画面の言葉。 */
export const SITE_EDIT_STATUS_LABELS: Record<SiteEditStatus, string> = {
  awaiting: '承認待ち',
  applied: '入れた',
  partial: '一部だけ入れた',
  failed: '入れられなかった',
  rejected: '却下',
  reverted: '元に戻した',
};

/** ページごとの結果。 */
export type SiteEditPageResult = 'pending' | 'applied' | 'unverified' | 'conflict' | 'failed';

/** ページごとの結果の、画面の言葉。 */
export const SITE_EDIT_PAGE_RESULT_LABELS: Record<SiteEditPageResult, string> = {
  pending: 'まだ入れていない',
  applied: '入れた（表示を確かめた）',
  unverified: '入れた（表示はまだ変わっていない）',
  conflict: '入れなかった（先に WordPress で直されていた）',
  failed: '入れられなかった',
};

/** 1 か所の直し（人が読む文）。 */
export interface SiteEditChange {
  /** 直す前の文。足すときは空。 */
  before: string;
  /** 直した後の文。消すときは空。 */
  after: string;
}

/** 画面と秘書に見せる、直し 1 ページ分。 */
export interface SiteEditPageView {
  kind: 'page' | 'post';
  wpId: string;
  title: string;
  /** 公開の URL。 */
  link: string;
  /** 題名を直すなら、直した後の題名。 */
  newTitle: string | null;
  changes: SiteEditChange[];
  result: SiteEditPageResult;
  /** 入れられなかった・確かめられなかった理由。 */
  reason: string;
}

/** サイトのカテゴリー・タグの直し 1 つ（画面と秘書に見せる。第45.17節）。 */
export interface SiteTermChangeView {
  /** 作る・名前を変える・記事に付ける／外す・消す（消すのは元に戻すときだけ）。 */
  kind: 'create' | 'rename' | 'assign' | 'delete';
  /** 人が読む 1 行（「サイトのカテゴリー『旅行』を作る」など）。 */
  text: string;
  result: SiteEditPageResult;
  reason: string;
}

/** 段 2a の直し 1 つ（画面と秘書に見せる。第45.18.1節）。 */
export interface SiteActionView {
  kind: 'create' | 'status' | 'revision' | 'featured';
  /** 人が読む 1 行（「記事『秋のお知らせ』を作る（下書き）」など）。 */
  text: string;
  /** 作った・直した記事の URL（分かるとき）。 */
  link: string;
  result: SiteEditPageResult;
  reason: string;
}

/** 画面と秘書に見せる、直し 1 件（1 回の頼み）。 */
export interface SiteEditView {
  id: string;
  status: SiteEditStatus;
  /** 頼み（そのまま）。 */
  request: string;
  requestedBy: string;
  /** 元に戻す直しなら、戻した直しの ID。 */
  revertOf: string | null;
  pages: SiteEditPageView[];
  /** サイトのカテゴリーとタグの直し（第45.17節）。 */
  terms: SiteTermChangeView[];
  /** 新しい記事と固定ページ・公開の状態・前の版・アイキャッチ（第45.18.1節）。 */
  actions: SiteActionView[];
  createdAt: string;
  appliedAt: string | null;
  /** 元に戻せるか（入れたもので、90 日の中で、直す前の本文を持っている）。 */
  revertible: boolean;
  /** 直す前の本文を消した（90 日を過ぎた）。 */
  purged: boolean;
  /** 直すのに使った WordPress の利用者（本人の接続か会社の接続か。第45.16節）。 */
  account: { kind: 'user' | 'company'; username: string };
}
