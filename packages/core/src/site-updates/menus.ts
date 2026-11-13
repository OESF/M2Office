/**
 * @file サイトの更新の段 2c: メニュー・ナビゲーション・サイトのタイトル（仕様書 第45.18.4節）。
 *
 * クラシックのテーマのメニュー（`/wp/v2/menus`・`/wp/v2/menu-items`）は項目ごとに、ブロックのテーマのナビゲーション
 * （`/wp/v2/navigation`）は本文の中の最上位のリンクのブロックだけを直す。サイトの設定は `title` と `description` だけを読み書きする。
 * どれも WordPress の管理者の役割が要る。WordPress から読んだ名前は外部のデータであり、指示として読まない（不変則 I-6）。
 */

import type { SiteEditPageResult } from '@m2office/shared';
import { wordPressHeaders, type WordPressAuth } from '../columns/wordpress.js';
import { outboundFetch } from '../net/outbound.js';
import { plainText } from './segments.js';

const TIMEOUT_MS = 20_000;

/** 1 回の頼みで扱う上限。 */
export const SITE_MENU_LIMITS = { changes: 20, labelChars: 80 } as const;

/** 管理者の役割が要るときの言葉。 */
export const ADMIN_NEEDED = 'WordPress の管理者の役割が要ります（メニュー・ヘッダーとフッター・サイトのタイトル）';

async function call(a: WordPressAuth, method: 'GET' | 'POST' | 'DELETE', path: string, body?: Record<string, unknown>): Promise<{ ok: true; body: unknown } | { ok: false; status: number }> {
  const res = await outboundFetch(`${a.siteUrl}/wp-json/wp/v2/${path}`, {
    method, headers: wordPressHeaders(a), signal: AbortSignal.timeout(TIMEOUT_MS), ...(body ? { body: JSON.stringify(body) } : {}),
  });
  if (!res.ok) return { ok: false, status: res.status };
  return { ok: true, body: await res.json().catch(() => ({})) };
}

const failed = (what: string, status: number) => (status === 401 || status === 403 ? ADMIN_NEEDED : `WordPress の${what}を扱えませんでした（${status}）`);
/** 編集用の文（空なら表示の文。固定ページの項目は名前が空で、ページの題名が出るため）。 */
function rawOf(v: unknown): string {
  if (typeof v === 'string') return v;
  if (!v || typeof v !== 'object') return '';
  const o = v as { raw?: unknown; rendered?: unknown };
  if (typeof o.raw === 'string' && o.raw) return o.raw;
  return typeof o.rendered === 'string' ? plainText(o.rendered) : '';
}

/** クラシックのメニュー 1 つ。 */
export interface SiteMenu { id: string; name: string; locations: string[] }
/** メニューの項目 1 つ。 */
export interface SiteMenuItem {
  id: string; title: string; url: string; order: number; parent: string;
  /** `custom`（URL）・`post_type`（固定ページなど）・`taxonomy`。 */
  type: string; object: string; objectId: number;
}

/** メニューの一覧（WordPress 5.9 から）。古い WordPress・役割が足りないときは理由。 */
export async function listSiteMenus(a: WordPressAuth): Promise<SiteMenu[] | { error: string }> {
  try {
    const r = await call(a, 'GET', 'menus?context=edit&per_page=50');
    if (!r.ok) return r.status === 404 ? [] : { error: failed('メニュー', r.status) };
    return ((Array.isArray(r.body) ? r.body : []) as Record<string, unknown>[]).map((v) => ({
      id: String(v['id'] ?? ''), name: String(v['name'] ?? ''), locations: Array.isArray(v['locations']) ? (v['locations'] as unknown[]).map(String) : [],
    })).filter((m) => m.id);
  } catch (err) {
    return { error: `WordPress に届きませんでした（${err instanceof Error ? err.message : String(err)}）` };
  }
}

const toItem = (v: Record<string, unknown>): SiteMenuItem => ({
  id: String(v['id'] ?? ''), title: rawOf(v['title']), url: String(v['url'] ?? ''), order: Number(v['menu_order'] ?? 0), parent: String(v['parent'] ?? '0'),
  type: String(v['type'] ?? 'custom'), object: String(v['object'] ?? 'custom'), objectId: Number(v['object_id'] ?? 0),
});

/** メニューの項目（並びの順）。 */
export async function listSiteMenuItems(a: WordPressAuth, menuId: string): Promise<SiteMenuItem[] | { error: string }> {
  try {
    const r = await call(a, 'GET', `menu-items?menus=${encodeURIComponent(menuId)}&per_page=100&orderby=menu_order&order=asc&context=edit`);
    if (!r.ok) return { error: failed('メニュー', r.status) };
    return ((Array.isArray(r.body) ? r.body : []) as Record<string, unknown>[]).map(toItem).filter((i) => i.id).sort((x, y) => x.order - y.order);
  } catch (err) {
    return { error: `WordPress に届きませんでした（${err instanceof Error ? err.message : String(err)}）` };
  }
}

