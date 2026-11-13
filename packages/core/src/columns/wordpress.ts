/**
 * @file WordPress への書き込み（仕様書 第32.10節・第32.18.1節）。REST API（`wp-json/wp/v2`）を、アプリケーションパスワードで呼ぶ。
 *
 * 段 1 は**下書き**として入れるだけで、公開は WordPress の側で押す（Q-162）。
 * パスワードは会社の接続の秘密の値として暗号化して預け（移行 062）、呼ぶときだけ取り出す。画面にも記録にも出さない。
 * 相手の応答は外部のデータとして扱う。
 */

import { markdownToDocHtml } from '../connectors/google/doc-html.js';
import { outboundFetch } from '../net/outbound.js';

/** WordPress につなぐ値。 */
export interface WordPressAuth {
  siteUrl: string;
  username: string;
  password: string;
}

/** 呼び出しを待つ時間（ミリ秒）。 */
const TIMEOUT_MS = 20_000;

/** サイトの URL を整える（末尾の `/` を外す。http(s) だけ）。読めなければ `null`。 */
export function normalizeSiteUrl(raw: string): string | null {
  try {
    const u = new URL(raw.trim());
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
    return `${u.origin}${u.pathname.replace(/\/+$/, '')}`;
  } catch {
    return null;
  }
}

/**
 * WordPress の REST API を呼ぶときの見出し（アプリケーションパスワードの Basic 認証）。
 *
 * @remarks サイトの更新（第45章）も同じ見出しで呼ぶ
 */
export function wordPressHeaders(a: WordPressAuth): Record<string, string> {
  return headers(a);
}

function headers(a: WordPressAuth): Record<string, string> {
  // アプリケーションパスワードは空白を含めて渡してよいが、空白を除いても通る
  const token = Buffer.from(`${a.username}:${a.password.replace(/\s+/g, '')}`).toString('base64');
  return { authorization: `Basic ${token}`, 'content-type': 'application/json', accept: 'application/json' };
}

/** つながるか（利用者名とパスワードが通り、記事を書ける権限があるか）を確かめる。 */
export async function checkWordPress(a: WordPressAuth): Promise<{ ok: true; name: string } | { ok: false; error: string }> {
  try {
    const res = await outboundFetch(`${a.siteUrl}/wp-json/wp/v2/users/me?context=edit`, { headers: headers(a), signal: AbortSignal.timeout(TIMEOUT_MS) });
    if (res.status === 401 || res.status === 403) return { ok: false, error: '利用者名かアプリケーションパスワードが違うか、記事を書く権限がありません' };
    if (res.status === 404) return { ok: false, error: 'WordPress の REST API が見つかりません。サイトの URL を確かめてください' };
    if (!res.ok) return { ok: false, error: `WordPress が応答しませんでした（${res.status}）` };
    const body = await res.json() as { name?: unknown; capabilities?: Record<string, unknown> };
    if (body.capabilities && body.capabilities['edit_posts'] === false) return { ok: false, error: 'この利用者には記事を書く権限がありません' };
    return { ok: true, name: typeof body.name === 'string' ? body.name : a.username };
  } catch (err) {
    return { ok: false, error: `WordPress に届きませんでした（${err instanceof Error ? err.message : String(err)}）` };
  }
}

/** 本文（Markdown）を、WordPress に入れる HTML にする（`<html>` の包みを外す）。 */
export function columnHtml(markdown: string): string {
  return markdownToDocHtml(markdown).replace(/^[\s\S]*?<body[^>]*>/i, '').replace(/<\/body>[\s\S]*$/i, '').replace(/^<html[^>]*>|<\/html>$/gi, '').trim();
}

/**
 * 下書きの記事を作る。
 *
 * @returns 記事の ID と、WordPress の編集の画面の URL
 */
