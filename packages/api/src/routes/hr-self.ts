/**
 * @file 本人の「給与・勤怠」の API（仕様書 第30.25節・第30.6.1節・第30.7.1節。人事・給与の段 2）。
 *
 * 打刻・日の直し・今月の勤怠・有給の残りと申請・給与明細（段 4）。**本人の分だけ**を扱う（H-3）。
 * 利用者が台帳に結び付いていなければ（同じメールアドレスなら自動で結び付く）404。人事・給与を切っている会社も 404。
 */

import { Hono } from 'hono';
import { jstDate, type DayFix } from '@m2office/core';
import type { AttPunchKind, HrEmployee } from '@m2office/shared';
import type { AppDeps } from '../context.js';
import type { AppEnv } from '../middleware/tenant.js';

const KINDS: AttPunchKind[] = ['in', 'out', 'break_start', 'break_end'];

/**
 * 本人の「給与・勤怠」の API（`/v1/me/hr`）。
 *
 * @remarks テナント境界: 本人に結び付いた従業員だけを扱う（不変則 I-2・I-9）
 */
export function hrSelfRoute(deps: AppDeps) {
  const app = new Hono<AppEnv & { Variables: { employee: HrEmployee } }>();
  const att = deps.hr.attendance;

  app.use('*', async (c, next) => {
    const { tenant, user } = c.get('ctx');
    const employee = await att.selfEmployee(tenant.id, user.id);
    if (!employee) return c.json({ error: '人事の台帳にあなたが載っていないか、会社で人事・給与を使っていません' }, 404);
    c.set('employee', employee);
    await next();
  });

  /** 今の打刻の状態・期間の勤怠・有給の残り。`month`（YYYY-MM）で締めの期間を選ぶ。 */
  app.get('/', async (c) => {
    const { tenant } = c.get('ctx');
    const employee = c.get('employee');
    const period = await att.period(tenant.id, c.req.query('month'));
    const [state, { days, totals }, leave, settings, closed] = await Promise.all([
      att.state(tenant.id, employee.id), att.days(tenant.id, employee, period), att.balance(tenant.id, employee),
      att.settings(tenant.id), att.isClosed(tenant.id, period.end),
    ]);
    return c.json({
      employee: { id: employee.id, name: employee.name, hiredOn: employee.hiredOn },
      state, period, days, totals, today: jstDate(new Date()),
      leave: { remaining: leave.remaining, grants: leave.grants, obligation: leave.obligation, takes: leave.takes.filter((t) => t.status === 'taken').slice(-30) },
      halfDay: settings.leave.halfDay, closed: !!closed,
    });
  });

  /** 打刻する（出勤・休憩・休憩終わり・退勤）。 */
  app.post('/punch', async (c) => {
    const { tenant, user } = c.get('ctx');
    const b = await c.req.json<{ kind?: string; source?: string }>().catch(() => ({} as { kind?: string; source?: string }));
    if (!KINDS.includes(b.kind as AttPunchKind)) return c.json({ error: '打刻の種類が違います' }, 400);
    const r = await att.punch(tenant.id, user.id, c.get('employee'), b.kind as AttPunchKind, b.source === 'mobile' ? 'mobile' : 'screen');
    return 'error' in r ? c.json(r, 409) : c.json(r, 201);
  });

  /** 1 日の打刻を直す（締めた期間は直せない）。 */
  app.put('/days/:date', async (c) => {
    const { tenant, user } = c.get('ctx');
    const b = await c.req.json<Partial<DayFix>>().catch(() => ({} as Partial<DayFix>));
    const r = await att.fixDay(tenant.id, user.id, c.get('employee'), c.req.param('date'), {
      in: String(b.in ?? ''), out: b.out ? String(b.out) : null, breaks: Array.isArray(b.breaks) ? b.breaks : [],
    }, false);
    return 'error' in r ? c.json(r, 400) : c.json(r);
  });

  /** 有給を取る（承認の段は挟まない。人事区画の人に知らせる）。 */
  app.post('/leave', async (c) => {
    const { tenant, user } = c.get('ctx');
    const b = await c.req.json<{ date?: string; days?: number }>().catch(() => ({} as { date?: string; days?: number }));
    const r = await att.requestLeave(tenant.id, user.id, c.get('employee'), String(b.date ?? ''), Number(b.days ?? 1), 'screen');
    return 'error' in r ? c.json(r, 400) : c.json(r, 201);
  });

  /** 有給の取得を取り消す（締めた期間は担当者だけ）。 */
  app.delete('/leave/:id', async (c) => {
    const { tenant, user } = c.get('ctx');
    const r = await att.cancelLeave(tenant.id, user.id, c.get('employee'), c.req.param('id'), false);
    return 'error' in r ? c.json(r, 400) : c.json(r);
  });

  // ---- 給与明細（段 4。第30.10.3節）。画面で受け取るには本人の同意が要る ----

  const payroll = deps.hr.payroll;

  /** 明細の一覧と同意（同意が無ければ明細は出さない）。 */
  app.get('/payslips', async (c) => {
    const { tenant } = c.get('ctx');
    return c.json(await payroll.mySlips(tenant.id, c.get('employee')));
  });

  /** 明細 1 つ（行と根拠）と、前の回からの差の説明。 */
  app.get('/payslips/:id', async (c) => {
    const { tenant, user } = c.get('ctx');
    const r = await payroll.mySlip(tenant.id, user.id, c.get('employee'), c.req.param('id'));
    return r ? c.json(r) : c.json({ error: '明細が見つかりません' }, 404);
  });

  /** 自分の明細の PDF。 */
  app.get('/payslips/:id/pdf', async (c) => {
    const { tenant, user } = c.get('ctx');
    const employee = c.get('employee');
    const r = await payroll.slipPdf(tenant.id, user.id, c.req.param('id'), employee.id);
    if (!r) return c.json({ error: '明細が見つかりません' }, 404);
    c.header('Content-Type', 'application/pdf');
    c.header('Content-Disposition', `attachment; filename="${r.filename}"`);
    return c.body(r.bytes as unknown as ArrayBuffer);
  });

  /** 明細を画面で受け取ることに同意する・取り消す（本文 `{ consent: true | false }`）。 */
  app.put('/payslip-consent', async (c) => {
    const { tenant, user } = c.get('ctx');
    const b = await c.req.json<{ consent?: unknown }>().catch(() => ({} as { consent?: unknown }));
    if (typeof b.consent !== 'boolean') return c.json({ error: 'consent に true か false を指定してください' }, 400);
    return c.json({ consentAt: await payroll.setConsent(tenant.id, user.id, c.get('employee'), b.consent) });
  });

  return app;
}
