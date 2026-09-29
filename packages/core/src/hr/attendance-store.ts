/**
 * @file 勤怠と休暇の置き場（仕様書 第30.24節。段 2）。打刻・締め・有給の付与と取得・知らせの印を PostgreSQL に持つ。
 *
 * すべての問い合わせを会社（テナント）を設定したトランザクションで行う（不変則 I-2）。
 * 打刻・付与・取得は消さない。直すときは前の打刻に印を付け、取り消すときは取得に印を付ける。
 */

import pg from 'pg';
import type { AttClose, AttPunch, AttPunchKind, AttTotals, LeaveGrant, LeaveTake } from '@m2office/shared';

const iso = (v: unknown): string => (v instanceof Date ? v.toISOString() : String(v ?? ''));
const day = (v: unknown): string => String(v ?? '').slice(0, 10);

/** 勤怠と休暇の置き場。 */
export interface AttendanceStore {
  listPunches(tenantId: string, q: { employeeId?: string; from: string; to: string }): Promise<AttPunch[]>;
  addPunch(tenantId: string, p: AttPunch & { createdBy: string }): Promise<void>;
  /** 打刻に「直した」の印を付ける（消さない）。 */
  replacePunches(tenantId: string, employeeId: string, ids: string[], by: string): Promise<number>;
  lastPunch(tenantId: string, employeeId: string): Promise<AttPunch | null>;
  /** 従業員ごとの最初の打刻の日（日本時間）。打刻を始める前の日を「打刻がありません」と指摘しないため。 */
  firstPunchDates(tenantId: string): Promise<Map<string, string>>;
  listCloses(tenantId: string): Promise<(AttClose & { totals: Record<string, AttTotals> })[]>;
  addClose(tenantId: string, c: { id: string; periodStart: string; periodEnd: string; totals: Record<string, AttTotals>; by: string }): Promise<void>;
  reopenClose(tenantId: string, id: string, by: string): Promise<boolean>;
  listGrants(tenantId: string, employeeId?: string): Promise<LeaveGrant[]>;
  /** 付与を足す。同じ日の付与があれば足さない（`false`）。 */
  addGrant(tenantId: string, g: LeaveGrant & { createdBy: string }): Promise<boolean>;
  updateGrant(tenantId: string, id: string, patch: { days: number; note: string }): Promise<boolean>;
  listTakes(tenantId: string, q: { employeeId?: string; from?: string; to?: string }): Promise<LeaveTake[]>;
  addTake(tenantId: string, t: LeaveTake & { createdBy: string; note: string }): Promise<void>;
  cancelTake(tenantId: string, id: string, by: string): Promise<LeaveTake | null>;
  /** 知らせの印を付ける。初めてなら `true`（知らせてよい）。 */
  markAlert(tenantId: string, employeeId: string, key: string): Promise<boolean>;
}

interface PunchRow { id: string; employee_id: string; kind: AttPunchKind; at: unknown; source: AttPunch['source'] }
const toPunch = (r: PunchRow): AttPunch => ({ id: r.id, employeeId: r.employee_id, kind: r.kind, at: iso(r.at), source: r.source });

interface GrantRow { id: string; employee_id: string; granted_on: unknown; days: unknown; expires_on: unknown; basis: LeaveGrant['basis']; note: string }
const toGrant = (r: GrantRow): LeaveGrant => ({
  id: r.id, employeeId: r.employee_id, grantedOn: day(r.granted_on), days: Number(r.days), expiresOn: day(r.expires_on), basis: r.basis, note: r.note,
});

interface TakeRow { id: string; employee_id: string; date: unknown; days: unknown; status: LeaveTake['status']; source: LeaveTake['source'] }
const toTake = (r: TakeRow): LeaveTake => ({ id: r.id, employeeId: r.employee_id, date: day(r.date), days: Number(r.days), status: r.status, source: r.source });

