/**
 * @file 販促物の作成のツール（仕様書 第41.10節）。作る（3 案）・直す・作り直す・探す。秘書と付属の業務が使う。
 *
 * 会社が切っているときと、利用範囲の外の人には「使えない」と返す（呼ぶたびに `ctx.printDesigns.access()` で確かめる）。
 * どれも社外には何も出さない（店頭サイネージ・Web への掲載は、それぞれの業務の決まりで行う）。
 */

import { PRINT_KIND_LABELS, PRINT_SIZES, PRINT_STATE_LABELS, printDesignPath, type PrintDesign, type PrintDesignSettings, type PrintState } from '@m2office/shared';
import type { Tool, ToolContext } from '../tools/registry.js';
import type { PrintDesignDetail, PrintDesignService } from './service.js';

/** ツールに渡す販促物の作成の文脈。 */
export interface PrintDesignToolContext {
  service: PrintDesignService;
  /**
   * 依頼者がいま販促物の作成を使えるか。使えるなら会社の設定を返す。
   *
   * @returns 使えなければ `null`
   */
  access(): Promise<PrintDesignSettings | null>;
}

const UNAVAILABLE = { available: false, reason: '販促物の作成は使えません（会社で切っているか、利用範囲の外です）' };
const str = (v: unknown) => (typeof v === 'string' ? v.trim() : '');
const who = (ctx: ToolContext) => ({ tenantId: ctx.tenantId, userId: ctx.userId });

async function serviceOf(ctx: ToolContext): Promise<PrintDesignService | null> {
  if (!ctx.printDesigns) return null;
  return (await ctx.printDesigns.access()) ? ctx.printDesigns.service : null;
}

/** 秘書に返す 1 つの物の形。 */
function brief(r: PrintDesignDetail) {
  const current = r.versions.find((v) => v.id === r.design.currentVersionId);
  return {
    path: printDesignPath(r.design.id), title: r.design.title, kind: PRINT_KIND_LABELS[r.design.kind], size: PRINT_SIZES[r.design.size].label,
    state: PRINT_STATE_LABELS[r.state], proposals: current ? 0 : r.versions.filter((v) => v.proposal).length,
    checks: (current ?? r.versions[0])?.checks.map((c) => c.message) ?? [],
  };
}

/** 題名の言葉で物を選ぶ。空なら本人がいちばん新しく直した物。 */
async function pick(service: PrintDesignService, ctx: ToolContext, q: string): Promise<(PrintDesign & { state: PrintState }) | { candidates: string[] } | null> {
  const list = await service.list(who(ctx));
  if (!q) return list.find((d) => d.createdBy === ctx.userId) ?? list[0] ?? null;
  const words = q.normalize('NFKC').split(/[\s　、]+/).filter(Boolean);
  const hits = list.filter((d) => words.every((w) => `${d.title} ${d.place} ${PRINT_KIND_LABELS[d.kind]}`.normalize('NFKC').includes(w)));
  if (hits.length === 1) return hits[0]!;
  if (hits.length > 1) {
    // 同じ言葉に当たれば、新しく直した物を選ぶ（作り直しの元は、はっきり言われたときだけ）
    return hits[0]!;
  }
  return null;
}

/**
 * 作る（「春の決算セールのチラシを A4 で。3/1〜15、全品 10% オフ」）。文面と 3 案を作る。
 *
 * @remarks 危険度 `write-internal`。社内に物を作るだけ。生成 AI の画像は会社の外部の AI の方針に従う
 */
export const printCreate: Tool = {
  name: 'print.create',
  risk: 'write-internal',
  activityLabel: '販促物の案を作っています',
  helpText: 'ポップ・チラシ・パンフレット・案内・ポスター・ショップカードの案を 3 つ作ります',
  description: '販促物を作る。request は頼みの文のまま（用件・期間・値段など）。kind は pop・flyer・brochure・notice・poster・card（言われたときだけ）。size は A6・A5・A4・A3・A2・B5・B2・postcard・card・A4-3fold・A4-2fold（言われたときだけ）。photoFileId は渡された写真のファイルの ID（あれば）',
  args: {
    properties: {
      request: { type: 'string', description: '頼みの文' },
      kind: { type: 'string', description: '種類' },
      size: { type: 'string', description: '大きさ' },
      photoFileId: { type: 'string', description: '写真のファイルの ID' },
    },
    required: ['request'],
  },
  async invoke(args, ctx) {
    const service = await serviceOf(ctx);
    if (!service) return UNAVAILABLE;
    const r = await service.create(who(ctx), { request: args['request'], kind: args['kind'], size: args['size'], photoFileId: args['photoFileId'] });
    if ('error' in r) return { available: false, reason: r.error };
    return { available: true, created: brief(r), note: '3 案を作りました。画面で 1 つを選んでから、直したいことを頼めます。言われていない値段・期間は書いていません' };
  },
};

