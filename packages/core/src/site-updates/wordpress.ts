/**
 * @file サイトの更新の、WordPress の固定ページと投稿の読み書き（仕様書 第45.5節・第45.7節・第45.10節）。
 *
 * REST API（`wp-json/wp/v2`）を、会社の接続のアプリケーションパスワードで呼ぶ（ADR-0140）。
 * 本文は編集用の形（`context=edit` の `raw`）で読み書きし、最後に直された時刻（`modified_gmt`）でぶつかりを確かめる。
 * 相手の応答とページの文は外部のデータとして扱い、指示として読まない（不変則 I-6）。
 */

import { outboundFetch } from '../net/outbound.js';
import { wordPressHeaders, type WordPressAuth } from '../columns/wordpress.js';
import { plainText } from './segments.js';

/** 呼び出しを待つ時間（ミリ秒）。 */
const TIMEOUT_MS = 20_000;
/** 公開のページを読むときの上限（バイト）。 */
const PUBLIC_MAX_BYTES = 2_000_000;

/** 直す対象の種類。 */
export type SiteContentKind = 'page' | 'post';

/** 探した結果の 1 件。 */
export interface SiteContentHit {
  kind: SiteContentKind;
  id: string;
  title: string;
  link: string;
  status: string;
}

/** 編集用に読んだ 1 件。 */
export interface SiteContent extends SiteContentHit {
  /** 本文（ブロックの印を含む編集用の形）。 */
  content: string;
  excerpt: string;
  /** 最後に直された時刻（UTC。WordPress の `modified_gmt`）。 */
  modifiedGmt: string;
}

const PATH: Record<SiteContentKind, string> = { page: 'pages', post: 'posts' };

function raw(v: unknown): string {
  if (typeof v === 'string') return v;
  if (v && typeof v === 'object' && typeof (v as { raw?: unknown }).raw === 'string') return (v as { raw: string }).raw;
  if (v && typeof v === 'object' && typeof (v as { rendered?: unknown }).rendered === 'string') return plainText((v as { rendered: string }).rendered);
  return '';
}

async function getJson(a: WordPressAuth, path: string): Promise<{ ok: true; body: unknown } | { ok: false; status: number }> {
  const res = await outboundFetch(`${a.siteUrl}/wp-json/wp/v2/${path}`, { headers: wordPressHeaders(a), signal: AbortSignal.timeout(TIMEOUT_MS) });
  if (!res.ok) return { ok: false, status: res.status };
  return { ok: true, body: await res.json() };
}

/**
 * 固定ページと投稿を探す。言葉があれば題名と本文から、無ければ固定ページの一覧（よく直すのは固定ページのため）。
 *
 * @param query 探す言葉（空なら一覧）
 * @returns 見つかったもの（固定ページを先に。それぞれ 20 件まで）。届かなければ理由
 */
export async function findSiteContent(a: WordPressAuth, query: string): Promise<{ hits: SiteContentHit[] } | { error: string }> {
  try {
    const q = query.trim();
    const fields = '_fields=id,title,link,status,type';
    const kinds: SiteContentKind[] = q ? ['page', 'post'] : ['page'];
    const hits: SiteContentHit[] = [];
    for (const kind of kinds) {
      const r = await getJson(a, `${PATH[kind]}?${q ? `search=${encodeURIComponent(q)}&` : ''}per_page=${q ? 20 : 100}&status=publish,private,draft&context=edit&${fields}`);
      if (!r.ok) {
        if (r.status === 401 || r.status === 403) return { error: 'WordPress の利用者に、固定ページと投稿を直す権限がありません（「編集者」の役割にしてください）' };
        return { error: `WordPress で探せませんでした（${r.status}）` };
      }
      for (const v of (Array.isArray(r.body) ? r.body : []) as Record<string, unknown>[]) {
        hits.push({ kind, id: String(v['id'] ?? ''), title: raw(v['title']), link: typeof v['link'] === 'string' ? v['link'] : '', status: typeof v['status'] === 'string' ? v['status'] : '' });
      }
    }
    return { hits: hits.filter((h) => h.id) };
  } catch (err) {
    return { error: `WordPress に届きませんでした（${err instanceof Error ? err.message : String(err)}）` };
  }
}

