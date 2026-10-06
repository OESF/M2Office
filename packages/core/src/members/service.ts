/**
 * @file 会員とポイントの処理（仕様書 第40章）。会員を作る（店頭・LINE）・会員証・来店と購入のポイント・特典を使う・取り消し・調整・
 * まとめる・削除・特典を決める・有効期限の失効（ワーカーの {@link MemberService.tick}）。
 * 段 2 の残り（第40.19節）で、直近 1 年の来店の回数によるランクとランクだけの特典、店頭サイネージに特典を流すこと。
 *
 * **購入の金額は保存しない**（ポイントにしたら捨てる。お金の機能にしない。第40.6節）。ポイントはマイナスにしない。
 * ポイントを付けるのはログインした従業員だけ。会員証や知らせを自動で LINE・メールに送らない（第40.5節）。
 */

import { createHash, randomBytes, randomUUID } from 'node:crypto';
import {
  MEMBERS_EXTENSION_ID, MEMBER_AUDIENCE_LABELS, MEMBER_EXPIRY_TEXT, MEMBER_LIMITS, MEMBER_MESSAGE_MAX, MEMBER_RANK_ORDER, canUseAgent,
  type Member, type MemberAudience, type MemberMessage, type MemberPoint, type MemberRank, type MemberReward, type MemberSettings,
} from '@m2office/shared';
import type { Repository } from '../repository/types.js';
import { silentLogger, type Logger } from '../log/logger.js';
import { openLine, type LineDeps } from '../inquiries/line.js';
import type { MemberStore, StoredMember, StoredMessage, StoredPoint } from './store.js';
import type { SignageService } from '../signage/service.js';
import { refreshRewardSignage } from './screen.js';

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
  /** 会社の LINE 公式アカウント（会員への LINE の知らせを送る。問い合わせの記録でつないだもの。第40.18節） */
  line?: LineDeps;
  /** 会員への LINE の知らせを、承認の段のある業務として起こす（実行の ID を返す） */
  submitter?(tenantId: string, userId: string, messageId: string): Promise<string>;
  /** 実行の状態（承認されなかった知らせを「承認されなかった」にする） */
  runStatus?(tenantId: string, runId: string): Promise<string | null>;
  /** 店頭サイネージ（特典を流す。第40.19節。無ければ流さない） */
  signage?: SignageService;
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
const DAY = 86_400_000;

