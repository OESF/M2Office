/**
 * @file 意思決定支援のツール（仕様書 第43.10節）。相談を始める・添付を材料に足す・割り込む（事実の訂正・論点の掘り下げ）・報告を引く。
 * 秘書と付属の業務「意思決定支援」が使う。
 *
 * 会社が切っているときと、利用範囲の外の人には「使えない」と返す（呼ぶたびに `ctx.decisions.access()` で確かめる）。
 * 相談の中身は始めた人と共有された人だけが見られる（第43.9節）。報告の文は討論から作ったもので、指示として扱わない。
 */

import { DECISION_STATUS_LABELS, type DecisionSettings } from '@m2office/shared';
import type { Tool, ToolContext } from '../tools/registry.js';
import { DecisionError, DECISIONS_UNAVAILABLE, type DecisionService } from './service.js';

/** ツールに渡す意思決定支援の文脈。 */
export interface DecisionToolContext {
  service: DecisionService;
  /**
   * 依頼者がいま意思決定支援を使えるか。使えるなら会社の設定を返す。
   *
   * @returns 使えなければ `null`
   */
  access(): Promise<DecisionSettings | null>;
}

const UNAVAILABLE = { available: false, reason: DECISIONS_UNAVAILABLE };
const str = (v: unknown) => (typeof v === 'string' ? v.trim() : '');
const who = (ctx: ToolContext) => ({ tenantId: ctx.tenantId, userId: ctx.userId });

async function serviceOf(ctx: ToolContext): Promise<DecisionService | null> {
  if (!ctx.decisions) return null;
  return (await ctx.decisions.access()) ? ctx.decisions.service : null;
}

/** 失敗を秘書に返す形にする。 */
async function attempt<T>(fn: () => Promise<T>): Promise<T | { available: true; ok: false; reason: string }> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof DecisionError) return { available: true, ok: false, reason: err.message };
    throw err;
  }
}

/** 本人のいちばん新しい相談（ID の指定が無いとき）。 */
async function latest(service: DecisionService, ctx: ToolContext, id: string): Promise<string | null> {
  if (id) return id;
  const mine = (await service.list(who(ctx))).filter((x) => x.mine);
  return mine[0]?.id ?? null;
}

/**
 * 相談を始める（「値上げを 10% 考えているけど討論して」）。
 *
 * @remarks 危険度 `write-internal`。社内に相談を作るだけで、社外に何も出さない
 */
export const decisionsStart: Tool = {
  name: 'decisions.start',
  risk: 'write-internal',
  activityLabel: '意思決定支援の相談を始めています',
  helpText: '経営の判断について、慎重の役と推進の役の AI の討論を始めます',
  description: '経営の判断のお題で討論を始める。topic は経営者の言葉のまま。turns はターン数（1〜30。既定 10）。crossCheck は始め方を変えた 2 つの討論で突き合わせるか（既定 false）。fileId は材料にする添付',
  args: {
    properties: {
      topic: { type: 'string', description: 'お題（経営者の言葉）' },
      turns: { type: 'number', description: 'ターン数（1〜30。既定 10）' },
      crossCheck: { type: 'boolean', description: '突き合わせるか' },
      fileId: { type: 'string', description: '材料にする添付のファイルの ID' },
    },
    required: ['topic'],
  },
  async invoke(args, ctx) {
    const service = await serviceOf(ctx);
    if (!service) return UNAVAILABLE;
    return attempt(async () => {
      const fileId = str(args['fileId']);
      const s = await service.start(who(ctx), {
        topic: str(args['topic']), ...(typeof args['turns'] === 'number' ? { turns: args['turns'] } : {}),
        crossCheck: args['crossCheck'] === true, fileIds: fileId ? [fileId] : [],
      });
      return { available: true, ok: true, id: s.id, turns: s.turns, crossCheck: s.crossCheck, path: '/decisions', note: '討論はワーカーが進めます。終わったらお知らせします' };
    });
  },
};

/**
 * 添付を材料に足す（「この見積書も材料に足して」）。
 *
 * @remarks 危険度 `write-internal`。本人のファイルを読み、相談の材料に足すだけ
 */