/**
 * 1 件を編集用の形で読む。
 *
 * @returns 読めなければ理由
 */
export async function readSiteContent(a: WordPressAuth, kind: SiteContentKind, id: string): Promise<SiteContent | { error: string }> {
  try {
    const r = await getJson(a, `${PATH[kind]}/${encodeURIComponent(id)}?context=edit&_fields=id,title,link,status,content,excerpt,modified_gmt`);
    if (!r.ok) {
      if (r.status === 404) return { error: 'そのページは WordPress にありません（消されたかもしれません）' };
      if (r.status === 401 || r.status === 403) return { error: 'WordPress の利用者に、このページを直す権限がありません（「編集者」の役割にしてください）' };
      return { error: `WordPress からページを読めませんでした（${r.status}）` };
    }
    const v = r.body as Record<string, unknown>;
    return {
      kind, id: String(v['id'] ?? id), title: raw(v['title']), link: typeof v['link'] === 'string' ? v['link'] : '',
      status: typeof v['status'] === 'string' ? v['status'] : '', content: raw(v['content']), excerpt: raw(v['excerpt']),
      modifiedGmt: typeof v['modified_gmt'] === 'string' ? v['modified_gmt'] : '',
    };
  } catch (err) {
    return { error: `WordPress に届きませんでした（${err instanceof Error ? err.message : String(err)}）` };
  }
}

/**
 * 1 件の本文（と題名・抜粋）を書き換える。公開の状態は変えない（第45.7節、Q-332）。
 *
 * @returns 書き換えた後の最後に直された時刻と公開の URL。書けなければ理由
 */
export async function updateSiteContent(a: WordPressAuth, kind: SiteContentKind, id: string, v: { content: string; title?: string; excerpt?: string }): Promise<{ modifiedGmt: string; link: string } | { error: string }> {
  try {
    const res = await outboundFetch(`${a.siteUrl}/wp-json/wp/v2/${PATH[kind]}/${encodeURIComponent(id)}?context=edit&_fields=modified_gmt,link`, {
      method: 'POST', headers: wordPressHeaders(a), signal: AbortSignal.timeout(TIMEOUT_MS),
      body: JSON.stringify({ content: v.content, ...(v.title !== undefined ? { title: v.title } : {}), ...(v.excerpt !== undefined ? { excerpt: v.excerpt } : {}) }),
    });
    if (res.status === 401 || res.status === 403) return { error: 'WordPress の利用者に、このページを直す権限がありません（「編集者」の役割にしてください）' };
    if (!res.ok) return { error: `WordPress でページを直せませんでした（${res.status}）` };
    const body = await res.json() as { modified_gmt?: unknown; link?: unknown };
    return { modifiedGmt: typeof body.modified_gmt === 'string' ? body.modified_gmt : '', link: typeof body.link === 'string' ? body.link : '' };
  } catch (err) {
    return { error: `WordPress に届きませんでした（${err instanceof Error ? err.message : String(err)}）` };
  }
}

/** サイトの更新に要る WordPress の権限（第45.10節）。 */
export const SITE_UPDATE_CAPABILITIES = ['edit_pages', 'edit_published_pages', 'edit_others_pages', 'edit_posts', 'edit_published_posts', 'edit_others_posts'] as const;

/** WordPress の役割の、画面の言葉。 */
export const WORDPRESS_ROLE_LABELS: Record<string, string> = {
  administrator: '管理者', editor: '編集者', author: '投稿者', contributor: '寄稿者', subscriber: '購読者',
};

/**
 * アプリケーションパスワードの利用者が誰か（表示名・役割）と、サイトの更新に足りない権限（第45.16節）。
 *
 * @returns 通らなければ理由
 */
