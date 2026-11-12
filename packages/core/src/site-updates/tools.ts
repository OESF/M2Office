/**
 * @file サイトの更新のツール（仕様書 第45.5節〜第45.8節）。直し案を作って承認へ進める・元に戻す直し案を作る・記録を読む・入れる（承認の後）。
 * 秘書と付属の業務が使う。
 *
 * 会社がサイトの更新を切っているときと、利用範囲の外の人には「使えない」と返す（呼ぶたびに `ctx.siteUpdates.access()` で確かめる）。
 * **サイトに入れるのは承認の後だけ**（`site_updates.apply` は危険度 `external-send`。承認の画面に直す前と後を出す）。
 */

import { SITE_EDIT_PAGE_RESULT_LABELS, SITE_EDIT_STATUS_LABELS, type SiteEditView, type SiteUpdatesSettings } from '@m2office/shared';
import type { Tool, ToolContext } from '../tools/registry.js';
import type { SiteUpdateService } from './service.js';

/** ツールに渡すサイトの更新の文脈。 */
export interface SiteUpdateToolContext {
  service: SiteUpdateService;
  /**
   * 依頼者がいまサイトの更新を使えるか。使えるなら会社の設定を返す。
   *
   * @returns 使えなければ `null`
   */
  access(): Promise<SiteUpdatesSettings | null>;
}

const UNAVAILABLE = { available: false, reason: 'サイトの更新は使えません（会社で切っているか、利用範囲の外です）' };
const str = (v: unknown) => (typeof v === 'string' ? v.trim() : '');

async function serviceOf(ctx: ToolContext): Promise<SiteUpdateService | null> {
  if (!ctx.siteUpdates) return null;
  return (await ctx.siteUpdates.access()) ? ctx.siteUpdates.service : null;
}

const who = (ctx: ToolContext) => ({ tenantId: ctx.tenantId, userId: ctx.userId });

/** サイトの更新の画面の場所。 */
export const SITE_UPDATES_PATH = '/site-updates';

/** 秘書に返す 1 件の形。 */
function brief(e: SiteEditView) {
  return {
    editId: e.id, status: SITE_EDIT_STATUS_LABELS[e.status], request: e.request, revertible: e.revertible,
    pages: e.pages.map((p) => ({
      title: p.title, link: p.link, result: SITE_EDIT_PAGE_RESULT_LABELS[p.result], reason: p.reason || null,
      changes: p.changes.map((c) => (c.before && c.after ? `${c.before} → ${c.after}` : c.after ? `足す: ${c.after}` : `消す: ${c.before}`)),
    })),
    terms: e.terms.map((c) => ({ change: c.text, result: SITE_EDIT_PAGE_RESULT_LABELS[c.result], reason: c.reason || null })),
    actions: e.actions.map((a) => ({ change: a.text, link: a.link || null, result: SITE_EDIT_PAGE_RESULT_LABELS[a.result], reason: a.reason || null })),
  };
}

/**
 * 直し案を作り、承認へ進める（第45.5節）。
 *
 * @remarks 危険度 `write-internal`。直し案を作って承認の依頼を出すだけで、サイトには入れない（入れるのは承認の後）。WordPress を読むだけ
 */
export const siteUpdatesPropose: Tool = {
  name: 'site_updates.propose',
  risk: 'write-internal',
  activityLabel: 'サイトの直し案を作っています',
  helpText: '頼みに合わせて、会社の Web サイト（WordPress）の直すページと場所を探し、直す前と後の直し案を作って承認へ進めます。サイトに入れるのは承認の後です',
  description: '会社の Web サイト（WordPress）のいまあるページを直す直し案を作り、承認へ進める。request には依頼者の頼みをそのまま入れる（「トップの営業時間を 10 時からにして」「料金のページに年末年始の休みを足して」）。サイトには入れない',
  args: { properties: { request: { type: 'string', description: '依頼者の頼み（そのまま）' } }, required: ['request'] },
  async invoke(args, ctx) {
    const service = await serviceOf(ctx);
    if (!service) return UNAVAILABLE;
    const r = await service.propose(who(ctx), str(args['request']));
    if ('error' in r) return { available: false, reason: r.error };
    return { available: true, ...brief(r.edit), path: SITE_UPDATES_PATH, note: '直し案を作り、承認へ進めました。承認の画面で直す前と後を確かめて承認すると、サイトに入ります' };
  },
};

/**
 * サイトのカテゴリーとタグの直し案を作り、承認へ進める（第45.17節）。作る・名前を変える・記事に付ける・外す。
 *
 * @remarks 危険度 `write-internal`。直し案を作って承認の依頼を出すだけで、サイトには入れない。分からなければ聞き返す文を返す
 */
