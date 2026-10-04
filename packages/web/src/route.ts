/**
 * @file 画面の URL（仕様書 第6.1.6節）。URL と画面の対応を 1 か所に置く。
 *
 * URL には画面の種類と、意味を持たない ID（業務・実行・記事・区分）だけを載せる。
 * 入力した内容・名前・メールアドレスは載せない（ブラウザの履歴や共有したリンクから漏れるため）。
 * 見てよいかは API が決める。URL は開く画面を選ぶだけである。
 */

/** ワークスペースの画面。業務は ID だけを持つ（一覧を読んでから業務を引く）。 */
export type Route =
  | { kind: 'home' }
  | { kind: 'agent'; agentId: string }
  | { kind: 'run'; runId: string }
  | { kind: 'approvals' }
  | { kind: 'history' }
  | { kind: 'notifications' }
  | { kind: 'schedules' }
  /** 名刺（仕様書 第27.8節）。`contactId` があれば詳細。 */
  | { kind: 'cards'; contactId: string | null }
  /** 在庫（仕様書 第29章）。`itemId` があれば品目の詳細。 */
  | { kind: 'inventory'; itemId: string | null }
  /** 人事・給与の担当者（仕様書 第30.25節）。`employeeId` があれば 1 人の台帳。 */
  | { kind: 'hr'; employeeId: string | null }
  /** 本人の「給与・勤怠」（仕様書 第30.25節）。 */
  | { kind: 'attendance' }
  /** 店頭サイネージの管理の画面（仕様書 第31.9.4節）。 */
  | { kind: 'signage' }
  /** Web のコラム（仕様書 第32.18.1節）。`columnId` があれば 1 つのコラム。 */
  | { kind: 'columns'; columnId: string | null }
  /** 問い合わせの記録（仕様書 第33.17節）。`inquiryId` があれば 1 件。 */
  | { kind: 'inquiries'; inquiryId: string | null }
  /** 競合の分析（仕様書 第36.18節）。 */
  | { kind: 'competitors' }
  /** お知らせの作成（仕様書 第35.17節）。`announcementId` があれば 1 件。 */
  | { kind: 'announcements'; announcementId: string | null }
  /** Web の振り返り（仕様書 第34.18節）。`month`（YYYY-MM）があればその月の便り。 */
  | { kind: 'webReview'; month: string | null }
  | { kind: 'settings'; section: string | null }
  | { kind: 'help'; articleId: string | null }
  | { kind: 'unknown' };

/** URL に載せてよい ID の形。これ以外は無いものとして扱う（URL を手で書き換えた場合など）。 */
const ID = /^[A-Za-z0-9_.:-]{1,128}$/;

/** 道を区切って、読める形にする。読めない区切りは空にする。 */
function segments(pathname: string): string[] {
  return pathname.split('/').filter(Boolean).map((s) => {
    try { return decodeURIComponent(s); } catch { return ''; }
  });
}

const id = (v: string | undefined) => (v !== undefined && ID.test(v) ? v : null);

/**
 * ワークスペースの URL を読む。
 *
 * @returns 画面。知らない URL は `unknown`（呼ぶ側が最初の画面に戻す）
 */