export async function whoAmI(a: WordPressAuth): Promise<{ name: string; roles: string[]; missing: string[]; capabilities: Record<string, boolean> } | { error: string }> {
  try {
    const r = await getJson(a, 'users/me?context=edit&_fields=name,roles,capabilities');
    if (!r.ok) {
      if (r.status === 401 || r.status === 403) return { error: '利用者名かアプリケーションパスワードが違います（ログインのパスワードではなく、アプリケーションパスワードを入れてください）' };
      if (r.status === 404) return { error: 'WordPress の REST API が見つかりません' };
      return { error: `WordPress が応答しませんでした（${r.status}）` };
    }
    const v = r.body as { name?: unknown; roles?: unknown; capabilities?: Record<string, unknown> };
    const caps = v.capabilities ?? {};
    return {
      name: typeof v.name === 'string' ? v.name : a.username,
      roles: Array.isArray(v.roles) ? (v.roles as unknown[]).filter((x): x is string => typeof x === 'string') : [],
      missing: SITE_UPDATE_CAPABILITIES.filter((c) => caps[c] !== true),
      capabilities: Object.fromEntries(Object.entries(caps).map(([k, v]) => [k, v === true])),
    };
  } catch (err) {
    return { error: `WordPress に届きませんでした（${err instanceof Error ? err.message : String(err)}）` };
  }
}

/** サイトのカテゴリーかタグか（第45.17節）。 */
export type SiteTaxonomy = 'category' | 'tag';
const TAX_PATH: Record<SiteTaxonomy, string> = { category: 'categories', tag: 'tags' };

/** サイトのカテゴリー・タグ 1 つ。 */
export interface SiteTerm {
  taxonomy: SiteTaxonomy;
  id: string;
  name: string;
  /** 親のカテゴリー（タグと親の無いものは `null`）。 */
  parent: string | null;
  /** 付いている記事の数。 */
  count: number;
}

/**
 * サイトのカテゴリーかタグの一覧（300 まで）。
 *
 * @returns 読めなければ理由
 */
export async function listSiteTerms(a: WordPressAuth, taxonomy: SiteTaxonomy): Promise<SiteTerm[] | { error: string }> {
  try {
    const out: SiteTerm[] = [];
    for (let page = 1; page <= 3; page++) {
      const r = await getJson(a, `${TAX_PATH[taxonomy]}?per_page=100&page=${page}&hide_empty=false&_fields=id,name,parent,count`);
      if (!r.ok) {
        if (r.status === 400 && page > 1) break;
        return { error: `WordPress のサイトの${taxonomy === 'category' ? 'カテゴリー' : 'タグ'}を読めませんでした（${r.status}）` };
      }
      const list = Array.isArray(r.body) ? r.body as Record<string, unknown>[] : [];
      for (const v of list) {
        out.push({
          taxonomy, id: String(v['id'] ?? ''), name: plainText(String(v['name'] ?? '')),
          parent: typeof v['parent'] === 'number' && v['parent'] > 0 ? String(v['parent']) : null, count: typeof v['count'] === 'number' ? v['count'] : 0,
        });
      }
      if (list.length < 100) break;
    }
    return out.filter((t) => t.id);
  } catch (err) {
    return { error: `WordPress に届きませんでした（${err instanceof Error ? err.message : String(err)}）` };
  }
}

/** カテゴリー・タグ 1 つを読む（元に戻すとき、記事の数と名前を確かめる）。 */
export async function readSiteTerm(a: WordPressAuth, taxonomy: SiteTaxonomy, id: string): Promise<SiteTerm | null> {
  try {
    const r = await getJson(a, `${TAX_PATH[taxonomy]}/${encodeURIComponent(id)}?_fields=id,name,parent,count`);
    if (!r.ok) return null;
    const v = r.body as Record<string, unknown>;
    return { taxonomy, id, name: plainText(String(v['name'] ?? '')), parent: typeof v['parent'] === 'number' && v['parent'] > 0 ? String(v['parent']) : null, count: typeof v['count'] === 'number' ? v['count'] : 0 };
  } catch {
    return null;
  }
}

async function send(a: WordPressAuth, method: 'POST' | 'DELETE', path: string, body?: Record<string, unknown>): Promise<{ ok: true; body: unknown } | { ok: false; status: number; code: string }> {
  const res = await outboundFetch(`${a.siteUrl}/wp-json/wp/v2/${path}`, {
    method, headers: wordPressHeaders(a), signal: AbortSignal.timeout(TIMEOUT_MS), ...(body ? { body: JSON.stringify(body) } : {}),
  });
  if (!res.ok) {
    const j = await res.json().catch(() => ({})) as { code?: unknown };
    return { ok: false, status: res.status, code: typeof j.code === 'string' ? j.code : '' };
  }
  return { ok: true, body: await res.json().catch(() => ({})) };
}

