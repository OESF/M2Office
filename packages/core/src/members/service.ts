/**
 * @file 会員とポイントの処理（仕様書 第40章）。会員を作る（店頭・LINE）・会員証・来店と購入のポイント・特典を使う・取り消し・調整・
 * まとめる・削除・特典を決める・有効期限の失効（ワーカーの {@link MemberService.tick}）。
 *
 * **購入の金額は保存しない**（ポイントにしたら捨てる。お金の機能にしない。第40.6節）。ポイントはマイナスにしない。
 * ポイントを付けるのはログインした従業員だけ。会員証や知らせを自動で LINE・メールに送らない（第40.5節）。
 */

import { randomBytes, randomUUID } from 'node:crypto';
import {
  MEMBERS_EXTENSION_ID, MEMBER_LIMITS, canUseAgent,
  type Member, type MemberPoint, type MemberReward, type MemberSettings,
} from '@m2office/shared';
import type { Repository } from '../repository/types.js';
import { silentLogger, type Logger } from '../log/logger.js';
import type { MemberStore, StoredMember, StoredPoint } from './store.js';

/** 操作する人。 */
export interface MemberViewer {
  tenantId: string;
  userId: string;
}

/** LINE の ID トークンを確かめた結果（お客様の ID と LINE の名前）。 */
export interface LineIdentity {
  sub: string;
  name: string;
}

/** LIFF の ID トークンを確かめる口。 */
export interface LineIdTokenVerifier {
  /** 確かめられなければ `null`。 */
  verify(idToken: string, channelId: string): Promise<LineIdentity | null>;
}

/** 処理に要るもの。 */
export interface MemberServiceDeps {
  store: MemberStore;
  repo: Repository;
  /** LINE の ID トークンを確かめる口（会社ごと。見本の会社では見本） */
  lineFor?(tenantId: string): LineIdTokenVerifier;
  logger?: Logger;
  now?(): Date;
}

/** 仕組みが行うとき（ワーカー）。 */
const SYSTEM = 'system';

/**
 * 会社が会員とポイントを使っていて、利用者が利用範囲の中なら、会社の設定を返す。
 *
 * @returns 使えなければ `null`
 */
export function membersAccess(repo: Repository) {
  return async (tenantId: string, userId: string): Promise<MemberSettings | null> => {
    const settings = await repo.getTenantSettings(tenantId);
    if (!settings.members.enabled) return null;
    const groups = await repo.listUserGroupIds(tenantId, userId);
    if (!canUseAgent(settings.access, MEMBERS_EXTENSION_ID, userId, groups)) return null;
    return settings.members;
  };
}

const jstDay = (d: Date) => new Date(d.getTime() + 9 * 3_600_000).toISOString().slice(0, 10);
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const text = (v: unknown, max: number) => (typeof v === 'string' ? v.trim().replace(/\s+/g, ' ').slice(0, max) : '');
const digits = (v: string) => v.replace(/\D/g, '');

/** 会員証の鍵（推測できない長さ）。 */
export const newCardKey = () => randomBytes(24).toString('base64url');

/** LINE の ID トークンを、LINE の確認の口（`/oauth2/v2.1/verify`）で確かめる。 */
export class LineApiVerifier implements LineIdTokenVerifier {
  constructor(private readonly base = 'https://api.line.me', private readonly timeoutMs = 10_000) {}

  async verify(idToken: string, channelId: string): Promise<LineIdentity | null> {
    if (!idToken || !channelId) return null;
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), this.timeoutMs);
    try {
      const res = await fetch(`${this.base}/oauth2/v2.1/verify`, {
        method: 'POST', signal: ctl.signal, redirect: 'error',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ id_token: idToken, client_id: channelId }),
      });
      if (!res.ok) return null;
      const o = await res.json() as { sub?: unknown; name?: unknown; aud?: unknown };
      if (typeof o.sub !== 'string' || !o.sub || (o.aud !== undefined && String(o.aud) !== channelId)) return null;
      return { sub: o.sub, name: typeof o.name === 'string' ? o.name.slice(0, 30) : '' };
    } catch {
      return null;
    } finally {
      clearTimeout(timer);
    }
  }
}

