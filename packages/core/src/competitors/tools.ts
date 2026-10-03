/**
 * @file 競合の分析のツール（仕様書 第36.10節）。見る（一覧・事実・レポート）と、探す・足す・外す・今すぐ見回る。
 * 秘書と付属の業務が使う。
 *
 * 会社が競合の分析を切っているときと、利用範囲の外の人には「使えない」と返す（呼ぶたびに `ctx.competitors.access()` で確かめる）。
 * 読んだ事実は相手のサイトから取り出したものであり、データとして扱う（不変則 I-6。読むツールの結果に `untrusted` を付ける）。
 * 探す・見回るは作業として受け付けるだけで、終わったら画面と知らせに出る。社外へは何も送らない。
 */

import { COMPETITOR_FACT_LABELS, COMPETITOR_ORIGIN_LABELS, type Competitor, type CompetitorSettings } from '@m2office/shared';
import type { Tool, ToolContext } from '../tools/registry.js';
import type { CompetitorService } from './service.js';

/** ツールに渡す競合の分析の文脈。 */
export interface CompetitorToolContext {
  service: CompetitorService;
  /**
   * 依頼者がいま競合の分析を使えるか。使えるなら会社の設定を返す。
   *
   * @returns 使えなければ `null`
   */
  access(): Promise<CompetitorSettings | null>;
}

const UNAVAILABLE = { available: false, reason: '競合の分析は使えません（会社で切っているか、利用範囲の外です）' };
const PATH = '/competitors';

const str = (v: unknown) => (typeof v === 'string' ? v.trim() : '');

async function serviceOf(ctx: ToolContext): Promise<CompetitorService | null> {
  if (!ctx.competitors) return null;
  return (await ctx.competitors.access()) ? ctx.competitors.service : null;
}

const who = (ctx: ToolContext) => ({ tenantId: ctx.tenantId, userId: ctx.userId });

/** 秘書に返す 1 社の形。 */
function brief(c: Competitor) {
  return {
    name: c.name || '（名前を引けませんでした）', url: c.url, foundBy: COMPETITOR_ORIGIN_LABELS[c.origin],
    distance: c.distanceM !== null ? `${(c.distanceM / 1000).toFixed(1)} km` : null, reason: c.reason,
    lastRead: c.lastReadAt, facts: c.factCount, note: c.readNote || null,
    googleRating: c.rating !== null ? `${c.rating}（${c.ratingCount ?? 0} 件）` : null,
    // 地図の情報を見せるときの表記（訳さない。第36.13節）
    source: c.origin === 'map' ? 'Google Maps' : null,
  };
}

/**
 * 自社の像と、覚えている競合を読む（「競合はどこ？」）。
 *
 * @remarks 危険度 `read`
 */
export const competitorsList: Tool = {
  name: 'competitors.list',
  risk: 'read',
  activityLabel: '競合を調べています',
  helpText: '自社の像と商圏、覚えている競合（名前・距離・見つけ方・最後に読んだ日）を読みます',
  description: '競合の分析が覚えている、自社の像（事業・商圏）と競合の一覧を返す。動いている作業（探している・見回っている）があればそれも返す',
  args: { properties: {} },
  async invoke(_args, ctx) {
    const service = await serviceOf(ctx);
    if (!service) return UNAVAILABLE;
    const o = await service.overview(who(ctx));
    return {
      available: true, untrusted: true, path: PATH,
      profile: o.profile ? {
        business: o.profile.business, area: o.profile.area.local ? `半径 ${((o.profile.area.radiusM ?? 0) / 1000).toFixed(1)} km` : '全国（商圏なし）',
        areaReason: o.profile.area.reason, website: o.profile.website || null,
        googleRating: o.selfRating ? `${o.selfRating.rating}（${o.selfRating.count} 件）` : null,
      } : null,
      competitors: o.competitors.map(brief),
      working: o.job ? o.job.message || (o.job.kind === 'discover' ? '競合を探しています' : '見回っています') : null,
      note: o.mapNote || null,
    };
  },
};

