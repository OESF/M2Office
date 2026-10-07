/**
 * @file シフトの置き場（仕様書 第30.6.2節）。締めの期間ごとの組み（下書きか公開か）・1 人 1 日のシフト・本人の休みの希望。
 *
 * すべての問い合わせを会社（テナント）を設定したトランザクションで行う（不変則 I-2）。
 */

import pg from 'pg';
import { createPool } from '../repository/pool.js';
import type { HrShift, HrShiftPlan } from '@m2office/shared';

const iso = (v: unknown): string | null => (v ? (v instanceof Date ? v.toISOString() : String(v)) : null);
/** 日付の列は `::text` で読む（Date にすると時差で前の日になる）。 */
const day = (v: unknown): string => String(v ?? '').slice(0, 10);

/** シフトの置き場。 */
export interface ShiftStore {
  getPlan(tenantId: string, periodStart: string): Promise<HrShiftPlan | null>;
  /** `from`〜`to` の日と重なる、公開した組み（勤怠の集計に使う）。 */
  listPublished(tenantId: string, from: string, to: string): Promise<HrShiftPlan[]>;
  /** 期間の組みを残す（下書きか公開か）。 */
  savePlan(tenantId: string, plan: { periodStart: string; periodEnd: string; status: 'draft' | 'published'; generated?: boolean }, by: string): Promise<void>;
  listShifts(tenantId: string, from: string, to: string, employeeId?: string): Promise<HrShift[]>;
  /** 期間のシフトを丸ごと置き換える（案を作ったとき）。 */
  replaceShifts(tenantId: string, from: string, to: string, shifts: HrShift[], by: string): Promise<void>;
  /** 1 人 1 日のシフトを直す。 */
  setShift(tenantId: string, s: HrShift, by: string): Promise<void>;
  listRequests(tenantId: string, from: string, to: string, employeeId?: string): Promise<{ employeeId: string; date: string; note: string }[]>;
  /** 本人の休みの希望を入れるか外す。 */
  setRequest(tenantId: string, employeeId: string, date: string, on: boolean, note?: string): Promise<void>;
}

interface ShiftRow { employee_id: string; date: unknown; pattern: string | null; start_time: string; end_time: string; break_minutes: number; changed_after_publish: boolean }
const toShift = (r: ShiftRow): HrShift => ({
  employeeId: r.employee_id, date: day(r.date), patternId: r.pattern, start: r.start_time, end: r.end_time, breakMinutes: r.break_minutes, changedAfterPublish: r.changed_after_publish,
});

/** PostgreSQL のシフトの置き場。 */
export class PostgresShiftStore implements ShiftStore {
  private readonly pool: pg.Pool;

  constructor(connectionString: string) {
    this.pool = createPool(connectionString, { max: 2, name: 'hr/shift' });
  }

  async close(): Promise<void> {
    await this.pool.end();
  }