/** 見本の会社の口（`mock:<お客様の ID>:<名前>` を通す。外には問い合わせない）。 */
export class MockLineVerifier implements LineIdTokenVerifier {
  async verify(idToken: string): Promise<LineIdentity | null> {
    const m = /^mock:([A-Za-z0-9_-]{1,40})(?::(.{0,30}))?$/.exec(idToken);
    return m ? { sub: `U${m[1]}`, name: m[2] ?? '' } : null;
  }
}

/** 会員証で開いたときの答え。 */
export interface CardView {
  member: Member;
  /** いま使える特典（ポイントが足りるか付き） */
  rewards: (MemberReward & { enough: boolean })[];
}

/**
 * 会員とポイントの操作。
 *
 * @remarks 呼ぶ前に、利用者が使えるかを {@link membersAccess} で確かめること（会員証のページと LINE の入口を除く）
 */
export class MemberService {
  private readonly log: Logger;

  constructor(readonly deps: MemberServiceDeps) {
    this.log = deps.logger ?? silentLogger;
  }

  private now(): Date {
    return this.deps.now ? this.deps.now() : new Date();
  }

  private async isAdmin(who: MemberViewer): Promise<boolean> {
    const u = await this.deps.repo.findUserById(who.tenantId, who.userId);
    return !!u?.roles.includes('admin');
  }

  private async audit(who: MemberViewer, action: string, targetId: string, detail: Record<string, unknown>): Promise<void> {
    await this.deps.repo.appendAudit({
      id: randomUUID(), tenantId: who.tenantId, actorType: who.userId === SYSTEM ? 'system' : 'user', actorId: who.userId === SYSTEM ? 'member-watch' : who.userId,
      action, targetType: 'member', targetId, detail, occurredAt: new Date().toISOString(),
    });
  }

  private view(m: StoredMember): Member {
    return {
      id: m.id, number: m.number, nickname: m.nickname, phone: m.phone, line: !!m.lineUserId, balance: m.balance, visits: m.visits,
      lastVisitAt: m.lastVisitAt, lastEarnedAt: m.lastEarnedAt, createdAt: m.createdAt,
    };
  }

  /** 今日（日本時間）。 */
  today(): string {
    return jstDay(this.now());
  }

  /** 会社の設定。 */
  async settings(tenantId: string): Promise<MemberSettings> {
    return (await this.deps.repo.getTenantSettings(tenantId)).members;
  }

  /**
   * 来店のポイント・購入の率・有効期限・LINE の会員証の設定を直す（管理者だけ。第40.4節）。
   *
   * @returns 直せなければ理由
   */
  async saveSettings(who: MemberViewer, input: Record<string, unknown>): Promise<string | null> {
    if (!(await this.isAdmin(who))) return '会員とポイントの設定を直せるのは管理者だけです';
    const cur = await this.settings(who.tenantId);
    const next = { ...cur };
    const int = (k: 'visitPoints' | 'yenPerPoint' | 'expiryDays', min: number, max: number, label: string): string | null => {
      if (input[k] === undefined) return null;
      const n = Number(input[k]);
      if (!Number.isInteger(n) || n < min || n > max) return `${label}は ${min}〜${max} で入れてください`;
      next[k] = n;
      return null;
    };
    const problem = int('visitPoints', 0, 100, '来店のポイント') ?? int('yenPerPoint', 1, 100_000, '何円で 1 ポイントか') ?? int('expiryDays', 30, 3650, '有効期限の日数');
    if (problem) return problem;
    if (input['liffId'] !== undefined) {
      const v = text(input['liffId'], 60);
      if (v && !/^[0-9]{6,}-[A-Za-z0-9]{4,}$/.test(v)) return 'LIFF ID の形が違います（例: 1234567890-AbCdEfGh）';
      next.liffId = v;
    }
    if (input['lineLoginChannelId'] !== undefined) {
      const v = text(input['lineLoginChannelId'], 20);
      if (v && !/^\d{6,15}$/.test(v)) return 'LINE ログインのチャネル ID は数字で入れてください';
      next.lineLoginChannelId = v;
    }
    await this.deps.repo.saveTenantSettings(who.tenantId, 'members', next, who.userId);
    await this.audit(who, 'member.settings', 'settings', { fields: Object.keys(input) });
    return null;
  }

