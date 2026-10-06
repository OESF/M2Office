/**
 * @file 会員とポイントの置き場（仕様書 第40.13節）。PostgreSQL（行単位の制限つき）と、テスト用のメモリ。
 *
 * ポイントの記録は追記のみ（PostgreSQL ではアプリのロールに更新と削除を許さない）。いまのポイント・来店の回数・最後の来店は記録から求める。
 * 取り消された記録（`reversal_of` で指された記録）は、来店の回数と最後の来店に数えない。
 */

import { randomUUID } from 'node:crypto';
import pg from 'pg';
import type { MemberPointKind, MemberReward } from '@m2office/shared';

/** 置き場に持つ会員（数は記録から求めたもの）。 */
export interface StoredMember {
  id: string;
  number: number;
  nickname: string;
  phone: string;
  lineUserId: string | null;
  cardKey: string;
  mergedInto: string | null;
  balance: number;
  visits: number;
  lastVisitAt: string | null;
  lastEarnedAt: string | null;
  createdBy: string;
  createdAt: string;
}

/** 置き場に持つポイントの記録。 */
export interface StoredPoint {
  id: string;
  memberId: string;
  kind: MemberPointKind;
  points: number;
  rewardId: string | null;
  rewardName: string;
  reversalOf: string | null;
  reversed: boolean;
  note: string;
  /** 日本時間の日付（来店は 1 日 1 回まで） */
  localDay: string;
  createdBy: string;
  createdAt: string;
}

/** 新しく足す記録。 */
export type NewPoint = Pick<StoredPoint, 'memberId' | 'kind' | 'points' | 'rewardId' | 'rewardName' | 'reversalOf' | 'note' | 'localDay' | 'createdBy'>;

/** 会員の置き場。 */
export interface MemberStore {
  list(tenantId: string, q?: { search?: string; limit?: number }): Promise<StoredMember[]>;
  get(tenantId: string, id: string): Promise<StoredMember | null>;
  byCardKey(tenantId: string, key: string): Promise<StoredMember | null>;
  byLineUser(tenantId: string, lineUserId: string): Promise<StoredMember | null>;
  create(tenantId: string, m: { nickname: string; phone: string; lineUserId: string | null; cardKey: string; createdBy: string }): Promise<string>;
  update(tenantId: string, id: string, patch: Partial<Pick<StoredMember, 'nickname' | 'phone' | 'lineUserId' | 'mergedInto'>>): Promise<void>;
  delete(tenantId: string, id: string): Promise<void>;
  addPoint(tenantId: string, p: NewPoint): Promise<string>;
  points(tenantId: string, memberId: string, limit?: number): Promise<StoredPoint[]>;
  getPoint(tenantId: string, id: string): Promise<StoredPoint | null>;
  rewards(tenantId: string): Promise<MemberReward[]>;
  getReward(tenantId: string, id: string): Promise<MemberReward | null>;
  createReward(tenantId: string, r: Pick<MemberReward, 'name' | 'points' | 'validFrom' | 'validTo'>): Promise<string>;
  updateReward(tenantId: string, id: string, patch: Partial<Pick<MemberReward, 'name' | 'points' | 'validFrom' | 'validTo' | 'status'>>): Promise<void>;
}

const iso = (v: unknown): string => (v instanceof Date ? v.toISOString() : new Date(String(v ?? '')).toISOString());
const isoOrNull = (v: unknown): string | null => (v ? iso(v) : null);
const day = (v: unknown): string | null => {
  if (!v) return null;
  if (v instanceof Date) return new Date(v.getTime() - v.getTimezoneOffset() * 60_000).toISOString().slice(0, 10);
  return String(v).slice(0, 10);
};

/** 貯めたことになる記録（有効期限の起点）。 */
const EARNING: MemberPointKind[] = ['visit', 'purchase', 'adjust'];