/** 誕生日の書き方（「3/14」「03-14」「3月14日」）を MM-DD に。読めなければ `false`、空なら `null`。 */
export function birthdayOf(v: unknown): string | null | false {
  if (v === null || v === undefined || v === '') return null;
  const m = /^(\d{1,2})\s*(?:[-/月.])\s*(\d{1,2})日?$/.exec(String(v).normalize('NFKC').trim());
  if (!m) return false;
  const mm = Number(m[1]);
  const dd = Number(m[2]);
  const days = [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (mm < 1 || mm > 12 || dd < 1 || dd > days[mm - 1]!) return false;
  return `${String(mm).padStart(2, '0')}-${String(dd).padStart(2, '0')}`;
}

/** 失効する日（最後に貯めた日か会員になった日から、有効期限の日数のあと。日本時間の YYYY-MM-DD）。 */
export const expiryDayOf = (m: Pick<StoredMember, 'lastEarnedAt' | 'createdAt'>, expiryDays: number) =>
  jstDay(new Date(Date.parse(m.lastEarnedAt ?? m.createdAt) + expiryDays * DAY));

/** 知らせの文に、1 人ずつ呼び名・ポイント・失効日を差し込む。 */
export function renderMemberText(text: string, m: Pick<StoredMember, 'nickname' | 'balance' | 'lastEarnedAt' | 'createdAt'>, expiryDays: number): string {
  const day = expiryDayOf(m, expiryDays);
  return text.replace(/\{呼び名\}/g, m.nickname).replace(/\{ポイント\}/g, String(m.balance))
    .replace(/\{失効日\}/g, `${Number(day.slice(5, 7))}月${Number(day.slice(8, 10))}日`).slice(0, 5000);
}

/** 承認の後に中身が変わっていないかを見る印（文と宛先）。 */
export const messageDigest = (m: Pick<StoredMessage, 'text' | 'recipients'>) =>
  createHash('sha256').update(`${m.text}\n${[...m.recipients].sort().join(',')}`).digest('hex').slice(0, 16);
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

/** ランクの境の回数（どちらも `null` ならランクを使わない）。 */
export interface RankCut {
  silver: number | null;
  gold: number | null;
}

/** 直近 1 年の来店の回数からランクを決める（純粋な関数）。 */
export function rankOf(yearVisits: number, cut: RankCut): MemberRank {
  if (cut.gold !== null && yearVisits >= cut.gold) return 'gold';
  if (cut.silver !== null && yearVisits >= cut.silver) return 'silver';
  return 'regular';
}

/**
 * 来店のある会員の来店の回数から、ランクの境の回数を決める（純粋な関数。第40.19節）。上からおよそ 1 割をゴールド、3 割までをシルバーにする。
 * 来店のある会員が少なければ決めない（`null`）。少ない回数でランクが付かないよう、下限を置く。
 *
 * @param counts 会員ごとの直近 1 年の来店の回数（来店のある会員だけ）
 */
export function rankCutOf(counts: number[]): RankCut {
  if (counts.length < MEMBER_LIMITS.rankMembersMin) return { silver: null, gold: null };
  const sorted = [...counts].sort((a, b) => b - a);
  const at = (share: number) => sorted[Math.max(0, Math.ceil(sorted.length * share) - 1)]!;
  const silver = Math.max(at(MEMBER_LIMITS.rankSilverShare), MEMBER_LIMITS.rankSilverMin);
  const gold = Math.max(at(MEMBER_LIMITS.rankGoldShare), MEMBER_LIMITS.rankGoldMin, silver + 1);
  return { silver, gold };
}

/** 会員を画面の形にするときに使う、会社のランクの材料。 */
interface RankContext {
  visits: Map<string, number>;
  cut: RankCut;
}

/**
 * 会員とポイントの操作。
 *
 * @remarks 呼ぶ前に、利用者が使えるかを {@link membersAccess} で確かめること（会員証のページと LINE の入口を除く）
 */
export class MemberService {
  private readonly log: Logger;
  /** 会社ごとの、サイネージの 1 枚の作り直しの順番待ち */
  private readonly signageQueue = new Map<string, Promise<'added' | 'removed' | 'same'>>();

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

  private view(m: StoredMember, rc: RankContext): Member {
    const yearVisits = rc.visits.get(m.id) ?? 0;
    return {
      id: m.id, number: m.number, nickname: m.nickname, phone: m.phone, birthday: m.birthday, line: !!m.lineUserId, balance: m.balance, visits: m.visits,
      yearVisits, rank: rankOf(yearVisits, rc.cut), lastVisitAt: m.lastVisitAt, lastEarnedAt: m.lastEarnedAt, createdAt: m.createdAt,
    };
  }

  /** 会社のランクの材料（会員ごとの直近 1 年の来店の回数と、境の回数）。 */
  private async rankContext(tenantId: string): Promise<RankContext> {
    const settings = await this.settings(tenantId);
    const since = new Date(this.now().getTime() - MEMBER_LIMITS.rankDays * DAY).toISOString();
    return { visits: await this.deps.store.visitsByMember(tenantId, since), cut: { silver: settings.rankSilver ?? null, gold: settings.rankGold ?? null } };
  }

  /** 1 人の会員を画面の形にする。 */
  private async viewOne(tenantId: string, m: StoredMember): Promise<Member> {
    return this.view(m, await this.rankContext(tenantId));
  }

  /** いまのランクの境の回数（画面に出す）。 */
  async rankCut(tenantId: string): Promise<RankCut & { auto: boolean; at: string | null }> {
    const s = await this.settings(tenantId);
    return { silver: s.rankSilver ?? null, gold: s.rankGold ?? null, auto: s.rankAuto !== false, at: s.rankAt ?? null };
  }

  /**
   * ランクの境の回数を、会社の会員の来店の分布から決め直す（自動のときだけ。第40.19節）。
   *
   * @returns 決めた境
   */
  async recomputeRanks(tenantId: string, now: Date = this.now()): Promise<RankCut> {
    const settings = await this.settings(tenantId);
    if (settings.rankAuto === false) return { silver: settings.rankSilver ?? null, gold: settings.rankGold ?? null };
    const since = new Date(now.getTime() - MEMBER_LIMITS.rankDays * DAY).toISOString();
    const live = new Set((await this.deps.store.list(tenantId, { limit: 5000 })).map((m) => m.id));
    const counts = [...(await this.deps.store.visitsByMember(tenantId, since)).entries()].filter(([id]) => live.has(id)).map(([, n]) => n);
    const cut = rankCutOf(counts);
    await this.deps.repo.saveTenantSettings(tenantId, 'members', { ...(await this.settings(tenantId)), rankSilver: cut.silver, rankGold: cut.gold, rankAt: now.toISOString() }, SYSTEM);
    return cut;
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
    // ランクの境の回数（管理者が決めると、自動で決め直さない。第40.19節）
    if (input['rankSilver'] !== undefined || input['rankGold'] !== undefined) {
      const silver = Number(input['rankSilver'] ?? next.rankSilver);
      const gold = Number(input['rankGold'] ?? next.rankGold);
      if (!Number.isInteger(silver) || !Number.isInteger(gold) || silver < 1 || gold <= silver || gold > MEMBER_LIMITS.rankDays) {
        return 'ランクの境は、シルバーは 1 回以上、ゴールドはシルバーより多い回数（年 365 回まで）で入れてください';
      }
      next.rankSilver = silver;
      next.rankGold = gold;
      next.rankAuto = false;
      next.rankAt = this.now().toISOString();
    }
    const backToAuto = input['rankAuto'] === true && next.rankAuto === false;
    if (backToAuto) next.rankAuto = true;
    const signageChanged = input['signage'] !== undefined && (input['signage'] === true) !== !!cur.signage;
    if (input['signage'] !== undefined) next.signage = input['signage'] === true;
    await this.deps.repo.saveTenantSettings(who.tenantId, 'members', next, who.userId);
    await this.audit(who, 'member.settings', 'settings', { fields: Object.keys(input) });
    if (backToAuto) await this.recomputeRanks(who.tenantId);
    if (signageChanged) await this.refreshSignage(who.tenantId).catch((err) => this.log.warn('特典のサイネージを作り直せませんでした', { error: String(err) }));
    return null;
  }

  // ---- 会員 ----------------------------------------------------------------------------------

  /** 一覧（会員番号の新しい順。呼び名・会員番号・電話で探す）。 */
  async list(who: MemberViewer, search = ''): Promise<Member[]> {
    const rc = await this.rankContext(who.tenantId);
    return (await this.deps.store.list(who.tenantId, { search })).map((m) => this.view(m, rc));
  }

  /** 1 件と、ポイントの記録と、まとめる候補（同じ電話・同じ呼び名）。見つからなければ `null`。 */
  async get(who: MemberViewer, id: string): Promise<{ member: Member; points: MemberPoint[]; candidates: Member[] } | null> {
    const m = await this.deps.store.get(who.tenantId, id);
    if (!m || m.mergedInto) return null;
    const names = new Map((await this.deps.repo.listUsers(who.tenantId)).map((u) => [u.id, u.displayName || u.email]));
    const points = (await this.deps.store.points(who.tenantId, id)).map((p) => this.pointView(p, names));
    const all = await this.deps.store.list(who.tenantId);
    const phone = digits(m.phone);
    const rc = await this.rankContext(who.tenantId);
    const candidates = all.filter((x) => x.id !== m.id && ((phone.length >= 9 && digits(x.phone) === phone) || x.nickname === m.nickname)).slice(0, 5).map((x) => this.view(x, rc));
    return { member: this.view(m, rc), points, candidates };
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
    const member = await this.viewOne(tenantId, m);
    const rewards = (await this.usableRewards(tenantId, today, member)).map((r) => ({ ...r, enough: m!.balance >= r.points }));
    return { member, rewards, cardKey: m.cardKey };
  }

  /** いま使える特典（誕生月だけの特典は誕生月の会員にだけ。第40.18節。ランクだけの特典はそのランク以上の会員にだけ。第40.19節）。 */
  private async usableRewards(tenantId: string, today: string, member: Pick<Member, 'birthday' | 'rank'> | null): Promise<MemberReward[]> {
    const month = today.slice(5, 7);
    return (await this.deps.store.rewards(tenantId)).filter((r) => r.status === 'active' && (!r.validFrom || r.validFrom <= today) && (!r.validTo || r.validTo >= today)
      && (!r.birthdayOnly || member?.birthday?.slice(0, 2) === month)
      && MEMBER_RANK_ORDER[member?.rank ?? 'regular'] >= MEMBER_RANK_ORDER[r.minRank]);
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
  async create(who: MemberViewer, input: { nickname?: unknown; phone?: unknown; birthday?: unknown }): Promise<{ member: Member; cardKey: string } | { error: string }> {
    const nickname = text(input.nickname, MEMBER_LIMITS.nicknameMax);
    if (!nickname) return { error: '呼び名を入れてください（ニックネームでかまいません）' };
    const phone = text(input.phone, 20);
    if (phone && digits(phone).length < 9) return { error: '電話は 9 桁以上の数字で入れてください（任意です）' };
    const birthday = birthdayOf(input.birthday);
    if (birthday === false) return { error: '誕生日は「3/14」のように月と日で入れてください（任意です）' };
    const cardKey = newCardKey();
    const id = await this.deps.store.create(who.tenantId, { nickname, phone, birthday, lineUserId: null, cardKey, createdBy: who.userId });
    return { member: await this.viewOne(who.tenantId, (await this.deps.store.get(who.tenantId, id))!), cardKey };
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
      if (m) return this.viewOne(tenantId, m);
    }
    const phone = digits(key.phone ?? '');
    if (phone.length < 9) return null;
    const hit = (await this.deps.store.list(tenantId, { search: phone })).find((m) => digits(m.phone) === phone);
    return hit ? this.viewOne(tenantId, hit) : null;
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
    return { member: await this.viewOne(who.tenantId, (await this.deps.store.get(who.tenantId, m.id))!), points: p.points };
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
    const r = (await this.usableRewards(who.tenantId, this.today(), await this.viewOne(who.tenantId, m))).find((x) => x.id === rewardId);
    if (!r) return { error: 'その特典はいま使えません（誕生月だけの特典は誕生月の会員だけ、ランクだけの特典はそのランクの会員だけが使えます）' };
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
  async update(who: MemberViewer, id: string, input: { nickname?: unknown; phone?: unknown; birthday?: unknown }): Promise<string | null> {
    const m = await this.target(who, id);
    if ('error' in m) return m.error;
    const patch: { nickname?: string; phone?: string; birthday?: string | null } = {};
    if (input.birthday !== undefined) {
      const b = birthdayOf(input.birthday);
      if (b === false) return '誕生日は「3/14」のように月と日で入れてください';
      patch.birthday = b;
    }
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

  private rewardInput(input: Record<string, unknown>): Partial<Pick<MemberReward, 'name' | 'points' | 'validFrom' | 'validTo' | 'status' | 'birthdayOnly' | 'minRank'>> | { error: string } {
    const out: Partial<Pick<MemberReward, 'name' | 'points' | 'validFrom' | 'validTo' | 'status' | 'birthdayOnly' | 'minRank'>> = {};
    if (input['birthdayOnly'] !== undefined) out.birthdayOnly = input['birthdayOnly'] === true;
    if (input['minRank'] !== undefined) {
      const v = input['minRank'] === null || input['minRank'] === '' ? 'regular' : input['minRank'];
      if (v !== 'regular' && v !== 'silver' && v !== 'gold') return { error: 'ランクは regular（全員）・silver（シルバー以上）・gold（ゴールドだけ）で入れてください' };
      out.minRank = v;
    }
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
    const id = await this.deps.store.createReward(who.tenantId, {
      name: v.name, points: v.points, birthdayOnly: !!v.birthdayOnly, minRank: v.minRank ?? 'regular', validFrom: v.validFrom ?? null, validTo: v.validTo ?? null,
    });
    await this.audit(who, 'member.reward.create', id, { points: v.points });
    void this.refreshSignage(who.tenantId).catch((err) => this.log.warn('特典のサイネージを作り直せませんでした', { error: String(err) }));
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
    void this.refreshSignage(who.tenantId).catch((err) => this.log.warn('特典のサイネージを作り直せませんでした', { error: String(err) }));
    return null;
  }

  // ---- 店頭サイネージ（第40.19節） --------------------------------------------------------------

  /**
   * 店頭サイネージに流す特典の 1 枚を作り直す。会社が「サイネージに特典を流す」にしていて、サイネージを使っていれば、
   * いま使える特典（ポイントの少ない順に 6 つまで）を 1 枚にして、すべての画面の流れの先頭に足す。中身が同じなら作り直さない。
   * 切った・特典が無い・サイネージを使っていなければ、流している 1 枚を外す。
   *
   * @returns 足したか・外したか・そのままか
   * @remarks 危険度: 低（会社の中の画面に出す。社外への送信に当たらない。ADR-0051）
   */
  async refreshSignage(tenantId: string): Promise<'added' | 'removed' | 'same'> {
    // 同じ会社の作り直しは 1 つずつ（特典を足した直後の作り直しと見張りが重なっても、2 枚にしない）
    const prev = this.signageQueue.get(tenantId) ?? Promise.resolve();
    const next = prev.catch(() => undefined).then(() => this.refreshSignageNow(tenantId));
    this.signageQueue.set(tenantId, next);
    try {
      return await next;
    } finally {
      if (this.signageQueue.get(tenantId) === next) this.signageQueue.delete(tenantId);
    }
  }

  private async refreshSignageNow(tenantId: string): Promise<'added' | 'removed' | 'same'> {
    if (!this.deps.signage) return 'same';
    const settings = await this.settings(tenantId);
    const today = this.today();
    const rewards = settings.enabled && settings.signage
      ? (await this.deps.store.rewards(tenantId)).filter((r) => r.status === 'active' && (!r.validFrom || r.validFrom <= today) && (!r.validTo || r.validTo >= today))
      : [];
    const r = await refreshRewardSignage(this.deps.signage, tenantId, rewards, { assetId: settings.signageAssetId ?? null, digest: settings.signageDigest ?? null });
    if (r.result !== 'same') {
      await this.deps.repo.saveTenantSettings(tenantId, 'members', { ...(await this.settings(tenantId)), signageAssetId: r.assetId, signageDigest: r.digest }, SYSTEM);
    }
    return r.result;
  }

  // ---- 会員への LINE の知らせ（段 2。第40.18節） -------------------------------------------------

  /** 宛先の会員（LINE でつながっている、まとめていない会員のうち、宛先に当たる人）。 */
  private async audienceOf(tenantId: string, audience: MemberAudience, now: Date): Promise<StoredMember[]> {
    const { expiryDays } = await this.settings(tenantId);
    const today = jstDay(now);
    const in30 = jstDay(new Date(now.getTime() + 30 * DAY));
    const before60 = now.getTime() - 60 * DAY;
    return (await this.deps.store.list(tenantId, { limit: 5000 })).filter((m) => !!m.lineUserId).filter((m) => {
      if (audience === 'away') return Date.parse(m.lastVisitAt ?? m.createdAt) < before60;
      if (audience === 'expiring') { const d = expiryDayOf(m, expiryDays); return m.balance > 0 && d >= today && d <= in30; }
      return true;
    });
  }

  /** 宛先ごとの、LINE でつながっている会員の数（知らせを用意する前に見せる）。 */
  async audienceCounts(who: MemberViewer): Promise<Record<MemberAudience, number>> {
    const now = this.now();
    const out = {} as Record<MemberAudience, number>;
    for (const a of Object.keys(MEMBER_AUDIENCE_LABELS) as MemberAudience[]) out[a] = (await this.audienceOf(who.tenantId, a, now)).length;
    return out;
  }

  /** 知らせの一覧（新しい順）。承認されなかった・失敗した実行は、知らせの状態に写す。 */
  async messages(who: MemberViewer): Promise<MemberMessage[]> {
    const list = await this.deps.store.listMessages(who.tenantId);
    for (const m of list) {
      if (m.status !== 'awaiting' || !m.runId || !this.deps.runStatus) continue;
      const st = await this.deps.runStatus(who.tenantId, m.runId).catch(() => null);
      if (st === 'rejected' || st === 'cancelled' || st === 'expired') { m.status = 'rejected'; await this.deps.store.updateMessage(who.tenantId, m.id, { status: 'rejected' }); }
      else if (st === 'failed') { m.status = 'failed'; await this.deps.store.updateMessage(who.tenantId, m.id, { status: 'failed' }); }
    }
    return list.map(({ recipients: _r, ...m }) => m);
  }

  /**
   * 会員への LINE の知らせを用意して、承認へ進める（管理者だけ）。送るのは承認の後（社外への送信。第9.4.0節）。
   *
   * @param kind 失効の前の知らせ（自動）か、管理者が書いたものか
   * @returns 用意した知らせか、用意できない理由
   */
  async prepareMessage(
    who: MemberViewer, input: { audience?: unknown; text?: unknown }, kind: MemberMessage['kind'] = 'custom', exclude: ReadonlySet<string> = new Set(), requester?: string,
  ): Promise<{ message: MemberMessage } | { error: string }> {
    if (who.userId !== SYSTEM && !(await this.isAdmin(who))) return { error: '会員に LINE で知らせるのは管理者だけです' };
    const audience = String(input.audience ?? '') as MemberAudience;
    if (!(audience in MEMBER_AUDIENCE_LABELS)) return { error: '宛先が違います' };
    const body = typeof input.text === 'string' ? input.text.trim().slice(0, MEMBER_MESSAGE_MAX) : '';
    if (!body) return { error: '知らせる文を入れてください' };
    if (!this.deps.line || !this.deps.submitter) return { error: 'LINE の知らせは使えません' };
    const line = await openLine(this.deps.line, who.tenantId).catch(() => null);
    if (!line) return { error: '会社の LINE 公式アカウントをつないでいません（問い合わせの記録の設定でつなぎます）' };
    const recipients = (await this.audienceOf(who.tenantId, audience, this.now())).filter((m) => !exclude.has(m.id)).map((m) => m.id);
    if (!recipients.length) return { error: `${MEMBER_AUDIENCE_LABELS[audience]}で LINE でつながっている会員がいません` };
    const id = await this.deps.store.createMessage(who.tenantId, { kind, audience, text: body, recipients, createdBy: who.userId });
    // 仕組みが用意したときは、業務を管理者の名前で起こす（承認は管理者が行う）
    const runId = await this.deps.submitter(who.tenantId, requester ?? who.userId, id);
    await this.deps.store.updateMessage(who.tenantId, id, { status: 'awaiting', runId });
    await this.audit(who, 'member.line.submit', id, { kind, audience, count: recipients.length });
    const { recipients: _r, ...m } = (await this.deps.store.getMessage(who.tenantId, id))!;
    return { message: m };
  }

  /** 承認の画面に出すもの（宛先の数・1 人目に差し込んだ文・LINE の残り）。送れないなら理由。 */
  async previewMessage(tenantId: string, id: string): Promise<{ count: number; sample: string; audience: string; remaining: number | null; digest: string } | { error: string }> {
    const m = await this.deps.store.getMessage(tenantId, id);
    if (!m) return { error: '知らせが見つかりません' };
    if (m.status !== 'awaiting' && m.status !== 'draft') return { error: 'この知らせはもう送ったか、取りやめました' };
    const { expiryDays } = await this.settings(tenantId);
    const first = m.recipients.length ? await this.deps.store.get(tenantId, m.recipients[0]!) : null;
    const line = this.deps.line ? await openLine(this.deps.line, tenantId).catch(() => null) : null;
    if (!line) return { error: '会社の LINE 公式アカウントをつないでいません' };
    const quota = await line.client.quota().catch(() => null);
    const remaining = quota && quota.limit !== null ? quota.limit - quota.used : null;
    if (remaining !== null && remaining < m.recipients.length) return { error: `LINE の今月の残り（${remaining} 通）より宛先（${m.recipients.length} 人）が多いため送れません` };
    return {
      count: m.recipients.length, audience: MEMBER_AUDIENCE_LABELS[m.audience], remaining, digest: messageDigest(m),
      sample: first ? renderMemberText(m.text, first, expiryDays) : m.text,
    };
  }

  /**
   * 承認された知らせを送る（社外への送信。承認の後にだけ呼ばれる）。1 人ずつ文を差し込んで LINE で送り、結果を作った人に知らせる。
   *
   * @param digest 承認したときの中身の印（変わっていたら送らない）
   * @returns 送れた数か、送れない理由
   */
  async sendMessage(who: MemberViewer, id: string, digest: string): Promise<{ sent: number; failed: number } | { error: string }> {
    const m = await this.deps.store.getMessage(who.tenantId, id);
    if (!m) return { error: '知らせが見つかりません' };
    if (m.status !== 'awaiting') return { error: 'この知らせはもう送ったか、取りやめました' };
    if (messageDigest(m) !== digest) return { error: '承認の後に中身が変わったため、送りません' };
    const line = this.deps.line ? await openLine(this.deps.line, who.tenantId).catch(() => null) : null;
    if (!line) {
      await this.deps.store.updateMessage(who.tenantId, id, { status: 'failed', note: 'LINE 公式アカウントをつないでいません' });
      return { error: '会社の LINE 公式アカウントをつないでいません' };
    }
    const { expiryDays } = await this.settings(who.tenantId);
    let sent = 0;
    let failed = 0;
    for (const memberId of m.recipients) {
      const member = await this.deps.store.get(who.tenantId, memberId);
      // 退会・まとめた・LINE を外した会員には送らない
      if (!member || member.mergedInto || !member.lineUserId) { failed += 1; continue; }
      try {
        await line.client.push(member.lineUserId, renderMemberText(m.text, member, expiryDays));
        sent += 1;
      } catch {
        failed += 1;
      }
    }
    const status = sent > 0 ? 'sent' : 'failed';
    await this.deps.store.updateMessage(who.tenantId, id, { status, sent, sentAt: this.now().toISOString(), note: failed ? `送れなかった ${failed} 人` : '' });
    await this.audit(who, 'member.line.send', id, { kind: m.kind, sent, failed });
    await this.notifyUser(who.tenantId, m.createdBy === SYSTEM ? who.userId : m.createdBy, `会員への LINE の知らせを送りました（${sent} 人）`,
      `${MEMBER_AUDIENCE_LABELS[m.audience]}に送りました。${failed ? `送れなかった人: ${failed} 人（退会・LINE を外したなど）。` : ''}`);
    return { sent, failed };
  }

  /** 1 人に知らせる（会員の知らせを切った人には送らない）。 */
  private async notifyUser(tenantId: string, userId: string, title: string, body: string): Promise<void> {
    const { repo } = this.deps;
    const user = await repo.findUserById(tenantId, userId);
    if (!user || user.status !== 'active') return;
    const prefs = await repo.getUserSettings(tenantId, userId).catch(() => null);
    if (prefs?.notifications.kinds.member === false) return;
    await repo.createNotification({ id: randomUUID(), tenantId, userId, kind: 'member', title, body: body.slice(0, 400), runId: null, readAt: null, createdAt: this.now().toISOString() });
  }

  /**
   * 週の見立て（第40.18節）。新しい会員・来店の回数（先週と比べる）・しばらく来ていない会員・失効が近い会員を数える（プログラムが数える）。
   * 失効が近い LINE の会員がいれば、失効の前の知らせを用意して承認へ進める（60 日のうちに知らせた人には送らない）。
   */
  private async weekly(tenantId: string, now: Date): Promise<void> {
    const settings = await this.settings(tenantId);
    const all = await this.deps.store.list(tenantId, { limit: 5000 });
    const weekAgo = now.getTime() - 7 * DAY;
    const twoWeeksAgo = now.getTime() - 14 * DAY;
    const fresh = all.filter((m) => Date.parse(m.createdAt) >= weekAgo).length;
    const visits = await this.deps.store.visitCount(tenantId, new Date(weekAgo).toISOString(), now.toISOString());
    const lastVisits = await this.deps.store.visitCount(tenantId, new Date(twoWeeksAgo).toISOString(), new Date(weekAgo).toISOString());
    const away = all.filter((m) => m.visits > 0 && Date.parse(m.lastVisitAt ?? m.createdAt) < now.getTime() - 60 * DAY).length;
    const today = jstDay(now);
    const in30 = jstDay(new Date(now.getTime() + 30 * DAY));
    const expiring = all.filter((m) => { const d = expiryDayOf(m, settings.expiryDays); return m.balance > 0 && d >= today && d <= in30; });
    const admins = (await this.deps.repo.listUsers(tenantId)).filter((u) => u.status === 'active' && u.roles.includes('admin'));
    let proposed = '';
    // 失効の前の知らせ（自動で用意し、管理者の承認を待つ）。60 日のうちに用意・送った人は外す
    if (expiring.some((m) => m.lineUserId) && admins[0] && this.deps.line && this.deps.submitter) {
      const since = now.getTime() - 60 * DAY;
      const done = new Set((await this.deps.store.listMessages(tenantId, 100))
        .filter((x) => x.kind === 'expiry' && ['awaiting', 'sent'].includes(x.status) && Date.parse(x.createdAt) >= since).flatMap((x) => x.recipients));
      const r = await this.prepareMessage({ tenantId, userId: SYSTEM }, { audience: 'expiring', text: MEMBER_EXPIRY_TEXT }, 'expiry', done, admins[0].id).catch(() => null);
      if (r && 'message' in r) proposed = `失効が近い LINE の会員 ${r.message.count} 人への知らせを用意し、承認待ちにしました（承認トレイで確かめてください）。`;
    }
    const rc = await this.rankContext(tenantId);
    const ranked = all.map((m) => this.view(m, rc).rank);
    const rankLine = rc.cut.gold !== null && rc.cut.silver !== null
      ? `ゴールド ${ranked.filter((r) => r === 'gold').length} 人・シルバー ${ranked.filter((r) => r === 'silver').length} 人（直近 1 年の来店 ${rc.cut.gold} 回・${rc.cut.silver} 回から）。`
      : '';
    const body = [
      `会員 ${all.length} 人（今週の新しい会員 ${fresh} 人）。`,
      rankLine,
      `今週の来店 ${visits} 回（先週 ${lastVisits} 回）。`,
      `しばらく（60 日）来ていない会員 ${away} 人。`,
      `30 日のうちにポイントが失効する会員 ${expiring.length} 人。`,
      proposed,
    ].join('');
    for (const u of admins) {
      if (!canUseAgent((await this.deps.repo.getTenantSettings(tenantId)).access, MEMBERS_EXTENSION_ID, u.id, await this.deps.repo.listUserGroupIds(tenantId, u.id))) continue;
      await this.notifyUser(tenantId, u.id, '会員の週の見立て', body);
    }
    await this.deps.repo.saveTenantSettings(tenantId, 'members', { ...(await this.settings(tenantId)), digestAt: now.toISOString() }, SYSTEM);
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
        if (!settings.enabled) {
          // 切った会社のサイネージの 1 枚は外す
          if (settings.signageAssetId) await this.refreshSignage(tenantId).catch(() => undefined);
          continue;
        }
        // 週の見立て（月曜の 8 時（日本時間）を過ぎて、前の見立てから 6 日より空いたら）
        const jst = new Date(now.getTime() + 9 * 3_600_000);
        // ランクの境は月に 1 回決め直す（自動のとき。初めては、すぐ。第40.19節）
        const month = jst.toISOString().slice(0, 7);
        const rankMonth = settings.rankAt ? new Date(Date.parse(settings.rankAt) + 9 * 3_600_000).toISOString().slice(0, 7) : null;
        if (settings.rankAuto !== false && (!rankMonth || (rankMonth !== month && jst.getUTCHours() >= 8))) await this.recomputeRanks(tenantId, now);
        if (jst.getUTCDay() === 1 && jst.getUTCHours() >= 8 && (!settings.digestAt || now.getTime() - Date.parse(settings.digestAt) > 6 * DAY)) {
          await this.weekly(tenantId, now);
        }
        // 特典の期間が始まった・終わったら、サイネージの 1 枚を作り直す（中身が同じなら何もしない）
        await this.refreshSignage(tenantId).catch((err) => this.log.warn('特典のサイネージを作り直せませんでした', { tenantId, error: String(err) }));
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