/**
 * カテゴリーかタグを作る。
 *
 * @returns 作った ID。作れなければ理由
 */
export async function createSiteTerm(a: WordPressAuth, taxonomy: SiteTaxonomy, name: string, parent: string | null): Promise<{ id: string } | { error: string }> {
  try {
    const r = await send(a, 'POST', TAX_PATH[taxonomy], { name, ...(taxonomy === 'category' && parent ? { parent: Number(parent) } : {}) });
    if (!r.ok) {
      if (r.code === 'term_exists') return { error: `「${name}」はもうあります` };
      if (r.status === 401 || r.status === 403) return { error: 'WordPress の利用者に、カテゴリーとタグを作る権限がありません（「編集者」の役割にしてください）' };
      return { error: `WordPress で「${name}」を作れませんでした（${r.status}）` };
    }
    const id = String((r.body as { id?: unknown }).id ?? '');
    return id ? { id } : { error: 'WordPress の応答に ID がありません' };
  } catch (err) {
    return { error: `WordPress に届きませんでした（${err instanceof Error ? err.message : String(err)}）` };
  }
}

/** カテゴリーかタグの名前だけを変える（スラッグは送らない＝変えない。Q-342）。 */
export async function renameSiteTerm(a: WordPressAuth, taxonomy: SiteTaxonomy, id: string, name: string): Promise<string | null> {
  try {
    const r = await send(a, 'POST', `${TAX_PATH[taxonomy]}/${encodeURIComponent(id)}`, { name });
    if (r.ok) return null;
    return r.status === 401 || r.status === 403 ? 'WordPress の利用者に、カテゴリーとタグを直す権限がありません' : `WordPress で名前を変えられませんでした（${r.status}）`;
  } catch (err) {
    return `WordPress に届きませんでした（${err instanceof Error ? err.message : String(err)}）`;
  }
}

/** カテゴリーかタグを消す（元に戻すときに、作ったもので記事が 1 つも付いていないものだけ。Q-341）。 */
export async function deleteSiteTerm(a: WordPressAuth, taxonomy: SiteTaxonomy, id: string): Promise<string | null> {
  try {
    const r = await send(a, 'DELETE', `${TAX_PATH[taxonomy]}/${encodeURIComponent(id)}?force=true`);
    return r.ok ? null : `WordPress で消せませんでした（${r.status}）`;
  } catch (err) {
    return `WordPress に届きませんでした（${err instanceof Error ? err.message : String(err)}）`;
  }
}

/** 記事 1 つのカテゴリーとタグ。 */
export interface SitePostTerms {
  id: string;
  title: string;
  link: string;
  date: string;
  categories: string[];
  tags: string[];
  modifiedGmt: string;
}

function postTermsOf(v: Record<string, unknown>): SitePostTerms {
  const ids = (x: unknown) => (Array.isArray(x) ? (x as unknown[]).map((n) => String(n)) : []);
  return {
    id: String(v['id'] ?? ''), title: raw(v['title']), link: typeof v['link'] === 'string' ? v['link'] : '', date: typeof v['date'] === 'string' ? v['date'] : '',
    categories: ids(v['categories']), tags: ids(v['tags']), modifiedGmt: typeof v['modified_gmt'] === 'string' ? v['modified_gmt'] : '',
  };
}

/**
 * 記事を探す（言葉があれば題名と本文から、無ければ新しい順）。カテゴリーとタグも返す。
 *
 * @returns 20 件まで。届かなければ理由
 */
export async function findSitePosts(a: WordPressAuth, query: string): Promise<SitePostTerms[] | { error: string }> {
  try {
    const q = query.trim();
    const r = await getJson(a, `posts?${q ? `search=${encodeURIComponent(q)}&` : ''}per_page=20&status=publish,private,draft,future&context=edit&_fields=id,title,link,date,categories,tags,modified_gmt`);
    if (!r.ok) return { error: `WordPress で記事を探せませんでした（${r.status}）` };
    return (Array.isArray(r.body) ? r.body as Record<string, unknown>[] : []).map(postTermsOf).filter((p) => p.id);
  } catch (err) {
    return { error: `WordPress に届きませんでした（${err instanceof Error ? err.message : String(err)}）` };
  }
}

