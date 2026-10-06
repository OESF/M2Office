/**
 * @file 会員とポイントのツール（仕様書 第40.7節）。会員を引く・ポイントを足す／取り消す・特典を作る／直す。秘書と付属の業務が使う。
 *
 * 会社が切っているときと、利用範囲の外の人には「使えない」と返す（呼ぶたびに `ctx.members.access()` で確かめる）。
 * 答えには電話を入れない（推論に渡さない。第40.11節）。
 */

import type { Member, MemberSettings } from '@m2office/shared';
import type { Tool, ToolContext } from '../tools/registry.js';
import type { MemberService } from './service.js';

/** ツールに渡す会員とポイントの文脈。 */
export interface MemberToolContext {
  service: MemberService;
  /**
   * 依頼者がいま会員とポイントを使えるか。使えるなら会社の設定を返す。
   *
   * @returns 使えなければ `null`
   */
  access(): Promise<MemberSettings | null>;
}

const UNAVAILABLE = { available: false, reason: '会員とポイントは使えません（会社で切っているか、利用範囲の外です）' };
const str = (v: unknown) => (typeof v === 'string' ? v.trim() : '');
const who = (ctx: ToolContext) => ({ tenantId: ctx.tenantId, userId: ctx.userId });
const PATH = '/members';

async function serviceOf(ctx: ToolContext): Promise<MemberService | null> {
  if (!ctx.members) return null;
  return (await ctx.members.access()) ? ctx.members.service : null;
}

/** 秘書に返す 1 人の形（電話は入れない）。 */
const brief = (m: Member) => ({
  path: `${PATH}/${encodeURIComponent(m.id)}`, number: m.number, nickname: m.nickname, points: m.balance, visits: m.visits,
  lastVisit: m.lastVisitAt ? m.lastVisitAt.slice(0, 10) : null, line: m.line,
});

/** 会員番号か呼び名で 1 人を選ぶ。いくつも当たれば候補。 */
async function pick(service: MemberService, ctx: ToolContext, q: string): Promise<Member | { candidates: Member[] } | null> {
  const all = await service.list(who(ctx));
  const no = /^(?:No\.?\s*|会員番号\s*)?(\d{1,7})$/i.exec(q.normalize('NFKC'));
  const hit = no ? all.filter((m) => m.number === Number(no[1])) : all.filter((m) => m.nickname.normalize('NFKC').includes(q.normalize('NFKC').replace(/(さん|様)$/, '')));
  if (hit.length === 1) return hit[0]!;
  if (hit.length > 1) return { candidates: hit.slice(0, 5) };
  return null;
}

/**
 * 会員を引く（「会員は何人？」「今月よく来た会員は？」「しばらく来ていない会員は？」「田中さんのポイントは？」）。
 *
 * @remarks 危険度 `read`
 */
export const membersFind: Tool = {
  name: 'members.find',
  risk: 'read',
  activityLabel: '会員の台帳を見ています',
  helpText: '会員の数・ポイント・来店の回数・最後の来店を引きます',
  description: '会員を引く。query は会員番号か呼び名（空なら全体）。order は points（ポイントの多い順）・visits（来店の多い順）・recent（最近来た順）・away（しばらく来ていない順）。awayDays を入れると、その日数より前から来ていない会員だけ',
  args: {
    properties: {
      query: { type: 'string', description: '会員番号か呼び名' },
      order: { type: 'string', description: 'points・visits・recent・away' },
      awayDays: { type: 'number', description: '何日来ていない会員か' },
    },
  },
  async invoke(args, ctx) {
    const service = await serviceOf(ctx);
    if (!service) return UNAVAILABLE;
    const q = str(args['query']);
    if (q) {
      const m = await pick(service, ctx, q);
      if (!m) return { available: true, path: PATH, count: 0, members: [] };
      if ('candidates' in m) return { available: true, path: PATH, count: m.candidates.length, members: m.candidates.map(brief) };
      return { available: true, path: PATH, count: 1, members: [brief(m)] };
    }
    let list = await service.list(who(ctx));
    const total = list.length;
    const days = typeof args['awayDays'] === 'number' ? args['awayDays'] : null;
    if (days !== null) {
      const limit = Date.now() - days * 86_400_000;
      list = list.filter((m) => !m.lastVisitAt || Date.parse(m.lastVisitAt) < limit);
    }
    const order = str(args['order']);
    const by: Record<string, (a: Member, b: Member) => number> = {
      points: (a, b) => b.balance - a.balance,
      visits: (a, b) => b.visits - a.visits,
      recent: (a, b) => (b.lastVisitAt ?? '').localeCompare(a.lastVisitAt ?? ''),
      away: (a, b) => (a.lastVisitAt ?? '').localeCompare(b.lastVisitAt ?? ''),
    };
    if (by[order]) list = [...list].sort(by[order]);
    return { available: true, path: PATH, total, count: list.length, members: list.slice(0, 20).map(brief) };
  },
};