export const siteUpdatesTerms: Tool = {
  name: 'site_updates.terms',
  risk: 'write-internal',
  activityLabel: 'サイトのカテゴリーとタグの直し案を作っています',
  helpText: '頼みに合わせて、会社の Web サイト（WordPress）のカテゴリーとタグを作る・名前を変える・記事に付ける・外す直し案を作り、承認へ進めます。サイトに入れるのは承認の後です',
  description: '会社の Web サイト（WordPress）のカテゴリーとタグを作る・名前を変える・記事に付ける・外す直し案を作り、承認へ進める。request には依頼者の頼みをそのまま入れる（「ブログに『イベント』というカテゴリーを作って」「先週の夏祭りの記事を『イベント』に入れて」）。消すことはしない',
  args: { properties: { request: { type: 'string', description: '依頼者の頼み（そのまま）' } }, required: ['request'] },
  async invoke(args, ctx) {
    const service = await serviceOf(ctx);
    if (!service) return UNAVAILABLE;
    const r = await service.proposeTerms(who(ctx), str(args['request']));
    if ('ask' in r) return { available: true, question: r.ask, note: 'どれを指すか分からないので、聞き返してください' };
    if ('error' in r) return { available: false, reason: r.error };
    return { available: true, ...brief(r.edit), notes: r.notes, path: SITE_UPDATES_PATH, note: '直し案を作り、承認へ進めました。承認の画面で確かめて承認すると、サイトに入ります' };
  },
};

/**
 * 新しい記事と固定ページ・公開の状態・前の版・アイキャッチの直し案を作り、承認へ進める（段 2a。第45.18.1節）。
 *
 * @remarks 危険度 `write-internal`。直し案を作って承認の依頼を出すだけで、サイトには入れない。公開するのは頼まれたときだけ。分からなければ聞き返す文を返す
 */
export const siteUpdatesActions: Tool = {
  name: 'site_updates.actions',
  risk: 'write-internal',
  activityLabel: 'サイトの記事と固定ページの直し案を作っています',
  helpText: '頼みに合わせて、会社の Web サイト（WordPress）に新しい記事と固定ページを作る（本文とアイキャッチも作る）・公開や下書きや予約やゴミ箱に変える・前の版に戻す直し案を作り、承認へ進めます。サイトに入れるのは承認の後です',
  description: '会社の Web サイト（WordPress）に新しい記事か固定ページを作る（本文は秘書が書く。アイキャッチも作れる）・公開の状態を変える（公開・下書き・非公開・予約・ゴミ箱）・前の版に戻す・いまある記事にアイキャッチを付ける直し案を作り、承認へ進める。request には依頼者の頼みをそのまま入れる（「年末年始の営業のお知らせの記事を作って公開して」「先週の記事を下書きに戻して」「会社案内のページを昨日の版に戻して」）',
  args: { properties: { request: { type: 'string', description: '依頼者の頼み（そのまま）' } }, required: ['request'] },
  async invoke(args, ctx) {
    const service = await serviceOf(ctx);
    if (!service) return UNAVAILABLE;
    const r = await service.proposeActions(who(ctx), str(args['request']));
    if ('ask' in r) return { available: true, question: r.ask, note: 'どれを指すか分からないので、聞き返してください' };
    if ('error' in r) return { available: false, reason: r.error };
    return { available: true, ...brief(r.edit), notes: r.notes, path: SITE_UPDATES_PATH, note: '直し案を作り、承認へ進めました。承認の画面で確かめて承認すると、サイトに入ります' };
  },
};

/**
 * サイトのカテゴリーとタグの一覧（「サイトのカテゴリーは何がある？」）。
 *
 * @remarks 危険度 `read`
 */
export const siteUpdatesTermList: Tool = {
  name: 'site_updates.term_list',
  risk: 'read',
  activityLabel: 'サイトのカテゴリーとタグを調べています',
  helpText: '会社の Web サイト（WordPress）のカテゴリーとタグの一覧（名前・親・記事の数）を読みます',
  description: '会社の Web サイト（WordPress）のカテゴリー（名前・親・記事の数）とタグ（名前・記事の数）の一覧を返す',
  args: { properties: {} },
  async invoke(_args, ctx) {
    const service = await serviceOf(ctx);
    if (!service) return UNAVAILABLE;
    const r = await service.siteTerms(who(ctx));
    return 'error' in r ? { available: false, reason: r.error } : { available: true, ...r };
  },
};

/**
 * 入れた直しを元に戻す直し案を作り、承認へ進める（第45.8節）。
 *
 * @remarks 危険度 `write-internal`。戻すのもサイトに出すことなので、入れるのは承認の後
 */