/** 記事 1 つのカテゴリーとタグを読む。 */
export async function readSitePostTerms(a: WordPressAuth, id: string): Promise<SitePostTerms | { error: string }> {
  try {
    const r = await getJson(a, `posts/${encodeURIComponent(id)}?context=edit&_fields=id,title,link,date,categories,tags,modified_gmt`);
    if (!r.ok) return { error: r.status === 404 ? 'その記事は WordPress にありません' : `WordPress から記事を読めませんでした（${r.status}）` };
    return postTermsOf(r.body as Record<string, unknown>);
  } catch (err) {
    return { error: `WordPress に届きませんでした（${err instanceof Error ? err.message : String(err)}）` };
  }
}

/**
 * 記事のカテゴリーとタグを、渡したものにそろえる。
 *
 * @returns 直した後の最後に直された時刻。直せなければ理由
 */
export async function setSitePostTerms(a: WordPressAuth, id: string, terms: { categories: string[]; tags: string[] }): Promise<{ modifiedGmt: string } | { error: string }> {
  try {
    const r = await send(a, 'POST', `posts/${encodeURIComponent(id)}?context=edit&_fields=modified_gmt`, { categories: terms.categories.map(Number), tags: terms.tags.map(Number) });
    if (!r.ok) return { error: r.status === 401 || r.status === 403 ? 'WordPress の利用者に、この記事を直す権限がありません' : `WordPress で記事のカテゴリーとタグを直せませんでした（${r.status}）` };
    const m = (r.body as { modified_gmt?: unknown }).modified_gmt;
    return { modifiedGmt: typeof m === 'string' ? m : '' };
  } catch (err) {
    return { error: `WordPress に届きませんでした（${err instanceof Error ? err.message : String(err)}）` };
  }
}

/** 記事・固定ページの公開の状態（第45.18節）。 */
export type SiteStatus = 'publish' | 'draft' | 'private' | 'future' | 'pending' | 'trash';

/** 記事・固定ページの状態を読んだもの。 */
export interface SiteStatusView {
  kind: SiteContentKind;
  id: string;
  title: string;
  link: string;
  status: string;
  /** 公開の日時（予約なら予約の日時。サイトの時刻）。 */
  date: string;
  modifiedGmt: string;
  /** アイキャッチのメディア（無ければ 0）。 */
  featuredMedia: number;
  content: string;
  excerpt: string;
}

/**
 * 記事・固定ページの状態を読む（ゴミ箱のものも読む）。
 *
 * @returns 読めなければ理由
 */
export async function readSiteStatus(a: WordPressAuth, kind: SiteContentKind, id: string): Promise<SiteStatusView | { error: string }> {
  try {
    const r = await getJson(a, `${PATH[kind]}/${encodeURIComponent(id)}?context=edit&_fields=id,title,link,status,date,modified_gmt,featured_media,content,excerpt`);
    if (!r.ok) return { error: r.status === 404 ? 'そのページは WordPress にありません' : `WordPress からページを読めませんでした（${r.status}）` };
    const v = r.body as Record<string, unknown>;
    return {
      kind, id: String(v['id'] ?? id), title: raw(v['title']), link: typeof v['link'] === 'string' ? v['link'] : '', status: typeof v['status'] === 'string' ? v['status'] : '',
      date: typeof v['date'] === 'string' ? v['date'] : '', modifiedGmt: typeof v['modified_gmt'] === 'string' ? v['modified_gmt'] : '',
      featuredMedia: typeof v['featured_media'] === 'number' ? v['featured_media'] : 0, content: raw(v['content']), excerpt: raw(v['excerpt']),
    };
  } catch (err) {
    return { error: `WordPress に届きませんでした（${err instanceof Error ? err.message : String(err)}）` };
  }
}

/**
 * 記事か固定ページを作る（第45.18.1節）。
 *
 * @param v.status `draft`・`publish`・`future`（`date` に予約）
 * @returns 作った ID と URL。作れなければ理由
 */