export async function createWordPressDraft(a: WordPressAuth, post: {
  title: string; html: string; excerpt: string; featuredMedia?: string | null; categories?: number[];
  /** 入れる種類の口の名前（既定は `posts`。第45.20節）と、分類の口の名前と ID。 */
  restBase?: string; terms?: { field: string; ids: number[] };
}): Promise<{ id: string; editUrl: string } | { error: string }> {
  try {
    const res = await outboundFetch(`${a.siteUrl}/wp-json/wp/v2/${post.restBase ?? 'posts'}`, {
      method: 'POST', headers: headers(a), signal: AbortSignal.timeout(TIMEOUT_MS),
      body: JSON.stringify({
        title: post.title, content: post.html, excerpt: post.excerpt, status: 'draft',
        ...(post.featuredMedia ? { featured_media: Number(post.featuredMedia) } : {}),
        ...(post.categories?.length ? { categories: post.categories } : {}),
        ...(post.terms?.ids.length ? { [post.terms.field]: post.terms.ids } : {}),
      }),
    });
    if (!res.ok) return { error: `WordPress に入れられませんでした（${res.status}）` };
    const body = await res.json() as { id?: unknown; source_url?: unknown };
    const id = String(body.id ?? '');
    const url = typeof body.source_url === 'string' ? body.source_url : '';
    if (!id) return { error: 'WordPress の応答に記事の ID がありません' };
    return { id, editUrl: `${a.siteUrl}/wp-admin/post.php?post=${encodeURIComponent(id)}&action=edit` };
  } catch (err) {
    return { error: `WordPress に届きませんでした（${err instanceof Error ? err.message : String(err)}）` };
  }
}

/**
 * 画像を WordPress のメディアに入れる（カバー画像。仕様書 第32.18.2節）。代わりの文も付ける。
 *
 * @returns メディアの ID と URL（記事の中に置くとき使う。分からなければ空）。入れられなければ理由
 */
export async function uploadWordPressMedia(a: WordPressAuth, img: { bytes: Uint8Array; fileName: string; mimeType: string; alt: string }): Promise<{ id: string; url: string } | { error: string }> {
  try {
    const h = headers(a);
    const res = await outboundFetch(`${a.siteUrl}/wp-json/wp/v2/media`, {
      method: 'POST', signal: AbortSignal.timeout(TIMEOUT_MS),
      headers: { authorization: h['authorization']!, accept: 'application/json', 'content-type': img.mimeType, 'content-disposition': `attachment; filename="${img.fileName.replace(/[^\w.-]/g, '_')}"` },
      body: Buffer.from(img.bytes),
    });
    if (!res.ok) return { error: `カバー画像を WordPress に入れられませんでした（${res.status}）` };
    const body = await res.json() as { id?: unknown; source_url?: unknown };
    const id = String(body.id ?? '');
    const url = typeof body.source_url === 'string' ? body.source_url : '';
    if (!id) return { error: 'WordPress の応答にメディアの ID がありません' };
    // 代わりの文は入れた後に付ける（入れるときの口では受け取らないため）。付けられなくても記事は作る
    await outboundFetch(`${a.siteUrl}/wp-json/wp/v2/media/${encodeURIComponent(id)}`, {
      method: 'POST', headers: h, signal: AbortSignal.timeout(TIMEOUT_MS), body: JSON.stringify({ alt_text: img.alt }),
    }).catch(() => undefined);
    return { id, url };
  } catch (err) {
    return { error: `WordPress に届きませんでした（${err instanceof Error ? err.message : String(err)}）` };
  }
}

/**
 * 記事を作る（お知らせの作成。仕様書 第35.6.1節）。公開・予約公開・下書きを選べる。
 *
 * @param post.status `publish`（すぐ公開）・`future`（`date` に予約公開）・`draft`（下書き）
 * @param post.date 予約公開の日時（ISO。`future` のとき）
 * @returns 記事の ID・記事の URL・編集の画面の URL
 */