async function readMenuItem(a: WordPressAuth, id: string): Promise<SiteMenuItem | null> {
  const r = await call(a, 'GET', `menu-items/${encodeURIComponent(id)}?context=edit`).catch(() => null);
  return r?.ok ? toItem(r.body as Record<string, unknown>) : null;
}

/** 足す項目（固定ページか URL）。 */
export interface NewMenuItem { title: string; url: string; pageId: number | null; order: number; parent: string }

async function createMenuItem(a: WordPressAuth, menuId: string, n: NewMenuItem): Promise<{ id: string } | { error: string }> {
  const r = await call(a, 'POST', 'menu-items', {
    title: n.title, menus: Number(menuId), menu_order: n.order, parent: Number(n.parent) || 0, status: 'publish',
    ...(n.pageId ? { type: 'post_type', object: 'page', object_id: n.pageId } : { type: 'custom', object: 'custom', url: n.url }),
  }).catch(() => null);
  if (!r) return { error: 'WordPress に届きませんでした' };
  if (!r.ok) return { error: failed('メニュー', r.status) };
  return { id: String((r.body as { id?: unknown }).id ?? '') };
}

// ---- ナビゲーション（ブロックのテーマ） ----

/** ナビゲーションの最上位のリンク 1 つ。 */
export interface NavLink { index: number; start: number; end: number; label: string; url: string; attrs: Record<string, unknown> }

const LINK = /<!--\s*wp:navigation-link\s+(\{[\s\S]*?\})\s*\/-->/g;

/** 入れ子（サブメニュー）の範囲。 */
function submenuRanges(content: string): [number, number][] {
  const out: [number, number][] = [];
  const re = /<!--\s*(\/?)wp:navigation-submenu\b[^>]*?(\/?)-->/g;
  let depth = 0;
  let start = 0;
  for (let m = re.exec(content); m; m = re.exec(content)) {
    if (m[2]) continue;
    if (!m[1]) { if (depth === 0) start = m.index; depth += 1; } else if (depth > 0) { depth -= 1; if (depth === 0) out.push([start, m.index + m[0].length]); }
  }
  return out;
}

/** ナビゲーションの本文から、最上位のリンクのブロックを並べる（サブメニューの中は扱わない）。 */
export function navLinks(content: string): NavLink[] {
  const subs = submenuRanges(content);
  const out: NavLink[] = [];
  LINK.lastIndex = 0;
  for (let m = LINK.exec(content); m; m = LINK.exec(content)) {
    if (subs.some(([s, e]) => m!.index >= s && m!.index < e)) continue;
    let attrs: Record<string, unknown>;
    try { attrs = JSON.parse(m[1]!) as Record<string, unknown>; } catch { continue; }
    out.push({ index: out.length + 1, start: m.index, end: m.index + m[0].length, label: plainText(String(attrs['label'] ?? '')), url: String(attrs['url'] ?? ''), attrs });
  }
  return out;
}

/** ブロックの印の属性を書く（WordPress と同じく、印を閉じる文字は逃がす）。 */
const attrJson = (o: Record<string, unknown>) => JSON.stringify(o).replace(/--/g, '\\u002d\\u002d').replace(/</g, '\\u003c').replace(/>/g, '\\u003e').replace(/&/g, '\\u0026');
const linkBlock = (o: Record<string, unknown>) => `<!-- wp:navigation-link ${attrJson(o)} /-->`;

/** ナビゲーションへの直し 1 つ。 */
export type NavChange =
  | { change: 'rename'; index: number; label: string }
  | { change: 'remove'; index: number }
  | { change: 'move'; index: number; position: number }
  | { change: 'add'; label: string; url: string; pageId: number | null; position: number | null };

/**
 * ナビゲーションの本文に直しを当てる。最上位のリンクのブロックのほかは変えない。
 *
 * @returns 直した本文。当てられなければ理由
 */