interface MemberRow {
  id: string; number: number; nickname: string; phone: string; line_user_id: string | null; card_key: string; merged_into: string | null;
  created_by: string; created_at: unknown; balance: string | number | null; visits: string | number | null; last_visit: unknown; last_earned: unknown;
}
interface PointRow {
  id: string; member_id: string; kind: MemberPointKind; points: number; reward_id: string | null; reward_name: string; reversal_of: string | null;
  reversed: boolean | null; note: string; local_day: unknown; created_by: string; created_at: unknown;
}
interface RewardRow { id: string; name: string; points: number; valid_from: unknown; valid_to: unknown; status: 'active' | 'stopped'; created_at: unknown }

const toMember = (r: MemberRow): StoredMember => ({
  id: r.id, number: r.number, nickname: r.nickname, phone: r.phone, lineUserId: r.line_user_id, cardKey: r.card_key, mergedInto: r.merged_into,
  balance: Number(r.balance ?? 0), visits: Number(r.visits ?? 0), lastVisitAt: isoOrNull(r.last_visit), lastEarnedAt: isoOrNull(r.last_earned),
  createdBy: r.created_by, createdAt: iso(r.created_at),
});
const toPoint = (r: PointRow): StoredPoint => ({
  id: r.id, memberId: r.member_id, kind: r.kind, points: r.points, rewardId: r.reward_id, rewardName: r.reward_name, reversalOf: r.reversal_of,
  reversed: !!r.reversed, note: r.note, localDay: day(r.local_day)!, createdBy: r.created_by, createdAt: iso(r.created_at),
});
const toReward = (r: RewardRow): MemberReward => ({
  id: r.id, name: r.name, points: r.points, validFrom: day(r.valid_from), validTo: day(r.valid_to), status: r.status, createdAt: iso(r.created_at),
});

/** 会員の行と、記録から求めた数。 */
const MEMBER_SELECT = `
  select m.*,
    coalesce((select sum(p.points) from member_points p where p.tenant_id = m.tenant_id and p.member_id = m.id), 0) as balance,
    (select count(*) from member_points p where p.tenant_id = m.tenant_id and p.member_id = m.id and p.kind = 'visit'
       and not exists (select 1 from member_points u where u.tenant_id = p.tenant_id and u.reversal_of = p.id)) as visits,
    (select max(p.created_at) from member_points p where p.tenant_id = m.tenant_id and p.member_id = m.id and p.kind = 'visit'
       and not exists (select 1 from member_points u where u.tenant_id = p.tenant_id and u.reversal_of = p.id)) as last_visit,
    (select max(p.created_at) from member_points p where p.tenant_id = m.tenant_id and p.member_id = m.id and p.kind in ('visit', 'purchase', 'adjust') and p.points > 0
       and not exists (select 1 from member_points u where u.tenant_id = p.tenant_id and u.reversal_of = p.id)) as last_earned
  from members m`;

/** PostgreSQL の置き場。会社ごとに `app.tenant_id` を入れて行単位の制限を効かせる。 */
export class PostgresMemberStore implements MemberStore {
  private readonly pool: pg.Pool;

  constructor(connectionString: string) {
    this.pool = new pg.Pool({ connectionString, max: 4 });
  }

  private async q<T extends pg.QueryResultRow>(tenantId: string, text: string, params: unknown[] = []): Promise<T[]> {
    const c = await this.pool.connect();
    try {
      await c.query('begin');
      await c.query(`select set_config('app.tenant_id', $1, true)`, [tenantId]);
      const r = await c.query<T>(text, params);
      await c.query('commit');
      return r.rows;
    } catch (err) {
      await c.query('rollback').catch(() => undefined);
      throw err;
    } finally {
      c.release();
    }
  }

  async list(tenantId: string, q: { search?: string; limit?: number } = {}): Promise<StoredMember[]> {
    const params: unknown[] = [tenantId];
    let where = `m.tenant_id = $1 and m.merged_into is null`;
    const w = q.search?.trim();
    if (w) {
      params.push(`%${w.replace(/[\\%_]/g, (x) => `\\${x}`)}%`);
      const p = `$${params.length}`;
      params.push(w.replace(/\D/g, '') || '-');
      where += ` and (m.nickname ilike ${p} or m.number::text = $${params.length} or regexp_replace(m.phone, '[^0-9]', '', 'g') like '%' || $${params.length} || '%')`;
    }
    params.push(Math.min(Math.max(q.limit ?? 1000, 1), 5000));
    return (await this.q<MemberRow>(tenantId, `${MEMBER_SELECT} where ${where} order by m.number desc limit $${params.length}`, params)).map(toMember);
  }