export async function createWordPressPost(a: WordPressAuth, post: {
  title: string; html: string; status: 'publish' | 'future' | 'draft'; date?: string; categories?: number[];
  /** 入れる種類の口の名前（既定は `posts`。カスタム投稿タイプなら `news` など。第45.20節） */
  restBase?: string;
  /** 分類の口の名前と ID（既定は `categories` に `categories`）。 */
  terms?: { field: string; ids: number[] };
}): Promise<{ id: string; link: string; editUrl: string } | { error: string }> {
  try {
    const terms = post.terms ?? (post.categories?.length ? { field: 'categories', ids: post.categories } : null);
    const res = await outboundFetch(`${a.siteUrl}/wp-json/wp/v2/${post.restBase ?? 'posts'}`, {
      method: 'POST', headers: headers(a), signal: AbortSignal.timeout(TIMEOUT_MS),
      body: JSON.stringify({
        title: post.title, content: post.html, status: post.status,
        ...(post.status === 'future' && post.date ? { date_gmt: post.date.replace(/\.\d{3}Z$/, '').replace(/Z$/, '') } : {}),
        ...(terms && terms.ids.length ? { [terms.field]: terms.ids } : {}),
      }),
    });
    if (!res.ok) return { error: `WordPress に記事を入れられませんでした（${res.status}）` };
    const body = await res.json() as { id?: unknown; link?: unknown };
    const id = String(body.id ?? '');
    if (!id) return { error: 'WordPress の応答に記事の ID がありません' };
    return { id, link: typeof body.link === 'string' ? body.link : '', editUrl: `${a.siteUrl}/wp-admin/post.php?post=${encodeURIComponent(id)}&action=edit` };
  } catch (err) {
    return { error: `WordPress に届きませんでした（${err instanceof Error ? err.message : String(err)}）` };
  }
}

/**
 * カテゴリーの ID を引く。無ければ作る（お知らせの作成。第35.4節）。
 *
 * @returns カテゴリーの ID。引けず作れなければ `null`（カテゴリーなしで入れる）
 */
export async function ensureWordPressCategory(a: WordPressAuth, name: string): Promise<number | null> {
  return ensureWordPressTerm(a, 'categories', name);
}

/**
 * 分類（カテゴリー・独自の分類）の ID を引く。無ければ作る（第45.20節）。
 *
 * @param taxonomyBase 分類の口の名前（`categories`・`news_category` など）
 * @returns ID。引けず作れなければ `null`（分類なしで入れる）
 */
export async function ensureWordPressTerm(a: WordPressAuth, taxonomyBase: string, name: string): Promise<number | null> {
  try {
    const found = await outboundFetch(`${a.siteUrl}/wp-json/wp/v2/${taxonomyBase}?search=${encodeURIComponent(name)}&per_page=20`, { headers: headers(a), signal: AbortSignal.timeout(TIMEOUT_MS) });
    if (found.ok) {
      const list = await found.json() as { id?: number; name?: string }[];
      const hit = list.find((c) => c.name === name);
      if (hit?.id) return hit.id;
    }
    const made = await outboundFetch(`${a.siteUrl}/wp-json/wp/v2/${taxonomyBase}`, {
      method: 'POST', headers: headers(a), signal: AbortSignal.timeout(TIMEOUT_MS), body: JSON.stringify({ name }),
    });
    if (!made.ok) return null;
    const body = await made.json() as { id?: number };
    return typeof body.id === 'number' ? body.id : null;
  } catch {
    return null;
  }
}

/**
 * 記事の公開の状態と URL（Webの分析が、公開されたコラムの数字を読むため。第34.19節）。
 *
 * @returns 読めなければ `null`
 */
export async function getWordPressPost(a: WordPressAuth, ref: string): Promise<{ status: string; link: string } | null> {
  const { restBase, id } = parseWpRef(ref);
  try {
    const res = await outboundFetch(`${a.siteUrl}/wp-json/wp/v2/${restBase}/${encodeURIComponent(id)}?context=edit&_fields=status,link`, { headers: headers(a), signal: AbortSignal.timeout(TIMEOUT_MS) });
    if (!res.ok) return null;
    const v = await res.json() as { status?: string; link?: string };
    return { status: v.status ?? '', link: v.link ?? '' };
  } catch {
    return null;
  }
}

