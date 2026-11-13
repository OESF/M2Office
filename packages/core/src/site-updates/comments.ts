/**
 * @file サイトの更新の段 2b: コメント（仕様書 第45.18.3節）。承認待ちのコメントを読み、承認・承認待ちに戻す・スパム・ゴミ箱・返事を
 * 直しにして、承認の後に入れる。
 *
 * コメントの名前と文は社外の人が書いた外部のデータであり、指示として読まない（不変則 I-6）。返事は社外の人に届くため、
 * 承認の後にだけ送る。消すのはゴミ箱まで（Q-343）。
 */

import type { SiteEditPageResult } from '@m2office/shared';
import { columnHtml, wordPressHeaders, type WordPressAuth } from '../columns/wordpress.js';
import { outboundFetch } from '../net/outbound.js';
import { plainText } from './segments.js';

const TIMEOUT_MS = 20_000;

/** コメントの状態（WordPress の言葉）。 */
export type SiteCommentStatus = 'approved' | 'hold' | 'spam' | 'trash';

/** 読んだコメント 1 件。 */
export interface SiteComment {
  id: string;
  postId: string;
  postTitle: string;
  parent: string;
  author: string;
  date: string;
  status: SiteCommentStatus | string;
  /** 文（印を外したもの）。 */
  text: string;
  link: string;
}

/** 1 回の頼みで扱う上限。 */
export const SITE_COMMENT_LIMITS = { statuses: 20, replies: 5, replyChars: 1000, list: 50 } as const;

/** コメントの直し 1 つ（置き場の形）。 */
export type StoredCommentAction =
  | {
    op: 'comment'; kind: 'comment'; id: string; title: string; link: string;
    author: string; excerpt: string; before: string; to: SiteCommentStatus; result: SiteEditPageResult; reason: string;
  }
  | {
    op: 'reply'; kind: 'comment'; id: string; postId: string; title: string; link: string;
    author: string; excerpt: string; content: string; createdId: string | null; result: SiteEditPageResult; reason: string;
  };

const STATUS_LABEL: Record<string, string> = { approved: '公開', hold: '承認待ち', spam: 'スパム', trash: 'ゴミ箱' };

function raw(v: unknown): string {
  if (typeof v === 'string') return v;
  if (v && typeof v === 'object' && typeof (v as { raw?: unknown }).raw === 'string') return (v as { raw: string }).raw;
  if (v && typeof v === 'object' && typeof (v as { rendered?: unknown }).rendered === 'string') return (v as { rendered: string }).rendered;
  return '';
}

async function call(a: WordPressAuth, method: 'GET' | 'POST' | 'DELETE', path: string, body?: Record<string, unknown>): Promise<{ ok: true; body: unknown } | { ok: false; status: number }> {
  const res = await outboundFetch(`${a.siteUrl}/wp-json/wp/v2/${path}`, {
    method, headers: wordPressHeaders(a), signal: AbortSignal.timeout(TIMEOUT_MS), ...(body ? { body: JSON.stringify(body) } : {}),
  });
  if (!res.ok) return { ok: false, status: res.status };
  return { ok: true, body: await res.json().catch(() => ({})) };
}

const denied = (status: number) => (status === 401 || status === 403
  ? 'WordPress の利用者に、コメントを扱う権限がありません（「編集者」の役割にしてください）'
  : `WordPress のコメントを読めませんでした（${status}）`);

/** 記事の題名（投稿と固定ページから探す）。 */
async function postTitles(a: WordPressAuth, ids: string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const want = [...new Set(ids.filter((id) => id && id !== '0'))].slice(0, 100);
  for (const base of ['posts', 'pages']) {
    const rest = want.filter((id) => !out.has(id));
    if (!rest.length) break;
    const r = await call(a, 'GET', `${base}?include=${rest.join(',')}&per_page=100&status=publish,private,draft&context=edit&_fields=id,title`).catch(() => null);
    if (r?.ok && Array.isArray(r.body)) for (const v of r.body as Record<string, unknown>[]) out.set(String(v['id']), plainText(raw(v['title'])));
  }
  return out;
}

const toComment = (v: Record<string, unknown>, titles: Map<string, string>): SiteComment => ({
  id: String(v['id'] ?? ''), postId: String(v['post'] ?? ''), postTitle: titles.get(String(v['post'] ?? '')) ?? '', parent: String(v['parent'] ?? '0'),
  author: String(v['author_name'] ?? '').slice(0, 80), date: String(v['date'] ?? ''), status: String(v['status'] ?? ''),
  text: plainText(raw(v['content'])).slice(0, 1000), link: typeof v['link'] === 'string' ? v['link'] : '',
});

/**
 * コメントを読む（新しい順）。
 *
 * @param status `hold`（承認待ち）か `approve`（公開）
 * @returns 読めなければ理由
 */