  async get(tenantId: string, id: string): Promise<StoredMember | null> {
    const rows = await this.q<MemberRow>(tenantId, `${MEMBER_SELECT} where m.tenant_id = $1 and m.id = $2`, [tenantId, id]);
    return rows[0] ? toMember(rows[0]) : null;
  }

  async byCardKey(tenantId: string, key: string): Promise<StoredMember | null> {
    const rows = await this.q<MemberRow>(tenantId, `${MEMBER_SELECT} where m.tenant_id = $1 and m.card_key = $2`, [tenantId, key]);
    return rows[0] ? toMember(rows[0]) : null;
  }

  async byLineUser(tenantId: string, lineUserId: string): Promise<StoredMember | null> {
    const rows = await this.q<MemberRow>(tenantId, `${MEMBER_SELECT} where m.tenant_id = $1 and m.line_user_id = $2 and m.merged_into is null`, [tenantId, lineUserId]);
    return rows[0] ? toMember(rows[0]) : null;
  }

  async create(tenantId: string, m: { nickname: string; phone: string; lineUserId: string | null; cardKey: string; createdBy: string }): Promise<string> {
    const id = `mbr-${randomUUID()}`;
    // 会員番号は会社の中の連番。同時に作って重なったら、もう一度だけ番号を取り直す
    for (let i = 0; ; i++) {
      try {
        await this.q(tenantId,
          `insert into members (id, tenant_id, number, nickname, phone, line_user_id, card_key, created_by)
           select $1, $2, coalesce(max(number), 0) + 1, $3, $4, $5, $6, $7 from members where tenant_id = $2`,
          [id, tenantId, m.nickname, m.phone, m.lineUserId, m.cardKey, m.createdBy]);
        return id;
      } catch (err) {
        if ((err as { code?: string }).code !== '23505' || i >= 2) throw err;
      }
    }
  }

  async update(tenantId: string, id: string, patch: Partial<Pick<StoredMember, 'nickname' | 'phone' | 'lineUserId' | 'mergedInto'>>): Promise<void> {
    const cols: Record<string, string> = { nickname: 'nickname', phone: 'phone', lineUserId: 'line_user_id', mergedInto: 'merged_into' };
    const sets: string[] = [];
    const params: unknown[] = [tenantId, id];
    for (const [k, v] of Object.entries(patch)) {
      if (v === undefined || !cols[k]) continue;
      params.push(v);
      sets.push(`${cols[k]} = $${params.length}`);
    }
    if (sets.length) await this.q(tenantId, `update members set ${sets.join(', ')} where tenant_id = $1 and id = $2`, params);
  }

  async delete(tenantId: string, id: string): Promise<void> {
    await this.q(tenantId, `delete from members where tenant_id = $1 and id = $2`, [tenantId, id]);
  }