  // ---- 会員 ----------------------------------------------------------------------------------

  /** 一覧（会員番号の新しい順。呼び名・会員番号・電話で探す）。 */
  async list(who: MemberViewer, search = ''): Promise<Member[]> {
    return (await this.deps.store.list(who.tenantId, { search })).map((m) => this.view(m));
  }

  /** 1 件と、ポイントの記録と、まとめる候補（同じ電話・同じ呼び名）。見つからなければ `null`。 */
  async get(who: MemberViewer, id: string): Promise<{ member: Member; points: MemberPoint[]; candidates: Member[] } | null> {
    const m = await this.deps.store.get(who.tenantId, id);
    if (!m || m.mergedInto) return null;
    const names = new Map((await this.deps.repo.listUsers(who.tenantId)).map((u) => [u.id, u.displayName || u.email]));
    const points = (await this.deps.store.points(who.tenantId, id)).map((p) => this.pointView(p, names));
    const all = await this.deps.store.list(who.tenantId);
    const phone = digits(m.phone);
    const candidates = all.filter((x) => x.id !== m.id && ((phone.length >= 9 && digits(x.phone) === phone) || x.nickname === m.nickname)).slice(0, 5).map((x) => this.view(x));
    return { member: this.view(m), points, candidates };
  }

  private pointView(p: StoredPoint, names: Map<string, string>): MemberPoint {
    return {
      id: p.id, memberId: p.memberId, kind: p.kind, points: p.points, rewardId: p.rewardId, rewardName: p.rewardName, reversalOf: p.reversalOf, reversed: p.reversed,
      note: p.note, createdBy: p.createdBy, createdByName: p.createdBy === SYSTEM ? '自動' : names.get(p.createdBy) ?? '', createdAt: p.createdAt,
    };
  }

  /** 会員証の鍵から会員と使える特典（店員のスマホのページと会員証のページ）。見つからなければ `null`。 */
  async byCard(tenantId: string, key: string): Promise<(CardView & { cardKey: string }) | null> {
    if (!/^[A-Za-z0-9_-]{20,64}$/.test(key)) return null;
    let m = await this.deps.store.byCardKey(tenantId, key);
    // まとめた会員の古い会員証は、まとめた先の会員にする
    if (m?.mergedInto) m = await this.deps.store.get(tenantId, m.mergedInto);
    if (!m) return null;
    const today = this.today();
    const rewards = (await this.usableRewards(tenantId, today)).map((r) => ({ ...r, enough: m!.balance >= r.points }));
    return { member: this.view(m), rewards, cardKey: m.cardKey };
  }

  private async usableRewards(tenantId: string, today: string): Promise<MemberReward[]> {
    return (await this.deps.store.rewards(tenantId)).filter((r) => r.status === 'active' && (!r.validFrom || r.validFrom <= today) && (!r.validTo || r.validTo >= today));
  }

  /** 会員証の鍵（店員が会員を作ったあと、QR と紙のカードに使う）。 */
  async cardKeyOf(who: MemberViewer, id: string): Promise<string | null> {
    const m = await this.deps.store.get(who.tenantId, id);
    return m && !m.mergedInto ? m.cardKey : null;
  }

