/**
 * @file Web の振り返りのツール（仕様書 第34.10節・第34.18節）。月の便り・数字の問い・状態（始める前の手伝い）・サイトの選び直し。
 * 秘書と付属の業務「Web について聞く」、週次ブリーフが使う。
 *
 * 会社が Web の振り返りを切っているときと、利用範囲の外の人には「使えない」と返す（呼ぶたびに `ctx.webReview.access()` で確かめる）。
 * 数字はプログラムが計算したものを返す。推論はそれを言葉にするだけ（ADR-0067 決定 6）。
 */

import {
  WEB_REVIEW_BREAKDOWNS, WEB_REVIEW_METRICS, WEB_REVIEW_PERIODS,
  type WebReviewBreakdown, type WebReviewMetric, type WebReviewPeriod, type WebReviewSettings,
} from '@m2office/shared';
import type { Tool, ToolContext } from '../tools/registry.js';
import type { WebReviewService } from './service.js';

/** ツールに渡す Web の振り返りの文脈。 */
export interface WebReviewToolContext {
  service: WebReviewService;
  /**
   * 依頼者がいま Web の振り返りを使えるか。使えるなら会社の設定を返す。
   *
   * @returns 使えなければ `null`
   */
  access(): Promise<WebReviewSettings | null>;
}

const UNAVAILABLE = { available: false, reason: 'Web の振り返りは使えません（会社で切っているか、利用範囲の外です）' };
const PATH = '/web-review';
const str = (v: unknown) => (typeof v === 'string' ? v.trim() : '');

async function serviceOf(ctx: ToolContext): Promise<WebReviewService | null> {
  if (!ctx.webReview) return null;
  return (await ctx.webReview.access()) ? ctx.webReview.service : null;
}

const list = (o: Record<string, string>) => Object.entries(o).map(([k, v]) => `${k}（${v}）`).join('・');

/**
 * 月の便り（「先月の Web はどうだった？」）。
 *
 * @remarks 危険度 `read`。便りを作るのはワーカー（毎月 3 日）だけで、ここでは作らない
 */
export const webReviewReport: Tool = {
  name: 'web_review.report',
  risk: 'read',
  activityLabel: 'Web の便りを読んでいます',
  helpText: '会社の Web サイトの月の便り（要約・よかったこと・気になること・次にやること）を読みます',
  description: '会社の Web サイトの月の便りを返す。month（YYYY-MM）を言われなければいちばん新しいもの。recent が true なら、この 8 日に届いた便りの要点だけ（週次ブリーフ用。無ければ返さない）',
  args: {
    properties: {
      month: { type: 'string', description: '月（YYYY-MM）' },
      recent: { type: 'boolean', description: 'この 8 日に届いた便りの要点だけ' },
    },
  },
  async invoke(args, ctx) {
    const service = await serviceOf(ctx);
    if (!service) return UNAVAILABLE;
    if (args['recent'] === true) {
      const r = await service.recentSummary(ctx.tenantId);
      return r ? { available: true, ...r, path: PATH } : { available: false, reason: 'この 8 日に届いた Web の便りはありません' };
    }
    const month = /^\d{4}-\d{2}$/.test(str(args['month'])) ? str(args['month']) : undefined;
    const r = await service.report(ctx.tenantId, month);
    if (!r) {
      const st = await service.status(ctx.tenantId);
      return { available: true, report: null, note: st.state === 'ready' ? 'まだ便りがありません。毎月 3 日の朝に先月の分が届きます' : st.advice, path: PATH };
    }
    return {
      available: true, month: r.month, summary: r.summary, good: r.good, concern: r.concern, next: r.next,
      figures: r.figures, missing: r.figures.missing, path: `${PATH}/${r.month}`,
    };
  },
};

/**
 * 数字の問い（「先月、料金のページは何人見た？」）。決まった指標と切り口の組み合わせだけを呼ぶ。
 *
 * @remarks 危険度 `read`。集計の数字だけを読む（個人の閲覧の履歴は扱わない）
 */