  async addPoint(tenantId: string, p: NewPoint): Promise<string> {
    const id = `mpt-${randomUUID()}`;
    await this.q(tenantId,
      `insert into member_points (id, tenant_id, member_id, kind, points, reward_id, reward_name, reversal_of, note, local_day, created_by)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
      [id, tenantId, p.memberId, p.kind, p.points, p.rewardId, p.rewardName, p.reversalOf, p.note, p.localDay, p.createdBy]);
    return id;
  }

  async points(tenantId: string, memberId: string, limit = 200): Promise<StoredPoint[]> {
    const rows = await this.q<PointRow>(tenantId,
      `select p.*, exists (select 1 from member_points u where u.tenant_id = p.tenant_id and u.reversal_of = p.id) as reversed
         from member_points p where p.tenant_id = $1 and p.member_id = $2 order by p.created_at desc limit $3`, [tenantId, memberId, limit]);
    return rows.map(toPoint);
  }

  async getPoint(tenantId: string, id: string): Promise<StoredPoint | null> {
    const rows = await this.q<PointRow>(tenantId,
      `select p.*, exists (select 1 from member_points u where u.tenant_id = p.tenant_id and u.reversal_of = p.id) as reversed
         from member_points p where p.tenant_id = $1 and p.id = $2`, [tenantId, id]);
    return rows[0] ? toPoint(rows[0]) : null;
  }

  async rewards(tenantId: string): Promise<MemberReward[]> {
    return (await this.q<RewardRow>(tenantId, `select * from member_rewards where tenant_id = $1 order by points, created_at`, [tenantId])).map(toReward);
  }

  async getReward(tenantId: string, id: string): Promise<MemberReward | null> {
    const rows = await this.q<RewardRow>(tenantId, `select * from member_rewards where tenant_id = $1 and id = $2`, [tenantId, id]);
    return rows[0] ? toReward(rows[0]) : null;
  }

  async createReward(tenantId: string, r: Pick<MemberReward, 'name' | 'points' | 'validFrom' | 'validTo'>): Promise<string> {
    const id = `mrw-${randomUUID()}`;
    await this.q(tenantId, `insert into member_rewards (id, tenant_id, name, points, valid_from, valid_to) values ($1, $2, $3, $4, $5, $6)`,
      [id, tenantId, r.name, r.points, r.validFrom, r.validTo]);
    return id;
  }

  async updateReward(tenantId: string, id: string, patch: Partial<Pick<MemberReward, 'name' | 'points' | 'validFrom' | 'validTo' | 'status'>>): Promise<void> {
    const cols: Record<string, string> = { name: 'name', points: 'points', validFrom: 'valid_from', validTo: 'valid_to', status: 'status' };
    const sets: string[] = [];
    const params: unknown[] = [tenantId, id];
    for (const [k, v] of Object.entries(patch)) {
      if (v === undefined || !cols[k]) continue;
      params.push(v);
      sets.push(`${cols[k]} = $${params.length}`);
    }
    if (sets.length) await this.q(tenantId, `update member_rewards set ${sets.join(', ')} where tenant_id = $1 and id = $2`, params);
  }
}

/** テスト用のメモリの置き場（記録は追記のみ）。 */
export class MemoryMemberStore implements MemberStore {
  readonly members = new Map<string, Omit<StoredMember, 'balance' | 'visits' | 'lastVisitAt' | 'lastEarnedAt'> & { tenantId: string }>();
  readonly records: (Omit<StoredPoint, 'reversed'> & { tenantId: string })[] = [];
  readonly rewardRows = new Map<string, MemberReward & { tenantId: string }>();
  private clock = 0;

  private withStats(m: Omit<StoredMember, 'balance' | 'visits' | 'lastVisitAt' | 'lastEarnedAt'> & { tenantId: string }): StoredMember {
    const mine = this.records.filter((p) => p.tenantId === m.tenantId && p.memberId === m.id);
    const reversed = new Set(this.records.filter((p) => p.tenantId === m.tenantId && p.reversalOf).map((p) => p.reversalOf));
    const live = mine.filter((p) => !reversed.has(p.id));
    const visits = live.filter((p) => p.kind === 'visit');
    const earned = live.filter((p) => EARNING.includes(p.kind) && p.points > 0);
    const max = (xs: typeof mine) => xs.map((x) => x.createdAt).sort().at(-1) ?? null;
    const { tenantId: _t, ...rest } = m;
    return { ...rest, balance: mine.reduce((a, p) => a + p.points, 0), visits: visits.length, lastVisitAt: max(visits), lastEarnedAt: max(earned) };
  }

  /** 記録の時刻（テストでは足した順に 1 ミリ秒ずつ進める）。 */
  now: () => Date = () => new Date(Date.now() + this.clock++);

  async list(tenantId: string, q: { search?: string; limit?: number } = {}): Promise<StoredMember[]> {
    const w = q.search?.trim() ?? '';
    const digits = w.replace(/\D/g, '');
    return [...this.members.values()].filter((m) => m.tenantId === tenantId && !m.mergedInto)
      .filter((m) => !w || m.nickname.includes(w) || String(m.number) === digits || (!!digits && m.phone.replace(/\D/g, '').includes(digits)))
      .sort((a, b) => b.number - a.number).slice(0, q.limit ?? 1000).map((m) => this.withStats(m));
  }

  async get(tenantId: string, id: string): Promise<StoredMember | null> {
    const m = this.members.get(id);
    return m && m.tenantId === tenantId ? this.withStats(m) : null;
  }

  async byCardKey(tenantId: string, key: string): Promise<StoredMember | null> {
    const m = [...this.members.values()].find((x) => x.tenantId === tenantId && x.cardKey === key);
    return m ? this.withStats(m) : null;
  }

  async byLineUser(tenantId: string, lineUserId: string): Promise<StoredMember | null> {
    const m = [...this.members.values()].find((x) => x.tenantId === tenantId && x.lineUserId === lineUserId && !x.mergedInto);
    return m ? this.withStats(m) : null;
  }

  async create(tenantId: string, m: { nickname: string; phone: string; lineUserId: string | null; cardKey: string; createdBy: string }): Promise<string> {
    const id = `mbr-${randomUUID()}`;
    const number = Math.max(0, ...[...this.members.values()].filter((x) => x.tenantId === tenantId).map((x) => x.number)) + 1;
    this.members.set(id, { ...m, id, tenantId, number, mergedInto: null, createdAt: this.now().toISOString() });
    return id;
  }

  async update(tenantId: string, id: string, patch: Partial<Pick<StoredMember, 'nickname' | 'phone' | 'lineUserId' | 'mergedInto'>>): Promise<void> {
    const m = this.members.get(id);
    if (m && m.tenantId === tenantId) this.members.set(id, { ...m, ...Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined)) });
  }

  async delete(tenantId: string, id: string): Promise<void> {
    const m = this.members.get(id);
    if (m && m.tenantId === tenantId) this.members.delete(id);
  }

  async addPoint(tenantId: string, p: NewPoint): Promise<string> {
    if (p.reversalOf && this.records.some((r) => r.tenantId === tenantId && r.reversalOf === p.reversalOf)) throw new Error('もう取り消してあります');
    const id = `mpt-${randomUUID()}`;
    this.records.push({ ...p, id, tenantId, createdAt: this.now().toISOString() });
    return id;
  }

  private pointView(r: Omit<StoredPoint, 'reversed'> & { tenantId: string }): StoredPoint {
    const { tenantId, ...rest } = r;
    return { ...rest, reversed: this.records.some((u) => u.tenantId === tenantId && u.reversalOf === r.id) };
  }

  async points(tenantId: string, memberId: string, limit = 200): Promise<StoredPoint[]> {
    return this.records.filter((r) => r.tenantId === tenantId && r.memberId === memberId).map((r) => this.pointView(r))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, limit);
  }

  async getPoint(tenantId: string, id: string): Promise<StoredPoint | null> {
    const r = this.records.find((x) => x.tenantId === tenantId && x.id === id);
    return r ? this.pointView(r) : null;
  }

  async rewards(tenantId: string): Promise<MemberReward[]> {
    return [...this.rewardRows.values()].filter((r) => r.tenantId === tenantId).map(({ tenantId: _t, ...r }) => ({ ...r })).sort((a, b) => a.points - b.points);
  }

  async getReward(tenantId: string, id: string): Promise<MemberReward | null> {
    const r = this.rewardRows.get(id);
    if (!r || r.tenantId !== tenantId) return null;
    const { tenantId: _t, ...rest } = r;
    return { ...rest };
  }

  async createReward(tenantId: string, r: Pick<MemberReward, 'name' | 'points' | 'validFrom' | 'validTo'>): Promise<string> {
    const id = `mrw-${randomUUID()}`;
    this.rewardRows.set(id, { ...r, id, tenantId, status: 'active', createdAt: this.now().toISOString() });
    return id;
  }

  async updateReward(tenantId: string, id: string, patch: Partial<Pick<MemberReward, 'name' | 'points' | 'validFrom' | 'validTo' | 'status'>>): Promise<void> {
    const r = this.rewardRows.get(id);
    if (r && r.tenantId === tenantId) this.rewardRows.set(id, { ...r, ...Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined)) });
  }
}