/**
 * 1 社（か自社）の取り出した事実を読む（「〇〇店とうちの違いは？」）。
 *
 * @remarks 危険度 `read`
 */
export const competitorsFacts: Tool = {
  name: 'competitors.facts',
  risk: 'read',
  activityLabel: '競合の事実を調べています',
  helpText: '競合と自社の Web サイトから取り出した事実（サービスと値段・キャンペーン・お知らせ・営業時間）を、出典の URL と一緒に読みます',
  description: '競合（q に名前か URL の言葉）と自社の、いちばん新しい回の事実を出典の URL つきで返す。q が無ければ全社。違いを答えるときに使う',
  args: { properties: { q: { type: 'string', description: '競合の名前か URL の言葉（無ければ全社）' } } },
  async invoke(args, ctx) {
    const service = await serviceOf(ctx);
    if (!service) return UNAVAILABLE;
    const list = await service.find(who(ctx), str(args['q']));
    if (str(args['q']) && list.length === 0) return { available: false, reason: `「${str(args['q'])}」という競合は覚えていません`, path: PATH };
    const latest = (facts: { period: string; kind: keyof typeof COMPETITOR_FACT_LABELS; text: string; sourceUrl: string }[]) => {
      const p = facts[0]?.period;
      return facts.filter((f) => f.period === p).slice(0, 30).map((f) => ({ kind: COMPETITOR_FACT_LABELS[f.kind], fact: f.text, source: f.sourceUrl }));
    };
    const self = latest(await service.facts(who(ctx), null));
    const competitors = [];
    for (const c of list.slice(0, 10)) competitors.push({ ...brief(c), facts: latest(await service.facts(who(ctx), c.id)) });
    return { available: true, untrusted: true, path: PATH, self, competitors };
  },
};

/**
 * いちばん新しいレポートを読む（「競合の動きは？」）。
 *
 * @remarks 危険度 `read`
 */
export const competitorsReport: Tool = {
  name: 'competitors.report',
  risk: 'read',
  activityLabel: '競合のレポートを読んでいます',
  helpText: 'いちばん新しい競合のレポート（前の回からの動き・自社との違い・相手の強み・次の一手）を読みます',
  description: 'いちばん新しい競合のレポートを返す。まだ無ければ、その旨を返す',
  args: { properties: {} },
  async invoke(_args, ctx) {
    const service = await serviceOf(ctx);
    if (!service) return UNAVAILABLE;
    const [r] = await service.reports(who(ctx), 1);
    if (!r) return { available: false, reason: 'レポートはまだありません。「競合を探して」か「今すぐ見回って」と頼んでください', path: PATH };
    return { available: true, untrusted: true, path: PATH, period: r.period, createdAt: r.createdAt, changes: r.changes, report: r.text };
  },
};

/**
 * 競合を探す作業を受け付ける（「競合を探して」「半径 2 km で探し直して」「全国で探して」）。
 *
 * @remarks 危険度 `write-internal`。社内の競合の一覧を作り直す。相手のサイトは公開のページだけを読み、社外へは何も送らない
 */
export const competitorsDiscover: Tool = {
  name: 'competitors.discover',
  risk: 'write-internal',
  activityLabel: '競合を探し始めています',
  helpText: '自社の像をまとめ、近くの同業か同じような事業の会社を探して覚え、読んでレポートを作る作業を始めます',
  description: '競合を探す作業を始める（終わるまで数分かかる。終わったら知らせる）。radiusKm は「半径 2 km で」と言われたときの半径、nationwide は「全国で」と言われたとき。どちらも無ければ商圏は AI が決める（前に言われた商圏はそのまま）',
  args: {
    properties: {
      radiusKm: { type: 'number', description: '商圏の半径（キロメートル）' },
      nationwide: { type: 'boolean', description: '全国で探す' },
      auto: { type: 'boolean', description: '商圏を AI に決め直させる' },
    },
  },
  async invoke(args, ctx) {
    const service = await serviceOf(ctx);
    if (!service) return UNAVAILABLE;
    const km = Number(args['radiusKm']);
    const area = args['auto'] === true ? null
      : args['nationwide'] === true ? { local: false, radiusM: null }
        : Number.isFinite(km) && km > 0 ? { local: true, radiusM: Math.round(km * 1000) } : undefined;
    const r = await service.requestDiscover(who(ctx), area);
    return { available: true, path: PATH, started: !r.already, note: r.already ? 'すでに探しています' : '探し始めました。数分かかります。終わったらお知らせに届きます' };
  },
};