/**
 * 記事の公開の状態を変える（コラムの取り下げで下書きに戻す。第32.10節）。
 *
 * @returns 変えられなければ理由
 */
export async function setWordPressStatus(a: WordPressAuth, ref: string, status: 'draft' | 'publish'): Promise<string | null> {
  const { restBase, id } = parseWpRef(ref);
  try {
    const res = await outboundFetch(`${a.siteUrl}/wp-json/wp/v2/${restBase}/${encodeURIComponent(id)}`, {
      method: 'POST', headers: headers(a), signal: AbortSignal.timeout(TIMEOUT_MS), body: JSON.stringify({ status }),
    });
    return res.ok ? null : `WordPress の記事を下書きに戻せませんでした（${res.status}）`;
  } catch (err) {
    return `WordPress に届きませんでした（${err instanceof Error ? err.message : String(err)}）`;
  }
}

/** 記事の題名を変える（お知らせの期間の後に「（終了しました）」を付ける。第35.6.1節）。`restBase` は入れた種類の口の名前（既定は `posts`）。 */
export async function updateWordPressTitle(a: WordPressAuth, id: string, title: string, restBase = 'posts'): Promise<string | null> {
  try {
    const res = await outboundFetch(`${a.siteUrl}/wp-json/wp/v2/${restBase}/${encodeURIComponent(id)}`, {
      method: 'POST', headers: headers(a), signal: AbortSignal.timeout(TIMEOUT_MS), body: JSON.stringify({ title }),
    });
    return res.ok ? null : `WordPress の記事を直せませんでした（${res.status}）`;
  } catch (err) {
    return `WordPress に届きませんでした（${err instanceof Error ? err.message : String(err)}）`;
  }
}

/** 記事の種類 1 つ（第45.20節）。 */
export interface WordPressPostType {
  /** 種類の名前（`post`・`page`・`news` など）。 */
  slug: string;
  /** 表示名（「投稿」「お知らせ」など）。 */
  name: string;
  /** 口の名前（`posts`・`pages`・`news` など）。 */
  restBase: string;
  /** 持っている分類の名前（`category`・`post_tag`・`news_category` など）。 */
  taxonomies: string[];
}

/** 記事でない種類（扱わない）。 */
const NOT_CONTENT = new Set(['attachment', 'wp_block', 'wp_template', 'wp_template_part', 'wp_navigation', 'nav_menu_item', 'wp_global_styles', 'wp_font_family', 'wp_font_face', 'wp_pattern']);

/**
 * REST API に出している記事の種類の一覧（投稿・固定ページ・カスタム投稿タイプ）。
 *
 * @returns 読めなければ理由
 */
export async function listPostTypes(a: WordPressAuth): Promise<WordPressPostType[] | { error: string }> {
  try {
    const res = await outboundFetch(`${a.siteUrl}/wp-json/wp/v2/types?context=edit`, { headers: headers(a), signal: AbortSignal.timeout(TIMEOUT_MS) });
    if (!res.ok) return { error: `WordPress の記事の種類を読めませんでした（${res.status}）` };
    const body = await res.json() as Record<string, Record<string, unknown>>;
    return Object.entries(body ?? {}).filter(([slug]) => !NOT_CONTENT.has(slug)).map(([slug, v]) => ({
      slug, name: typeof v['name'] === 'string' ? v['name'] : slug,
      restBase: typeof v['rest_base'] === 'string' && v['rest_base'] ? v['rest_base'] : slug,
      taxonomies: Array.isArray(v['taxonomies']) ? (v['taxonomies'] as unknown[]).filter((x): x is string => typeof x === 'string') : [],
    }));
  } catch (err) {
    return { error: `WordPress に届きませんでした（${err instanceof Error ? err.message : String(err)}）` };
  }
}

/** 分類 1 つ。 */
export interface WordPressTaxonomy {
  slug: string;
  name: string;
  restBase: string;
  /** 親子があるか（カテゴリーの形か）。 */
  hierarchical: boolean;
}

