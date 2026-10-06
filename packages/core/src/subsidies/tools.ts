/**
 * @file 補助金・助成金の案内のツール（仕様書 第39.8節）。候補を引く・調べる・気になる／見送り、朝のブリーフに載せる締め切りの近い制度（第39.18節）。
 * 秘書と付属の業務と朝のブリーフが使う。
 *
 * 会社が切っているときと、利用範囲の外の人には「使えない」と返す（呼ぶたびに `ctx.subsidies.access()` で確かめる）。
 * 調べた結果は外のデータとして扱い（`untrusted`）、申請の書類は作らない（第39.6節）。
 */

import { SUBSIDY_FIT_LABELS, SUBSIDY_KIND_LABELS, SUBSIDY_STATUS_LABELS, type Subsidy, type SubsidySettings, type SubsidyStatus } from '@m2office/shared';
import type { Tool, ToolContext } from '../tools/registry.js';
import type { SubsidyService } from './service.js';

/** ツールに渡す補助金・助成金の案内の文脈。 */
export interface SubsidyToolContext {
  service: SubsidyService;
  /**
   * 依頼者がいま補助金・助成金の案内を使えるか。使えるなら会社の設定を返す。
   *
   * @returns 使えなければ `null`
   */
  access(): Promise<SubsidySettings | null>;
}

const UNAVAILABLE = { available: false, reason: '補助金・助成金の案内は使えません（会社で切っているか、利用範囲の外です）' };
const NOTE = '公募の中身は変わることがあります。申請の前に出典で確かめてください。申請書は作りません（相談先は contacts の地域の窓口と、認定支援機関・社会保険労務士・行政書士）';
const str = (v: unknown) => (typeof v === 'string' ? v.trim() : '');
const who = (ctx: ToolContext) => ({ tenantId: ctx.tenantId, userId: ctx.userId });

async function serviceOf(ctx: ToolContext): Promise<SubsidyService | null> {
  if (!ctx.subsidies) return null;
  return (await ctx.subsidies.access()) ? ctx.subsidies.service : null;
}

/** 秘書に返す 1 件の形。金額と日付は出典どおり（無ければ「不明」）。 */
function brief(c: Subsidy) {
  return {
    name: c.name, provider: c.provider || '不明', kind: SUBSIDY_KIND_LABELS[c.kind], fit: SUBSIDY_FIT_LABELS[c.fit], status: SUBSIDY_STATUS_LABELS[c.status],
    reason: c.reason, conditions: c.conditions, amount: c.amount || '不明（出典で確かめてください）', rate: c.rate || '不明（出典で確かめてください）',
    deadline: c.deadline ?? '不明（出典で確かめてください）', source: { title: c.sourceTitle, url: c.sourceUrl },
  };
}

/** 名前の言葉で候補を絞る。 */
function matching(list: Subsidy[], q: string): Subsidy[] {
  const words = q.normalize('NFKC').split(/[\s　、]+/).filter(Boolean);
  return words.length ? list.filter((c) => words.every((w) => `${c.name} ${c.provider}`.normalize('NFKC').includes(w))) : list;
}

/**
 * 候補を引く（「使える補助金ある？」「IT 導入補助金の締め切りは？」）。
 *
 * @remarks 危険度 `read`
 */
export const subsidiesFind: Tool = {
  name: 'subsidies.find',
  risk: 'read',
  activityLabel: '補助金・助成金の候補を見ています',
  helpText: '会社に合いそうな補助金・助成金の候補を、締め切りの近い順に引きます',
  description: '補助金・助成金の候補を引く。query は制度の名前の言葉（空なら全部）。締め切りの過ぎたものと見送りは返さない。searchedAt は最後に調べた日時',
  args: { properties: { query: { type: 'string', description: '制度の名前の言葉' } } },
  async invoke(args, ctx) {
    const service = await serviceOf(ctx);
    if (!service) return UNAVAILABLE;
    const settings = await ctx.subsidies!.access();
    const today = service.today();
    const list = matching((await service.list(who(ctx))).filter((c) => c.status !== 'skipped' && (!c.deadline || c.deadline >= today)), str(args['query']));
    return {
      available: true, untrusted: true, path: '/subsidies', searchedAt: settings?.searchedAt ?? null, count: list.length, items: list.slice(0, 10).map(brief), note: NOTE,
      contacts: await service.contactsOf(ctx.tenantId),
    };
  },
};