export const webReviewAsk: Tool = {
  name: 'web_review.ask',
  risk: 'read',
  activityLabel: 'Web の数字を調べています',
  helpText: 'アナリティクスと Search Console から、決まった指標と切り口で数字を読みます。期間と比べた相手を添えて答えます',
  description: [
    '会社の Web サイトの数字を読む。質問を次の決まった値に直して呼ぶ（一覧に無い組み合わせは扱わない）。',
    `metric: ${list(WEB_REVIEW_METRICS)}。`,
    `breakdown: ${list(WEB_REVIEW_BREAKDOWNS)}（アナリティクスの指標は none・page・source・device・region、検索の指標は none・searchQuery・searchPage・device）。`,
    `period: ${list(WEB_REVIEW_PERIODS)}。言われなければ lastMonth。custom なら start と end（YYYY-MM-DD）。`,
    'contains は、ページの URL か検索の言葉に含む文字（「料金のページ」なら price や料金。分からなければ breakdown を page にして一覧から探す）。',
  ].join(''),
  args: {
    properties: {
      metric: { type: 'string', enum: Object.keys(WEB_REVIEW_METRICS), description: '指標' },
      breakdown: { type: 'string', enum: Object.keys(WEB_REVIEW_BREAKDOWNS), description: '切り口' },
      period: { type: 'string', enum: Object.keys(WEB_REVIEW_PERIODS), description: '期間' },
      start: { type: 'string', description: '期間の始め（custom のとき。YYYY-MM-DD）' },
      end: { type: 'string', description: '期間の終わり（custom のとき。YYYY-MM-DD）' },
      contains: { type: 'string', description: 'ページの URL か検索の言葉に含む文字' },
    },
    required: ['metric'],
  },
  async invoke(args, ctx) {
    const service = await serviceOf(ctx);
    if (!service) return UNAVAILABLE;
    const r = await service.ask(ctx.tenantId, {
      metric: str(args['metric']) as WebReviewMetric,
      breakdown: (str(args['breakdown']) || 'none') as WebReviewBreakdown,
      period: (str(args['period']) || 'lastMonth') as WebReviewPeriod,
      ...(str(args['start']) ? { start: str(args['start']) } : {}),
      ...(str(args['end']) ? { end: str(args['end']) } : {}),
      ...(str(args['contains']) ? { contains: str(args['contains']) } : {}),
    });
    if ('error' in r) return { available: false, reason: r.error, path: PATH };
    return { available: true, ...r, note: '数字は Google の集計の値です。比べた相手は直前の同じ長さの期間です', path: PATH };
  },
};

/**
 * 状態と始める前の手伝い（「アナリティクスとつなぎたい」）。
 *
 * @remarks 危険度 `read`。依頼文は下書きを返すだけで、送らない
 */
export const webReviewStatus: Tool = {
  name: 'web_review.status',
  risk: 'read',
  activityLabel: 'Web の振り返りの状態を調べています',
  helpText: 'Google とつないだか・選んだプロパティとサイト・次にすることを読みます。制作会社への依頼文の下書きも作ります（送りません）',
  description: 'Web の振り返りの状態（つないだか・選んだアナリティクスのプロパティと Search Console のサイト・次にすること・制作会社に閲覧の権限をもらう依頼文の下書き）を返す',
  args: { properties: {} },
  async invoke(_args, ctx) {
    const service = await serviceOf(ctx);
    if (!service) return UNAVAILABLE;
    return { available: true, ...(await service.status(ctx.tenantId)), settingsPath: '/admin/extensions' };
  },
};

/**
 * プロパティとサイトを選び直す（「サイトは 〇〇 のほう」）。管理者だけ。
 *
 * @remarks 危険度 `write-internal`。会社の設定を変えるだけで、外には何も出さない
 */
export const webReviewSelect: Tool = {
  name: 'web_review.select',
  risk: 'write-internal',
  activityLabel: 'Web の振り返りのサイトを選び直しています',
  helpText: '見るアナリティクスのプロパティと Search Console のサイトを、見られるものの中から選び直します（管理者だけ）',
  description: '見るアナリティクスのプロパティか Search Console のサイトを選び直す（管理者だけ）。property と site には、名前か URL の一部を入れる（見られるものの中から、それを含むものが 1 つに決まれば選ぶ）',
  args: {
    properties: {
      property: { type: 'string', description: 'プロパティの名前か URL の一部' },
      site: { type: 'string', description: 'サイトの URL の一部' },
    },
  },
  async invoke(args, ctx) {
    const service = await serviceOf(ctx);
    if (!service) return UNAVAILABLE;
    if (!(await service.isAdmin(ctx.tenantId, ctx.userId))) return { available: false, reason: '選び直せるのは管理者だけです' };
    const c = await service.candidates(ctx.tenantId);
    if ('error' in c) return { available: false, reason: c.error };
    const want = { p: str(args['property']).toLowerCase(), s: str(args['site']).toLowerCase() };
    const props = want.p ? c.properties.filter((p) => `${p.name} ${p.uris.join(' ')} ${p.id}`.toLowerCase().includes(want.p)) : [];
    const sites = want.s ? c.sites.filter((s) => s.siteUrl.toLowerCase().includes(want.s)) : [];
    if ((want.p && props.length !== 1) || (want.s && sites.length !== 1) || (!want.p && !want.s)) {
      return { available: false, reason: '1 つに決められませんでした。次の中から名前か URL で選んでください', properties: c.properties.map((p) => ({ name: p.name, uris: p.uris })), sites: c.sites.map((s) => s.siteUrl) };
    }
    const err = await service.select({ tenantId: ctx.tenantId, userId: ctx.userId }, {
      ...(want.p ? { propertyId: props[0]!.id } : {}), ...(want.s ? { siteUrl: sites[0]!.siteUrl } : {}),
    });
    if (err) return { available: false, reason: err };
    return { available: true, property: want.p ? props[0]!.name : undefined, site: want.s ? sites[0]!.siteUrl : undefined, path: PATH };
  },
};

/** Web の振り返りのツール。 */
export const WEB_REVIEW_TOOLS: Tool[] = [webReviewReport, webReviewAsk, webReviewStatus, webReviewSelect];