  /**
   * 店頭で会員を作る（第40.5節）。呼び名は必須（ニックネームでよい）、電話は任意。
   *
   * @returns 作った会員と会員証の鍵か、作れない理由
   */
  async create(who: MemberViewer, input: { nickname?: unknown; phone?: unknown }): Promise<{ member: Member; cardKey: string } | { error: string }> {
    const nickname = text(input.nickname, MEMBER_LIMITS.nicknameMax);
    if (!nickname) return { error: '呼び名を入れてください（ニックネームでかまいません）' };
    const phone = text(input.phone, 20);
    if (phone && digits(phone).length < 9) return { error: '電話は 9 桁以上の数字で入れてください（任意です）' };
    const cardKey = newCardKey();
    const id = await this.deps.store.create(who.tenantId, { nickname, phone, lineUserId: null, cardKey, createdBy: who.userId });
    return { member: this.view((await this.deps.store.get(who.tenantId, id))!), cardKey };
  }

  /**
   * LINE の会員証のページ（LIFF）から入る（第40.5節）。ID トークンを LINE で確かめ、その LINE のお客様の会員証の鍵を返す。
   * 初めてのお客様は、呼び名を受け取ってから会員にする（呼び名が無ければ、LINE の名前を案として返す）。
   *
   * @returns 会員証の鍵か、呼び名が要る・入れない理由
   */
  async lineSignIn(tenantId: string, idToken: string, nickname?: string): Promise<{ cardKey: string } | { needsNickname: true; suggested: string } | { error: string }> {
    const settings = await this.settings(tenantId);
    if (!settings.enabled || !settings.liffId || !settings.lineLoginChannelId || !this.deps.lineFor) return { error: 'LINE の会員証は使えません' };
    const who = await this.deps.lineFor(tenantId).verify(idToken, settings.lineLoginChannelId);
    if (!who) return { error: 'LINE で確かめられませんでした。LINE からもう一度開いてください' };
    const cur = await this.deps.store.byLineUser(tenantId, who.sub);
    if (cur) return { cardKey: cur.cardKey };
    const name = text(nickname, MEMBER_LIMITS.nicknameMax);
    if (!name) return { needsNickname: true, suggested: who.name };
    const cardKey = newCardKey();
    await this.deps.store.create(tenantId, { nickname: name, phone: '', lineUserId: who.sub, cardKey, createdBy: 'line' });
    return { cardKey };
  }

  /** 問い合わせの連絡先と同じ人の会員（LINE のお客様の ID か、9 桁以上の電話で見分ける。第40.8節）。 */
  async findForContact(tenantId: string, key: { phone?: string | null; lineUserId?: string | null }): Promise<Member | null> {
    if (key.lineUserId) {
      const m = await this.deps.store.byLineUser(tenantId, key.lineUserId);
      if (m) return this.view(m);
    }
    const phone = digits(key.phone ?? '');
    if (phone.length < 9) return null;
    const hit = (await this.deps.store.list(tenantId, { search: phone })).find((m) => digits(m.phone) === phone);
    return hit ? this.view(hit) : null;
  }

  // ---- ポイント ------------------------------------------------------------------------------

  private async target(who: MemberViewer, memberId: string): Promise<StoredMember | { error: string }> {
    const m = await this.deps.store.get(who.tenantId, memberId);
    if (!m || m.mergedInto) return { error: '会員が見つかりません' };
    return m;
  }

  /** 記録を足して、足した後の会員を返す。 */
  private async add(who: MemberViewer, m: StoredMember, p: Pick<StoredPoint, 'kind' | 'points' | 'rewardId' | 'rewardName' | 'reversalOf' | 'note'>): Promise<{ member: Member; points: number }> {
    await this.deps.store.addPoint(who.tenantId, { ...p, memberId: m.id, localDay: this.today(), createdBy: who.userId });
    return { member: this.view((await this.deps.store.get(who.tenantId, m.id))!), points: p.points };
  }

