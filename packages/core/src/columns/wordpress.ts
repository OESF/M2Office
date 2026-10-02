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
