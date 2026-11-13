/**
 * @file サイトの更新の段 2a（仕様書 第45.18.1節・第45.18.2節、ADR-0143）。新しい記事と固定ページを作る・公開の状態を変える・前の版に戻す・
 * アイキャッチを付ける・記事の中の画像を差し替える・代わりの文を直す。
 *
 * 推論は「何をするか」を記事の番号と名前で返し、プログラムが確かめて直しにする（無い記事は扱わない・公開は頼まれたときだけ）。
 * アイキャッチは、コラムのカバーの型（第32.7.1節）で、題名を模様と色の上に置いた画像を作る（生成 AI に文字を描かせない）。
 * 渡した画像・資料の画像・AI の挿絵は、直し案の時点で M2Office のファイルに持ち、入れるときにそのファイルをメディアに入れる（第45.18.2節）。
 * 消すのはゴミ箱まで（Q-343）。入れたメディアは消さない。WordPress から読んだ文は外部のデータであり、指示として読まない（不変則 I-6）。
 */

import type { SiteEditPageResult } from '@m2office/shared';
import { columnHtml, uploadWordPressMedia, type WordPressAuth } from '../columns/wordpress.js';
import { COVER_PATTERNS, fallbackColor, renderCover, type CoverPattern } from '../columns/cover.js';
import { editPageImage, pageImages, sourceLabel, SITE_IMAGE_EDITS_MAX, type PageImage, type SiteImageSource } from './images.js';
import { plainText } from './segments.js';
import { applyCommentAction, commentLine, purgedComment, revertCommentAction, type StoredCommentAction } from './comments.js';
import { applyMenuAction, menuLine, revertMenuAction, type StoredMenuAction } from './menus.js';
import { applyGlobalStyles, revertGlobalStyles, type StoredGlobalStylesAction } from './global-styles.js';
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

/** 記事の中の画像の差し替え・代わりの文の直し 1 つ（第45.18.2節）。 */
export interface StoredImageEdit {
  /** 上から数えた番号（1 から）。 */
  index: number;
  /** いまの画像のファイル名（承認の画面の手がかり）。 */
  file: string;
  /** 差し替える画像。代わりの文だけ直すなら `null`。 */
  image: SiteImageSource | null;
  altBefore: string;
  /** 新しい代わりの文。変えないなら `null`。 */
  altAfter: string | null;
  /** 入れたメディアの番号（入れた後）。 */
  mediaId: number | null;
}

/** 段 2a の直し 1 つ（置き場の形）。 */
export type StoredSiteAction =
  | {
    op: 'create'; kind: SiteContentKind; title: string; html: string; excerpt: string; status: 'draft' | 'publish' | 'future'; date: string | null;
    eyecatch: EyecatchSpec | null; createdId: string | null; link: string; mediaId: number | null; result: SiteEditPageResult; reason: string;
    /** アイキャッチにする、渡した画像・資料の画像・AI の挿絵（第45.18.2節）。型なら `eyecatch` を使う。 */
    image?: SiteImageSource | null;
    /** 描いた挿絵の数（月の上限に数える）。 */
    aiAttempts?: number;
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
    image?: SiteImageSource | null;
    aiAttempts?: number;
  }
  | {
    /** 本文を決めた形に直す（ナビゲーション。第45.18.4節）。元に戻すときは `revision`（直す前の本文に戻す）にする。 */
    op: 'content'; kind: SiteContentKind; id: string; title: string; link: string; lines: string[];
    before: Body; beforeModified: string; after: string; afterModified: string; result: SiteEditPageResult; reason: string;
  }
  | StoredCommentAction
  | StoredMenuAction
  | StoredGlobalStylesAction
  | {
    /** 記事の中の画像を差し替える・代わりの文を直す（1 ページ分。第45.18.2節）。元に戻すときは `revision`（直す前の本文に戻す）にする。 */
    op: 'image'; kind: SiteContentKind; id: string; title: string; link: string; edits: StoredImageEdit[];
    before: Body; beforeModified: string; afterModified: string; result: SiteEditPageResult; reason: string;
    aiAttempts?: number;
  };