  /** 来店（第40.6節）。同じ会員は 1 日 1 回まで。 */
  async visit(who: MemberViewer, memberId: string): Promise<{ member: Member; points: number } | { error: string }> {
    const m = await this.target(who, memberId);
    if ('error' in m) return m;
    const { visitPoints } = await this.settings(who.tenantId);
    if (visitPoints <= 0) return { error: '来店のポイントは 0 にしてあります' };
    const today = this.today();
    if ((await this.deps.store.points(who.tenantId, m.id, 50)).some((p) => p.kind === 'visit' && p.localDay === today && !p.reversed)) {
      return { error: '今日はもう来店のポイントを付けました（1 日 1 回まで）' };
    }
    return this.add(who, m, { kind: 'visit', points: visitPoints, rewardId: null, rewardName: '', reversalOf: null, note: '' });
  }

  /** 購入（第40.6節）。金額を会社の率でポイントにし（端数は切り捨て）、**金額は保存しない**。 */
  async purchase(who: MemberViewer, memberId: string, amount: unknown): Promise<{ member: Member; points: number } | { error: string }> {
    const m = await this.target(who, memberId);
    if ('error' in m) return m;
    const yen = Number(amount);
    if (!Number.isInteger(yen) || yen <= 0 || yen > MEMBER_LIMITS.purchaseMax) return { error: '金額は 1 円以上の整数で入れてください' };
    const { yenPerPoint } = await this.settings(who.tenantId);
    const points = Math.floor(yen / yenPerPoint);
    if (points < 1) return { error: `${yenPerPoint} 円に届かないため、ポイントになりません` };
    return this.add(who, m, { kind: 'purchase', points, rewardId: null, rewardName: '', reversalOf: null, note: '' });
  }

  /** 特典を使う（第40.6節）。ポイントが足りなければ使えない。値引きの計算はレジで行う。 */
  async useReward(who: MemberViewer, memberId: string, rewardId: string): Promise<{ member: Member; points: number } | { error: string }> {
    const m = await this.target(who, memberId);
    if ('error' in m) return m;
    const r = (await this.usableRewards(who.tenantId, this.today())).find((x) => x.id === rewardId);
    if (!r) return { error: 'その特典はいま使えません' };
    if (m.balance < r.points) return { error: `ポイントが足りません（あと ${r.points - m.balance} ポイント）` };
    return this.add(who, m, { kind: 'reward', points: -r.points, rewardId: r.id, rewardName: r.name, reversalOf: null, note: '' });
  }

  /** 調整（「5 ポイント足して」）。理由を残す。マイナスにはしない。 */
  async adjust(who: MemberViewer, memberId: string, points: unknown, note: unknown): Promise<{ member: Member; points: number } | { error: string }> {
    const m = await this.target(who, memberId);
    if ('error' in m) return m;
    const n = Number(points);
    if (!Number.isInteger(n) || n === 0 || Math.abs(n) > MEMBER_LIMITS.adjustMax) return { error: `ポイントは 1〜${MEMBER_LIMITS.adjustMax} の整数で入れてください` };
    const reason = text(note, MEMBER_LIMITS.noteMax);
    if (!reason) return { error: '理由を入れてください' };
    if (m.balance + n < 0) return { error: 'ポイントがマイナスになるため、引けません' };
    return this.add(who, m, { kind: 'adjust', points: n, rewardId: null, rewardName: '', reversalOf: null, note: reason });
  }

