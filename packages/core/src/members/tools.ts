/**
 * @file 会員とポイントのツール（仕様書 第40.7節）。会員を引く・ポイントを足す／取り消す・特典を作る／直す。秘書と付属の業務が使う。
 *
 * 会社が切っているときと、利用範囲の外の人には「使えない」と返す（呼ぶたびに `ctx.members.access()` で確かめる）。
 * 答えには電話を入れない（推論に渡さない。第40.11節）。
 */

import { MEMBER_RANK_LABELS, minRankText, type Member, type MemberSettings } from '@m2office/shared';
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
  yearVisits: m.yearVisits, rank: MEMBER_RANK_LABELS[m.rank], lastVisit: m.lastVisitAt ? m.lastVisitAt.slice(0, 10) : null, line: m.line,
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
  description: '会員を引く。query は会員番号か呼び名（空なら全体）。order は points（ポイントの多い順）・visits（来店の多い順）・recent（最近来た順）・away（しばらく来ていない順）。awayDays を入れると、その日数より前から来ていない会員だけ。rank に gold・silver を入れると、そのランクの会員だけ（rank はゴールド・シルバー・一般。直近 1 年の来店の回数で決まる）',
  args: {
    properties: {
      query: { type: 'string', description: '会員番号か呼び名' },
      order: { type: 'string', description: 'points・visits・recent・away' },
      awayDays: { type: 'number', description: '何日来ていない会員か' },
      rank: { type: 'string', description: 'gold・silver（そのランクの会員だけ）' },
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
    const rank = str(args['rank']);
    if (rank === 'gold' || rank === 'silver') list = list.filter((m) => m.rank === rank);
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
  description: '特典を扱う。action は list（一覧）・create（作る。name と points。誕生月の会員だけなら birthdayOnly を true。ランクの会員だけなら minRank に silver（シルバー以上）か gold（ゴールドだけ））・update（直す。name で選び、points か newName か minRank）・stop（止める。name で選ぶ）',
  args: {
    properties: {
      action: { type: 'string', description: 'list・create・update・stop' },
      name: { type: 'string', description: '特典の名前' },
      points: { type: 'number', description: '必要なポイント' },
      newName: { type: 'string', description: '新しい名前' },
      birthdayOnly: { type: 'boolean', description: '誕生月の会員だけが使える特典か' },
      minRank: { type: 'string', description: 'regular（全員）・silver（シルバー以上）・gold（ゴールドだけ）' },
    },
    required: ['action'],
  },
  async invoke(args, ctx) {
    const service = await serviceOf(ctx);
    if (!service) return UNAVAILABLE;
    const action = str(args['action']);
    const list = await service.rewards(who(ctx));
    if (action === 'list') {
      return {
        available: true, path: PATH,
        rewards: list.map((r) => ({ name: r.name, points: r.points, who: [r.birthdayOnly ? '誕生月だけ' : '', minRankText(r.minRank)].filter(Boolean).join('・') || '会員全員', status: r.status === 'active' ? '使える' : '止めた' })),
      };
    }
    if (action === 'create') {
      const r = await service.createReward(who(ctx), {
        name: args['name'], points: args['points'], birthdayOnly: args['birthdayOnly'] === true, ...(str(args['minRank']) ? { minRank: str(args['minRank']) } : {}),
      });
      if ('error' in r) return { available: false, reason: r.error };
      return { available: true, reward: { name: r.reward.name, points: r.reward.points } };
    }
    const name = str(args['name']);
    const target = list.find((r) => r.name === name) ?? (list.filter((r) => r.name.includes(name)).length === 1 ? list.find((r) => r.name.includes(name)) : undefined);
    if (!target) return { available: false, reason: 'その特典は見つかりません' };
    const patch: Record<string, unknown> = action === 'stop' ? { status: 'stopped' } : {
      ...(args['points'] !== undefined ? { points: args['points'] } : {}), ...(str(args['newName']) ? { name: str(args['newName']) } : {}),
      ...(str(args['minRank']) ? { minRank: str(args['minRank']) } : {}),
    };
    const problem = await service.updateReward(who(ctx), target.id, patch);
    if (problem) return { available: false, reason: problem };
    return { available: true, reward: target.name, done: action === 'stop' ? '止めました' : '直しました' };
  },
};

/**
 * 承認された会員への LINE の知らせを送る（第40.18節）。宛先の 1 人ずつに呼び名・ポイント・失効日を差し込んで LINE で送る。
 *
 * @remarks 危険度 `external-send`。お客様に届くため、承認の段の直後でしか呼べない。承認の後に中身（文と宛先）が変わっていたら送らない
 */
export const membersSendLine: Tool = {
  name: 'members.send_line',
  risk: 'external-send',
  activityLabel: '会員に LINE で知らせています',
  helpText: '承認された会員への知らせを、LINE で 1 人ずつ送ります',
  description: '承認された会員への LINE の知らせ（messageId）を送る',
  args: { properties: { messageId: { type: 'string', description: '知らせの ID' } }, required: ['messageId'] },
  planKey: (args) => `member-message:${str(args['messageId'])}`,
  async prepare(args, ctx) {
    const service = await serviceOf(ctx);
    if (!service) return { kind: 'problem', reason: UNAVAILABLE.reason };
    const id = str(args['messageId']);
    const p = await service.previewMessage(ctx.tenantId, id).catch(() => null);
    if (!p) return { kind: 'problem', reason: '知らせが見つかりません' };
    if ('error' in p) return { kind: 'problem', reason: p.error };
    const shown = [
      `宛先: ${p.audience}（LINE でつながっている ${p.count} 人に 1 人ずつ。送った後は取り消せません）`,
      `今月の LINE の残り: ${p.remaining === null ? '上限なし' : `${p.remaining} 通`}`,
      `1 人目に届く文:\n${p.sample}`,
    ].join('\n');
    return { kind: 'ready', args: { messageId: id, digest: p.digest }, shown, audience: 'external' };
  },
  async invoke(args, ctx) {
    const service = await serviceOf(ctx);
    if (!service) return UNAVAILABLE;
    const r = await service.sendMessage(who(ctx), str(args['messageId']), str(args['digest']));
    if ('error' in r) return { available: false, reason: r.error };
    return { available: true, sent: r.sent, failed: r.failed };
  },
};

/** 会員とポイントのツール。 */
/**
 * ランクの境の回数を見る・決める・自動に戻す（「ゴールドは年 20 回にして」。決めるのは管理者。第40.19節）。
 *
 * @remarks 危険度 `write-internal`。会社の中の設定を変えるだけ
 */
export const membersRank: Tool = {
  name: 'members.rank',
  risk: 'write-internal',
  activityLabel: '会員のランクを見ています',
  helpText: '会員のランクの境（直近 1 年の来店の回数）を見る・決める・自動に戻す（決めるのは管理者）',
  description: 'ランクの境を扱う。action は show（いまの境と、ランクごとの人数）・set（決める。silver と gold は直近 1 年の来店の回数。決めると自動では変わらない）・auto（自動に戻す。毎月、会員の来店の分布から決める）',
  args: {
    properties: {
      action: { type: 'string', description: 'show・set・auto' },
      silver: { type: 'number', description: 'シルバーになる直近 1 年の来店の回数' },
      gold: { type: 'number', description: 'ゴールドになる直近 1 年の来店の回数' },
    },
    required: ['action'],
  },
  async invoke(args, ctx) {
    const service = await serviceOf(ctx);
    if (!service) return UNAVAILABLE;
    const action = str(args['action']);
    if (action === 'set' || action === 'auto') {
      const cur = await service.rankCut(ctx.tenantId);
      const input = action === 'auto' ? { rankAuto: true }
        : { rankSilver: args['silver'] ?? cur.silver, rankGold: args['gold'] ?? cur.gold };
      const problem = await service.saveSettings(who(ctx), input);
      if (problem) return { available: false, reason: problem };
    }
    const cut = await service.rankCut(ctx.tenantId);
    const list = await service.list(who(ctx));
    return {
      available: true, path: PATH, done: action === 'set' ? '決めました' : action === 'auto' ? '自動に戻しました' : null,
      gold: cut.gold, silver: cut.silver, auto: cut.auto,
      note: cut.gold === null ? '来店のある会員が 10 人に満たないため、まだランクを決めていません' : null,
      counts: { ゴールド: list.filter((m) => m.rank === 'gold').length, シルバー: list.filter((m) => m.rank === 'silver').length, 一般: list.filter((m) => m.rank === 'regular').length },
    };
  },
};

export const MEMBER_TOOLS: Tool[] = [membersFind, membersPoints, membersRewards, membersRank, membersSendLine];