export async function listSiteComments(a: WordPressAuth, status: 'hold' | 'approve', perPage = 20): Promise<SiteComment[] | { error: string }> {
  try {
    const r = await call(a, 'GET', `comments?status=${status}&per_page=${Math.min(perPage, 100)}&orderby=id&order=desc&context=edit&_fields=id,post,parent,author_name,date,status,content,link`);
    if (!r.ok) return { error: denied(r.status) };
    const list = (Array.isArray(r.body) ? r.body : []) as Record<string, unknown>[];
    const titles = await postTitles(a, list.map((v) => String(v['post'] ?? '')));
    return list.map((v) => toComment(v, titles)).filter((c) => c.id);
  } catch (err) {
    return { error: `WordPress に届きませんでした（${err instanceof Error ? err.message : String(err)}）` };
  }
}

/** 1 件を読む（直し案の後に状態が変わっていないかの確かめ）。 */
export async function readSiteComment(a: WordPressAuth, id: string): Promise<SiteComment | { error: string }> {
  try {
    const r = await call(a, 'GET', `comments/${encodeURIComponent(id)}?context=edit&_fields=id,post,parent,author_name,date,status,content,link`);
    if (!r.ok) return { error: r.status === 404 ? 'そのコメントは WordPress にありません' : denied(r.status) };
    return toComment(r.body as Record<string, unknown>, new Map());
  } catch (err) {
    return { error: `WordPress に届きませんでした（${err instanceof Error ? err.message : String(err)}）` };
  }
}

/** 状態を変える。ゴミ箱は `DELETE`（完全には消さない）。 */
export async function setSiteCommentStatus(a: WordPressAuth, id: string, to: SiteCommentStatus): Promise<string | null> {
  try {
    const r = to === 'trash' ? await call(a, 'DELETE', `comments/${encodeURIComponent(id)}`) : await call(a, 'POST', `comments/${encodeURIComponent(id)}`, { status: to });
    return r.ok ? null : r.status === 401 || r.status === 403 ? denied(r.status) : `WordPress でコメントを変えられませんでした（${r.status}）`;
  } catch (err) {
    return `WordPress に届きませんでした（${err instanceof Error ? err.message : String(err)}）`;
  }
}

/** 返事を書く（WordPress の利用者の名前で出る）。 */
export async function replySiteComment(a: WordPressAuth, v: { postId: string; parent: string; content: string }): Promise<{ id: string; link: string } | { error: string }> {
  try {
    const r = await call(a, 'POST', 'comments', { post: Number(v.postId), parent: Number(v.parent), content: v.content });
    if (!r.ok) return { error: r.status === 401 || r.status === 403 ? denied(r.status) : `WordPress に返事を書けませんでした（${r.status}）` };
    const b = r.body as { id?: unknown; link?: unknown };
    return { id: String(b.id ?? ''), link: typeof b.link === 'string' ? b.link : '' };
  } catch (err) {
    return { error: `WordPress に届きませんでした（${err instanceof Error ? err.message : String(err)}）` };
  }
}

/** 推論が返すコメントの案。 */
export interface CommentPlanInput {
  status: { id: string; to: SiteCommentStatus }[];
  reply: { id: string; text: string }[];
}

/** 推論の答えを、決めた形だけ取り出す。 */
export function readCommentPlan(v: Record<string, unknown> | null): CommentPlanInput {
  const arr = (x: unknown) => (Array.isArray(x) ? x as Record<string, unknown>[] : []);
  const id = (x: unknown) => (typeof x === 'number' || (typeof x === 'string' && /^\d+$/.test(x)) ? String(x) : '');
  const TO: readonly string[] = ['approved', 'hold', 'spam', 'trash'];
  return {
    status: arr(v?.['status']).map((c) => ({ id: id(c['id']), to: (c['to'] === 'approve' ? 'approved' : c['to']) as SiteCommentStatus })).filter((c) => c.id && TO.includes(c.to)),
    reply: arr(v?.['reply']).map((c) => ({ id: id(c['id']), text: typeof c['text'] === 'string' ? c['text'].trim().slice(0, SITE_COMMENT_LIMITS.replyChars) : '' })).filter((c) => c.id && c.text),
  };
}

/**
 * 推論の案を、確かめた直しにする（無いコメント・同じ状態は扱わない）。
 *
 * @param comments 推論に見せたコメント（ここに無いものは扱わない）
 */