/**
 * ポイントを足す・引く（「田中さんに 5 ポイント足して」）。理由を残す。
 *
 * @remarks 危険度 `write-internal`。社内の台帳に記録を足すだけ
 */
export const membersPoints: Tool = {
  name: 'members.points',
  risk: 'write-internal',
  activityLabel: '会員のポイントを直しています',
  helpText: '会員のポイントを足す・引く（理由を残す）',
  description: '会員のポイントを調整する。query は会員番号か呼び名。points は足す数（引くなら負の数）。note は理由（必須）',
  args: {
    properties: {
      query: { type: 'string', description: '会員番号か呼び名' },
      points: { type: 'number', description: '足す数（引くなら負）' },
      note: { type: 'string', description: '理由' },
    },
    required: ['query', 'points', 'note'],
  },
  async invoke(args, ctx) {
    const service = await serviceOf(ctx);
    if (!service) return UNAVAILABLE;
    const m = await pick(service, ctx, str(args['query']));
    if (!m) return { available: false, reason: 'その会員は見つかりません' };
    if ('candidates' in m) return { available: false, reason: 'いく人も当たりました。会員番号で言ってください', candidates: m.candidates.map(brief) };
    const r = await service.adjust(who(ctx), m.id, args['points'], args['note']);
    if ('error' in r) return { available: false, reason: r.error };
    return { available: true, member: brief(r.member), added: r.points };
  },
};

/**
 * 特典を作る・直す・止める（「10 ポイントでドリンク 1 杯の特典を作って」）。管理者だけ。
 *
 * @remarks 危険度 `write-internal`
 */
export const membersRewards: Tool = {
  name: 'members.rewards',
  risk: 'write-internal',
  activityLabel: '特典を直しています',
  helpText: 'ポイントと交換できる特典を作る・直す・止める（管理者）',
  description: '特典を扱う。action は list（一覧）・create（作る。name と points）・update（直す。name で選び、points か newName）・stop（止める。name で選ぶ）',
  args: {
    properties: {
      action: { type: 'string', description: 'list・create・update・stop' },
      name: { type: 'string', description: '特典の名前' },
      points: { type: 'number', description: '必要なポイント' },
      newName: { type: 'string', description: '新しい名前' },
    },
    required: ['action'],
  },
  async invoke(args, ctx) {
    const service = await serviceOf(ctx);
    if (!service) return UNAVAILABLE;
    const action = str(args['action']);
    const list = await service.rewards(who(ctx));
    if (action === 'list') return { available: true, path: PATH, rewards: list.map((r) => ({ name: r.name, points: r.points, status: r.status === 'active' ? '使える' : '止めた' })) };
    if (action === 'create') {
      const r = await service.createReward(who(ctx), { name: args['name'], points: args['points'] });
      if ('error' in r) return { available: false, reason: r.error };
      return { available: true, reward: { name: r.reward.name, points: r.reward.points } };
    }
    const name = str(args['name']);
    const target = list.find((r) => r.name === name) ?? (list.filter((r) => r.name.includes(name)).length === 1 ? list.find((r) => r.name.includes(name)) : undefined);
    if (!target) return { available: false, reason: 'その特典は見つかりません' };
    const patch: Record<string, unknown> = action === 'stop' ? { status: 'stopped' } : {
      ...(args['points'] !== undefined ? { points: args['points'] } : {}), ...(str(args['newName']) ? { name: str(args['newName']) } : {}),
    };
    const problem = await service.updateReward(who(ctx), target.id, patch);
    if (problem) return { available: false, reason: problem };
    return { available: true, reward: target.name, done: action === 'stop' ? '止めました' : '直しました' };
  },
};

/** 会員とポイントのツール。 */
export const MEMBER_TOOLS: Tool[] = [membersFind, membersPoints, membersRewards];
