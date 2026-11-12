/**
 * @file サイトの更新の段 2a（仕様書 第45.18.1節、ADR-0143）。新しい記事と固定ページを作る・公開の状態を変える・前の版に戻す・アイキャッチを付ける。
 *
 * 推論は「何をするか」を記事の番号と名前で返し、プログラムが確かめて直しにする（無い記事は扱わない・公開は頼まれたときだけ）。
 * アイキャッチは、コラムのカバーの型（第32.7.1節）で、題名を模様と色の上に置いた画像を作る（生成 AI に文字を描かせない）。
 * 消すのはゴミ箱まで（Q-343）。入れたメディアは消さない。WordPress から読んだ文は外部のデータであり、指示として読まない（不変則 I-6）。
 */

import type { SiteEditPageResult } from '@m2office/shared';
import { columnHtml, uploadWordPressMedia, type WordPressAuth } from '../columns/wordpress.js';
import { COVER_PATTERNS, fallbackColor, renderCover, type CoverPattern } from '../columns/cover.js';
import { plainText } from './segments.js';
import {
  createSiteContent, listSiteRevisions, readSiteStatus, setSiteFeatured, setSiteStatus, updateSiteContent,
  type SiteContentKind, type SiteStatus,
} from './wordpress.js';

/** 1 回の頼みで扱う上限。 */
export const SITE_ACTION_LIMITS = { creates: 5, statuses: 10, revisions: 5, featured: 10, bodyChars: 20_000, titleChars: 200 } as const;

/** アイキャッチの型（模様と色）。 */
export interface EyecatchSpec {
  pattern: CoverPattern;
  color: string;
}

type Body = { content: string; title: string; excerpt: string };

/** 段 2a の直し 1 つ（置き場の形）。 */
export type StoredSiteAction =
  | {
    op: 'create'; kind: SiteContentKind; title: string; html: string; excerpt: string; status: 'draft' | 'publish' | 'future'; date: string | null;
    eyecatch: EyecatchSpec | null; createdId: string | null; link: string; mediaId: number | null; result: SiteEditPageResult; reason: string;
  }
  | {
    op: 'status'; kind: SiteContentKind; id: string; title: string; link: string; before: { status: string; date: string };
    to: SiteStatus; date: string | null; result: SiteEditPageResult; reason: string;
  }
  | {
    op: 'revision'; kind: SiteContentKind; id: string; title: string; link: string;
    /** 戻す版の ID と日時。元に戻すときの「直す前の本文に戻す」は空。 */
    revisionId: string; revisionDate: string;
    before: Body; beforeModified: string; target: Body; afterModified: string; result: SiteEditPageResult; reason: string;
  }
  | {
    op: 'featured'; kind: SiteContentKind; id: string; title: string; link: string; before: number;
    /** 作って付けるアイキャッチ。元に戻すときは `null` で、`set` のメディアに戻す。 */
    eyecatch: EyecatchSpec | null; set: number | null; mediaId: number | null; result: SiteEditPageResult; reason: string;
  };

/** 推論が返す段 2a の案。 */
export interface ActionPlanInput {
  create: { kind: SiteContentKind; title: string; body: string; excerpt: string; publish: 'draft' | 'publish' | 'future'; date: string | null; eyecatch: boolean }[];
  status: { kind: SiteContentKind; id: string; to: SiteStatus; date: string | null }[];
  revision: { kind: SiteContentKind; id: string; before: string | null }[];
  featured: { kind: SiteContentKind; id: string }[];
}

