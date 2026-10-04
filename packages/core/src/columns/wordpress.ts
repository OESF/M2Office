/**
 * @file WordPress への書き込み（仕様書 第32.10節・第32.18.1節）。REST API（`wp-json/wp/v2`）を、アプリケーションパスワードで呼ぶ。
 *
 * 段 1 は**下書き**として入れるだけで、公開は WordPress の側で押す（Q-162）。
 * パスワードは会社の接続の秘密の値として暗号化して預け（移行 062）、呼ぶときだけ取り出す。画面にも記録にも出さない。
 * 相手の応答は外部のデータとして扱う。
 */

import { markdownToDocHtml } from '../connectors/google/doc-html.js';

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

function headers(a: WordPressAuth): Record<string, string> {
  // アプリケーションパスワードは空白を含めて渡してよいが、空白を除いても通る
  const token = Buffer.from(`${a.username}:${a.password.replace(/\s+/g, '')}`).toString('base64');
  return { authorization: `Basic ${token}`, 'content-type': 'application/json', accept: 'application/json' };
}

/** つながるか（利用者名とパスワードが通り、記事を書ける権限があるか）を確かめる。 */
export async function checkWordPress(a: WordPressAuth): Promise<{ ok: true; name: string } | { ok: false; error: string }> {
  try {
    const res = await fetch(`${a.siteUrl}/wp-json/wp/v2/users/me?context=edit`, { headers: headers(a), signal: AbortSignal.timeout(TIMEOUT_MS) });
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
export async function createWordPressDraft(a: WordPressAuth, post: { title: string; html: string; excerpt: string; featuredMedia?: string | null }): Promise<{ id: string; editUrl: string } | { error: string }> {
  try {
    const res = await fetch(`${a.siteUrl}/wp-json/wp/v2/posts`, {
      method: 'POST', headers: headers(a), signal: AbortSignal.timeout(TIMEOUT_MS),
      body: JSON.stringify({
        title: post.title, content: post.html, excerpt: post.excerpt, status: 'draft',
        ...(post.featuredMedia ? { featured_media: Number(post.featuredMedia) } : {}),
      }),
    });
    if (!res.ok) return { error: `WordPress に入れられませんでした（${res.status}）` };
    const body = await res.json() as { id?: unknown };
    const id = String(body.id ?? '');
    if (!id) return { error: 'WordPress の応答に記事の ID がありません' };
    return { id, editUrl: `${a.siteUrl}/wp-admin/post.php?post=${encodeURIComponent(id)}&action=edit` };
  } catch (err) {
    return { error: `WordPress に届きませんでした（${err instanceof Error ? err.message : String(err)}）` };
  }
}

/**
 * 画像を WordPress のメディアに入れる（カバー画像。仕様書 第32.18.2節）。代わりの文も付ける。
 *
 * @returns メディアの ID。入れられなければ理由
 */
export async function uploadWordPressMedia(a: WordPressAuth, img: { bytes: Uint8Array; fileName: string; mimeType: string; alt: string }): Promise<{ id: string } | { error: string }> {
  try {
    const h = headers(a);
    const res = await fetch(`${a.siteUrl}/wp-json/wp/v2/media`, {
      method: 'POST', signal: AbortSignal.timeout(TIMEOUT_MS),
      headers: { authorization: h['authorization']!, accept: 'application/json', 'content-type': img.mimeType, 'content-disposition': `attachment; filename="${img.fileName.replace(/[^\w.-]/g, '_')}"` },
      body: Buffer.from(img.bytes),
    });
    if (!res.ok) return { error: `カバー画像を WordPress に入れられませんでした（${res.status}）` };
    const body = await res.json() as { id?: unknown };
    const id = String(body.id ?? '');
    if (!id) return { error: 'WordPress の応答にメディアの ID がありません' };
    // 代わりの文は入れた後に付ける（入れるときの口では受け取らないため）。付けられなくても記事は作る
    await fetch(`${a.siteUrl}/wp-json/wp/v2/media/${encodeURIComponent(id)}`, {
      method: 'POST', headers: h, signal: AbortSignal.timeout(TIMEOUT_MS), body: JSON.stringify({ alt_text: img.alt }),
    }).catch(() => undefined);
    return { id };
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
}): Promise<{ id: string; link: string; editUrl: string } | { error: string }> {
  try {
    const res = await fetch(`${a.siteUrl}/wp-json/wp/v2/posts`, {
      method: 'POST', headers: headers(a), signal: AbortSignal.timeout(TIMEOUT_MS),
      body: JSON.stringify({
        title: post.title, content: post.html, status: post.status,
        ...(post.status === 'future' && post.date ? { date_gmt: post.date.replace(/\.\d{3}Z$/, '').replace(/Z$/, '') } : {}),
        ...(post.categories?.length ? { categories: post.categories } : {}),
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
  try {
    const found = await fetch(`${a.siteUrl}/wp-json/wp/v2/categories?search=${encodeURIComponent(name)}&per_page=20`, { headers: headers(a), signal: AbortSignal.timeout(TIMEOUT_MS) });
    if (found.ok) {
      const list = await found.json() as { id?: number; name?: string }[];
      const hit = list.find((c) => c.name === name);
      if (hit?.id) return hit.id;
    }
    const made = await fetch(`${a.siteUrl}/wp-json/wp/v2/categories`, {
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
 * 記事の公開の状態と URL（Web の分析が、公開されたコラムの数字を読むため。第34.19節）。
 *
 * @returns 読めなければ `null`
 */
export async function getWordPressPost(a: WordPressAuth, id: string): Promise<{ status: string; link: string } | null> {
  try {
    const res = await fetch(`${a.siteUrl}/wp-json/wp/v2/posts/${encodeURIComponent(id)}?context=edit&_fields=status,link`, { headers: headers(a), signal: AbortSignal.timeout(TIMEOUT_MS) });
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
export async function setWordPressStatus(a: WordPressAuth, id: string, status: 'draft' | 'publish'): Promise<string | null> {
  try {
    const res = await fetch(`${a.siteUrl}/wp-json/wp/v2/posts/${encodeURIComponent(id)}`, {
      method: 'POST', headers: headers(a), signal: AbortSignal.timeout(TIMEOUT_MS), body: JSON.stringify({ status }),
    });
    return res.ok ? null : `WordPress の記事を下書きに戻せませんでした（${res.status}）`;
  } catch (err) {
    return `WordPress に届きませんでした（${err instanceof Error ? err.message : String(err)}）`;
  }
}

/** 記事の題名を変える（お知らせの期間の後に「（終了しました）」を付ける。第35.6.1節）。 */
export async function updateWordPressTitle(a: WordPressAuth, id: string, title: string): Promise<string | null> {
  try {
    const res = await fetch(`${a.siteUrl}/wp-json/wp/v2/posts/${encodeURIComponent(id)}`, {
      method: 'POST', headers: headers(a), signal: AbortSignal.timeout(TIMEOUT_MS), body: JSON.stringify({ title }),
    });
    return res.ok ? null : `WordPress の記事を直せませんでした（${res.status}）`;
  } catch (err) {
    return `WordPress に届きませんでした（${err instanceof Error ? err.message : String(err)}）`;
  }
}