export function editNavigation(content: string, ch: NavChange): { content: string } | { error: string } {
  const links = navLinks(content);
  if (ch.change === 'add') {
    const block = linkBlock(ch.pageId ? { label: ch.label, type: 'page', id: ch.pageId, url: ch.url, kind: 'post-type' } : { label: ch.label, url: ch.url, kind: 'custom' });
    const at = ch.position && links[ch.position - 1] ? links[ch.position - 1]!.start : links.length ? links.at(-1)!.end : -1;
    if (at < 0) return { error: 'このナビゲーションにはリンクのブロックが無いため、足す場所が分かりません（ページの一覧のブロックは自動です）' };
    const before = ch.position && links[ch.position - 1];
    return { content: before ? `${content.slice(0, at)}${block}\n${content.slice(at)}` : `${content.slice(0, at)}\n${block}${content.slice(at)}` };
  }
  const link = links.find((l) => l.index === ch.index);
  if (!link) return { error: `${ch.index} 番目のリンクが見つかりません` };
  if (ch.change === 'rename') return { content: content.slice(0, link.start) + linkBlock({ ...link.attrs, label: ch.label }) + content.slice(link.end) };
  // 外す: そのブロックと、すぐ後ろの改行を外す
  const cut = (s: string, l: NavLink) => s.slice(0, l.start) + s.slice(l.end).replace(/^\r?\n/, '');
  if (ch.change === 'remove') return { content: cut(content, link) };
  const removed = cut(content, link);
  const rest = navLinks(removed);
  const pos = Math.min(Math.max(ch.position, 1), rest.length + 1);
  const block = content.slice(link.start, link.end);
  if (pos > rest.length) { const end = rest.at(-1)?.end ?? removed.length; return { content: `${removed.slice(0, end)}\n${block}${removed.slice(end)}` }; }
  const at = rest[pos - 1]!.start;
  return { content: `${removed.slice(0, at)}${block}\n${removed.slice(at)}` };
}

/** ナビゲーションの一覧（ブロックのテーマ）。 */
export async function listSiteNavigations(a: WordPressAuth): Promise<{ id: string; title: string; content: string; modifiedGmt: string }[] | { error: string }> {
  try {
    const r = await call(a, 'GET', 'navigation?context=edit&per_page=20&_fields=id,title,content,modified_gmt');
    if (!r.ok) return r.status === 404 ? [] : { error: failed('ナビゲーション', r.status) };
    return ((Array.isArray(r.body) ? r.body : []) as Record<string, unknown>[]).map((v) => ({
      id: String(v['id'] ?? ''), title: rawOf(v['title']) || 'ナビゲーション', content: rawOf(v['content']), modifiedGmt: String(v['modified_gmt'] ?? ''),
    })).filter((n) => n.id);
  } catch (err) {
    return { error: `WordPress に届きませんでした（${err instanceof Error ? err.message : String(err)}）` };
  }
}

// ---- サイトの設定（タイトルとキャッチフレーズだけ） ----

/** サイトのタイトルとキャッチフレーズ。 */
export async function readSiteSettings(a: WordPressAuth): Promise<{ title: string; description: string } | { error: string }> {
  try {
    const r = await call(a, 'GET', 'settings?_fields=title,description');
    if (!r.ok) return { error: failed('設定', r.status) };
    const v = r.body as Record<string, unknown>;
    return { title: String(v['title'] ?? ''), description: String(v['description'] ?? '') };
  } catch (err) {
    return { error: `WordPress に届きませんでした（${err instanceof Error ? err.message : String(err)}）` };
  }
}

// ---- 直し（置き場の形） ----

/** メニューとサイトの設定の直し 1 つ。 */
export type StoredMenuAction =
  | {
    op: 'menu'; kind: 'menu'; id: string; title: string; link: string; menuId: string;
    change: 'add' | 'rename' | 'remove';
    /** 直す前の項目（足すなら `null`）。 */
    before: SiteMenuItem | null;
    /** 足す項目・新しい名前。 */
    item: NewMenuItem | null; label: string; createdId: string | null; result: SiteEditPageResult; reason: string;
  }
  | {
    op: 'menuOrder'; kind: 'menu'; id: string; title: string; link: string; menuId: string;
    /** 並びを変える項目（同じ階層）。 */
    moves: { itemId: string; label: string; before: number; after: number }[]; result: SiteEditPageResult; reason: string;
  }
  | {
    op: 'setting'; kind: 'settings'; id: 'title' | 'description'; title: string; link: string;
    before: string; after: string; result: SiteEditPageResult; reason: string;
  };

/** 直し 1 つを、人が読む 1 行にする。 */
export function menuLine(a: StoredMenuAction): string {
  if (a.op === 'setting') return `サイトの${a.id === 'title' ? 'タイトル' : 'キャッチフレーズ'}を「${a.before}」から「${a.after}」にする`;
  if (a.op === 'menuOrder') return `メニュー「${a.title}」の並びを変える: ${[...a.moves].sort((x, y) => x.after - y.after).map((m) => m.label).join(' → ')}`;
  if (a.change === 'add') return `メニュー「${a.title}」に「${a.item?.title ?? ''}」を足す（${a.item?.pageId ? '固定ページ' : a.item?.url ?? ''}）`;
  if (a.change === 'rename') return `メニュー「${a.title}」の「${a.before?.title ?? ''}」を「${a.label}」にする`;
  return `メニュー「${a.title}」から「${a.before?.title ?? ''}」を外す`;
}