const KIND_LABEL: Record<SiteContentKind, string> = { page: '固定ページ', post: '記事' };
const STATUS_LABEL: Record<string, string> = { publish: '公開', draft: '下書き', private: '非公開', future: '予約', pending: 'レビュー待ち', trash: 'ゴミ箱' };
const STATUSES: readonly SiteStatus[] = ['publish', 'draft', 'private', 'future', 'pending', 'trash'];
const kindOf = (v: unknown): SiteContentKind => (v === 'page' ? 'page' : 'post');
const idOf = (v: unknown) => (typeof v === 'number' || (typeof v === 'string' && /^\d+$/.test(v)) ? String(v) : '');
const str = (v: unknown, max: number) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
const dateOf = (v: unknown) => (typeof v === 'string' && !Number.isNaN(Date.parse(v)) ? v.trim().slice(0, 25) : null);

/** 推論の答えを、決めた形だけ取り出す。 */
export function readActionPlan(v: Record<string, unknown> | null): ActionPlanInput {
  const arr = (x: unknown) => (Array.isArray(x) ? x as Record<string, unknown>[] : []);
  return {
    create: arr(v?.['create']).map((c) => ({
      kind: kindOf(c['kind']), title: str(c['title'], SITE_ACTION_LIMITS.titleChars), body: str(c['body'], SITE_ACTION_LIMITS.bodyChars), excerpt: str(c['excerpt'], 500),
      publish: (c['publish'] === 'publish' || c['publish'] === 'future' ? c['publish'] : 'draft') as 'draft' | 'publish' | 'future', date: dateOf(c['date']), eyecatch: c['eyecatch'] === true,
    })).filter((c) => c.title),
    status: arr(v?.['status']).map((c) => ({ kind: kindOf(c['kind']), id: idOf(c['id']), to: (STATUSES.includes(c['to'] as SiteStatus) ? c['to'] : '') as SiteStatus, date: dateOf(c['date']) }))
      .filter((c) => c.id && c.to),
    revision: arr(v?.['revision']).map((c) => ({ kind: kindOf(c['kind']), id: idOf(c['id']), before: dateOf(c['before']) })).filter((c) => c.id),
    featured: arr(v?.['featured']).map((c) => ({ kind: kindOf(c['kind']), id: idOf(c['id']) })).filter((c) => c.id),
  };
}

/** 頼みが、公開・予約を求めているか（求めていなければ下書きで作る。Q-346）。 */
export function asksToPublish(request: string): boolean {
  return /(公開|載せて|のせて|出して|アップ|予約)/.test(request.normalize('NFKC'));
}

/** アイキャッチの型を決める（題名から色、並びから模様）。 */
export function eyecatchFor(title: string, index = 0): EyecatchSpec {
  return { pattern: COVER_PATTERNS[index % COVER_PATTERNS.length]!, color: fallbackColor(title) };
}

/** 段 2a の直しを作るのに要る、読んだもの。 */
export interface ActionContext {
  /** 前の版・アイキャッチ・状態の確かめのために、1 つずつ読む。 */
  read(kind: SiteContentKind, id: string): Promise<{ title: string; link: string; status: string; date: string; modifiedGmt: string; featuredMedia: number; content: string; excerpt: string } | null>;
  revisions(kind: SiteContentKind, id: string): Promise<{ id: string; date: string; title: string; content: string; excerpt: string }[]>;
  now: Date;
}

/**
 * 推論の案を、確かめた直しにする（第45.18.1節）。
 *
 * @returns 直しと、扱わなかったものの添え書き
 */