/**
 * 直す（「見出しをもっと大きく」「落ち着いた色に」「画像を描き直して」）。新しい版にする。
 *
 * @remarks 危険度 `write-internal`
 */
export const printRevise: Tool = {
  name: 'print.revise',
  risk: 'write-internal',
  activityLabel: '販促物を直しています',
  helpText: '作った販促物を、頼みのとおりに直します（新しい版にします）',
  description: '販促物を直す。query は物の題名の言葉（空なら本人がいちばん新しく直した物）。instruction は直したいことの文のまま。photoFileId は差し替える写真のファイルの ID（あれば）',
  args: {
    properties: {
      query: { type: 'string', description: '物の題名の言葉' },
      instruction: { type: 'string', description: '直したいこと' },
      photoFileId: { type: 'string', description: '写真のファイルの ID' },
    },
    required: ['instruction'],
  },
  async invoke(args, ctx) {
    const service = await serviceOf(ctx);
    if (!service) return UNAVAILABLE;
    const d = await pick(service, ctx, str(args['query']));
    if (!d || 'candidates' in d) return { available: false, reason: 'その販促物は見つかりません' };
    const r = await service.revise(who(ctx), d.id, args['instruction'], args['photoFileId']);
    if ('error' in r) return { available: false, reason: r.error };
    return { available: true, revised: brief(r) };
  },
};

/**
 * 作り直す（「去年の夏祭りのチラシを今年の日付で」）。前の物を元に新しい物を作る。
 *
 * @remarks 危険度 `write-internal`
 */
export const printRemake: Tool = {
  name: 'print.remake',
  risk: 'write-internal',
  activityLabel: '販促物を作り直しています',
  helpText: '前に作った販促物を元に、日付などを直した新しい物を作ります',
  description: '前の販促物から作り直す。query は前の物の題名の言葉。instruction は直したいことの文のまま（「今年の日付で」など）',
  args: {
    properties: {
      query: { type: 'string', description: '前の物の題名の言葉' },
      instruction: { type: 'string', description: '直したいこと' },
    },
    required: ['query'],
  },
  async invoke(args, ctx) {
    const service = await serviceOf(ctx);
    if (!service) return UNAVAILABLE;
    const d = await pick(service, ctx, str(args['query']));
    if (!d || 'candidates' in d) return { available: false, reason: 'その販促物は見つかりません' };
    const r = await service.remake(who(ctx), d.id, args['instruction']);
    if ('error' in r) return { available: false, reason: r.error };
    return { available: true, remade: brief(r), from: d.title };
  },
};

/**
 * 探す（「いま貼っているポスターは？」「入口のポスターは？」）。
 *
 * @remarks 危険度 `read`
 */
export const printFind: Tool = {
  name: 'print.find',
  risk: 'read',
  activityLabel: '販促物を探しています',
  helpText: '作った販促物を、掲示の状態や置き場所で探します',
  description: '販促物を探す。query は題名・置き場所・種類の言葉（空なら全部）。state は posted（掲示中）・upcoming（これから）・ended（期間が終わった）・draft（下書き）',
  args: {
    properties: {
      query: { type: 'string', description: '題名・置き場所・種類の言葉' },
      state: { type: 'string', description: 'posted・upcoming・ended・draft' },
    },
  },
  async invoke(args, ctx) {
    const service = await serviceOf(ctx);
    if (!service) return UNAVAILABLE;
    const words = str(args['query']).normalize('NFKC').split(/[\s　、]+/).filter(Boolean);
    const state = str(args['state']);
    const list = (await service.list(who(ctx)))
      .filter((d) => !state || d.state === state)
      .filter((d) => words.every((w) => `${d.title} ${d.place} ${PRINT_KIND_LABELS[d.kind]}`.normalize('NFKC').includes(w)));
    return {
      available: true, path: '/print-designs', count: list.length,
      items: list.slice(0, 20).map((d) => ({
        path: printDesignPath(d.id), title: d.title, kind: PRINT_KIND_LABELS[d.kind], state: PRINT_STATE_LABELS[d.state], place: d.place || null,
        period: d.postFrom || d.postTo ? `${d.postFrom ?? ''}〜${d.postTo ?? ''}` : null,
      })),
    };
  },
};

/** 販促物の作成のツール。 */
export const PRINT_DESIGN_TOOLS: Tool[] = [printCreate, printRevise, printRemake, printFind];