  /**
   * 取り消す（逆の記録を足す。第40.6節）。その日の記録は店員が、前の日の記録は管理者が取り消す（管理者のときは監査ログに残す）。
   *
   * @returns 取り消せなければ理由
   */
  async undo(who: MemberViewer, pointId: string): Promise<string | null> {
    const p = await this.deps.store.getPoint(who.tenantId, pointId);
    if (!p) return '記録が見つかりません';
    if (p.kind === 'undo' || p.kind === 'expire') return 'この記録は取り消せません';
    if (p.reversed) return 'もう取り消してあります';
    const m = await this.target(who, p.memberId);
    if ('error' in m) return m.error;
    const sameDay = p.localDay === this.today();
    if (!sameDay && !(await this.isAdmin(who))) return '前の日の記録を取り消せるのは管理者だけです';
    if (m.balance - p.points < 0) return 'ポイントが足りないため取り消せません（先に使った特典を取り消してください）';
    try {
      await this.add(who, m, { kind: 'undo', points: -p.points, rewardId: p.rewardId, rewardName: p.rewardName, reversalOf: p.id, note: '' });
    } catch {
      return 'もう取り消してあります';
    }
    if (!sameDay) await this.audit(who, 'member.undo', m.id, { kind: p.kind });
    return null;
  }

  /**
   * 同じ人の会員をまとめる（管理者だけ）。まとめる元のポイントをまとめる先に移し（調整の記録を両方に足す）、LINE のつながりも移す。
   *
   * @returns まとめられなければ理由
   */
  async merge(who: MemberViewer, fromId: string, intoId: string): Promise<string | null> {
    if (!(await this.isAdmin(who))) return '会員をまとめられるのは管理者だけです';
    if (fromId === intoId) return '同じ会員です';
    const from = await this.target(who, fromId);
    const into = await this.target(who, intoId);
    if ('error' in from) return from.error;
    if ('error' in into) return into.error;
    if (from.balance !== 0) {
      await this.add(who, from, { kind: 'adjust', points: -from.balance, rewardId: null, rewardName: '', reversalOf: null, note: `会員番号 ${into.number} にまとめた` });
      await this.add(who, into, { kind: 'adjust', points: from.balance, rewardId: null, rewardName: '', reversalOf: null, note: `会員番号 ${from.number} をまとめた` });
    }
    const line = from.lineUserId;
    await this.deps.store.update(who.tenantId, from.id, { mergedInto: into.id, lineUserId: null });
    if (line && !into.lineUserId) await this.deps.store.update(who.tenantId, into.id, { lineUserId: line });
    if (!into.phone && from.phone) await this.deps.store.update(who.tenantId, into.id, { phone: from.phone });
    await this.audit(who, 'member.merge', into.id, { from: from.id, points: from.balance });
    return null;
  }

  /** 呼び名と電話を直す（利用範囲の人）。 */
  async update(who: MemberViewer, id: string, input: { nickname?: unknown; phone?: unknown }): Promise<string | null> {
    const m = await this.target(who, id);
    if ('error' in m) return m.error;
    const patch: { nickname?: string; phone?: string } = {};
    if (input.nickname !== undefined) {
      const v = text(input.nickname, MEMBER_LIMITS.nicknameMax);
      if (!v) return '呼び名を入れてください';
      patch.nickname = v;
    }
    if (input.phone !== undefined) {
      const v = text(input.phone, 20);
      if (v && digits(v).length < 9) return '電話は 9 桁以上の数字で入れてください';
      patch.phone = v;
    }
    await this.deps.store.update(who.tenantId, id, patch);
    return null;
  }

  /** 削除（退会。管理者だけ。第40.11節）。ポイントの記録は数だけが残り、だれのものかは消える。 */
  async remove(who: MemberViewer, id: string): Promise<string | null> {
    if (!(await this.isAdmin(who))) return '会員を削除できるのは管理者だけです';
    const m = await this.deps.store.get(who.tenantId, id);
    if (!m) return '会員が見つかりません';
    await this.deps.store.delete(who.tenantId, id);
    await this.audit(who, 'member.delete', id, {});
    return null;
  }

  // ---- 特典 ----------------------------------------------------------------------------------

  /** 特典（止めたものも含む）。 */
  async rewards(who: MemberViewer): Promise<MemberReward[]> {
    return this.deps.store.rewards(who.tenantId);
  }