export async function buildActions(plan: ActionPlanInput, request: string, ctx: ActionContext): Promise<{ actions: StoredSiteAction[]; notes: string[] }> {
  const actions: StoredSiteAction[] = [];
  const notes: string[] = [];
  const publishOk = asksToPublish(request);
  plan.create.slice(0, SITE_ACTION_LIMITS.creates).forEach((c, i) => {
    let status: 'draft' | 'publish' | 'future' = publishOk ? c.publish : 'draft';
    if (!publishOk && c.publish !== 'draft') notes.push(`「${c.title}」は、公開とは言われていないので下書きで作ります`);
    if (status === 'future' && (!c.date || Date.parse(c.date) <= ctx.now.getTime())) {
      notes.push(`「${c.title}」の予約の日時が読めないか過ぎているので、下書きで作ります`);
      status = 'draft';
    }
    actions.push({
      op: 'create', kind: c.kind, title: c.title, html: c.body ? columnHtml(c.body) : '', excerpt: c.excerpt, status, date: status === 'future' ? c.date : null,
      eyecatch: c.eyecatch && c.kind === 'post' ? eyecatchFor(c.title, i) : null, createdId: null, link: '', mediaId: null, result: 'pending', reason: '',
    });
  });
  for (const c of plan.status.slice(0, SITE_ACTION_LIMITS.statuses)) {
    const now = await ctx.read(c.kind, c.id);
    if (!now) { notes.push(`公開の状態を変える${KIND_LABEL[c.kind]}が見つかりません`); continue; }
    if (now.status === c.to && c.to !== 'future') continue;
    if (c.to === 'future' && (!c.date || Date.parse(c.date) <= ctx.now.getTime())) { notes.push(`「${now.title}」の予約の日時が読めないか過ぎているので、変えません`); continue; }
    actions.push({ op: 'status', kind: c.kind, id: c.id, title: now.title, link: now.link, before: { status: now.status, date: now.date }, to: c.to, date: c.to === 'future' ? c.date : null, result: 'pending', reason: '' });
  }
  for (const c of plan.revision.slice(0, SITE_ACTION_LIMITS.revisions)) {
    const now = await ctx.read(c.kind, c.id);
    if (!now) { notes.push(`前の版に戻す${KIND_LABEL[c.kind]}が見つかりません`); continue; }
    const list = (await ctx.revisions(c.kind, c.id)).filter((r) => r.content !== now.content || r.title !== now.title);
    const pick = c.before ? list.find((r) => Date.parse(r.date) < Date.parse(c.before!)) : list[0];
    if (!pick) { notes.push(`「${now.title}」には戻せる前の版がありません（WordPress が版を残していないか、いまと同じです）`); continue; }
    actions.push({
      op: 'revision', kind: c.kind, id: c.id, title: now.title, link: now.link, revisionId: pick.id, revisionDate: pick.date,
      before: { content: now.content, title: now.title, excerpt: now.excerpt }, beforeModified: now.modifiedGmt,
      target: { content: pick.content, title: pick.title, excerpt: pick.excerpt }, afterModified: '', result: 'pending', reason: '',
    });
  }
  let fi = 0;
  for (const c of plan.featured.slice(0, SITE_ACTION_LIMITS.featured)) {
    const now = await ctx.read(c.kind, c.id);
    if (!now) { notes.push(`アイキャッチを付ける${KIND_LABEL[c.kind]}が見つかりません`); continue; }
    actions.push({ op: 'featured', kind: c.kind, id: c.id, title: now.title, link: now.link, before: now.featuredMedia, eyecatch: eyecatchFor(now.title, fi++), set: null, mediaId: null, result: 'pending', reason: '' });
  }
  return { actions, notes };
}

const when = (d: string | null) => (d ? d.replace('T', ' ').slice(0, 16) : '');
const statusText = (s: string, date: string | null) => (s === 'future' ? `予約（${when(date)}）` : STATUS_LABEL[s] ?? s);

/** 直し 1 つを、人が読む 1 行にする（承認の画面・記録）。 */
export function actionLine(a: StoredSiteAction): string {
  if (a.op === 'create') return `${KIND_LABEL[a.kind]}「${a.title}」を作る（${statusText(a.status, a.date)}）${a.eyecatch ? '。アイキャッチを作って付ける' : ''}`;
  if (a.op === 'status') return `「${a.title}」を${statusText(a.before.status, a.before.status === 'future' ? a.before.date : null)}から${statusText(a.to, a.date)}にする${a.to === 'trash' ? '（WordPress のゴミ箱から戻せます）' : ''}`;
  if (a.op === 'revision') return a.revisionId ? `「${a.title}」を前の版（${when(a.revisionDate)}）に戻す` : `「${a.title}」を、前の版に戻す前の本文に戻す`;
  return a.set !== null ? `「${a.title}」のアイキャッチを前のものに戻す` : `「${a.title}」にアイキャッチを作って付ける`;
}