export async function createSiteContent(a: WordPressAuth, kind: SiteContentKind, v: {
  title: string; content: string; excerpt: string; status: 'draft' | 'publish' | 'future'; date: string | null; featuredMedia: number | null;
}): Promise<{ id: string; link: string } | { error: string }> {
  try {
    const r = await send(a, 'POST', `${PATH[kind]}?_fields=id,link`, {
      title: v.title, content: v.content, excerpt: v.excerpt, status: v.status,
      ...(v.status === 'future' && v.date ? { date: v.date } : {}), ...(v.featuredMedia ? { featured_media: v.featuredMedia } : {}),
    });
    if (!r.ok) return { error: r.status === 401 || r.status === 403 ? 'WordPress の利用者に、記事や固定ページを作る権限がありません' : `WordPress で作れませんでした（${r.status}）` };
    const b = r.body as { id?: unknown; link?: unknown };
    const id = String(b.id ?? '');
    return id ? { id, link: typeof b.link === 'string' ? b.link : '' } : { error: 'WordPress の応答に ID がありません' };
  } catch (err) {
    return { error: `WordPress に届きませんでした（${err instanceof Error ? err.message : String(err)}）` };
  }
}

/**
 * 公開の状態を変える。ゴミ箱は `trash`（WordPress のゴミ箱に入れるだけで、完全には消さない。Q-343）。
 *
 * @returns 変えた後の最後に直された時刻。変えられなければ理由
 */
export async function setSiteStatus(a: WordPressAuth, kind: SiteContentKind, id: string, status: SiteStatus, date: string | null): Promise<{ modifiedGmt: string } | { error: string }> {
  try {
    const r = status === 'trash'
      ? await send(a, 'DELETE', `${PATH[kind]}/${encodeURIComponent(id)}`)
      : await send(a, 'POST', `${PATH[kind]}/${encodeURIComponent(id)}?context=edit&_fields=modified_gmt`, { status, ...(date ? { date } : {}) });
    if (!r.ok) return { error: r.status === 401 || r.status === 403 ? 'WordPress の利用者に、公開の状態を変える権限がありません' : `WordPress で公開の状態を変えられませんでした（${r.status}）` };
    const m = (r.body as { modified_gmt?: unknown }).modified_gmt;
    return { modifiedGmt: typeof m === 'string' ? m : '' };
  } catch (err) {
    return { error: `WordPress に届きませんでした（${err instanceof Error ? err.message : String(err)}）` };
  }
}

/** 前の版 1 つ。 */
export interface SiteRevision {
  id: string;
  /** 版の日時（サイトの時刻）。 */
  date: string;
  title: string;
  content: string;
  excerpt: string;
}

/**
 * 前の版の一覧（新しい順。WordPress が版の記録を残していなければ空）。
 *
 * @returns 読めなければ理由
 */
export async function listSiteRevisions(a: WordPressAuth, kind: SiteContentKind, id: string): Promise<SiteRevision[] | { error: string }> {
  try {
    const r = await getJson(a, `${PATH[kind]}/${encodeURIComponent(id)}/revisions?context=edit&per_page=30&_fields=id,date,title,content,excerpt`);
    if (!r.ok) return { error: r.status === 401 || r.status === 403 ? 'WordPress の利用者に、前の版を読む権限がありません' : `WordPress から前の版を読めませんでした（${r.status}）` };
    return (Array.isArray(r.body) ? r.body as Record<string, unknown>[] : []).map((v) => ({
      id: String(v['id'] ?? ''), date: typeof v['date'] === 'string' ? v['date'] : '', title: raw(v['title']), content: raw(v['content']), excerpt: raw(v['excerpt']),
    })).filter((x) => x.id);
  } catch (err) {
    return { error: `WordPress に届きませんでした（${err instanceof Error ? err.message : String(err)}）` };
  }
}