  private async tx<T>(tenantId: string, fn: (c: pg.PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query('begin');
      await client.query(`select set_config('app.tenant_id', $1, true)`, [tenantId]);
      const out = await fn(client);
      await client.query('commit');
      return out;
    } catch (err) {
      await client.query('rollback').catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
  }

  private q<T extends pg.QueryResultRow>(tenantId: string, text: string, params: unknown[] = []): Promise<T[]> {
    return this.tx(tenantId, async (c) => (await c.query<T>(text, params as never[])).rows);
  }

  async getPlan(tenantId: string, periodStart: string): Promise<HrShiftPlan | null> {
    const rows = await this.q<{ period_start: unknown; period_end: unknown; status: 'draft' | 'published'; generated_at: unknown; published_at: unknown }>(tenantId,
      `select period_start::text, period_end::text, status, generated_at, published_at from hr_shift_plans where tenant_id = $1 and period_start = $2`, [tenantId, periodStart]);
    const r = rows[0];
    return r ? { periodStart: day(r.period_start), periodEnd: day(r.period_end), status: r.status, generatedAt: iso(r.generated_at), publishedAt: iso(r.published_at) } : null;
  }

  async listPublished(tenantId: string, from: string, to: string): Promise<HrShiftPlan[]> {
    const rows = await this.q<{ period_start: unknown; period_end: unknown; status: 'draft' | 'published'; generated_at: unknown; published_at: unknown }>(tenantId,
      `select period_start::text, period_end::text, status, generated_at, published_at from hr_shift_plans
       where tenant_id = $1 and status = 'published' and period_end >= $2::date and period_start <= $3::date`, [tenantId, from, to]);
    return rows.map((r) => ({ periodStart: day(r.period_start), periodEnd: day(r.period_end), status: r.status, generatedAt: iso(r.generated_at), publishedAt: iso(r.published_at) }));
  }

  async savePlan(tenantId: string, plan: { periodStart: string; periodEnd: string; status: 'draft' | 'published'; generated?: boolean }, by: string): Promise<void> {
    await this.q(tenantId, `insert into hr_shift_plans (tenant_id, period_start, period_end, status, generated_at, published_at, published_by)
      values ($1, $2, $3, $4, case when $5 then now() end, case when $4 = 'published' then now() end, case when $4 = 'published' then $6 end)
      on conflict (tenant_id, period_start) do update set period_end = excluded.period_end, status = excluded.status,
        generated_at = coalesce(excluded.generated_at, hr_shift_plans.generated_at),
        published_at = case when excluded.status = 'published' then coalesce(hr_shift_plans.published_at, now()) else hr_shift_plans.published_at end,
        published_by = case when excluded.status = 'published' then coalesce(hr_shift_plans.published_by, excluded.published_by) else hr_shift_plans.published_by end,
        updated_at = now()`, [tenantId, plan.periodStart, plan.periodEnd, plan.status, !!plan.generated, by]);
  }

  async listShifts(tenantId: string, from: string, to: string, employeeId?: string): Promise<HrShift[]> {
    const rows = await this.q<ShiftRow>(tenantId, `select employee_id, date::text, pattern, start_time, end_time, break_minutes, changed_after_publish from hr_shifts
      where tenant_id = $1 and date between $2::date and $3::date ${employeeId ? 'and employee_id = $4' : ''} order by date`, employeeId ? [tenantId, from, to, employeeId] : [tenantId, from, to]);
    return rows.map(toShift);
  }

  async replaceShifts(tenantId: string, from: string, to: string, shifts: HrShift[], by: string): Promise<void> {
    await this.tx(tenantId, async (c) => {
      await c.query(`delete from hr_shifts where tenant_id = $1 and date between $2::date and $3::date`, [tenantId, from, to]);
      for (const s of shifts) {
        await c.query(`insert into hr_shifts (tenant_id, employee_id, date, pattern, start_time, end_time, break_minutes, updated_by) values ($1,$2,$3,$4,$5,$6,$7,$8)`,
          [tenantId, s.employeeId, s.date, s.patternId, s.start, s.end, s.breakMinutes, by]);
      }
    });
  }

  async setShift(tenantId: string, s: HrShift, by: string): Promise<void> {
    await this.q(tenantId, `insert into hr_shifts (tenant_id, employee_id, date, pattern, start_time, end_time, break_minutes, changed_after_publish, updated_by)
      values ($1,$2,$3,$4,$5,$6,$7,$8,$9)
      on conflict (tenant_id, employee_id, date) do update set pattern = excluded.pattern, start_time = excluded.start_time, end_time = excluded.end_time,
        break_minutes = excluded.break_minutes, changed_after_publish = hr_shifts.changed_after_publish or excluded.changed_after_publish, updated_by = excluded.updated_by, updated_at = now()`,
    [tenantId, s.employeeId, s.date, s.patternId, s.start, s.end, s.breakMinutes, !!s.changedAfterPublish, by]);
  }

  async listRequests(tenantId: string, from: string, to: string, employeeId?: string): Promise<{ employeeId: string; date: string; note: string }[]> {
    const rows = await this.q<{ employee_id: string; date: unknown; note: string }>(tenantId, `select employee_id, date::text, note from hr_shift_requests
      where tenant_id = $1 and date between $2::date and $3::date ${employeeId ? 'and employee_id = $4' : ''} order by date`, employeeId ? [tenantId, from, to, employeeId] : [tenantId, from, to]);
    return rows.map((r) => ({ employeeId: r.employee_id, date: day(r.date), note: r.note }));
  }

  async setRequest(tenantId: string, employeeId: string, date: string, on: boolean, note = ''): Promise<void> {
    if (on) {
      await this.q(tenantId, `insert into hr_shift_requests (tenant_id, employee_id, date, note) values ($1,$2,$3,$4)
        on conflict (tenant_id, employee_id, date) do update set note = excluded.note`, [tenantId, employeeId, date, note.slice(0, 200)]);
    } else {
      await this.q(tenantId, `delete from hr_shift_requests where tenant_id = $1 and employee_id = $2 and date = $3`, [tenantId, employeeId, date]);
    }
  }
}