/** 承認の画面に添える、作る記事の本文の初め。 */
export function actionPreview(a: StoredSiteAction): string {
  if (a.op === 'create' && a.html) return plainText(a.html).slice(0, 400);
  if (a.op === 'revision') return `前の版の本文: ${plainText(a.target.content).slice(0, 300)}`;
  return '';
}

/** アイキャッチの画像を作ってメディアに入れる。 */
async function uploadEyecatch(wp: WordPressAuth, title: string, spec: EyecatchSpec): Promise<{ id: number } | { error: string }> {
  const png = renderCover({ title, background: { kind: 'template', pattern: spec.pattern, color: spec.color } });
  const r = await uploadWordPressMedia(wp, { bytes: png, fileName: 'eyecatch.png', mimeType: 'image/png', alt: title });
  return 'error' in r ? { error: r.error.replace('カバー画像', 'アイキャッチ') } : { id: Number(r.id) };
}

/**
 * 承認された段 2a の直しを、順に WordPress に入れる（作る → 状態 → 前の版 → アイキャッチ）。
 *
 * @returns 結果を書き込んだ直し（並びは元のまま）
 */
export async function applyActions(wp: WordPressAuth, actions: StoredSiteAction[]): Promise<StoredSiteAction[]> {
  const order = (a: StoredSiteAction) => ({ create: 0, status: 1, revision: 2, featured: 3 })[a.op];
  const indexed = actions.map((a, i) => ({ a, i })).sort((x, y) => order(x.a) - order(y.a) || x.i - y.i);
  const out = new Array<StoredSiteAction>(actions.length);
  for (const { a, i } of indexed) out[i] = await applyAction(wp, a);
  return out;
}

async function applyAction(wp: WordPressAuth, a: StoredSiteAction): Promise<StoredSiteAction> {
  if (a.op === 'create') {
    let mediaId: number | null = null;
    let note = '';
    if (a.eyecatch) {
      const m = await uploadEyecatch(wp, a.title, a.eyecatch);
      if ('error' in m) note = `アイキャッチは付けられませんでした（${m.error}）`; else mediaId = m.id;
    }
    const r = await createSiteContent(wp, a.kind, { title: a.title, content: a.html, excerpt: a.excerpt, status: a.status, date: a.date, featuredMedia: mediaId });
    if ('error' in r) return { ...a, mediaId, result: 'failed', reason: r.error };
    return { ...a, createdId: r.id, link: r.link, mediaId, result: 'applied', reason: note };
  }
  const now = await readSiteStatus(wp, a.kind, a.id);
  if ('error' in now) return { ...a, result: 'failed', reason: now.error };
  if (a.op === 'status') {
    if (now.status !== a.before.status) return { ...a, result: 'conflict', reason: '直し案を作った後に、WordPress で公開の状態が変えられていました' };
    const r = await setSiteStatus(wp, a.kind, a.id, a.to, a.date);
    return 'error' in r ? { ...a, result: 'failed', reason: r.error } : { ...a, result: 'applied', reason: '' };
  }
  if (a.op === 'revision') {
    if (now.modifiedGmt !== a.beforeModified || now.content !== a.before.content) return { ...a, result: 'conflict', reason: '直し案を作った後に、WordPress でこのページが直されていました' };
    const r = await updateSiteContent(wp, a.kind, a.id, { content: a.target.content, title: a.target.title, excerpt: a.target.excerpt });
    return 'error' in r ? { ...a, result: 'failed', reason: r.error } : { ...a, afterModified: r.modifiedGmt, result: 'applied', reason: '' };
  }
  if (now.featuredMedia !== a.before) return { ...a, result: 'conflict', reason: '直し案を作った後に、WordPress でアイキャッチが変えられていました' };
  let mediaId = a.set;
  if (mediaId === null) {
    if (!a.eyecatch) return { ...a, result: 'failed', reason: 'アイキャッチの作り方がありません' };
    const m = await uploadEyecatch(wp, a.title, a.eyecatch);
    if ('error' in m) return { ...a, result: 'failed', reason: m.error };
    mediaId = m.id;
  }
  const r = await setSiteFeatured(wp, a.kind, a.id, mediaId);
  return 'error' in r ? { ...a, mediaId, result: 'failed', reason: r.error } : { ...a, mediaId, result: 'applied', reason: '' };
}