/** PostgreSQL の勤怠と休暇の置き場。 */
export class PostgresAttendanceStore implements AttendanceStore {
  private readonly pool: pg.Pool;

  constructor(connectionString: string) {
    this.pool = new pg.Pool({ connectionString, max: 4 });
  }

  async close(): Promise<void> {
    await this.pool.end();
  }

  private async q<T extends pg.QueryResultRow>(tenantId: string, text: string, params: unknown[] = []): Promise<T[]> {
    const client = await this.pool.connect();
    try {
      await client.query('begin');
      await client.query(`select set_config('app.tenant_id', $1, true)`, [tenantId]);
      const rows = (await client.query<T>(text, params as never[])).rows;
      await client.query('commit');
      return rows;
    } catch (err) {
      await client.query('rollback').catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
  }

  async listPunches(tenantId: string, q: { employeeId?: string; from: string; to: string }): Promise<AttPunch[]> {
    const params: unknown[] = [tenantId, q.from, q.to];
    let where = 'tenant_id = $1 and replaced_at is null and at >= $2 and at < $3';
    if (q.employeeId) { params.push(q.employeeId); where += ` and employee_id = $${params.length}`; }
    const rows = await this.q<PunchRow>(tenantId, `select id, employee_id, kind, at, source from att_punches where ${where} order by employee_id, at`, params);
    return rows.map(toPunch);
  }

  async addPunch(tenantId: string, p: AttPunch & { createdBy: string }): Promise<void> {
    await this.q(tenantId, `insert into att_punches (id, tenant_id, employee_id, kind, at, source, created_by) values ($1,$2,$3,$4,$5,$6,$7)`,
      [p.id, tenantId, p.employeeId, p.kind, p.at, p.source, p.createdBy]);
  }

  async replacePunches(tenantId: string, employeeId: string, ids: string[], by: string): Promise<number> {
    if (ids.length === 0) return 0;
    const rows = await this.q<{ id: string }>(tenantId, `update att_punches set replaced_at = now(), replaced_by = $4
      where tenant_id = $1 and employee_id = $2 and replaced_at is null and id = any($3::text[]) returning id`, [tenantId, employeeId, ids, by]);
    return rows.length;
  }

  async lastPunch(tenantId: string, employeeId: string): Promise<AttPunch | null> {
    const rows = await this.q<PunchRow>(tenantId, `select id, employee_id, kind, at, source from att_punches
      where tenant_id = $1 and employee_id = $2 and replaced_at is null order by at desc limit 1`, [tenantId, employeeId]);
    return rows[0] ? toPunch(rows[0]) : null;
  }

  async firstPunchDates(tenantId: string): Promise<Map<string, string>> {
    const rows = await this.q<{ employee_id: string; d: string }>(tenantId, `select employee_id, min((at at time zone 'Asia/Tokyo')::date)::text as d
      from att_punches where tenant_id = $1 and replaced_at is null group by employee_id`, [tenantId]);
    return new Map(rows.map((r) => [r.employee_id, r.d]));
  }

  async listCloses(tenantId: string): Promise<(AttClose & { totals: Record<string, AttTotals> })[]> {
    const rows = await this.q<{ id: string; period_start: unknown; period_end: unknown; status: AttClose['status']; closed_by: string | null; closed_at: unknown; totals: Record<string, AttTotals> }>(
      tenantId, `select id, period_start::text, period_end::text, status, closed_by, closed_at, totals from att_closes where tenant_id = $1 order by period_end desc, closed_at desc`, [tenantId]);
    return rows.map((r) => ({ id: r.id, periodStart: day(r.period_start), periodEnd: day(r.period_end), status: r.status, closedBy: r.closed_by, closedAt: iso(r.closed_at), totals: r.totals ?? {} }));
  }

  async addClose(tenantId: string, c: { id: string; periodStart: string; periodEnd: string; totals: Record<string, AttTotals>; by: string }): Promise<void> {
    await this.q(tenantId, `insert into att_closes (id, tenant_id, period_start, period_end, totals, closed_by) values ($1,$2,$3,$4,$5::jsonb,$6)`,
      [c.id, tenantId, c.periodStart, c.periodEnd, JSON.stringify(c.totals), c.by]);
  }

  async reopenClose(tenantId: string, id: string, by: string): Promise<boolean> {
    const rows = await this.q<{ id: string }>(tenantId, `update att_closes set status = 'reopened', reopened_by = $3, reopened_at = now()
      where tenant_id = $1 and id = $2 and status = 'closed' returning id`, [tenantId, id, by]);
    return rows.length > 0;
  }

  async listGrants(tenantId: string, employeeId?: string): Promise<LeaveGrant[]> {
    const rows = await this.q<GrantRow>(tenantId, `select id, employee_id, granted_on::text, days, expires_on::text, basis, note from leave_grants
      where tenant_id = $1 ${employeeId ? 'and employee_id = $2' : ''} order by employee_id, granted_on`, employeeId ? [tenantId, employeeId] : [tenantId]);
    return rows.map(toGrant);
  }

  async addGrant(tenantId: string, g: LeaveGrant & { createdBy: string }): Promise<boolean> {
    const rows = await this.q<{ id: string }>(tenantId, `insert into leave_grants (id, tenant_id, employee_id, granted_on, days, expires_on, basis, note, created_by)
      values ($1,$2,$3,$4,$5,$6,$7,$8,$9) on conflict (tenant_id, employee_id, granted_on) do nothing returning id`,
    [g.id, tenantId, g.employeeId, g.grantedOn, g.days, g.expiresOn, g.basis, g.note, g.createdBy]);
    return rows.length > 0;
  }

  async updateGrant(tenantId: string, id: string, patch: { days: number; note: string }): Promise<boolean> {
    const rows = await this.q<{ id: string }>(tenantId, `update leave_grants set days = $3, note = $4, basis = 'manual' where tenant_id = $1 and id = $2 returning id`,
      [tenantId, id, patch.days, patch.note]);
    return rows.length > 0;
  }

  async listTakes(tenantId: string, q: { employeeId?: string; from?: string; to?: string }): Promise<LeaveTake[]> {
    const params: unknown[] = [tenantId];
    let where = 'tenant_id = $1';
    if (q.employeeId) { params.push(q.employeeId); where += ` and employee_id = $${params.length}`; }
    if (q.from) { params.push(q.from); where += ` and date >= $${params.length}`; }
    if (q.to) { params.push(q.to); where += ` and date <= $${params.length}`; }
    const rows = await this.q<TakeRow>(tenantId, `select id, employee_id, date::text, days, status, source from leave_takes where ${where} order by date`, params);
    return rows.map(toTake);
  }

  async addTake(tenantId: string, t: LeaveTake & { createdBy: string; note: string }): Promise<void> {
    await this.q(tenantId, `insert into leave_takes (id, tenant_id, employee_id, date, days, status, source, note, created_by) values ($1,$2,$3,$4,$5,'taken',$6,$7,$8)`,
      [t.id, tenantId, t.employeeId, t.date, t.days, t.source, t.note, t.createdBy]);
  }

  async cancelTake(tenantId: string, id: string, by: string): Promise<LeaveTake | null> {
    const rows = await this.q<TakeRow>(tenantId, `update leave_takes set status = 'cancelled', cancelled_by = $3, cancelled_at = now()
      where tenant_id = $1 and id = $2 and status = 'taken' returning id, employee_id, date::text, days, status, source`, [tenantId, id, by]);
    return rows[0] ? toTake(rows[0]) : null;
  }

  async markAlert(tenantId: string, employeeId: string, key: string): Promise<boolean> {
    const rows = await this.q<{ key: string }>(tenantId, `insert into hr_alerts (tenant_id, employee_id, key) values ($1,$2,$3)
      on conflict do nothing returning key`, [tenantId, employeeId, key]);
    return rows.length > 0;
  }
}
