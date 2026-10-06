/**
 * @file 契約の管理のツール（仕様書 第38.8節）。台帳を引く・契約書から台帳に入れる・直す（状態・担当・項目）。
 * 秘書と付属の業務が使う。
 *
 * 会社が契約の管理を切っているときと、利用範囲の外の人には「使えない」と返す（呼ぶたびに `ctx.contracts.access()` で確かめる）。
 * 契約の中身を秘書の記憶と会社の知識に入れない（付属の業務に学ばない業務の印。第38.8節）。答えは台帳の項目だけで、契約書の本文を写さない。
 */

import { CONTRACT_KIND_LABELS, CONTRACT_STATUS_LABELS, CONTRACT_UNKNOWN_LABELS, type Contract, type ContractSettings } from '@m2office/shared';
import type { Tool, ToolContext } from '../tools/registry.js';
import type { ContractService } from './service.js';

/** ツールに渡す契約の管理の文脈。 */
export interface ContractToolContext {
  service: ContractService;
  /**
   * 依頼者がいま契約の管理を使えるか。使えるなら会社の設定を返す。
   *
   * @returns 使えなければ `null`
   */
  access(): Promise<ContractSettings | null>;
}

const UNAVAILABLE = { available: false, reason: '契約の管理は使えません（会社で切っているか、利用範囲の外です）' };
const str = (v: unknown) => (typeof v === 'string' ? v.trim() : '');

async function serviceOf(ctx: ToolContext): Promise<ContractService | null> {
  if (!ctx.contracts) return null;
  return (await ctx.contracts.access()) ? ctx.contracts.service : null;
}

const who = (ctx: ToolContext) => ({ tenantId: ctx.tenantId, userId: ctx.userId });

/** 契約の画面の場所。 */
export const contractPath = (id: string) => `/contracts/${encodeURIComponent(id)}`;

/** 秘書に返す 1 件の形（台帳の項目だけ）。 */
function brief(c: Contract) {
  return {
    path: contractPath(c.id), party: c.party || '不明', kind: CONTRACT_KIND_LABELS[c.kind], title: c.title, status: CONTRACT_STATUS_LABELS[c.status],
    start: c.startOn, end: c.endOn, autoRenew: c.autoRenew, noticeDeadline: c.noticeDeadline, owner: c.ownerName,
    unknown: c.unknown.map((u) => CONTRACT_UNKNOWN_LABELS[u]),
  };
}

/** 名前の言葉で 1 件を選ぶ（相手・件名・種類）。いくつも当たれば候補。 */
async function pick(service: ContractService, ctx: ToolContext, q: string): Promise<Contract | { candidates: Contract[] } | null> {
  const words = q.normalize('NFKC').split(/[\s　]+/).filter(Boolean);
  const all = await service.list(who(ctx), { status: 'all' });
  const hit = all.filter((c) => words.every((w) => `${c.party} ${c.title} ${CONTRACT_KIND_LABELS[c.kind]}`.normalize('NFKC').includes(w)));
  if (hit.length === 1) return hit[0]!;
  if (hit.length > 1) return { candidates: hit.slice(0, 5) };
  return null;
}

/**
 * 台帳を引く（「〇〇社と NDA を結んでいる？」「今月期限の契約は？」）。
 *
 * @remarks 危険度 `read`
 */
export const contractsFind: Tool = {
  name: 'contracts.find',
  risk: 'read',
  activityLabel: '契約の台帳を見ています',
  helpText: '契約の台帳から、相手・種類・期限で契約を探します',
  description: '契約の台帳を引く。query は相手・件名・種類の言葉（空なら全件）。dueWithinDays を入れると、解約の申し出の期限か終わりがその日数のうちに来る契約だけを返す',
  args: {
    properties: {
      query: { type: 'string', description: '相手・件名・種類の言葉' },
      dueWithinDays: { type: 'number', description: '期限が何日のうちに来るか' },
      includeEnded: { type: 'boolean', description: '終わった契約も含めるか' },
    },
  },
  async invoke(args, ctx) {
    const service = await serviceOf(ctx);
    if (!service) return UNAVAILABLE;
    const q = str(args['query']);
    let list = await service.list(who(ctx), { status: args['includeEnded'] === true ? 'all' : 'active' });
    if (args['includeEnded'] !== true) list = [...list, ...(await service.list(who(ctx), { status: 'cancel_requested' }))];
    if (q) {
      const words = q.normalize('NFKC').split(/[\s　]+/).filter(Boolean);
      list = list.filter((c) => words.some((w) => `${c.party} ${c.title} ${CONTRACT_KIND_LABELS[c.kind]}`.normalize('NFKC').includes(w)));
    }
    const days = typeof args['dueWithinDays'] === 'number' ? args['dueWithinDays'] : null;
    if (days !== null) {
      const limit = new Date(Date.now() + days * 86_400_000 + 9 * 3_600_000).toISOString().slice(0, 10);
      list = list.filter((c) => { const d = [c.autoRenew ? c.noticeDeadline : null, c.endOn].filter((x): x is string => !!x).sort()[0]; return !!d && d <= limit; });
    }
    return { available: true, path: '/contracts', count: list.length, contracts: list.slice(0, 20).map(brief) };
  },
};