/** アイキャッチを変える（0 で外す）。 */
export async function setSiteFeatured(a: WordPressAuth, kind: SiteContentKind, id: string, mediaId: number): Promise<{ modifiedGmt: string } | { error: string }> {
  try {
    const r = await send(a, 'POST', `${PATH[kind]}/${encodeURIComponent(id)}?context=edit&_fields=modified_gmt`, { featured_media: mediaId });
    if (!r.ok) return { error: `WordPress でアイキャッチを変えられませんでした（${r.status}）` };
    const m = (r.body as { modified_gmt?: unknown }).modified_gmt;
    return { modifiedGmt: typeof m === 'string' ? m : '' };
  } catch (err) {
    return { error: `WordPress に届きませんでした（${err instanceof Error ? err.message : String(err)}）` };
  }
}

/** 記事・固定ページの一覧（新しい順。状態つき）。言葉があれば題名と本文から探す。 */
export async function listSiteItems(a: WordPressAuth, kind: SiteContentKind, query: string): Promise<{ id: string; title: string; status: string; date: string; link: string }[] | { error: string }> {
  try {
    const q = query.trim();
    const r = await getJson(a, `${PATH[kind]}?${q ? `search=${encodeURIComponent(q)}&` : ''}per_page=${kind === 'page' ? 100 : 20}&status=publish,private,draft,future,pending&context=edit&_fields=id,title,status,date,link`);
    if (!r.ok) return { error: `WordPress で一覧を読めませんでした（${r.status}）` };
    return (Array.isArray(r.body) ? r.body as Record<string, unknown>[] : []).map((v) => ({
      id: String(v['id'] ?? ''), title: raw(v['title']), status: typeof v['status'] === 'string' ? v['status'] : '', date: typeof v['date'] === 'string' ? v['date'] : '', link: typeof v['link'] === 'string' ? v['link'] : '',
    })).filter((x) => x.id);
  } catch (err) {
    return { error: `WordPress に届きませんでした（${err instanceof Error ? err.message : String(err)}）` };
  }
}

/**
 * 接続の利用者に、サイトの更新に要る権限があるか。
 *
 * @returns 足りない権限の一覧（空なら足りている）。確かめられなければ理由
 */
export async function missingSiteCapabilities(a: WordPressAuth): Promise<{ missing: string[] } | { error: string }> {
  try {
    const r = await getJson(a, 'users/me?context=edit&_fields=capabilities');
    if (!r.ok) return { error: r.status === 401 || r.status === 403 ? '利用者名かアプリケーションパスワードが違います' : `WordPress の利用者を読めませんでした（${r.status}）` };
    const caps = ((r.body as { capabilities?: Record<string, unknown> }).capabilities ?? {});
    return { missing: SITE_UPDATE_CAPABILITIES.filter((c) => caps[c] !== true) };
  } catch (err) {
    return { error: `WordPress に届きませんでした（${err instanceof Error ? err.message : String(err)}）` };
  }
}

/**
 * サイトの名前と説明（WordPress の設定の「サイトのタイトル」「キャッチフレーズ」。REST API の入口が返す）。ログインせずに読む。
 *
 * @returns 読めなければ `null`
 */
export async function readSiteName(siteUrl: string): Promise<{ name: string; description: string } | null> {
  try {
    const res = await outboundFetch(`${siteUrl}/wp-json/?_fields=name,description`, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(TIMEOUT_MS) });
    if (!res.ok) return null;
    const v = await res.json() as { name?: unknown; description?: unknown };
    return { name: typeof v.name === 'string' ? plainText(v.name) : '', description: typeof v.description === 'string' ? plainText(v.description) : '' };
  } catch {
    return null;
  }
}

/**
 * 公開のページを読み、人が読む文にする（入れた後の確かめ。第45.7節）。ログインせずに読む。
 *
 * @returns 文。読めなければ `null`
 */
export async function readPublicPage(url: string): Promise<string | null> {
  try {
    const u = new URL(url);
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
    // キャッシュを避けるため、確かめのたびに違う値を付ける
    u.searchParams.set('m2o_check', String(Date.now()));
    const res = await outboundFetch(u.toString(), { headers: { accept: 'text/html' }, signal: AbortSignal.timeout(TIMEOUT_MS) });
    if (!res.ok) return null;
    const text = await res.text();
    return plainText(text.slice(0, PUBLIC_MAX_BYTES));
  } catch {
    return null;
  }
}