/** 推論が返す段 2a の案。 */
export interface ActionPlanInput {
  create: { kind: SiteContentKind; title: string; body: string; excerpt: string; publish: 'draft' | 'publish' | 'future'; date: string | null; eyecatch: boolean; image: string }[];
  status: { kind: SiteContentKind; id: string; to: SiteStatus; date: string | null }[];
  revision: { kind: SiteContentKind; id: string; before: string | null }[];
  featured: { kind: SiteContentKind; id: string; image: string }[];
  /**
   * 記事の中の画像（第45.18.2節）。`which` はどの画像か（「最初」「2」「店の写真」「missing」= 代わりの文の無いものすべて）、
   * `image` は差し替える画像（空なら代わりの文だけ）、`alt` は新しい代わりの文（`null` なら AI が画像を見て書く。差し替えでは新しい画像を見て書く）。
   */
  images: { kind: SiteContentKind; id: string; which: string; image: string; alt: string | null }[];
}

/** 記事の種類の呼び方（カスタム投稿タイプは口の名前を添える）。 */
const kindLabel = (kind: SiteContentKind) => (kind === 'page' ? '固定ページ' : kind === 'post' ? '記事' : `記事（${kind}）`);
const STATUS_LABEL: Record<string, string> = { publish: '公開', draft: '下書き', private: '非公開', future: '予約', pending: 'レビュー待ち', trash: 'ゴミ箱' };
const STATUSES: readonly SiteStatus[] = ['publish', 'draft', 'private', 'future', 'pending', 'trash'];
const kindOf = (v: unknown): SiteContentKind => (v === 'page' ? 'page' : typeof v === 'string' && v !== 'post' && /^[a-z0-9_-]{1,40}$/i.test(v) && v !== 'pages' && v !== 'posts' ? v : 'post');
const idOf = (v: unknown) => (typeof v === 'number' || (typeof v === 'string' && /^\d+$/.test(v)) ? String(v) : '');
const str = (v: unknown, max: number) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
const dateOf = (v: unknown) => (typeof v === 'string' && !Number.isNaN(Date.parse(v)) ? v.trim().slice(0, 25) : null);