/** 分類の一覧（口の名前と親子の有無）。 */
export async function listTaxonomies(a: WordPressAuth): Promise<WordPressTaxonomy[] | { error: string }> {
  try {
    const res = await outboundFetch(`${a.siteUrl}/wp-json/wp/v2/taxonomies?context=edit`, { headers: headers(a), signal: AbortSignal.timeout(TIMEOUT_MS) });
    if (!res.ok) return { error: `WordPress の分類を読めませんでした（${res.status}）` };
    const body = await res.json() as Record<string, Record<string, unknown>>;
    return Object.entries(body ?? {}).map(([slug, v]) => ({
      slug, name: typeof v['name'] === 'string' ? v['name'] : slug,
      restBase: typeof v['rest_base'] === 'string' && v['rest_base'] ? v['rest_base'] : slug, hierarchical: v['hierarchical'] === true,
    }));
  } catch (err) {
    return { error: `WordPress に届きませんでした（${err instanceof Error ? err.message : String(err)}）` };
  }
}

/** お知らせらしい種類の名前と表示名（第45.20.2節）。 */
const NEWS_SLUG = /^(news|info|information|infos|topics?|notice|notices|oshirase|whatsnew|what-s-new)$/i;
const NEWS_LABEL = /(お知らせ|おしらせ|ニュース|新着情報|新着|インフォメーション|トピックス|NEWS|News)/;

/** 種類の一覧から、お知らせらしい種類の候補を選ぶ（投稿と固定ページは除く）。 */
export function pickNewsTypes(types: readonly WordPressPostType[]): WordPressPostType[] {
  return types.filter((t) => t.slug !== 'post' && t.slug !== 'page' && (NEWS_SLUG.test(t.slug) || NEWS_SLUG.test(t.restBase) || NEWS_LABEL.test(t.name)));
}

/**
 * 種類に付ける分類の口を決める（第45.20.2節）。`category` を持てば `categories`、持たずに親子のある独自の分類を持てばその口。
 *
 * @returns 無ければ `null`（分類を付けない）
 */
export function categoryFieldOf(type: WordPressPostType, taxonomies: readonly WordPressTaxonomy[]): WordPressTaxonomy | null {
  if (type.taxonomies.includes('category')) return taxonomies.find((t) => t.slug === 'category') ?? { slug: 'category', name: 'カテゴリー', restBase: 'categories', hierarchical: true };
  return taxonomies.find((t) => type.taxonomies.includes(t.slug) && t.hierarchical) ?? null;
}

/**
 * 入れた記事の参照（第45.20節）。投稿なら記事の ID のまま、ほかの種類なら `口の名前:ID`（`blog:123`）。
 *
 * @remarks コラムの記録は記事の ID の欄だけを持つため、種類を同じ欄に入れる。前から入っている ID はそのまま投稿として読める
 */
export function wpRef(restBase: string, id: string): string {
  return restBase === 'posts' ? id : `${restBase}:${id}`;
}

/** {@link wpRef} を読む。 */
export function parseWpRef(ref: string): { restBase: string; id: string } {
  const m = /^([a-z0-9_-]+):(\d+)$/i.exec(ref);
  return m ? { restBase: m[1]!, id: m[2]! } : { restBase: 'posts', id: ref };
}

/** コラムらしい種類の名前と表示名（第45.20.2節）。 */
const COLUMN_SLUG = /^(columns?|blogs?|journal|magazine|articles?|reading)$/i;
const COLUMN_LABEL = /(コラム|ブログ|読み物|マガジン|ジャーナル)/;

/** 種類の一覧から、コラムらしい種類の候補を選ぶ（投稿と固定ページは除く）。 */
export function pickColumnTypes(types: readonly WordPressPostType[]): WordPressPostType[] {
  return types.filter((t) => t.slug !== 'post' && t.slug !== 'page' && (COLUMN_SLUG.test(t.slug) || COLUMN_SLUG.test(t.restBase) || COLUMN_LABEL.test(t.name)));
}