/**
 * 調べる（候補が無いか古いとき。同じ会社は 1 日 1 回まで。外の公開の情報だけを読む）。
 *
 * @remarks 危険度 `read`。jGrants の公開の API と Web の調べもので公開のページを読むだけ。会社のことは検索の言葉に業種と地域が入る程度
 */
export const subsidiesSearch: Tool = {
  name: 'subsidies.search',
  risk: 'read',
  activityLabel: '補助金・助成金を調べています',
  helpText: '国・自治体の補助金と助成金を調べ、会社に合いそうなものを候補にします',
  description: '補助金・助成金を調べて候補にする。interest は頼みにあった関心（「人の採用」「IT の導入」など。無ければ空）。今日もう調べていれば、今ある候補を返す',
  args: { properties: { interest: { type: 'string', description: '頼みにあった関心' } } },
  async invoke(args, ctx) {
    const service = await serviceOf(ctx);
    if (!service) return UNAVAILABLE;
    const r = await service.search(who(ctx), str(args['interest']));
    if ('error' in r) return { available: false, reason: r.error };
    const today = service.today();
    const list = (await service.list(who(ctx))).filter((c) => c.status !== 'skipped' && (!c.deadline || c.deadline >= today));
    return { available: true, untrusted: true, path: '/subsidies', searchedToday: 'already' in r, added: 'added' in r ? r.added.length : 0, items: list.slice(0, 10).map(brief), note: NOTE };
  },
};

/**
 * 気になる・見送りにする（「さっきの補助金、気になるにして」）。
 *
 * @remarks 危険度 `write-internal`。社内の候補の状態を変えるだけ
 */
export const subsidiesMark: Tool = {
  name: 'subsidies.mark',
  risk: 'write-internal',
  activityLabel: '補助金・助成金の候補の状態を変えています',
  helpText: '補助金・助成金の候補を「気になる」か「見送り」にします',
  description: '候補の状態を変える。query は制度の名前の言葉。status は interested（気になる）・skipped（見送り）・new（戻す）',
  args: {
    properties: {
      query: { type: 'string', description: '制度の名前の言葉' },
      status: { type: 'string', description: 'interested・skipped・new' },
    },
    required: ['query', 'status'],
  },
  async invoke(args, ctx) {
    const service = await serviceOf(ctx);
    if (!service) return UNAVAILABLE;
    const status = str(args['status']) as SubsidyStatus;
    const hits = matching(await service.list(who(ctx)), str(args['query']));
    if (!hits.length) return { available: false, reason: 'その制度は候補にありません' };
    if (hits.length > 1) return { available: false, reason: 'いくつも当たりました。名前をもう少し足してください', candidates: hits.slice(0, 5).map((c) => c.name) };
    const problem = await service.mark(who(ctx), hits[0]!.id, status);
    if (problem) return { available: false, reason: problem };
    return { available: true, name: hits[0]!.name, status: SUBSIDY_STATUS_LABELS[status] };
  },
};

/**
 * 朝のブリーフに載せる、締め切りの近い「気になる」の制度（第39.18節）。7 日のうちのものだけ。
 *
 * @remarks 危険度 `read`
 */
export const subsidiesBrief: Tool = {
  name: 'subsidies.brief',
  risk: 'read',
  activityLabel: '補助金・助成金の締め切りを見ています',
  helpText: '朝のブリーフに載せる、締め切りの近い「気になる」の補助金・助成金を読みます',
  description: '「気になる」にした補助金・助成金のうち、締め切りが今日から 7 日のうちのものを、締め切りの近い順に返す（daysLeft は締め切りまでの日数。0 は今日）',
  args: { properties: {} },
  async invoke(_args, ctx) {
    const service = await serviceOf(ctx);
    if (!service) return UNAVAILABLE;
    const items = (await service.nearDeadlines(who(ctx))).slice(0, 5).map(({ subsidy: c, daysLeft }) => ({
      name: c.name, kind: SUBSIDY_KIND_LABELS[c.kind], deadline: c.deadline, daysLeft, source: c.sourceUrl,
    }));
    return { available: true, untrusted: true, path: '/subsidies', items };
  },
};

/** 補助金・助成金の案内のツール。 */
export const SUBSIDY_TOOLS: Tool[] = [subsidiesFind, subsidiesSearch, subsidiesMark, subsidiesBrief];