export const siteUpdatesRevert: Tool = {
  name: 'site_updates.revert',
  risk: 'write-internal',
  activityLabel: 'サイトの直しを元に戻す案を作っています',
  helpText: '入れたサイトの直しを、直す前の文に戻す案を作って承認へ進めます（90 日の間。戻すのも承認の後です）',
  description: '入れたサイトの直しを元に戻す案を作り、承認へ進める。editId は戻す直しの ID（「さっきの直しを戻して」なら、site_updates.list のいちばん新しい元に戻せるもの）。省くと、いちばん新しい元に戻せる直し',
  args: { properties: { editId: { type: 'string', description: '戻す直しの ID（省くと、いちばん新しい元に戻せる直し）' } } },
  async invoke(args, ctx) {
    const service = await serviceOf(ctx);
    if (!service) return UNAVAILABLE;
    let id = str(args['editId']);
    if (!id) {
      const last = (await service.list(who(ctx), 20)).find((e) => e.revertible && !e.revertOf);
      if (!last) return { available: false, reason: '元に戻せる直しがありません' };
      id = last.id;
    }
    const r = await service.revert(who(ctx), id);
    if ('error' in r) return { available: false, reason: r.error };
    return { available: true, ...brief(r.edit), path: SITE_UPDATES_PATH, note: '元に戻す案を作り、承認へ進めました。承認すると、直す前の文に戻ります' };
  },
};

/**
 * サイトの直しの記録（新しい順に 10 件）。
 *
 * @remarks 危険度 `read`
 */
export const siteUpdatesList: Tool = {
  name: 'site_updates.list',
  risk: 'read',
  activityLabel: 'サイトの直しの記録を調べています',
  helpText: 'サイトの直しの記録（いつ・どのページを・どう直したか・元に戻せるか）を読みます',
  description: 'サイトの直しの記録を新しい順に 10 件返す（状態・ページ・直す前と後・元に戻せるか）',
  args: { properties: {} },
  async invoke(_args, ctx) {
    const service = await serviceOf(ctx);
    if (!service) return UNAVAILABLE;
    return { available: true, items: (await service.list(who(ctx), 10)).map(brief), path: SITE_UPDATES_PATH };
  },
};

/**
 * 承認された直しをサイトに入れ、公開のページで確かめる（付属の業務「サイトに入れる」が承認の後に呼ぶ）。
 *
 * @remarks 危険度 `external-send`。会社の Web サイトに出すことは社外への送信。承認の画面に、ページごとの直す前と後を出す。
 * 入れられなければ例外を投げ、実行を失敗にする（入れたつもりで「済んだ」と伝えないため）
 */
export const siteUpdatesApply: Tool = {
  name: 'site_updates.apply',
  risk: 'external-send',
  activityLabel: 'サイトに入れています',
  helpText: '承認されたサイトの直しを WordPress に入れ、公開のページに出たかを確かめます。公開中のページはすぐに変わります',
  description: '承認されたサイトの直し（editId）を WordPress に入れ、公開のページで確かめる',
  args: { properties: { editId: { type: 'string', description: '直しの ID' } }, required: ['editId'] },
  planKey: (args) => `site-edit:${str(args['editId'])}`,
  async prepare(args, ctx) {
    const service = await serviceOf(ctx);
    if (!service) return { kind: 'problem', reason: UNAVAILABLE.reason };
    const id = str(args['editId']);
    const p = await service.preview(who(ctx), id).catch(() => null);
    if (!p) return { kind: 'problem', reason: '承認を待っている直しが見つかりません' };
    return { kind: 'ready', args: { editId: id, digest: p.digest }, shown: `${p.headline}\n${p.shown}`, audience: 'external' };
  },
  async invoke(args, ctx) {
    const service = await serviceOf(ctx);
    if (!service) return UNAVAILABLE;
    const r = await service.apply(who(ctx), str(args['editId']), str(args['digest']));
    if ('error' in r) throw new Error(r.error);
    // 1 つも入らなかったときも失敗にする（ページごとの理由を添える）
    if (r.edit.status === 'failed') {
      const why = [...r.edit.pages.map((p) => p.reason), ...r.edit.terms.map((c) => c.reason), ...r.edit.actions.map((a) => a.reason)].filter(Boolean);
      throw new Error(`サイトに入れられませんでした${why.length ? `（${why.slice(0, 3).join('／')}）` : ''}`);
    }
    return { available: true, ...brief(r.edit), path: SITE_UPDATES_PATH };
  },
};

/** サイトの更新のツール。 */
export const SITE_UPDATE_TOOLS: Tool[] = [siteUpdatesPropose, siteUpdatesActions, siteUpdatesTerms, siteUpdatesTermList, siteUpdatesRevert, siteUpdatesList, siteUpdatesApply];
