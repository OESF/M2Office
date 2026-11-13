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
export type SiteContentKind = string;

/**
 * 記事の種類の口の名前（第45.20.3節）。`page` は固定ページ、`post` は投稿、ほかはカスタム投稿タイプの口の名前（`news` など）。
 */
export function siteContentPath(kind: SiteContentKind): string {
  if (kind === 'page') return 'pages';
  if (kind === 'post') return 'posts';
  return /^[a-z0-9_-]{1,40}$/i.test(kind) ? kind : 'posts';
}

/**
 * サイトの部品（第45.18.3節・第45.18.4節）。再利用ブロック・テンプレートパーツ（ヘッダーとフッター）・ウィジェット。
 * いまあるページの文の直し（段 1）と同じ決まりで、文のかたまりだけを直す。
 */
export const SITE_PART_KINDS: readonly SiteContentKind[] = ['blocks', 'template-parts', 'widgets'];

/** 1 件の口（テンプレートパーツの番号 `テーマ//名前` は、区切りの `/` をそのまま送る）。 */
function itemPath(kind: SiteContentKind, id: string): string {
  return `${siteContentPath(kind)}/${kind === 'template-parts' ? id.split('/').map(encodeURIComponent).join('/') : encodeURIComponent(id)}`;
}

/** 部品の呼び方（承認の画面と推論に渡す一覧）。 */
export function sitePartLabel(kind: SiteContentKind, title: string, area = ''): string {
  if (kind === 'blocks') return `再利用ブロック「${title}」（使っているページすべてに出ます）`;
  if (kind === 'template-parts') return `${area === 'footer' ? 'フッター' : area === 'header' ? 'ヘッダー' : 'テンプレートパーツ'}（${title}。すべてのページに出ます）`;
  if (kind === 'widgets') return `ウィジェット（${title}）`;
  return title;
}

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
export async function findSiteContent(a: WordPressAuth, query: string, customKinds: readonly SiteContentKind[] = []): Promise<{ hits: SiteContentHit[] } | { error: string }> {
  try {
    const q = query.trim();
    const fields = '_fields=id,title,link,status,type';
    // カスタム投稿タイプ（第45.20.3節）は、言葉で探すときに投稿と並べて探す
    const kinds: SiteContentKind[] = q ? ['page', 'post', ...customKinds] : ['page'];
    const hits: SiteContentHit[] = [];
    // 部品（第45.18.3節・第45.18.4節）。役割が足りない・テーマが持たないときは黙って外す
    hits.push(...await findSiteParts(a, q));
    for (const kind of kinds) {
      const r = await getJson(a, `${siteContentPath(kind)}?${q ? `search=${encodeURIComponent(q)}&` : ''}per_page=${q ? 20 : 100}&status=publish,private,draft&context=edit&${fields}`);
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

/** 部品を探す。言葉があれば再利用ブロックだけを言葉で、無ければ再利用ブロック・ヘッダーとフッター・ウィジェットを並べる。 */
async function findSiteParts(a: WordPressAuth, q: string): Promise<SiteContentHit[]> {
  const hits: SiteContentHit[] = [];
  const blocks = await getJson(a, `blocks?${q ? `search=${encodeURIComponent(q)}&` : ''}per_page=50&context=edit&_fields=id,title,status`).catch(() => null);
  if (blocks?.ok && Array.isArray(blocks.body)) {
    for (const v of blocks.body as Record<string, unknown>[]) hits.push({ kind: 'blocks', id: String(v['id'] ?? ''), title: sitePartLabel('blocks', raw(v['title'])), link: '', status: String(v['status'] ?? 'publish') });
  }
  if (q) return hits;
  const parts = await getJson(a, 'template-parts?context=edit&_fields=id,title,area').catch(() => null);
  if (parts?.ok && Array.isArray(parts.body)) {
    for (const v of parts.body as Record<string, unknown>[]) {
      const area = String(v['area'] ?? '');
      if (area !== 'header' && area !== 'footer') continue;
      hits.push({ kind: 'template-parts', id: String(v['id'] ?? ''), title: sitePartLabel('template-parts', raw(v['title']) || String(v['id']), area), link: `${a.siteUrl}/`, status: 'publish' });
    }
  }
  const widgets = await getJson(a, 'widgets?context=edit').catch(() => null);
  if (widgets?.ok && Array.isArray(widgets.body)) {
    for (const v of widgets.body as Record<string, unknown>[]) {
      const sidebar = String(v['sidebar'] ?? '');
      if (!sidebar || sidebar === 'wp_inactive_widgets' || widgetText(v) === null) continue;
      hits.push({ kind: 'widgets', id: String(v['id'] ?? ''), title: sitePartLabel('widgets', `${sidebar}・${String(v['id'] ?? '')}`), link: `${a.siteUrl}/`, status: 'publish' });
    }
  }
  return hits;
}

/** ウィジェットの文（ブロックのウィジェットは `content`、テキストと HTML のウィジェットは `text`・`content`）。文を持たなければ `null`。 */
function widgetText(v: Record<string, unknown>): { field: 'content' | 'text'; text: string; raw: Record<string, unknown> } | null {
  const inst = v['instance'] as { raw?: Record<string, unknown> } | undefined;
  const r = inst?.raw;
  if (!r || typeof r !== 'object') return null;
  if (v['id_base'] === 'block' && typeof r['content'] === 'string') return { field: 'content', text: r['content'], raw: r };
  if ((v['id_base'] === 'text' || v['id_base'] === 'custom_html') && typeof r['text'] === 'string') return { field: 'text', text: r['text'], raw: r };
  if (v['id_base'] === 'custom_html' && typeof r['content'] === 'string') return { field: 'content', text: r['content'], raw: r };
  return null;
}

/**
 * 1 件を編集用の形で読む。
 *
 * @returns 読めなければ理由
 */
export async function readSiteContent(a: WordPressAuth, kind: SiteContentKind, id: string): Promise<SiteContent | { error: string }> {
  try {
    if (kind === 'widgets') return await readWidget(a, id);
    const r = await getJson(a, `${itemPath(kind, id)}?context=edit&_fields=id,title,link,status,content,excerpt,modified_gmt,modified,area`);
    if (!r.ok) {
      if (r.status === 404) return { error: 'そのページは WordPress にありません（消されたかもしれません）' };
      if (r.status === 401 || r.status === 403) return { error: 'WordPress の利用者に、このページを直す権限がありません（「編集者」の役割にしてください）' };
      return { error: `WordPress からページを読めませんでした（${r.status}）` };
    }
    const v = r.body as Record<string, unknown>;
    const part = kind === 'blocks' || kind === 'template-parts';
    return {
      kind, id: String(v['id'] ?? id), title: part ? sitePartLabel(kind, raw(v['title']) || id, String(v['area'] ?? '')) : raw(v['title']),
      link: kind === 'template-parts' ? `${a.siteUrl}/` : typeof v['link'] === 'string' ? v['link'] : '',
      status: typeof v['status'] === 'string' ? v['status'] : 'publish', content: raw(v['content']), excerpt: raw(v['excerpt']),
      // テンプレートパーツは modified_gmt を持たない（6.3 から modified だけ）
      modifiedGmt: typeof v['modified_gmt'] === 'string' ? v['modified_gmt'] : typeof v['modified'] === 'string' ? v['modified'] : '',
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
    if (kind === 'widgets') return await updateWidget(a, id, v.content);
    // 部品は本文だけを送る（題名は承認の画面の呼び方にしてあるため。抜粋は持たない）
    const part = kind === 'blocks' || kind === 'template-parts' || kind === 'navigation';
    const res = await outboundFetch(`${a.siteUrl}/wp-json/wp/v2/${itemPath(kind, id)}?context=edit&_fields=modified_gmt,modified,link`, {
      method: 'POST', headers: wordPressHeaders(a), signal: AbortSignal.timeout(TIMEOUT_MS),
      body: JSON.stringify(part ? { content: v.content } : { content: v.content, ...(v.title !== undefined ? { title: v.title } : {}), ...(v.excerpt !== undefined ? { excerpt: v.excerpt } : {}) }),
    });
    if (res.status === 401 || res.status === 403) return { error: kind === 'template-parts' ? 'WordPress の利用者に、ヘッダーとフッターを直す権限がありません（WordPress の管理者の役割が要ります）' : 'WordPress の利用者に、このページを直す権限がありません（「編集者」の役割にしてください）' };
    if (!res.ok) return { error: `WordPress でページを直せませんでした（${res.status}）` };
    const body = await res.json() as { modified_gmt?: unknown; modified?: unknown; link?: unknown };
    return { modifiedGmt: typeof body.modified_gmt === 'string' ? body.modified_gmt : typeof body.modified === 'string' ? body.modified : '', link: kind === 'template-parts' ? `${a.siteUrl}/` : typeof body.link === 'string' ? body.link : '' };
  } catch (err) {
    return { error: `WordPress に届きませんでした（${err instanceof Error ? err.message : String(err)}）` };
  }
}

/** ウィジェットを編集用の形で読む（第45.18.4節）。 */
async function readWidget(a: WordPressAuth, id: string): Promise<SiteContent | { error: string }> {
  const r = await getJson(a, `widgets/${encodeURIComponent(id)}?context=edit`);
  if (!r.ok) return { error: r.status === 401 || r.status === 403 ? 'WordPress の利用者に、ウィジェットを直す権限がありません（WordPress の管理者の役割が要ります）' : `WordPress からウィジェットを読めませんでした（${r.status}）` };
  const v = r.body as Record<string, unknown>;
  const t = widgetText(v);
  if (!t) return { error: 'このウィジェットは文を直せません' };
  return { kind: 'widgets', id, title: sitePartLabel('widgets', `${String(v['sidebar'] ?? '')}・${id}`), link: `${a.siteUrl}/`, status: 'publish', content: t.text, excerpt: '', modifiedGmt: '' };
}

/** ウィジェットの文を書き換える（ほかの設定はいまのまま）。 */
async function updateWidget(a: WordPressAuth, id: string, content: string): Promise<{ modifiedGmt: string; link: string } | { error: string }> {
  const r = await getJson(a, `widgets/${encodeURIComponent(id)}?context=edit`);
  if (!r.ok) return { error: `WordPress からウィジェットを読めませんでした（${r.status}）` };
  const t = widgetText(r.body as Record<string, unknown>);
  if (!t) return { error: 'このウィジェットは文を直せません' };
  const res = await outboundFetch(`${a.siteUrl}/wp-json/wp/v2/widgets/${encodeURIComponent(id)}`, {
    method: 'POST', headers: wordPressHeaders(a), signal: AbortSignal.timeout(TIMEOUT_MS), body: JSON.stringify({ instance: { raw: { ...t.raw, [t.field]: content } } }),
  });
  if (res.status === 401 || res.status === 403) return { error: 'WordPress の利用者に、ウィジェットを直す権限がありません（WordPress の管理者の役割が要ります）' };
  if (!res.ok) return { error: `WordPress でウィジェットを直せませんでした（${res.status}）` };
  return { modifiedGmt: '', link: `${a.siteUrl}/` };
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
export type SiteTaxonomy = string;

/** 分類の口の名前。`category` はカテゴリー、`tag` はタグ、ほかは独自の分類の口の名前（`news_category` など。第45.20.3節）。 */
export function taxonomyPath(t: SiteTaxonomy): string {
  if (t === 'category') return 'categories';
  if (t === 'tag') return 'tags';
  return /^[a-z0-9_-]{1,40}$/i.test(t) ? t : 'categories';
}

/**
 * 記事の種類ごとの、分類の欄（記事の REST の欄の名前）。投稿は `categories` と `tags`。カスタム投稿タイプは、親子のある分類と無い分類の口の名前。
 */
export interface PostTermFields {
  /** 記事の種類（`post` か、カスタム投稿タイプの口の名前）。 */
  kind: string;
  /** 親子のある分類（カテゴリーの形）の、分類の名前（`category` か口の名前）と記事の欄の名前。 */
  category: { taxonomy: SiteTaxonomy; field: string } | null;
  /** 親子の無い分類（タグの形）。 */
  tag: { taxonomy: SiteTaxonomy; field: string } | null;
}

/** 投稿の分類の欄。 */
export const POST_TERM_FIELDS: PostTermFields = { kind: 'post', category: { taxonomy: 'category', field: 'categories' }, tag: { taxonomy: 'tag', field: 'tags' } };

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
      const r = await getJson(a, `${taxonomyPath(taxonomy)}?per_page=100&page=${page}&hide_empty=false&_fields=id,name,parent,count`);
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
    const r = await getJson(a, `${taxonomyPath(taxonomy)}/${encodeURIComponent(id)}?_fields=id,name,parent,count`);
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
    const r = await send(a, 'POST', taxonomyPath(taxonomy), { name, ...(parent ? { parent: Number(parent) } : {}) });
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
    const r = await send(a, 'POST', `${taxonomyPath(taxonomy)}/${encodeURIComponent(id)}`, { name });
    if (r.ok) return null;
    return r.status === 401 || r.status === 403 ? 'WordPress の利用者に、カテゴリーとタグを直す権限がありません' : `WordPress で名前を変えられませんでした（${r.status}）`;
  } catch (err) {
    return `WordPress に届きませんでした（${err instanceof Error ? err.message : String(err)}）`;
  }
}

/** カテゴリーかタグを消す（元に戻すときに、作ったもので記事が 1 つも付いていないものだけ。Q-341）。 */
export async function deleteSiteTerm(a: WordPressAuth, taxonomy: SiteTaxonomy, id: string): Promise<string | null> {
  try {
    const r = await send(a, 'DELETE', `${taxonomyPath(taxonomy)}/${encodeURIComponent(id)}?force=true`);
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

function postTermsOf(v: Record<string, unknown>, f: PostTermFields = POST_TERM_FIELDS): SitePostTerms {
  const ids = (x: unknown) => (Array.isArray(x) ? (x as unknown[]).map((n) => String(n)) : []);
  return {
    id: String(v['id'] ?? ''), title: raw(v['title']), link: typeof v['link'] === 'string' ? v['link'] : '', date: typeof v['date'] === 'string' ? v['date'] : '',
    categories: f.category ? ids(v[f.category.field]) : [], tags: f.tag ? ids(v[f.tag.field]) : [], modifiedGmt: typeof v['modified_gmt'] === 'string' ? v['modified_gmt'] : '',
  };
}

const termFieldsQuery = (f: PostTermFields) => ['id', 'title', 'link', 'date', ...(f.category ? [f.category.field] : []), ...(f.tag ? [f.tag.field] : []), 'modified_gmt'].join(',');

/**
 * 記事を探す（言葉があれば題名と本文から、無ければ新しい順）。カテゴリーとタグも返す。
 *
 * @returns 20 件まで。届かなければ理由
 */
export async function findSitePosts(a: WordPressAuth, query: string, f: PostTermFields = POST_TERM_FIELDS): Promise<SitePostTerms[] | { error: string }> {
  try {
    const q = query.trim();
    const r = await getJson(a, `${siteContentPath(f.kind)}?${q ? `search=${encodeURIComponent(q)}&` : ''}per_page=20&status=publish,private,draft,future&context=edit&_fields=${termFieldsQuery(f)}`);
    if (!r.ok) return { error: `WordPress で記事を探せませんでした（${r.status}）` };
    return (Array.isArray(r.body) ? r.body as Record<string, unknown>[] : []).map((v) => postTermsOf(v, f)).filter((p) => p.id);
  } catch (err) {
    return { error: `WordPress に届きませんでした（${err instanceof Error ? err.message : String(err)}）` };
  }
}

/** 記事 1 つのカテゴリーとタグを読む。 */
export async function readSitePostTerms(a: WordPressAuth, id: string, f: PostTermFields = POST_TERM_FIELDS): Promise<SitePostTerms | { error: string }> {
  try {
    const r = await getJson(a, `${siteContentPath(f.kind)}/${encodeURIComponent(id)}?context=edit&_fields=${termFieldsQuery(f)}`);
    if (!r.ok) return { error: r.status === 404 ? 'その記事は WordPress にありません' : `WordPress から記事を読めませんでした（${r.status}）` };
    return postTermsOf(r.body as Record<string, unknown>, f);
  } catch (err) {
    return { error: `WordPress に届きませんでした（${err instanceof Error ? err.message : String(err)}）` };
  }
}

/**
 * 記事のカテゴリーとタグを、渡したものにそろえる。
 *
 * @returns 直した後の最後に直された時刻。直せなければ理由
 */
export async function setSitePostTerms(a: WordPressAuth, id: string, terms: { categories: string[]; tags: string[] }, f: PostTermFields = POST_TERM_FIELDS): Promise<{ modifiedGmt: string } | { error: string }> {
  try {
    const r = await send(a, 'POST', `${siteContentPath(f.kind)}/${encodeURIComponent(id)}?context=edit&_fields=modified_gmt`, {
      ...(f.category ? { [f.category.field]: terms.categories.map(Number) } : {}), ...(f.tag ? { [f.tag.field]: terms.tags.map(Number) } : {}),
    });
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
    const r = await getJson(a, `${siteContentPath(kind)}/${encodeURIComponent(id)}?context=edit&_fields=id,title,link,status,date,modified_gmt,featured_media,content,excerpt`);
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
    const r = await send(a, 'POST', `${siteContentPath(kind)}?_fields=id,link`, {
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
      ? await send(a, 'DELETE', `${siteContentPath(kind)}/${encodeURIComponent(id)}`)
      : await send(a, 'POST', `${siteContentPath(kind)}/${encodeURIComponent(id)}?context=edit&_fields=modified_gmt`, { status, ...(date ? { date } : {}) });
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
    const r = await getJson(a, `${siteContentPath(kind)}/${encodeURIComponent(id)}/revisions?context=edit&per_page=30&_fields=id,date,title,content,excerpt`);
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
    const r = await send(a, 'POST', `${siteContentPath(kind)}/${encodeURIComponent(id)}?context=edit&_fields=modified_gmt`, { featured_media: mediaId });
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
    const r = await getJson(a, `${siteContentPath(kind)}?${q ? `search=${encodeURIComponent(q)}&` : ''}per_page=${kind === 'page' ? 100 : 20}&status=publish,private,draft,future,pending&context=edit&_fields=id,title,status,date,link`);
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

/** テーマの全体のスタイル（ブロックのテーマ。第46.7節・段 3）。 */
export interface SiteGlobalStyles {
  /** 全体のスタイルの番号（利用者が直した分を持つ投稿）。 */
  id: string;
  theme: string;
  settings: Record<string, unknown>;
  styles: Record<string, unknown>;
}

/**
 * いま使っているテーマの全体のスタイルを読む。ブロックのテーマ（`theme.json` を持つ）でなければ理由。
 *
 * @returns 全体のスタイル。読めなければ理由（`classic` が真なら、クラシックのテーマのため）
 */
export async function readGlobalStyles(a: WordPressAuth): Promise<SiteGlobalStyles | { error: string; classic?: boolean }> {
  try {
    const t = await getJson(a, 'themes?status=active&context=edit');
    if (!t.ok) return { error: t.status === 401 || t.status === 403 ? 'テーマを読むには、WordPress の管理者の役割が要ります' : `WordPress のテーマを読めませんでした（${t.status}）` };
    const theme = ((Array.isArray(t.body) ? t.body : []) as Record<string, unknown>[])[0];
    if (!theme) return { error: '使っているテーマが分かりません' };
    const stylesheet = String(theme['stylesheet'] ?? '');
    const links = theme['_links'] as Record<string, { href?: string }[]> | undefined;
    const href = links?.['wp:user-global-styles']?.[0]?.href ?? '';
    const id = /global-styles\/(\d+)/.exec(href)?.[1];
    if (theme['is_block_theme'] === false || !id) return { error: `テーマ「${stylesheet}」はクラシックのテーマのため、全体のスタイルを直に入れられません`, classic: true };
    const g = await getJson(a, `global-styles/${id}?context=edit`);
    if (!g.ok) return { error: g.status === 401 || g.status === 403 ? '全体のスタイルを直すには、WordPress の管理者の役割が要ります' : `全体のスタイルを読めませんでした（${g.status}）` };
    const v = g.body as Record<string, unknown>;
    const obj = (x: unknown) => (x && typeof x === 'object' && !Array.isArray(x) ? x as Record<string, unknown> : {});
    return { id, theme: stylesheet, settings: obj(v['settings']), styles: obj(v['styles']) };
  } catch (err) {
    return { error: `WordPress に届きませんでした（${err instanceof Error ? err.message : String(err)}）` };
  }
}

/** 全体のスタイルを書く（設定とスタイルをまるごと置き換える。呼ぶ側が、いまの値に足した形を渡す）。 */
export async function writeGlobalStyles(a: WordPressAuth, id: string, v: { settings: Record<string, unknown>; styles: Record<string, unknown> }): Promise<string | null> {
  try {
    const res = await outboundFetch(`${a.siteUrl}/wp-json/wp/v2/global-styles/${encodeURIComponent(id)}`, {
      method: 'POST', headers: wordPressHeaders(a), signal: AbortSignal.timeout(TIMEOUT_MS), body: JSON.stringify(v),
    });
    if (res.status === 401 || res.status === 403) return '全体のスタイルを直すには、WordPress の管理者の役割が要ります';
    return res.ok ? null : `WordPress で全体のスタイルを直せませんでした（${res.status}）`;
  } catch (err) {
    return `WordPress に届きませんでした（${err instanceof Error ? err.message : String(err)}）`;
  }
}