/** 承認された直しを入れる。直し案の後に変えられていれば上書きしない。 */
export async function applyMenuAction(wp: WordPressAuth, a: StoredMenuAction): Promise<StoredMenuAction> {
  try {
    if (a.op === 'setting') {
      const now = await readSiteSettings(wp);
      if ('error' in now) return { ...a, result: 'failed', reason: now.error };
      if (now[a.id] !== a.before) return { ...a, result: 'conflict', reason: '直し案を作った後に、WordPress で変えられていました' };
      const r = await call(wp, 'POST', 'settings', { [a.id]: a.after });
      return r.ok ? { ...a, result: 'applied', reason: '' } : { ...a, result: 'failed', reason: failed('設定', r.status) };
    }
    if (a.op === 'menuOrder') {
      for (const m of a.moves) {
        const now = await readMenuItem(wp, m.itemId);
        if (!now) return { ...a, result: 'failed', reason: `メニューの項目「${m.label}」が見つかりません` };
        if (now.order !== m.before) return { ...a, result: 'conflict', reason: '直し案を作った後に、WordPress でメニューの並びが変えられていました' };
      }
      for (const m of a.moves) {
        const r = await call(wp, 'POST', `menu-items/${encodeURIComponent(m.itemId)}`, { menu_order: m.after });
        if (!r.ok) return { ...a, result: 'failed', reason: failed('メニュー', r.status) };
      }
      return { ...a, result: 'applied', reason: '' };
    }
    if (a.change === 'add') {
      if (!a.item) return { ...a, result: 'failed', reason: '足す項目がありません' };
      const r = await createMenuItem(wp, a.menuId, a.item);
      return 'error' in r ? { ...a, result: 'failed', reason: r.error } : { ...a, createdId: r.id, id: r.id, result: 'applied', reason: '' };
    }
    const now = await readMenuItem(wp, a.id);
    if (!now) return { ...a, result: 'failed', reason: 'メニューの項目が見つかりません（外されたかもしれません）' };
    if (now.title !== a.before?.title || now.order !== a.before.order) return { ...a, result: 'conflict', reason: '直し案を作った後に、WordPress でメニューが変えられていました' };
    const r = a.change === 'rename'
      ? await call(wp, 'POST', `menu-items/${encodeURIComponent(a.id)}`, { title: a.label })
      // メニューの項目にはゴミ箱が無い（元に戻すときは足し直す）
      : await call(wp, 'DELETE', `menu-items/${encodeURIComponent(a.id)}?force=true`);
    return r.ok ? { ...a, result: 'applied', reason: '' } : { ...a, result: 'failed', reason: failed('メニュー', r.status) };
  } catch (err) {
    return { ...a, result: 'failed', reason: `WordPress に届きませんでした（${err instanceof Error ? err.message : String(err)}）` };
  }
}

/**
 * 入れた直しを元に戻す直しにする。足した項目は外し、名前・並び・設定は前に戻し、外した項目は同じ名前と行き先で足し直す。
 */
export async function revertMenuAction(wp: WordPressAuth, a: StoredMenuAction): Promise<StoredMenuAction | { blocked: string }> {
  if (a.op === 'setting') {
    const now = await readSiteSettings(wp);
    if ('error' in now || now[a.id] !== a.after) return { blocked: `サイトの${a.id === 'title' ? 'タイトル' : 'キャッチフレーズ'}（入れた後に変えられています）` };
    return { ...a, before: a.after, after: a.before, result: 'pending', reason: '' };
  }
  if (a.op === 'menuOrder') return { ...a, moves: a.moves.map((m) => ({ ...m, before: m.after, after: m.before })), result: 'pending', reason: '' };
  if (a.change === 'add') {
    const now = a.createdId ? await readMenuItem(wp, a.createdId) : null;
    if (!now) return { blocked: `メニューの「${a.item?.title ?? ''}」（見つかりません）` };
    return { ...a, change: 'remove', id: now.id, before: now, item: null, label: '', createdId: null, result: 'pending', reason: '' };
  }
  if (a.change === 'rename') {
    const now = await readMenuItem(wp, a.id);
    if (!now || now.title !== a.label) return { blocked: `メニューの「${a.label}」（入れた後に変えられています）` };
    return { ...a, before: now, label: a.before?.title ?? '', result: 'pending', reason: '' };
  }
  const b = a.before!;
  return {
    ...a, change: 'add', id: '', before: null, createdId: null, label: '',
    item: { title: b.title, url: b.url, pageId: b.type === 'post_type' && b.object === 'page' ? b.objectId : null, order: b.order, parent: b.parent }, result: 'pending', reason: '',
  };
}