/**
 * 入れた段 2a の直しを元に戻す直しにする（第45.18.1節）。作ったものはゴミ箱へ、状態は前の状態へ、前の版は戻す前の本文へ、
 * アイキャッチは前のものへ。入れた後に人が変えていれば戻さない。入れたメディアは消さない（Q-343）。
 */
export async function revertActions(wp: WordPressAuth, actions: StoredSiteAction[]): Promise<{ actions: StoredSiteAction[]; blocked: string[] }> {
  const out: StoredSiteAction[] = [];
  const blocked: string[] = [];
  for (const a of actions.filter((x) => x.result === 'applied')) {
    if (a.op === 'create') {
      if (!a.createdId) continue;
      const now = await readSiteStatus(wp, a.kind, a.createdId);
      if ('error' in now) { blocked.push(`「${a.title}」（${now.error}）`); continue; }
      if (now.status === 'trash') continue;
      out.push({ op: 'status', kind: a.kind, id: a.createdId, title: now.title, link: now.link, before: { status: now.status, date: now.date }, to: 'trash', date: null, result: 'pending', reason: '' });
      continue;
    }
    const now = await readSiteStatus(wp, a.kind, a.id);
    if ('error' in now) { blocked.push(`「${a.title}」（${now.error}）`); continue; }
    if (a.op === 'status') {
      if (now.status !== a.to) { blocked.push(`「${a.title}」（入れた後に WordPress で公開の状態が変えられています）`); continue; }
      const to = (a.before.status === 'trash' ? 'draft' : a.before.status) as SiteStatus;
      out.push({ op: 'status', kind: a.kind, id: a.id, title: now.title, link: now.link, before: { status: now.status, date: now.date }, to, date: to === 'future' ? a.before.date : null, result: 'pending', reason: '' });
    } else if (a.op === 'revision') {
      if (now.modifiedGmt !== a.afterModified) { blocked.push(`「${a.title}」（入れた後に WordPress で直されています）`); continue; }
      out.push({
        op: 'revision', kind: a.kind, id: a.id, title: now.title, link: now.link, revisionId: '', revisionDate: '',
        before: { content: now.content, title: now.title, excerpt: now.excerpt }, beforeModified: now.modifiedGmt, target: a.before, afterModified: '', result: 'pending', reason: '',
      });
    } else {
      if (now.featuredMedia !== a.mediaId) { blocked.push(`「${a.title}」（入れた後に WordPress でアイキャッチが変えられています）`); continue; }
      out.push({ op: 'featured', kind: a.kind, id: a.id, title: now.title, link: now.link, before: now.featuredMedia, eyecatch: null, set: a.before, mediaId: null, result: 'pending', reason: '' });
    }
  }
  return { actions: out, blocked };
}

/** 90 日を過ぎた直しの、本文と題名を消す（記録だけを残す）。 */
export function purgedAction(a: StoredSiteAction): StoredSiteAction {
  const empty = { content: '', title: '', excerpt: '' };
  if (a.op === 'create') return { ...a, title: '', html: '', excerpt: '' };
  if (a.op === 'revision') return { ...a, title: '', before: empty, target: empty };
  return { ...a, title: '' };
}