/**
 * 契約書から台帳に入れる（「この契約を台帳に入れて」「さっきチェックした契約、結んだ」）。
 *
 * @remarks 危険度 `write-internal`。社内の台帳に入れ、会社のドライブに契約書を置くだけ（社外に出さない）
 */
export const contractsRegister: Tool = {
  name: 'contracts.register',
  risk: 'write-internal',
  activityLabel: '契約を台帳に入れています',
  helpText: '結んだ契約書から相手・期間・自動更新と解約の申し出の期限を取り出し、契約の台帳に入れます',
  description: '結んだ契約を台帳に入れる。fileId は渡された契約書のファイル。ファイルが無く「さっきチェックした契約」なら fromReview を true にする（本人がいちばん新しく行った契約書チェックの契約書を使う）',
  args: {
    properties: {
      fileId: { type: 'string', description: '契約書のファイルの ID' },
      fromReview: { type: 'boolean', description: 'いちばん新しい契約書チェックの契約書を使うか' },
    },
  },
  async invoke(args, ctx) {
    const service = await serviceOf(ctx);
    if (!service) return UNAVAILABLE;
    const fileId = str(args['fileId']);
    const r = fileId ? await service.importFile(who(ctx), fileId) : args['fromReview'] === true ? await service.importReview(who(ctx), null) : { error: '契約書のファイルを渡してください' };
    if ('error' in r) return { available: false, reason: r.error };
    return { available: true, contract: brief(r.contract), noticeRule: r.contract.noticeRule || null, linkedToPrevious: !!r.linkedTo, fileNote: r.fileNote };
  },
};

/**
 * 台帳を直す（「〇〇社の保守契約は解約する」「担当を田中さんにして」）。
 *
 * @remarks 危険度 `write-internal`。社内の台帳を直すだけ。解約の申し出を相手に送ることはしない
 */
export const contractsUpdate: Tool = {
  name: 'contracts.update',
  risk: 'write-internal',
  activityLabel: '契約の台帳を直しています',
  helpText: '契約の状態（解約を申し出た など）・担当・期間を直します',
  description: '台帳の 1 件を直す。query は相手・件名・種類の言葉。status は active（有効）・cancel_requested（解約を申し出た）・ended（終了）。endOn・startOn は YYYY-MM-DD',
  args: {
    properties: {
      query: { type: 'string', description: '相手・件名・種類の言葉' },
      status: { type: 'string', description: 'active・cancel_requested・ended' },
      startOn: { type: 'string', description: '始め（YYYY-MM-DD）' },
      endOn: { type: 'string', description: '終わり（YYYY-MM-DD）' },
      note: { type: 'string', description: 'メモ' },
    },
    required: ['query'],
  },
  async invoke(args, ctx) {
    const service = await serviceOf(ctx);
    if (!service) return UNAVAILABLE;
    const target = await pick(service, ctx, str(args['query']));
    if (!target) return { available: false, reason: 'その契約が台帳にありません' };
    if ('candidates' in target) return { available: false, reason: 'いくつも当たりました。相手か種類を足してください', candidates: target.candidates.map(brief) };
    const patch: Record<string, unknown> = {};
    for (const k of ['status', 'startOn', 'endOn', 'note']) if (typeof args[k] === 'string' && args[k]) patch[k] = args[k];
    const problem = await service.update(who(ctx), target.id, patch);
    if (problem) return { available: false, reason: problem };
    return { available: true, contract: brief((await service.get(who(ctx), target.id))!) };
  },
};

/** 契約の管理のツール。 */
export const CONTRACT_TOOLS: Tool[] = [contractsFind, contractsRegister, contractsUpdate];