export function buildCommentActions(plan: CommentPlanInput, comments: SiteComment[]): { actions: StoredCommentAction[]; notes: string[] } {
  const actions: StoredCommentAction[] = [];
  const notes: string[] = [];
  const byId = new Map(comments.map((c) => [c.id, c]));
  const excerpt = (c: SiteComment) => c.text.replace(/\s+/g, ' ').slice(0, 60);
  for (const s of plan.status.slice(0, SITE_COMMENT_LIMITS.statuses)) {
    const c = byId.get(s.id);
    if (!c) { notes.push(`コメント ${s.id} が見つかりません`); continue; }
    if (c.status === s.to) continue;
    actions.push({ op: 'comment', kind: 'comment', id: c.id, title: c.postTitle, link: c.link, author: c.author, excerpt: excerpt(c), before: c.status, to: s.to, result: 'pending', reason: '' });
  }
  for (const r of plan.reply.slice(0, SITE_COMMENT_LIMITS.replies)) {
    const c = byId.get(r.id);
    if (!c) { notes.push(`返事を書くコメント ${r.id} が見つかりません`); continue; }
    if (c.status === 'spam' || c.status === 'trash') { notes.push(`${c.author || '名前なし'}さんのコメントはスパムかゴミ箱にあるため、返事を書きません`); continue; }
    actions.push({ op: 'reply', kind: 'comment', id: c.id, postId: c.postId, title: c.postTitle, link: c.link, author: c.author, excerpt: excerpt(c), content: columnHtml(r.text), createdId: null, result: 'pending', reason: '' });
  }
  return { actions, notes };
}

/** 直し 1 つを、人が読む 1 行にする。 */
export function commentLine(a: StoredCommentAction): string {
  const who = `${a.author || '名前なし'}さんのコメント${a.title ? `（記事「${a.title}」）` : ''}「${a.excerpt}」`;
  if (a.op === 'reply') return a.createdId && !a.content ? `${who}への返事をゴミ箱に入れる` : `${who}に返事を書く: 「${plainText(a.content).slice(0, 300)}」`;
  return `${who}を${STATUS_LABEL[a.before] ?? a.before}から${STATUS_LABEL[a.to] ?? a.to}にする${a.to === 'trash' ? '（WordPress のゴミ箱から戻せます）' : ''}`;
}

/** 承認された直しを入れる。直し案の後に状態が変わっていれば上書きしない。 */
export async function applyCommentAction(wp: WordPressAuth, a: StoredCommentAction): Promise<StoredCommentAction> {
  if (a.op === 'comment') {
    const now = await readSiteComment(wp, a.id);
    if ('error' in now) return { ...a, result: 'failed', reason: now.error };
    if (now.status !== a.before) return { ...a, result: 'conflict', reason: '直し案を作った後に、WordPress でコメントの状態が変えられていました' };
    const err = await setSiteCommentStatus(wp, a.id, a.to);
    return err ? { ...a, result: 'failed', reason: err } : { ...a, result: 'applied', reason: '' };
  }
  // 元に戻すときの「書いた返事をゴミ箱に入れる」（content が空で createdId がある）
  if (a.createdId && !a.content) {
    const err = await setSiteCommentStatus(wp, a.createdId, 'trash');
    return err ? { ...a, result: 'failed', reason: err } : { ...a, result: 'applied', reason: '' };
  }
  const r = await replySiteComment(wp, { postId: a.postId, parent: a.id, content: a.content });
  return 'error' in r ? { ...a, result: 'failed', reason: r.error } : { ...a, createdId: r.id, link: r.link || a.link, result: 'applied', reason: '' };
}

/**
 * 入れたコメントの直しを元に戻す直しにする。状態は前の状態に、書いた返事はゴミ箱に入れる。入れた後に変えられていれば戻さない。
 */
export async function revertCommentAction(wp: WordPressAuth, a: StoredCommentAction): Promise<StoredCommentAction | { blocked: string }> {
  if (a.op === 'comment') {
    const now = await readSiteComment(wp, a.id);
    if ('error' in now) return { blocked: `${a.author || '名前なし'}さんのコメント（${now.error}）` };
    if (now.status !== a.to) return { blocked: `${a.author || '名前なし'}さんのコメント（入れた後に WordPress で状態が変えられています）` };
    return { ...a, before: now.status, to: (a.before === 'approved' || a.before === 'hold' || a.before === 'spam' || a.before === 'trash' ? a.before : 'hold') as SiteCommentStatus, result: 'pending', reason: '' };
  }
  if (!a.createdId) return { blocked: `${a.author || '名前なし'}さんへの返事（書いた返事が分かりません）` };
  return { ...a, content: '', result: 'pending', reason: '' };
}

/** 90 日を過ぎた直しの、文を消す（記録だけを残す）。 */
export function purgedComment(a: StoredCommentAction): StoredCommentAction {
  return a.op === 'reply' ? { ...a, author: '', excerpt: '', content: a.createdId ? '' : a.content, title: '' } : { ...a, author: '', excerpt: '', title: '' };
}