  private rewardInput(input: Record<string, unknown>): Partial<Pick<MemberReward, 'name' | 'points' | 'validFrom' | 'validTo' | 'status'>> | { error: string } {
    const out: Partial<Pick<MemberReward, 'name' | 'points' | 'validFrom' | 'validTo' | 'status'>> = {};
    if (input['name'] !== undefined) {
      const v = text(input['name'], MEMBER_LIMITS.rewardNameMax);
      if (!v) return { error: '特典の名前を入れてください' };
      out.name = v;
    }
    if (input['points'] !== undefined) {
      const n = Number(input['points']);
      if (!Number.isInteger(n) || n < 1 || n > 100_000) return { error: '必要なポイントは 1 以上の整数で入れてください' };
      out.points = n;
    }
    for (const k of ['validFrom', 'validTo'] as const) {
      if (input[k] === undefined) continue;
      const v = input[k];
      if (v === null || v === '') { out[k] = null; continue; }
      if (typeof v !== 'string' || !DATE.test(v)) return { error: '日付は YYYY-MM-DD の形で入れてください' };
      out[k] = v;
    }
    if (input['status'] !== undefined) {
      if (input['status'] !== 'active' && input['status'] !== 'stopped') return { error: '状態が違います' };
      out.status = input['status'];
    }
    return out;
  }

  /** 特典を作る（管理者だけ）。名前と必要なポイントだけで作れる。 */
  async createReward(who: MemberViewer, input: Record<string, unknown>): Promise<{ reward: MemberReward } | { error: string }> {
    if (!(await this.isAdmin(who))) return { error: '特典を作れるのは管理者だけです' };
    const v = this.rewardInput(input);
    if ('error' in v) return v;
    if (!v.name || !v.points) return { error: '特典の名前と必要なポイントを入れてください' };
    const id = await this.deps.store.createReward(who.tenantId, { name: v.name, points: v.points, validFrom: v.validFrom ?? null, validTo: v.validTo ?? null });
    await this.audit(who, 'member.reward.create', id, { points: v.points });
    return { reward: (await this.deps.store.getReward(who.tenantId, id))! };
  }

  /** 特典を直す・止める（管理者だけ）。 */
  async updateReward(who: MemberViewer, id: string, input: Record<string, unknown>): Promise<string | null> {
    if (!(await this.isAdmin(who))) return '特典を直せるのは管理者だけです';
    if (!(await this.deps.store.getReward(who.tenantId, id))) return '特典が見つかりません';
    const v = this.rewardInput(input);
    if ('error' in v) return v.error;
    await this.deps.store.updateReward(who.tenantId, id, v);
    await this.audit(who, 'member.reward.update', id, { fields: Object.keys(v) });
    return null;
  }

  // ---- 有効期限 ------------------------------------------------------------------------------

  /**
   * 失効の 1 回分（ワーカーから。1 日に 1 回）。最後に貯めた日から有効期限の日数がたった会員の、残りのポイントを失効させる（失効の記録を足す）。
   *
   * @returns 失効させた会員の数
   */
  async tick(now: Date = this.now()): Promise<number> {
    let expired = 0;
    for (const tenantId of await this.deps.repo.listTenantIds()) {
      try {
        const settings = await this.settings(tenantId);
        if (!settings.enabled) continue;
        const limit = now.getTime() - settings.expiryDays * 86_400_000;
        for (const m of await this.deps.store.list(tenantId, { limit: 5000 })) {
          const since = Date.parse(m.lastEarnedAt ?? m.createdAt);
          if (m.balance <= 0 || since >= limit) continue;
          await this.deps.store.addPoint(tenantId, {
            memberId: m.id, kind: 'expire', points: -m.balance, rewardId: null, rewardName: '', reversalOf: null,
            note: `最後に貯めた日から ${settings.expiryDays} 日`, localDay: jstDay(now), createdBy: SYSTEM,
          });
          expired += 1;
        }
      } catch (err) {
        this.log.warn('会員のポイントの失効に失敗しました', { tenantId, error: err instanceof Error ? err.message : String(err) });
      }
    }
    return expired;
  }
}