/**
 * 競合を入れる（「〇〇店を競合に入れて」）。
 *
 * @remarks 危険度 `write-internal`
 */
export const competitorsAdd: Tool = {
  name: 'competitors.add',
  risk: 'write-internal',
  activityLabel: '競合を入れています',
  helpText: 'URL か店の名前で、競合を入れます。Web サイトのトップを読んで確かめてから入れます',
  description: '競合を入れる。text には URL か店・会社の名前を入れる。入れたら、その会社のサイトを読む作業を始める',
  args: { properties: { text: { type: 'string', description: 'URL か店・会社の名前' } }, required: ['text'] },
  async invoke(args, ctx) {
    const service = await serviceOf(ctx);
    if (!service) return UNAVAILABLE;
    const r = await service.add(who(ctx), str(args['text']));
    if ('error' in r) return { available: false, reason: r.error, path: PATH };
    return { available: true, path: PATH, note: '競合に入れました。サイトを読んでいます' };
  },
};

/**
 * 競合を外す（「〇〇は競合じゃない」）。
 *
 * @remarks 危険度 `write-internal`。外したものは次に自動で探しても入れない
 */
export const competitorsRemove: Tool = {
  name: 'competitors.remove',
  risk: 'write-internal',
  activityLabel: '競合を外しています',
  helpText: '覚えている競合を外します。次に自動で探しても入れません',
  description: '競合を外す。q には外す競合の名前か URL の言葉。1 つに決まらなければ候補を返す',
  args: { properties: { q: { type: 'string', description: '競合の名前か URL の言葉' } }, required: ['q'] },
  async invoke(args, ctx) {
    const service = await serviceOf(ctx);
    if (!service) return UNAVAILABLE;
    const q = str(args['q']);
    if (!q) return { available: false, reason: 'どの競合を外すかを教えてください' };
    const list = await service.find(who(ctx), q);
    if (list.length === 0) return { available: false, reason: `「${q}」という競合は覚えていません`, path: PATH };
    if (list.length > 1) return { available: false, reason: '1 つに決まりません', candidates: list.map(brief), untrusted: true };
    await service.remove(who(ctx), list[0]!.id);
    return { available: true, path: PATH, removed: list[0]!.name || list[0]!.url };
  },
};

/**
 * 今すぐ見回る作業を受け付ける（「今すぐ見回って」）。
 *
 * @remarks 危険度 `write-internal`。相手のサイトは公開のページだけを読み、社外へは何も送らない
 */
export const competitorsCheck: Tool = {
  name: 'competitors.check',
  risk: 'write-internal',
  activityLabel: '見回りを始めています',
  helpText: '自社と競合のサイトを今すぐ読み、レポートを作る作業を始めます',
  description: '自社と覚えている競合のサイトを今すぐ読んでレポートを作る作業を始める（数分かかる。終わったら知らせる）',
  args: { properties: {} },
  async invoke(_args, ctx) {
    const service = await serviceOf(ctx);
    if (!service) return UNAVAILABLE;
    const r = await service.requestCheck(who(ctx));
    return { available: true, path: PATH, started: !r.already, note: r.already ? 'すでに見回っています' : '見回りを始めました。数分かかります。終わったらお知らせに届きます' };
  },
};

/** 競合の分析のツール。 */
export const COMPETITOR_TOOLS: Tool[] = [competitorsList, competitorsFacts, competitorsReport, competitorsDiscover, competitorsAdd, competitorsRemove, competitorsCheck];