/** 推論の答えを、決めた形だけ取り出す。 */
export function readActionPlan(v: Record<string, unknown> | null): ActionPlanInput {
  const arr = (x: unknown) => (Array.isArray(x) ? x as Record<string, unknown>[] : []);
  return {
    create: arr(v?.['create']).map((c) => ({
      kind: kindOf(c['kind']), title: str(c['title'], SITE_ACTION_LIMITS.titleChars), body: str(c['body'], SITE_ACTION_LIMITS.bodyChars), excerpt: str(c['excerpt'], 500),
      publish: (c['publish'] === 'publish' || c['publish'] === 'future' ? c['publish'] : 'draft') as 'draft' | 'publish' | 'future', date: dateOf(c['date']),
      eyecatch: c['eyecatch'] === true || !!str(c['image'], 200), image: str(c['image'], 200),
    })).filter((c) => c.title),
    status: arr(v?.['status']).map((c) => ({ kind: kindOf(c['kind']), id: idOf(c['id']), to: (STATUSES.includes(c['to'] as SiteStatus) ? c['to'] : '') as SiteStatus, date: dateOf(c['date']) }))
      .filter((c) => c.id && c.to),
    revision: arr(v?.['revision']).map((c) => ({ kind: kindOf(c['kind']), id: idOf(c['id']), before: dateOf(c['before']) })).filter((c) => c.id),
    featured: arr(v?.['featured']).map((c) => ({ kind: kindOf(c['kind']), id: idOf(c['id']), image: str(c['image'], 200) })).filter((c) => c.id),
    images: arr(v?.['images']).map((c) => ({
      kind: kindOf(c['kind']), id: idOf(c['id']), which: str(c['which'], 200), image: str(c['image'], 200),
      alt: typeof c['alt'] === 'string' && c['alt'].trim() ? c['alt'].trim().replace(/\s+/g, ' ').slice(0, 250) : null,
    })).filter((c) => c.id),
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
  /**
   * 画像の指定（`file:1`・`library:言葉`・`ai`・`template`・空 = 決まった順）を、用意した画像にする（第45.18.2節）。
   * 無ければ型のアイキャッチだけを作る（第45.18.1節）。
   *
   * @param purpose アイキャッチなら題名を重ね、本文の画像なら重ねない
   */
  image?(spec: string, title: string, purpose: 'eyecatch' | 'body'): Promise<{ source: SiteImageSource; aiAttempts: number; note?: string } | { note: string } | { ask: string }>;
  /** どの画像かを推論に選ばせる（番号・位置・ファイル名で決まらないとき）。 */
  pickImage?(which: string, images: PageImage[], title: string): Promise<number[] | { ask: string }>;
  /** 画像を見て代わりの文を 1 文で書く（書けなければ空）。 */
  describe?(target: { source: SiteImageSource } | { url: string }): Promise<string>;
}

/** どの画像かを聞き返す文（番号と手がかりを並べる）。 */
export function imageAsk(title: string, images: PageImage[]): string {
  const list = images.slice(0, 8).map((i) => `${i.index}. ${i.file || '（名前なし）'}${i.alt ? `「${i.alt.slice(0, 30)}」` : ''}${i.heading ? `（見出し「${i.heading.slice(0, 30)}」の下）` : ''}`);
  return `「${title}」には画像が ${images.length} 枚あります。どの画像ですか（${list.join('・')}）`;
}

/** 頼みの「どの画像か」を番号にする。番号・位置・ファイル名で決まらなければ推論に選ばせ、それも無ければ聞き返す。 */
async function whichImages(which: string, images: PageImage[], title: string, ctx: ActionContext): Promise<number[] | { ask: string }> {
  if (images.length === 1) return [images[0]!.index];
  const w = which.normalize('NFKC').trim();
  if (/^(all|すべて|全部)/i.test(w)) return images.map((i) => i.index);
  if (/最初|先頭|一番上|いちばん上/.test(w)) return [images[0]!.index];
  if (/最後|一番下|いちばん下/.test(w)) return [images.at(-1)!.index];
  // 数は 3 桁まで（長い数の並びで遅くならないように）
  const n = /^(\d{1,3})$|(?:^|\D)(\d{1,3}) ?(?:番目|枚目|つ目)/.exec(w);
  const num = n ? Number(n[1] ?? n[2]) : NaN;
  if (images.some((i) => i.index === num)) return [num];
  const byFile = w ? images.filter((i) => i.file && w.includes(i.file.replace(/\.\w+$/, ''))) : [];
  if (byFile.length === 1) return [byFile[0]!.index];
  if (ctx.pickImage && w) return ctx.pickImage(w, images, title);
  return { ask: imageAsk(title, images) };
}

/** アイキャッチの画像を決める。用意できなければ型にする。 */
async function eyecatchOf(spec: string, title: string, i: number, ctx: ActionContext): Promise<{ image: SiteImageSource | null; eyecatch: EyecatchSpec | null; aiAttempts: number; note: string } | { ask: string }> {
  if (!ctx.image) return { image: null, eyecatch: eyecatchFor(title, i), aiAttempts: 0, note: '' };
  const r = await ctx.image(spec, title, 'eyecatch');
  if ('ask' in r) return r;
  if (!('source' in r)) return { image: null, eyecatch: eyecatchFor(title, i), aiAttempts: 0, note: `${r.note}。アイキャッチは型で作ります` };
  if (r.source.from === 'template') return { image: null, eyecatch: { pattern: r.source.pattern, color: r.source.color }, aiAttempts: r.aiAttempts, note: r.note ?? '' };
  return { image: r.source, eyecatch: null, aiAttempts: r.aiAttempts, note: r.note ?? '' };
}

/**
 * 推論の案を、確かめた直しにする（第45.18.1節）。
 *
 * @returns 直しと、扱わなかったものの添え書き
 */
export async function buildActions(plan: ActionPlanInput, request: string, ctx: ActionContext): Promise<{ actions: StoredSiteAction[]; notes: string[]; ask?: string }> {
  const actions: StoredSiteAction[] = [];
  const notes: string[] = [];
  const publishOk = asksToPublish(request);
  for (const [i, c] of plan.create.slice(0, SITE_ACTION_LIMITS.creates).entries()) {
    let status: 'draft' | 'publish' | 'future' = publishOk ? c.publish : 'draft';
    if (!publishOk && c.publish !== 'draft') notes.push(`「${c.title}」は、公開とは言われていないので下書きで作ります`);
    if (status === 'future' && (!c.date || Date.parse(c.date) <= ctx.now.getTime())) {
      notes.push(`「${c.title}」の予約の日時が読めないか過ぎているので、下書きで作ります`);
      status = 'draft';
    }
    let pic: { image: SiteImageSource | null; eyecatch: EyecatchSpec | null; aiAttempts: number } = { image: null, eyecatch: null, aiAttempts: 0 };
    if (c.eyecatch && c.kind !== 'page') {
      const r = await eyecatchOf(c.image, c.title, i, ctx);
      if ('ask' in r) return { actions, notes, ask: r.ask };
      if (r.note) notes.push(`「${c.title}」: ${r.note}`);
      pic = r;
    }
    actions.push({
      op: 'create', kind: c.kind, title: c.title, html: c.body ? columnHtml(c.body) : '', excerpt: c.excerpt, status, date: status === 'future' ? c.date : null,
      eyecatch: pic.eyecatch, image: pic.image, aiAttempts: pic.aiAttempts, createdId: null, link: '', mediaId: null, result: 'pending', reason: '',
    });
  }
  for (const c of plan.status.slice(0, SITE_ACTION_LIMITS.statuses)) {
    const now = await ctx.read(c.kind, c.id);
    if (!now) { notes.push(`公開の状態を変える${kindLabel(c.kind)}が見つかりません`); continue; }
    if (now.status === c.to && c.to !== 'future') continue;
    if (c.to === 'future' && (!c.date || Date.parse(c.date) <= ctx.now.getTime())) { notes.push(`「${now.title}」の予約の日時が読めないか過ぎているので、変えません`); continue; }
    actions.push({ op: 'status', kind: c.kind, id: c.id, title: now.title, link: now.link, before: { status: now.status, date: now.date }, to: c.to, date: c.to === 'future' ? c.date : null, result: 'pending', reason: '' });
  }
  for (const c of plan.revision.slice(0, SITE_ACTION_LIMITS.revisions)) {
    const now = await ctx.read(c.kind, c.id);
    if (!now) { notes.push(`前の版に戻す${kindLabel(c.kind)}が見つかりません`); continue; }
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
    if (!now) { notes.push(`アイキャッチを付ける${kindLabel(c.kind)}が見つかりません`); continue; }
    const pic = await eyecatchOf(c.image, now.title, fi++, ctx);
    if ('ask' in pic) return { actions, notes, ask: pic.ask };
    if (pic.note) notes.push(`「${now.title}」: ${pic.note}`);
    actions.push({
      op: 'featured', kind: c.kind, id: c.id, title: now.title, link: now.link, before: now.featuredMedia, eyecatch: pic.eyecatch, image: pic.image, aiAttempts: pic.aiAttempts,
      set: null, mediaId: null, result: 'pending', reason: '',
    });
  }
  // 記事の中の画像（第45.18.2節）。同じページの頼みは 1 つの直しにまとめる
  const groups = new Map<string, ActionPlanInput['images']>();
  for (const e of plan.images) groups.set(`${e.kind}:${e.id}`, [...(groups.get(`${e.kind}:${e.id}`) ?? []), e]);
  let budget = SITE_IMAGE_EDITS_MAX;
  for (const list of groups.values()) {
    const { kind, id } = list[0]!;
    const now = await ctx.read(kind, id);
    if (!now) { notes.push(`画像を直す${kindLabel(kind)}が見つかりません`); continue; }
    const all = pageImages(now.content);
    const usable = all.filter((x) => !x.inGallery);
    if (!usable.length) { notes.push(`「${now.title}」には、直せる画像がありません${all.length ? '（ギャラリーの中の画像は扱いません）' : ''}`); continue; }
    const edits: StoredImageEdit[] = [];
    let aiAttempts = 0;
    for (const e of list) {
      let targets: number[];
      if (/^(missing|代わりの文の無い|代わりの文がない)/i.test(e.which)) {
        targets = usable.filter((x) => !x.alt.trim()).map((x) => x.index);
        if (!targets.length) { notes.push(`「${now.title}」の画像には、どれも代わりの文があります`); continue; }
      } else {
        const p = await whichImages(e.which, usable, now.title, ctx);
        if ('ask' in p) return { actions, notes, ask: p.ask };
        targets = p;
      }
      for (const index of targets) {
        if (edits.some((x) => x.index === index)) continue;
        if (budget <= 0) { notes.push(`画像は 1 回に ${SITE_IMAGE_EDITS_MAX} 枚までです。残りは、もう一度頼んでください`); break; }
        const img = usable.find((x) => x.index === index);
        if (!img) continue;
        let image: SiteImageSource | null = null;
        if (e.image) {
          if (!ctx.image) { notes.push('差し替える画像を用意できません'); continue; }
          const r = await ctx.image(e.image, now.title, 'body');
          if ('ask' in r) return { actions, notes, ask: r.ask };
          if (!('source' in r)) { notes.push(r.note); continue; }
          if (r.note) notes.push(r.note);
          image = r.source;
          aiAttempts += r.aiAttempts;
        }
        let altAfter = e.alt;
        if (altAfter === null) {
          const d = ctx.describe ? (await ctx.describe(image ? { source: image } : { url: img.src }).catch(() => '')).trim().slice(0, 250) : '';
          if (d) altAfter = d;
          else if (!image) { notes.push(`「${now.title}」の ${index} 番目の画像（${img.file}）は、代わりの文を書けませんでした`); continue; }
          else notes.push(`「${now.title}」の ${index} 番目の新しい画像は、代わりの文を書けなかったので前のままにします`);
        }
        if (!image && altAfter === img.alt) continue;
        edits.push({ index, file: img.file, image, altBefore: img.alt, altAfter, mediaId: null });
        budget -= 1;
      }
    }
    if (!edits.length) continue;
    actions.push({
      op: 'image', kind, id, title: now.title, link: now.link, edits, before: { content: now.content, title: now.title, excerpt: now.excerpt },
      beforeModified: now.modifiedGmt, afterModified: '', result: 'pending', reason: '', aiAttempts,
    });
  }
  return { actions, notes };
}

const when = (d: string | null) => (d ? d.replace('T', ' ').slice(0, 16) : '');
const statusText = (s: string, date: string | null) => (s === 'future' ? `予約（${when(date)}）` : STATUS_LABEL[s] ?? s);

/** 直し 1 つを、人が読む 1 行にする（承認の画面・記録）。 */
export function actionLine(a: StoredSiteAction): string {
  if (a.op === 'comment' || a.op === 'reply') return commentLine(a);
  if (a.op === 'menu' || a.op === 'menuOrder' || a.op === 'setting') return menuLine(a);
  if (a.op === 'content') return `${a.title}: ${a.lines.join('、')}`;
  if (a.op === 'globalStyles') return a.lines.join('。');
  if (a.op === 'create') return `${kindLabel(a.kind)}「${a.title}」を作る（${statusText(a.status, a.date)}）${a.image ? `。アイキャッチに${spaced(sourceLabel(a.image))}を付ける` : a.eyecatch ? '。アイキャッチを作って付ける' : ''}`;
  if (a.op === 'status') return `「${a.title}」を${statusText(a.before.status, a.before.status === 'future' ? a.before.date : null)}から${statusText(a.to, a.date)}にする${a.to === 'trash' ? '（WordPress のゴミ箱から戻せます）' : ''}`;
  if (a.op === 'revision') return a.revisionId ? `「${a.title}」を前の版（${when(a.revisionDate)}）に戻す` : `「${a.title}」を、直す前の本文に戻す`;
  if (a.op === 'image') return `「${a.title}」の画像: ${a.edits.map(imageEditLine).join('、')}`;
  if (a.set !== null) return `「${a.title}」のアイキャッチを前のものに戻す`;
  return a.image ? `「${a.title}」のアイキャッチを${spaced(sourceLabel(a.image))}にする` : `「${a.title}」にアイキャッチを作って付ける`;
}

/** 直しが使う、M2Office のファイルに持った画像のファイル（画面の小さな見本）。 */
export function actionFiles(a: StoredSiteAction): string[] {
  if (a.op === 'globalStyles') return a.previewFileId ? [a.previewFileId] : [];
  const all = a.op === 'create' || a.op === 'featured' ? [a.image] : a.op === 'image' ? a.edits.map((e) => e.image) : [];
  return all.flatMap((x) => (x && x.from !== 'template' ? [x.fileId] : []));
}

/** 出どころの呼び方の前に、英数字で始まるなら空白を置く（「を AI の挿絵」）。 */
const spaced = (label: string) => (/^[A-Za-z0-9]/.test(label) ? ` ${label}` : label);

/** 画像の直し 1 つを文にする。 */
function imageEditLine(e: StoredImageEdit): string {
  const which = `${e.index} 番目${e.file ? `（${e.file}）` : ''}`;
  if (e.image) return `${which}を${spaced(sourceLabel(e.image))}に差し替える${e.altAfter !== null ? `（代わりの文「${e.altAfter}」）` : ''}`;
  return `${which}の代わりの文を「${e.altBefore || 'なし'}」から「${e.altAfter ?? ''}」にする`;
}

/** 承認の画面に添える、作る記事の本文の初め。 */
export function actionPreview(a: StoredSiteAction): string {
  if (a.op === 'create' && a.html) return plainText(a.html).slice(0, 400);
  if (a.op === 'revision') return `前の版の本文: ${plainText(a.target.content).slice(0, 300)}`;
  return '';
}

/** 画像の中身を読む（渡した画像・資料の画像・AI の挿絵として M2Office に持ったファイル）。 */
export type SiteImageBytes = (s: Extract<SiteImageSource, { fileId: string }>) => Promise<{ bytes: Uint8Array; mimeType: string } | null>;

const EXT: Record<string, string> = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif' };

/** 画像をメディアに入れる（型ならここで作る）。 */
async function uploadSource(wp: WordPressAuth, s: SiteImageSource, title: string, alt: string, bytesOf?: SiteImageBytes): Promise<{ id: number; url: string } | { error: string }> {
  let img: { bytes: Uint8Array; mimeType: string; fileName: string };
  if (s.from === 'template') {
    img = { bytes: renderCover({ title, background: { kind: 'template', pattern: s.pattern, color: s.color } }), mimeType: 'image/png', fileName: 'eyecatch.png' };
  } else {
    const b = bytesOf ? await bytesOf(s).catch(() => null) : null;
    if (!b) return { error: `${sourceLabel(s)}が見つかりません（消されたかもしれません）` };
    const ext = EXT[b.mimeType] ?? 'png';
    const base = (s.name || 'image').replace(/\.[A-Za-z0-9]+$/, '').replace(/[^\w.-]/g, '_').slice(0, 60) || 'image';
    img = { bytes: b.bytes, mimeType: b.mimeType, fileName: `${base}.${ext}` };
  }
  const r = await uploadWordPressMedia(wp, { ...img, alt });
  return 'error' in r ? { error: r.error.replace('カバー画像', '画像') } : { id: Number(r.id), url: r.url };
}

/** 作る・付けるアイキャッチの出どころ（型は `eyecatch` から）。 */
const eyecatchSource = (a: { image?: SiteImageSource | null; eyecatch: EyecatchSpec | null }): SiteImageSource | null =>
  a.image ?? (a.eyecatch ? { from: 'template', pattern: a.eyecatch.pattern, color: a.eyecatch.color } : null);

/**
 * 承認された段 2a の直しを、順に WordPress に入れる（作る → 状態 → 前の版 → アイキャッチ）。
 *
 * @returns 結果を書き込んだ直し（並びは元のまま）
 */
export async function applyActions(wp: WordPressAuth, actions: StoredSiteAction[], bytesOf?: SiteImageBytes): Promise<StoredSiteAction[]> {
  const order = (a: StoredSiteAction) => ({ create: 0, status: 1, revision: 2, featured: 3, image: 4, comment: 5, reply: 6, menu: 7, menuOrder: 8, content: 9, setting: 10, globalStyles: 11 })[a.op];
  const indexed = actions.map((a, i) => ({ a, i })).sort((x, y) => order(x.a) - order(y.a) || x.i - y.i);
  const out = new Array<StoredSiteAction>(actions.length);
  for (const { a, i } of indexed) out[i] = await applyAction(wp, a, bytesOf);
  return out;
}

async function applyAction(wp: WordPressAuth, a: StoredSiteAction, bytesOf?: SiteImageBytes): Promise<StoredSiteAction> {
  if (a.op === 'comment' || a.op === 'reply') return applyCommentAction(wp, a);
  if (a.op === 'menu' || a.op === 'menuOrder' || a.op === 'setting') return applyMenuAction(wp, a);
  if (a.op === 'globalStyles') return applyGlobalStyles(wp, a);
  if (a.op === 'create') {
    let mediaId: number | null = null;
    let note = '';
    const src = eyecatchSource(a);
    if (src) {
      const m = await uploadSource(wp, src, a.title, a.title, bytesOf);
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
  if (a.op === 'content') {
    if (now.modifiedGmt !== a.beforeModified || now.content !== a.before.content) return { ...a, result: 'conflict', reason: '直し案を作った後に、WordPress で変えられていました' };
    const r = await updateSiteContent(wp, a.kind, a.id, { content: a.after });
    return 'error' in r ? { ...a, result: 'failed', reason: r.error } : { ...a, afterModified: r.modifiedGmt, result: 'applied', reason: '' };
  }
  if (a.op === 'image') {
    if (now.modifiedGmt !== a.beforeModified || now.content !== a.before.content) return { ...a, result: 'conflict', reason: '直し案を作った後に、WordPress でこのページが直されていました' };
    let html = now.content;
    const done: StoredImageEdit[] = [];
    for (const e of a.edits) {
      let media: { id: number; url: string } | undefined;
      if (e.image) {
        const m = await uploadSource(wp, e.image, a.title, e.altAfter ?? e.altBefore, bytesOf);
        if ('error' in m) return { ...a, edits: [...done, ...a.edits.slice(done.length)], result: 'failed', reason: m.error };
        if (!m.url) return { ...a, result: 'failed', reason: 'WordPress の応答に画像の URL がありません' };
        media = m;
      }
      const r = editPageImage(html, e.index, { ...(media ? { media } : {}), ...(e.altAfter !== null ? { alt: e.altAfter } : {}) });
      if ('error' in r) return { ...a, result: 'failed', reason: r.error };
      html = r.html;
      done.push({ ...e, mediaId: media?.id ?? null });
    }
    const r = await updateSiteContent(wp, a.kind, a.id, { content: html });
    return 'error' in r ? { ...a, edits: done, result: 'failed', reason: r.error } : { ...a, edits: done, afterModified: r.modifiedGmt, result: 'applied', reason: '' };
  }
  if (now.featuredMedia !== a.before) return { ...a, result: 'conflict', reason: '直し案を作った後に、WordPress でアイキャッチが変えられていました' };
  let mediaId = a.set;
  if (mediaId === null) {
    const src = eyecatchSource(a);
    if (!src) return { ...a, result: 'failed', reason: 'アイキャッチの作り方がありません' };
    const m = await uploadSource(wp, src, a.title, a.title, bytesOf);
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
    if (a.op === 'comment' || a.op === 'reply' || a.op === 'menu' || a.op === 'menuOrder' || a.op === 'setting' || a.op === 'globalStyles') {
      const r = a.op === 'comment' || a.op === 'reply' ? await revertCommentAction(wp, a) : a.op === 'globalStyles' ? await revertGlobalStyles(wp, a) : await revertMenuAction(wp, a);
      if ('blocked' in r) blocked.push(r.blocked); else out.push(r);
      continue;
    }
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
    } else if (a.op === 'image' || a.op === 'content') {
      // 画像の直しとナビゲーションは、直す前の本文に戻す（題名と抜粋は変えていないので、いまのまま）
      if (now.modifiedGmt !== a.afterModified) { blocked.push(`「${a.title}」（入れた後に WordPress で直されています）`); continue; }
      out.push({
        op: 'revision', kind: a.kind, id: a.id, title: now.title, link: now.link, revisionId: '', revisionDate: '',
        before: { content: now.content, title: now.title, excerpt: now.excerpt }, beforeModified: now.modifiedGmt,
        target: { content: a.before.content, title: now.title, excerpt: now.excerpt }, afterModified: '', result: 'pending', reason: '',
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
  if (a.op === 'image') return { ...a, title: '', before: empty, edits: a.edits.map((e) => ({ ...e, altBefore: '', altAfter: e.altAfter === null ? null : '' })) };
  if (a.op === 'content') return { ...a, title: '', lines: [], before: empty, after: '' };
  if (a.op === 'comment' || a.op === 'reply') return purgedComment(a);
  if (a.op === 'menu' || a.op === 'menuOrder' || a.op === 'setting') return a;
  // 全体のスタイルは、元に戻すのに前の値が要るが、90 日を過ぎたら戻せないので消す
  if (a.op === 'globalStyles') return { ...a, before: { settings: {}, styles: {} }, after: { settings: {}, styles: {} } };
  return { ...a, title: '' };
}