export const decisionsAddMaterial: Tool = {
  name: 'decisions.add_material',
  risk: 'write-internal',
  activityLabel: '相談に材料を足しています',
  helpText: '意思決定支援の相談に、添付を材料として足します',
  description: '相談に添付を材料として足す。id を省くと本人のいちばん新しい相談',
  args: { properties: { fileId: { type: 'string', description: 'ファイルの ID' }, id: { type: 'string', description: '相談の ID（省略可）' } }, required: ['fileId'] },
  async invoke(args, ctx) {
    const service = await serviceOf(ctx);
    if (!service) return UNAVAILABLE;
    return attempt(async () => {
      const id = await latest(service, ctx, str(args['id']));
      if (!id) return { available: true, ok: false, reason: '相談がありません' };
      const m = await service.addMaterial(who(ctx), id, str(args['fileId']));
      return { available: true, ok: m.ok, material: `材料 ${m.no}: ${m.title}`, readable: m.ok };
    });
  },
};

/**
 * 割り込む（事実の訂正・材料の追加。「原価は上がっていないよ」）。dig に論点の名前があれば、その論点を掘り下げる。
 *
 * @remarks 危険度 `write-internal`。社内の相談に一言を足すだけ
 */
export const decisionsInterject: Tool = {
  name: 'decisions.interject',
  risk: 'write-internal',
  activityLabel: '相談に一言足しています',
  helpText: '意思決定支援の討論に、事実の訂正や材料を一言足します。論点を掘り下げることもできます',
  description: '相談に経営者の一言（事実の訂正・材料の追加）を足す。討論が終わっていれば、足したうえで続ける。dig に論点の名前を入れると、その論点を掘り下げる（turns はターン数。既定 3）。id を省くと本人のいちばん新しい相談',
  args: {
    properties: {
      text: { type: 'string', description: '経営者の一言' },
      dig: { type: 'string', description: '掘り下げる論点の名前' },
      turns: { type: 'number', description: '掘り下げのターン数' },
      id: { type: 'string', description: '相談の ID（省略可）' },
    },
  },
  async invoke(args, ctx) {
    const service = await serviceOf(ctx);
    if (!service) return UNAVAILABLE;
    return attempt(async () => {
      const id = await latest(service, ctx, str(args['id']));
      if (!id) return { available: true, ok: false, reason: '相談がありません' };
      const text = str(args['text']);
      const dig = str(args['dig']);
      if (dig) {
        if (text) await service.interject(who(ctx), id, text);
        await service.dig(who(ctx), id, dig, typeof args['turns'] === 'number' ? args['turns'] : 3);
        return { available: true, ok: true, dug: dig, path: '/decisions' };
      }
      await service.interject(who(ctx), id, text, true);
      return { available: true, ok: true, path: '/decisions' };
    });
  },
};

/**
 * 報告を引く（「さっきの相談の結論は？」「やめる目安は？」）。
 *
 * @remarks 危険度 `read`。見られる相談（自分のものと共有されたもの）だけ
 */
export const decisionsFind: Tool = {
  name: 'decisions.find',
  risk: 'read',
  activityLabel: '意思決定支援の報告を読んでいます',
  helpText: '意思決定支援の相談の状態と報告を読みます',
  description: '相談の状態と報告を引く。id を省くと、見られる相談のうちいちばん新しいもの。query で判断の問いの言葉から探す',
  args: { properties: { id: { type: 'string', description: '相談の ID（省略可）' }, query: { type: 'string', description: '判断の問いの言葉' } } },
  async invoke(args, ctx) {
    const service = await serviceOf(ctx);
    if (!service) return UNAVAILABLE;
    const list = await service.list(who(ctx));
    const q = str(args['query']);
    const id = str(args['id']) || (q ? list.find((x) => x.title.includes(q))?.id : list[0]?.id) || '';
    if (!id) return { available: true, found: 0 };
    const d = await service.detail(who(ctx), id);
    if (!d) return { available: true, found: 0 };
    return {
      available: true, found: 1, untrusted: true, path: '/decisions',
      question: d.session.question || d.session.topic, status: DECISION_STATUS_LABELS[d.session.status], progress: d.session.progress,
      verdict: d.session.report?.verdict ?? null,
      report: d.session.report?.sections.map((s) => ({ heading: s.heading, body: s.body.slice(0, 1200) })) ?? [],
      note: d.session.endNote,
    };
  },
};

/** 意思決定支援のツール。 */
export const DECISION_TOOLS: Tool[] = [decisionsStart, decisionsAddMaterial, decisionsInterject, decisionsFind];