export function parseRoute(pathname: string): Route {
  const [head, second, ...rest] = segments(pathname);
  if (rest.length > 0) return { kind: 'unknown' };
  switch (head) {
    case undefined: return { kind: 'home' };
    case 'agents': { const a = id(second); return a ? { kind: 'agent', agentId: a } : { kind: 'unknown' }; }
    case 'runs': { const r = id(second); return r ? { kind: 'run', runId: r } : { kind: 'unknown' }; }
    case 'approvals': return second === undefined ? { kind: 'approvals' } : { kind: 'unknown' };
    case 'history': return second === undefined ? { kind: 'history' } : { kind: 'unknown' };
    case 'notifications': return second === undefined ? { kind: 'notifications' } : { kind: 'unknown' };
    case 'schedules': return second === undefined ? { kind: 'schedules' } : { kind: 'unknown' };
    case 'cards': return second === undefined ? { kind: 'cards', contactId: null } : id(second) ? { kind: 'cards', contactId: id(second) } : { kind: 'unknown' };
    case 'inventory': return second === undefined ? { kind: 'inventory', itemId: null } : id(second) ? { kind: 'inventory', itemId: id(second) } : { kind: 'unknown' };
    case 'attendance': return second === undefined ? { kind: 'attendance' } : { kind: 'unknown' };
    case 'signage': return second === undefined ? { kind: 'signage' } : { kind: 'unknown' };
    case 'competitors': return second === undefined ? { kind: 'competitors' } : { kind: 'unknown' };
    case 'announcements': return second === undefined ? { kind: 'announcements', announcementId: null } : id(second) ? { kind: 'announcements', announcementId: id(second) } : { kind: 'unknown' };
    case 'web-review': return second === undefined ? { kind: 'webReview', month: null } : /^\d{4}-(0[1-9]|1[0-2])$/.test(second) ? { kind: 'webReview', month: second } : { kind: 'unknown' };
    case 'columns': return second === undefined ? { kind: 'columns', columnId: null } : id(second) ? { kind: 'columns', columnId: id(second) } : { kind: 'unknown' };
    case 'inquiries': return second === undefined ? { kind: 'inquiries', inquiryId: null } : id(second) ? { kind: 'inquiries', inquiryId: id(second) } : { kind: 'unknown' };
    case 'hr': return second === undefined ? { kind: 'hr', employeeId: null } : id(second) ? { kind: 'hr', employeeId: id(second) } : { kind: 'unknown' };
    case 'settings': return { kind: 'settings', section: id(second) };
    case 'help': return { kind: 'help', articleId: id(second) };
    default: return { kind: 'unknown' };
  }
}

/** ワークスペースの画面の URL。`unknown` は最初の画面にする。 */
export function routePath(route: Route): string {
  const enc = encodeURIComponent;
  switch (route.kind) {
    case 'home': case 'unknown': return '/';
    case 'agent': return `/agents/${enc(route.agentId)}`;
    case 'run': return `/runs/${enc(route.runId)}`;
    case 'approvals': case 'history': case 'notifications': case 'schedules': case 'attendance': case 'signage': case 'competitors': return `/${route.kind}`;
    case 'cards': return route.contactId ? `/cards/${enc(route.contactId)}` : '/cards';
    case 'inventory': return route.itemId ? `/inventory/${enc(route.itemId)}` : '/inventory';
    case 'hr': return route.employeeId ? `/hr/${enc(route.employeeId)}` : '/hr';
    case 'columns': return route.columnId ? `/columns/${enc(route.columnId)}` : '/columns';
    case 'inquiries': return route.inquiryId ? `/inquiries/${enc(route.inquiryId)}` : '/inquiries';
    case 'announcements': return route.announcementId ? `/announcements/${enc(route.announcementId)}` : '/announcements';
    case 'webReview': return route.month ? `/web-review/${enc(route.month)}` : '/web-review';
    case 'settings': return route.section ? `/settings/${enc(route.section)}` : '/settings';
    case 'help': return route.articleId ? `/help/${enc(route.articleId)}` : '/help';
  }
}

/** 管理者ページの画面（区分と小分け）。どちらも無ければ最初の区分。 */
export interface AdminRoute {
  tab: string | null;
  page: string | null;
}

/** 管理者ページの URL（`/admin/{区分}/{小分け}`）を読む。`/admin` 以外は `null`。 */
export function parseAdminRoute(pathname: string): AdminRoute | null {
  const [head, tab, page, ...rest] = segments(pathname);
  if (head !== 'admin' || rest.length > 0) return head === 'admin' ? { tab: null, page: null } : null;
  return { tab: id(tab), page: id(page) };
}

/** 管理者ページの URL。 */
export function adminPath(tab: string, page: string): string {
  const enc = encodeURIComponent;
  return `/admin/${enc(tab)}${page ? `/${enc(page)}` : ''}`;
}

/**
 * 画面を切り替えたときに URL を合わせる。**同じなら何もしない**。
 *
 * @param replace 履歴に積まず、今の URL を置き換える（最初に開いたとき、戻る・進むのあと、見つからずに戻すとき）
 *
 * @remarks 開発で会社を選ぶ `?tenant=` などの問い合わせの部分は保つ
 */
export function syncUrl(path: string, replace: boolean): void {
  if (location.pathname === path) return;
  const url = `${path}${location.search}`;
  if (replace) history.replaceState(null, '', url);
  else history.pushState(null, '', url);
}
