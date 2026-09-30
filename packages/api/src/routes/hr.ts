/**
 * @file 人事・給与の担当者の API（仕様書 第30章）。台帳・勤怠・有給・給与の計算と点検・確定・振込データ・賃金台帳・住民税の通知書・試しの計算。
 *
 * 会社で入れていて、**人事区画に入っている人だけ**が使える（第30.2節）。それ以外は 403。
 * 他人の台帳を見ただけでも監査ログに残す（第30.21節。処理側で残す）。
 */

import { Hono, type Context } from 'hono';
import { readSheet, renderSheet, detectKind, HR_IMPORT_MAX_ROWS, HR_PHOTO_MAX_BYTES, MAX_FILE_BYTES, MIME, type DayFix, type EmployeeInput, type FilingSheet, type TermsInput } from '@m2office/core';
import type { AppDeps } from '../context.js';
import type { AppEnv } from '../middleware/tenant.js';

/** 取り込むファイルの大きさの上限。 */
const IMPORT_MAX_BYTES = 5 * 1024 * 1024;

/**
 * 人事・給与の担当者の API（`/v1/hr`）。
 *
 * @remarks テナント境界: 処理と置き場が会社ごとに絞る（不変則 I-2）。人事区画の確かめはここで行う（不変則 I-12）
 */
export function hrRoute(deps: AppDeps) {
  const app = new Hono<AppEnv>();
  const service = deps.hr.service;

  app.use('*', async (c, next) => {
    const { tenant, user } = c.get('ctx');
    if (!(await deps.hr.access(tenant.id, user.id))) {
      return c.json({ error: '人事・給与は使えません（会社で切っているか、人事区画に入っていません）' }, 403);
    }
    await next();
  });

  /** 従業員の一覧と、済んでいない手続き・会社の設定。 */
  app.get('/employees', async (c) => {
    const { tenant, user } = c.get('ctx');
    const [employees, tasks, settings] = await Promise.all([
      service.list(tenant.id, user.id), service.openTasks(tenant.id), service.settings(tenant.id),
    ]);
    return c.json({ employees, tasks, settings });
  });

  /** 1 人の台帳（雇用条件の履歴と手続きつき）。 */
  app.get('/employees/:id', async (c) => {
    const { tenant, user } = c.get('ctx');
    const d = await service.detail(tenant.id, user.id, c.req.param('id'));
    return d ? c.json(d) : c.json({ error: '従業員が見つかりません' }, 404);
  });

  /** 従業員を作る（入社。最初の雇用条件と、入社の手続きを作る）。 */
  app.post('/employees', async (c) => {
    const { tenant, user } = c.get('ctx');
    const body = await c.req.json<EmployeeInput & { terms?: TermsInput }>().catch(() => ({}) as EmployeeInput);
    const res = await service.create(tenant.id, user.id, body);
    return 'error' in res ? c.json(res, 400) : c.json(res, 201);
  });

  /** 台帳の基本の項目を直す。 */
  app.put('/employees/:id', async (c) => {
    const { tenant, user } = c.get('ctx');
    const body = await c.req.json<EmployeeInput>().catch(() => ({}) as EmployeeInput);
    const res = await service.update(tenant.id, user.id, c.req.param('id'), body);
    return 'error' in res ? c.json(res, 400) : c.json(res);
  });

  /** 雇用条件を足す（履歴）。 */
  app.post('/employees/:id/terms', async (c) => {
    const { tenant, user } = c.get('ctx');
    const body = await c.req.json<TermsInput>().catch(() => ({}) as TermsInput);
    const res = await service.addTerms(tenant.id, user.id, c.req.param('id'), body);
    return 'error' in res ? c.json(res, 400) : c.json(res, 201);
  });

  /** 退職を記録する（退職の手続きを作る）。 */
  app.post('/employees/:id/leave', async (c) => {
    const { tenant, user } = c.get('ctx');
    const body = await c.req.json<{ leftOn?: string; reason?: string }>().catch(() => ({}));
    const res = await service.leave(tenant.id, user.id, c.req.param('id'), body);
    return 'error' in res ? c.json(res, 400) : c.json(res);
  });

  /** 手続きを済んだにする・戻す。 */
  app.put('/tasks/:id', async (c) => {
    const { tenant, user } = c.get('ctx');
    const body = await c.req.json<{ done?: unknown }>().catch(() => ({ done: undefined }));
    if (typeof body.done !== 'boolean') return c.json({ error: 'done に true か false を指定してください' }, 400);
    const task = await service.setTaskDone(tenant.id, user.id, c.req.param('id'), body.done);
    return task ? c.json({ task }) : c.json({ error: '手続きが見つかりません' }, 404);
  });

  /** 顔写真を入れる（`file`。画面で縮めた JPEG か PNG。前の写真は残さない。第30.5.4節）。 */
  app.put('/employees/:id/photo', async (c) => {
    const { tenant, user } = c.get('ctx');
    const f = (await c.req.parseBody())['file'];
    if (!(f instanceof File)) return c.json({ error: '写真を選んでください' }, 400);
    if (f.size > HR_PHOTO_MAX_BYTES) return c.json({ error: '写真が大きすぎます（1 MB まで）' }, 413);
    const r = await service.setPhoto(tenant.id, user.id, c.req.param('id'), new Uint8Array(await f.arrayBuffer()));
    return 'error' in r ? c.json(r, 400) : c.json(r);
  });

  /** 顔写真を外す。 */
  app.delete('/employees/:id/photo', async (c) => {
    const { tenant, user } = c.get('ctx');
    return (await service.deletePhoto(tenant.id, user.id, c.req.param('id'))) ? c.json({ ok: true }) : c.json({ error: '写真はありません' }, 404);
  });

  /** 顔写真をまとめて取り込むときの 1 枚（`file`）。ファイル名か写真の中の名札で人に当てる。当てられなければ入れずに理由を返す。 */
  app.post('/photos/import', async (c) => {
    const { tenant, user } = c.get('ctx');
    const f = (await c.req.parseBody())['file'];
    if (!(f instanceof File)) return c.json({ error: '写真を選んでください' }, 400);
    if (f.size > HR_PHOTO_MAX_BYTES) return c.json({ error: '写真が大きすぎます（1 MB まで）' }, 413);
    const r = await service.importPhoto(tenant.id, user.id, f.name, new Uint8Array(await f.arrayBuffer()));
    return 'error' in r ? c.json(r, 422) : c.json(r);
  });

  /** 表計算（CSV・Excel）から従業員を取り込む。見出しは推論で読む。 */
  app.post('/import', async (c) => {
    const { tenant, user } = c.get('ctx');
    const form = await c.req.parseBody();
    const f = form['file'];
    if (!(f instanceof File)) return c.json({ error: 'ファイルを選んでください' }, 400);
    if (f.size > IMPORT_MAX_BYTES) return c.json({ error: 'ファイルが大きすぎます（5 MB まで）' }, 413);
    const bytes = new Uint8Array(await f.arrayBuffer());
    const kind = (bytes[0] === 0x50 && bytes[1] === 0x4b) || /\.xlsx$/i.test(f.name) ? 'xlsx' : 'csv';
    let rows;
    try {
      rows = (await readSheet(bytes, kind, { maxRows: HR_IMPORT_MAX_ROWS + 1 })).rows;
    } catch {
      return c.json({ error: '表として読めませんでした（CSV か Excel のファイルを選んでください）' }, 400);
    }
    if (rows.length < 2) return c.json({ error: '見出しの行と、従業員の行が要ります' }, 400);
    return c.json(await service.importRows(tenant.id, user.id, rows));
  });

  // ---- 勤怠（段 2。第30.6.1節） ----

  const att = deps.hr.attendance;
  const employeeOf = async (tenantId: string, id: string) => deps.hr.service.deps.store.getEmployee(tenantId, id);
  const sheet = async (c: Context<AppEnv>, name: string, file: string, table: { columns: string[]; rows: (string | number | null)[][] }) => {
    const format = c.req.query('format') === 'csv' ? 'csv' : 'xlsx';
    const bytes = await renderSheet(name, table.columns, table.rows, format);
    c.header('Content-Type', format === 'csv' ? 'text/csv; charset=utf-8' : 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    c.header('Content-Disposition', `attachment; filename="${file}.${format}"`);
    return c.body(bytes as unknown as ArrayBuffer);
  };

  /** 期間の従業員ごとの勤怠の集計・点検の数・36 協定の知らせと、締めの記録（`month`: 締め日の月 YYYY-MM）。 */
  app.get('/attendance', async (c) => {
    const { tenant, user } = c.get('ctx');
    const period = await att.period(tenant.id, c.req.query('month'));
    const [rows, closes] = await Promise.all([att.summary(tenant.id, period), att.closes(tenant.id)]);
    await deps.repo.appendAudit({
      id: crypto.randomUUID(), tenantId: tenant.id, actorType: 'user', actorId: user.id, action: 'hr.attendance.view',
      targetType: 'hr', targetId: `${period.start}..${period.end}`, detail: { rows: rows.length }, occurredAt: new Date().toISOString(),
    });
    return c.json({ period, rows, close: closes.find((x) => x.periodEnd === period.end && x.status === 'closed') ?? null });
  });

  /** 出勤簿を書き出す（期間の日ごと）。 */
  app.get('/attendance/book', async (c) => {
    const { tenant, user } = c.get('ctx');
    const period = await att.period(tenant.id, c.req.query('month'));
    return sheet(c, '出勤簿', `attendance-${period.end.slice(0, 7)}`, await att.attendanceBook(tenant.id, user.id, period));
  });

  /** 1 人の期間の日ごとの勤怠。 */
  app.get('/attendance/:employeeId', async (c) => {
    const { tenant, user } = c.get('ctx');
    const employee = await employeeOf(tenant.id, c.req.param('employeeId'));
    if (!employee) return c.json({ error: '従業員が見つかりません' }, 404);
    const period = await att.period(tenant.id, c.req.query('month'));
    const r = await att.days(tenant.id, employee, period);
    await deps.repo.appendAudit({
      id: crypto.randomUUID(), tenantId: tenant.id, actorType: 'user', actorId: user.id, action: 'hr.view',
      targetType: 'hr_employee', targetId: employee.id, detail: { attendance: `${period.start}..${period.end}` }, occurredAt: new Date().toISOString(),
    });
    return c.json({ employee: { id: employee.id, name: employee.name }, period, ...r });
  });

  /** 担当者が 1 日の打刻を直す（締めた期間は、締めを戻してから）。 */
  app.put('/attendance/:employeeId/days/:date', async (c) => {
    const { tenant, user } = c.get('ctx');
    const employee = await employeeOf(tenant.id, c.req.param('employeeId'));
    if (!employee) return c.json({ error: '従業員が見つかりません' }, 404);
    const b = await c.req.json<Partial<DayFix>>().catch(() => ({} as Partial<DayFix>));
    const r = await att.fixDay(tenant.id, user.id, employee, c.req.param('date'), {
      in: String(b.in ?? ''), out: b.out ? String(b.out) : null, breaks: Array.isArray(b.breaks) ? b.breaks : [],
    }, true);
    return 'error' in r ? c.json(r, 400) : c.json(r);
  });

  /** 期間を締める。 */
  app.post('/attendance/close', async (c) => {
    const { tenant, user } = c.get('ctx');
    const b = await c.req.json<{ month?: string }>().catch(() => ({} as { month?: string }));
    const r = await att.close(tenant.id, user.id, await att.period(tenant.id, b.month));
    return 'error' in r ? c.json(r, 409) : c.json(r, 201);
  });

  /** 締めを戻す。 */
  app.post('/attendance/closes/:id/reopen', async (c) => {
    const { tenant, user } = c.get('ctx');
    return (await att.reopen(tenant.id, user.id, c.req.param('id'))) ? c.json({ ok: true }) : c.json({ error: '締めが見つかりません' }, 404);
  });

  // ---- 有給（段 2。第30.7.1節） ----

  /** 有給の一覧（残り・取得義務・出勤率の低い人）。 */
  app.get('/leave', async (c) => {
    const { tenant } = c.get('ctx');
    return c.json({ rows: await att.leaveOverview(tenant.id) });
  });

  /** 年次有給休暇の管理簿を書き出す。 */
  app.get('/leave/register', async (c) => {
    const { tenant, user } = c.get('ctx');
    return sheet(c, '年次有給休暇管理簿', 'leave-register', await att.leaveRegister(tenant.id, user.id));
  });

  /** 手作業の付与（導入のときの今の残日数・付与の直し）。 */
  app.post('/leave/:employeeId/grants', async (c) => {
    const { tenant, user } = c.get('ctx');
    const employee = await employeeOf(tenant.id, c.req.param('employeeId'));
    if (!employee) return c.json({ error: '従業員が見つかりません' }, 404);
    const b = await c.req.json<{ grantedOn?: string; days?: number; note?: string }>().catch(() => ({} as { grantedOn?: string; days?: number; note?: string }));
    const r = await att.addGrant(tenant.id, user.id, employee, String(b.grantedOn ?? ''), Number(b.days), String(b.note ?? ''));
    return 'error' in r ? c.json(r, 400) : c.json(r, 201);
  });

  /** 担当者が有給の取得を記録する（締めた期間も記録できる）。 */
  app.post('/leave/:employeeId/takes', async (c) => {
    const { tenant, user } = c.get('ctx');
    const employee = await employeeOf(tenant.id, c.req.param('employeeId'));
    if (!employee) return c.json({ error: '従業員が見つかりません' }, 404);
    const b = await c.req.json<{ date?: string; days?: number }>().catch(() => ({} as { date?: string; days?: number }));
    const r = await att.requestLeave(tenant.id, user.id, employee, String(b.date ?? ''), Number(b.days ?? 1), 'staff');
    return 'error' in r ? c.json(r, 400) : c.json(r, 201);
  });

  /** 担当者が有給の取得を取り消す。 */
  app.delete('/leave/takes/:id', async (c) => {
    const { tenant, user } = c.get('ctx');
    const r = await att.cancelLeave(tenant.id, user.id, null, c.req.param('id'), true);
    return 'error' in r ? c.json(r, 400) : c.json(r);
  });

  // ---- 給与（段 3。第30.10.1節） ----

  const payroll = deps.hr.payroll;

  /** 給与の情報・標準報酬月額・家族（1 人）。 */
  app.get('/payroll/employees/:id', async (c) => {
    const { tenant } = c.get('ctx');
    const id = c.req.param('id');
    if (!(await employeeOf(tenant.id, id))) return c.json({ error: '従業員が見つかりません' }, 404);
    const [profile, standardPays, family] = await Promise.all([payroll.profile(tenant.id, id), payroll.standardPays(tenant.id, id), payroll.family(tenant.id, id)]);
    return c.json({ profile, standardPays, family });
  });

  /** 給与の情報を直す（税の区分・扶養の数・住民税・通勤・口座）。 */
  app.put('/payroll/employees/:id/profile', async (c) => {
    const { tenant, user } = c.get('ctx');
    const id = c.req.param('id');
    if (!(await employeeOf(tenant.id, id))) return c.json({ error: '従業員が見つかりません' }, 404);
    const r = await payroll.saveProfile(tenant.id, user.id, id, await c.req.json().catch(() => ({})));
    return 'error' in r ? c.json(r, 400) : c.json(r);
  });

  /** 標準報酬月額を足す（報酬の額を入れれば等級表で直す）。 */
  app.post('/payroll/employees/:id/standard-pay', async (c) => {
    const { tenant, user } = c.get('ctx');
    const id = c.req.param('id');
    if (!(await employeeOf(tenant.id, id))) return c.json({ error: '従業員が見つかりません' }, 404);
    const b = await c.req.json<{ fromMonth?: string; pay?: number }>().catch(() => ({} as { fromMonth?: string; pay?: number }));
    const r = await payroll.addStandardPay(tenant.id, user.id, id, String(b.fromMonth ?? ''), Number(b.pay));
    return 'error' in r ? c.json(r, 400) : c.json(r, 201);
  });

  /** 家族を足す・外す。 */
  app.post('/payroll/employees/:id/family', async (c) => {
    const { tenant, user } = c.get('ctx');
    const id = c.req.param('id');
    if (!(await employeeOf(tenant.id, id))) return c.json({ error: '従業員が見つかりません' }, 404);
    const r = await payroll.addFamily(tenant.id, user.id, id, await c.req.json().catch(() => ({})));
    return 'error' in r ? c.json(r, 400) : c.json(r, 201);
  });
  app.delete('/payroll/employees/:id/family/:memberId', async (c) => {
    const { tenant, user } = c.get('ctx');
    return (await payroll.removeFamily(tenant.id, user.id, c.req.param('id'), c.req.param('memberId'))) ? c.json({ ok: true }) : c.json({ error: '見つかりません' }, 404);
  });

  /** 給与の回の一覧と、支給月の支払日・勤怠の期間（`month` を渡したとき）。 */
  app.get('/payroll/runs', async (c) => {
    const { tenant } = c.get('ctx');
    const month = c.req.query('month');
    const [runs, schedule] = await Promise.all([payroll.runs(tenant.id), month && /^\d{4}-\d{2}$/.test(month) ? payroll.schedule(tenant.id, month) : null]);
    return c.json({ runs, schedule });
  });

  /** 支給月の月の給与を計算する（下書き。同じ月の下書きは置き換える）。 */
  app.post('/payroll/runs', async (c) => {
    const { tenant, user } = c.get('ctx');
    const b = await c.req.json<{ month?: string }>().catch(() => ({} as { month?: string }));
    const r = await payroll.calculate(tenant.id, user.id, String(b.month ?? ''));
    return 'error' in r ? c.json(r, 400) : c.json(r, 201);
  });

  /** 回と明細（見たことを監査ログに残す）。確定を止めているものも返す。 */
  app.get('/payroll/runs/:id', async (c) => {
    const { tenant, user } = c.get('ctx');
    const r = await payroll.run(tenant.id, user.id, c.req.param('id'));
    if (!r) return c.json({ error: '回が見つかりません' }, 404);
    const adjustments = r.run.kind === 'monthly' || r.run.kind === 'bonus' ? await payroll.adjustments(tenant.id, r.run.kind, r.run.payMonth) : [];
    return c.json({ ...r, adjustments, blockers: payroll.blockers(r.run), canConfirm: user.roles.includes('admin') });
  });

  // ---- 調整の行・賞与・訂正の回（Phase 2 段 1。第30.10.4節・第30.11.1節） ----

  /** 回の調整の行（`kind`: monthly・bonus、`month`）。 */
  app.get('/payroll/adjustments', async (c) => {
    const { tenant } = c.get('ctx');
    const kind = c.req.query('kind') === 'bonus' ? 'bonus' : 'monthly';
    return c.json({ adjustments: await payroll.adjustments(tenant.id, kind, String(c.req.query('month') ?? '')) });
  });

  /** 調整の行を足す（`employeeId`・`kind`・`payMonth`・`label`・`direction`・`amount`・`taxable`・`insurable`・`reason`）。 */
  app.post('/payroll/adjustments', async (c) => {
    const { tenant, user } = c.get('ctx');
    const r = await payroll.addAdjustment(tenant.id, user.id, await c.req.json().catch(() => ({})));
    return 'error' in r ? c.json(r, 400) : c.json(r, 201);
  });

  /** 調整の行を外す（`kind`・`month` の回が確定していなければ）。 */
  app.delete('/payroll/adjustments/:id', async (c) => {
    const { tenant, user } = c.get('ctx');
    const kind = c.req.query('kind') === 'bonus' ? 'bonus' : 'monthly';
    const r = await payroll.removeAdjustment(tenant.id, user.id, c.req.param('id'), kind, String(c.req.query('month') ?? ''));
    return 'error' in r ? c.json(r, 400) : c.json(r);
  });

  /** 賞与の回の入力（`month`）と、入れられる従業員。 */
  app.get('/payroll/bonus', async (c) => {
    const { tenant, user } = c.get('ctx');
    const month = String(c.req.query('month') ?? '');
    if (!/^\d{4}-\d{2}$/.test(month)) return c.json({ error: '支給月を YYYY-MM で入れてください' }, 400);
    const [plan, employees] = await Promise.all([payroll.bonusPlan(tenant.id, month), service.list(tenant.id, user.id)]);
    return c.json({ plan, employees: employees.filter((e) => e.status === 'active' && e.category !== 'owner').map((e) => ({ id: e.id, name: e.name })) });
  });

  /** 賞与の回の入力を残す（`payDate`・`longPeriod`・`amounts`）。 */
  app.put('/payroll/bonus', async (c) => {
    const { tenant, user } = c.get('ctx');
    const r = await payroll.saveBonusPlan(tenant.id, user.id, await c.req.json().catch(() => ({})));
    return 'error' in r ? c.json(r, 400) : c.json(r);
  });

  /** 賞与を計算して下書きにする（`month`）。 */
  app.post('/payroll/bonus/calculate', async (c) => {
    const { tenant, user } = c.get('ctx');
    const b = await c.req.json<{ month?: string }>().catch(() => ({} as { month?: string }));
    const r = await payroll.calculateBonus(tenant.id, user.id, String(b.month ?? ''));
    return 'error' in r ? c.json(r, 400) : c.json(r, 201);
  });

  /** 賞与支払届の下書き（確定した賞与の回。`format`: csv・xlsx）。 */
  app.get('/payroll/runs/:id/bonus-report', async (c) => {
    const { tenant, user } = c.get('ctx');
    const r = await payroll.bonusReport(tenant.id, user.id, c.req.param('id'));
    if ('error' in r) return c.json(r, 400);
    const format = c.req.query('format') === 'xlsx' ? 'xlsx' : 'csv';
    const bytes = await renderSheet('賞与支払届（下書き）', r.columns, r.rows, format);
    c.header('Content-Type', format === 'csv' ? 'text/csv; charset=utf-8' : 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    c.header('Content-Disposition', `attachment; filename="bonus-report-${r.payDate}.${format}"`);
    return c.body(bytes as unknown as ArrayBuffer);
  });

  /** 確定した月の給与の訂正の回を作る（`payDate`: 差額を払う日）。 */
  app.post('/payroll/runs/:id/correction', async (c) => {
    const { tenant, user } = c.get('ctx');
    const b = await c.req.json<{ payDate?: string }>().catch(() => ({} as { payDate?: string }));
    const r = await payroll.createCorrection(tenant.id, user.id, c.req.param('id'), String(b.payDate ?? ''));
    return 'error' in r ? c.json(r, 400) : c.json(r, 201);
  });

  /**
   * 月の給与を確定する（お金の確定。管理者が押すことを承認とする。ADR-0053）。
   *
   * @remarks 危険度: financial。管理者でなければ 403
   */
  app.post('/payroll/runs/:id/confirm', async (c) => {
    const { tenant, user } = c.get('ctx');
    if (!user.roles.includes('admin')) return c.json({ error: '給与の確定は管理者が行います。「管理者に確定を頼む」を使ってください' }, 403);
    const r = await payroll.confirm(tenant.id, user.id, c.req.param('id'));
    return 'error' in r ? c.json(r, 400) : c.json(r);
  });

  /** 管理者に確定を頼む（人事区画に入っている管理者に知らせる）。 */
  app.post('/payroll/runs/:id/request', async (c) => {
    const { tenant, user } = c.get('ctx');
    const r = await payroll.requestConfirm(tenant.id, user.id, c.req.param('id'));
    return 'error' in r ? c.json(r, 400) : c.json(r);
  });

  /**
   * 振込データ（全銀協の形式・シフト JIS）を作る。確定した回からだけ。
   *
   * @remarks 危険度: financial（確定を承認とみなす）。管理者でなければ 403。送金はしない
   */
  app.post('/payroll/runs/:id/transfer', async (c) => {
    const { tenant, user } = c.get('ctx');
    if (!user.roles.includes('admin')) return c.json({ error: '振込データは管理者が作ります' }, 403);
    const r = await payroll.transfer(tenant.id, user.id, c.req.param('id'));
    if ('error' in r) return c.json(r, 400);
    c.header('Content-Type', 'text/plain; charset=Shift_JIS');
    c.header('Content-Disposition', `attachment; filename="${r.filename}"`);
    c.header('X-Transfer-Count', String(r.count));
    c.header('X-Transfer-Excluded', encodeURIComponent(r.excluded.join('、')));
    return c.body(r.bytes as unknown as ArrayBuffer);
  });

  /** 明細の PDF（同意の無い人・アカウントの無い人に渡す）。 */
  app.get('/payroll/slips/:id/pdf', async (c) => {
    const { tenant, user } = c.get('ctx');
    const r = await payroll.slipPdf(tenant.id, user.id, c.req.param('id'));
    if (!r) return c.json({ error: '明細が見つかりません' }, 404);
    c.header('Content-Type', 'application/pdf');
    c.header('Content-Disposition', `attachment; filename="${r.filename}"`);
    return c.body(r.bytes as unknown as ArrayBuffer);
  });

  /** 賃金台帳を CSV・Excel で書き出す（年の確定した月の給与。監査ログに残す）。 */
  app.get('/payroll/ledger', async (c) => {
    const { tenant, user } = c.get('ctx');
    const year = Number(c.req.query('year'));
    if (!Number.isInteger(year) || year < 2000 || year > 2100) return c.json({ error: '年を入れてください' }, 400);
    const format = c.req.query('format') === 'xlsx' ? 'xlsx' : 'csv';
    const { columns, rows } = await payroll.ledger(tenant.id, user.id, year);
    const bytes = await renderSheet(`賃金台帳 ${year}`, columns, rows, format);
    c.header('Content-Type', format === 'csv' ? 'text/csv; charset=utf-8' : 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    c.header('Content-Disposition', `attachment; filename="wage-ledger-${year}.${format}"`);
    return c.body(bytes as unknown as ArrayBuffer);
  });

  /** 住民税の決定通知書（PDF か写真）を読み、従業員の給与の情報に入れる。ファイルは残さない。 */
  app.post('/payroll/resident-tax/read', async (c) => {
    const { tenant, user } = c.get('ctx');
    const form = await c.req.parseBody();
    const f = form['file'];
    if (!(f instanceof File)) return c.json({ error: '通知書の PDF か写真を選んでください' }, 400);
    if (f.size > MAX_FILE_BYTES) return c.json({ error: 'ファイルが大きすぎます（10 MB まで）' }, 413);
    const bytes = new Uint8Array(await f.arrayBuffer());
    const kind = detectKind(f.name || 'notice.pdf', bytes);
    if (!kind || !['png', 'jpeg', 'webp', 'pdf'].includes(kind)) return c.json({ error: '通知書の PDF か写真（PNG・JPEG・WebP）を選んでください' }, 400);
    const r = await payroll.readNotice(tenant.id, user.id, bytes, MIME[kind]);
    return 'error' in r ? c.json(r, 422) : c.json(r);
  });

  /** 試しの計算。支給月（`month`）と、今の方法の給与の表（`file`。CSV か Excel）を受け取り、並べて差を出す。 */
  app.post('/payroll/trials', async (c) => {
    const { tenant, user } = c.get('ctx');
    const form = await c.req.parseBody();
    const f = form['file'];
    if (!(f instanceof File)) return c.json({ error: '今の方法の給与の表（CSV か Excel）を選んでください' }, 400);
    if (f.size > IMPORT_MAX_BYTES) return c.json({ error: 'ファイルが大きすぎます（5 MB まで）' }, 413);
    const bytes = new Uint8Array(await f.arrayBuffer());
    const kind = (bytes[0] === 0x50 && bytes[1] === 0x4b) || /\.xlsx$/i.test(f.name) ? 'xlsx' : 'csv';
    let rows;
    try {
      rows = (await readSheet(bytes, kind, { maxRows: HR_IMPORT_MAX_ROWS + 1 })).rows;
    } catch {
      return c.json({ error: '表として読めませんでした（CSV か Excel のファイルを選んでください）' }, 400);
    }
    const r = await payroll.trial(tenant.id, user.id, String(form['month'] ?? ''), rows);
    return 'error' in r ? c.json(r, 400) : c.json(r, 201);
  });

  // ---- 労働条件通知書と労務カレンダー（第30.5.3節・第30.19.1節） ----

  /** 労働条件通知書の中身と足りない事項（作る前に見る）。`on` で雇用条件を選ぶ日。 */
  app.get('/employees/:id/terms-notice', async (c) => {
    const { tenant, user } = c.get('ctx');
    const doc = await service.termsNotice(tenant.id, user.id, c.req.param('id'), undefined, c.req.query('on'));
    return doc ? c.json({ notice: doc, texts: (await service.settings(tenant.id)).notice }) : c.json({ error: '従業員か雇用条件が見つかりません' }, 404);
  });

  /** 労働条件通知書の PDF。本文 `notice`（会社の定めの文。次からの既定として残す）・`on`。 */
  app.post('/employees/:id/terms-notice', async (c) => {
    const { tenant, user } = c.get('ctx');
    const b = await c.req.json<{ notice?: Record<string, string>; on?: string }>().catch(() => ({} as { notice?: Record<string, string>; on?: string }));
    const r = await service.termsNoticePdf(tenant.id, user.id, c.req.param('id'), b.notice, b.on);
    if (!r) return c.json({ error: '従業員か雇用条件が見つかりません' }, 404);
    c.header('Content-Type', 'application/pdf');
    c.header('Content-Disposition', 'attachment; filename="terms-notice.pdf"');
    return c.body(r.bytes as unknown as ArrayBuffer);
  });

  /** 労務の期限（今日から `days` 日。既定 90。過ぎて済んでいない手続きを含む）。 */
  app.get('/calendar', async (c) => {
    const { tenant } = c.get('ctx');
    const days = Math.min(366, Math.max(1, Number(c.req.query('days')) || 90));
    return c.json({ items: await deps.hr.calendar.list(tenant.id, days) });
  });

  // ---- 年末調整（Phase 2 段 2。第30.15.1節） ----

  const yea = deps.hr.yea;
  const yearOf = (v: string | undefined) => { const n = Number(v); return Number.isInteger(n) && n >= 2000 && n <= 2100 ? n : null; };

  /** 年末調整の一覧（対象・申告の状態・不備）と、その年の年末調整の回。 */
  app.get('/yea', async (c) => {
    const { tenant, user } = c.get('ctx');
    const year = yearOf(c.req.query('year'));
    if (!year) return c.json({ error: '年を入れてください' }, 400);
    return c.json(await yea.overview(tenant.id, user.id, year));
  });

  /** 対象の人に申告を頼む。 */
  app.post('/yea/request', async (c) => {
    const { tenant, user } = c.get('ctx');
    const b = await c.req.json<{ year?: string }>().catch(() => ({} as { year?: string }));
    const year = yearOf(String(b.year ?? ''));
    return year ? c.json(await yea.request(tenant.id, user.id, year)) : c.json({ error: '年を入れてください' }, 400);
  });

  /** 年末調整を計算して、年末調整の回（下書き）にする（`year`・`payDate`: 還付を払う日）。 */
  app.post('/yea/calculate', async (c) => {
    const { tenant, user } = c.get('ctx');
    const b = await c.req.json<{ year?: string; payDate?: string }>().catch(() => ({} as { year?: string; payDate?: string }));
    const year = yearOf(String(b.year ?? ''));
    if (!year) return c.json({ error: '年を入れてください' }, 400);
    const r = await yea.calculate(tenant.id, user.id, year, String(b.payDate ?? ''));
    return 'error' in r ? c.json(r, 400) : c.json(r, 201);
  });

  /** 源泉徴収票（提出用）・給与支払報告書・法定調書合計表の下書き（表計算）。 */
  app.get('/yea/report', async (c) => {
    const { tenant, user } = c.get('ctx');
    const year = yearOf(c.req.query('year'));
    if (!year) return c.json({ error: '年を入れてください' }, 400);
    const format = c.req.query('format') === 'xlsx' ? 'xlsx' : 'csv';
    const { columns, rows } = await yea.report(tenant.id, user.id, year);
    const bytes = await renderSheet(`源泉徴収票・給与支払報告書 ${year}`, columns, rows, format);
    c.header('Content-Type', format === 'csv' ? 'text/csv; charset=utf-8' : 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    c.header('Content-Disposition', `attachment; filename="withholding-${year}.${format}"`);
    return c.body(bytes as unknown as ArrayBuffer);
  });

  /** 1 人の申告。 */
  app.get('/yea/:employeeId', async (c) => {
    const { tenant } = c.get('ctx');
    const year = yearOf(c.req.query('year'));
    const e = await employeeOf(tenant.id, c.req.param('employeeId'));
    if (!year || !e) return c.json({ error: '従業員か年が見つかりません' }, 404);
    return c.json({ declaration: await yea.declaration(tenant.id, e, year) });
  });

  /** 担当者が申告を直す（アカウントの無い人の分を入れる）。 */
  app.put('/yea/:employeeId', async (c) => {
    const { tenant, user } = c.get('ctx');
    const b = await c.req.json<{ year?: string; data?: unknown }>().catch(() => ({} as { year?: string; data?: unknown }));
    const year = yearOf(String(b.year ?? ''));
    const e = await employeeOf(tenant.id, c.req.param('employeeId'));
    if (!year || !e) return c.json({ error: '従業員か年が見つかりません' }, 404);
    const r = await yea.save(tenant.id, user.id, e, year, (b.data ?? {}) as never, { submit: true, byStaff: true });
    return 'error' in r ? c.json(r, 400) : c.json(r);
  });

  /** 担当者が申告を確かめた（`checked`: true・false）。 */
  app.post('/yea/:employeeId/check', async (c) => {
    const { tenant, user } = c.get('ctx');
    const b = await c.req.json<{ year?: string; checked?: boolean }>().catch(() => ({} as { year?: string; checked?: boolean }));
    const year = yearOf(String(b.year ?? ''));
    if (!year) return c.json({ error: '年を入れてください' }, 400);
    return (await yea.check(tenant.id, user.id, c.req.param('employeeId'), year, b.checked !== false)) ? c.json({ ok: true }) : c.json({ error: '申告が出ていません' }, 404);
  });

  /** 源泉徴収票（本人交付用）の PDF。 */
  app.get('/yea/:employeeId/withholding.pdf', async (c) => {
    const { tenant, user } = c.get('ctx');
    const year = yearOf(c.req.query('year'));
    const e = await employeeOf(tenant.id, c.req.param('employeeId'));
    if (!year || !e) return c.json({ error: '従業員か年が見つかりません' }, 404);
    const bytes = await yea.withholdingPdf(tenant.id, user.id, e, year);
    if (!bytes) return c.json({ error: 'その年の給与がありません' }, 404);
    c.header('Content-Type', 'application/pdf');
    c.header('Content-Disposition', `attachment; filename="withholding-${year}.pdf"`);
    return c.body(bytes as unknown as ArrayBuffer);
  });

  // ---- 社会保険（Phase 2 段 3。第30.12.1節） ----

  const social = deps.hr.social;
  /** 下書きの表を返す。標準報酬月額に入れた人数を X-Applied に入れる。 */
  const sheetResponse = async (c: Context<AppEnv>, r: FilingSheet | { error: string }, name: string) => {
    if ('error' in r) return c.json(r, 400);
    const format = c.req.query('format') === 'csv' ? 'csv' : 'xlsx';
    const bytes = await renderSheet(r.title, r.columns, r.rows, format);
    c.header('Content-Type', format === 'csv' ? 'text/csv; charset=utf-8' : 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    c.header('Content-Disposition', `attachment; filename="${name}.${format}"`);
    c.header('X-Applied', String(r.applied));
    return c.body(bytes as unknown as ArrayBuffer);
  };
  const idsOf = (v: string | undefined) => (v ? v.split(',').map((x) => x.trim()).filter(Boolean).slice(0, 200) : undefined);

  /** 社会保険の画面（定時決定の年・随時改定の候補・資格の取得と喪失・加入の判定）。 */
  app.get('/social', async (c) => {
    const { tenant } = c.get('ctx');
    const year = yearOf(c.req.query('year'));
    if (!year) return c.json({ error: '年を入れてください' }, 400);
    return c.json(await social.overview(tenant.id, year));
  });

  /** 算定基礎届の下書き（9 月からの標準報酬月額を入れる）。 */
  app.post('/social/regular/report', async (c) => {
    const { tenant, user } = c.get('ctx');
    const year = yearOf(c.req.query('year'));
    if (!year) return c.json({ error: '年を入れてください' }, 400);
    return sheetResponse(c, await social.regularReport(tenant.id, user.id, year), `santei-${year}`);
  });

  /** 月額変更届の下書き（改定の月からの標準報酬月額を入れる。`ids` で人を選べる）。 */
  app.post('/social/change/report', async (c) => {
    const { tenant, user } = c.get('ctx');
    return sheetResponse(c, await social.changeReport(tenant.id, user.id, idsOf(c.req.query('ids'))), 'getsuhen');
  });

  /** 資格取得届・資格喪失届・70 歳到達届の下書き（資格取得は取得の月からの標準報酬月額を入れる）。 */
  app.post('/social/events/:kind/report', async (c) => {
    const { tenant, user } = c.get('ctx');
    const kind = c.req.param('kind');
    if (kind !== 'acquire' && kind !== 'lose' && kind !== 'age70') return c.json({ error: '届出の種類が違います' }, 400);
    return sheetResponse(c, await social.eventReport(tenant.id, user.id, kind, idsOf(c.req.query('ids'))), `${kind}`);
  });

  // ---- シフト（Phase 2 段 5。第30.6.2節） ----

  const shifts = deps.hr.shifts;
  const monthOf = (v: unknown) => (typeof v === 'string' && /^\d{4}-(0[1-9]|1[0-2])$/.test(v) ? v : null);
  const shiftResult = (c: Context<AppEnv>, r: object) => ('error' in r ? c.json(r, 400) : c.json(r));

  /** シフトの画面（`month`: 締め日の月。省略すれば次の期間）。 */
  app.get('/shifts', async (c) => {
    const { tenant } = c.get('ctx');
    const m = c.req.query('month');
    if (m !== undefined && !monthOf(m)) return c.json({ error: '月を YYYY-MM で入れてください' }, 400);
    return c.json(await shifts.view(tenant.id, m));
  });

  /** 勤務の型・日ごとに要る人数・変形労働時間制を直す。 */
  app.put('/shifts/settings', async (c) => {
    const { tenant, user } = c.get('ctx');
    return shiftResult(c, await shifts.saveSettings(tenant.id, user.id, await c.req.json().catch(() => ({}))));
  });

  /** シフトの案を作る（下書き。公開した期間は作り直せない）。 */
  app.post('/shifts/generate', async (c) => {
    const { tenant, user } = c.get('ctx');
    const b = await c.req.json<{ month?: string }>().catch(() => ({} as { month?: string }));
    const m = monthOf(b.month);
    return m ? shiftResult(c, await shifts.generate(tenant.id, user.id, m)) : c.json({ error: '月を YYYY-MM で入れてください' }, 400);
  });

  /** 1 人 1 日のシフトを直す（`patternId` が null なら休み）。 */
  app.put('/shifts/cell', async (c) => {
    const { tenant, user } = c.get('ctx');
    const b = await c.req.json<{ month?: string; employeeId?: string; date?: string; patternId?: string | null; start?: string; end?: string; breakMinutes?: number }>().catch(() => ({} as Record<string, never>));
    const m = monthOf(b.month);
    if (!m || !b.employeeId || !/^\d{4}-\d{2}-\d{2}$/.test(String(b.date))) return c.json({ error: '月・従業員・日を入れてください' }, 400);
    if (!(await employeeOf(tenant.id, b.employeeId))) return c.json({ error: '従業員が見つかりません' }, 404);
    return shiftResult(c, await shifts.setCell(tenant.id, user.id, m, b.employeeId, String(b.date), { patternId: b.patternId ?? null, start: b.start, end: b.end, breakMinutes: b.breakMinutes }));
  });

  /** 公開する（シフトの人に知らせ、勤怠の所定になる）。 */
  app.post('/shifts/publish', async (c) => {
    const { tenant, user } = c.get('ctx');
    const b = await c.req.json<{ month?: string }>().catch(() => ({} as { month?: string }));
    const m = monthOf(b.month);
    return m ? shiftResult(c, await shifts.publish(tenant.id, user.id, m)) : c.json({ error: '月を YYYY-MM で入れてください' }, 400);
  });

  // ---- 労働保険の年度更新（Phase 2 段 4。第30.13.1節） ----

  const labor = deps.hr.labor;

  /** 年度更新の画面（`year`: 申告する年）。 */
  app.get('/labor-insurance', async (c) => {
    const { tenant } = c.get('ctx');
    const year = yearOf(c.req.query('year'));
    return year ? c.json(await labor.view(tenant.id, year)) : c.json({ error: '年を入れてください' }, 400);
  });

  /** 足りない月の合計・申告済の概算保険料・見込みの賃金を残す（`year` と送った項目）。 */
  app.put('/labor-insurance', async (c) => {
    const { tenant, user } = c.get('ctx');
    const b = await c.req.json<Record<string, unknown>>().catch(() => ({} as Record<string, unknown>));
    const year = yearOf(String(b['year'] ?? ''));
    if (!year) return c.json({ error: '年を入れてください' }, 400);
    const r = await labor.save(tenant.id, user.id, year, b as never);
    // 画面の形（months を持つ）なら保存できた。error は計算できない理由で、保存の失敗ではない
    return 'months' in r ? c.json(r) : c.json(r, 400);
  });

  /** 算定基礎賃金集計表と申告書に書く額の下書き（結果を残し、次の年の申告済の概算保険料と延納の納期限に使う）。 */
  app.post('/labor-insurance/report', async (c) => {
    const { tenant, user } = c.get('ctx');
    const year = yearOf(c.req.query('year'));
    if (!year) return c.json({ error: '年を入れてください' }, 400);
    return sheetResponse(c, await labor.report(tenant.id, user.id, year), `nendo-koshin-${year}`);
  });

  /** 台帳に結び付けられる利用者（名前とメールアドレスだけ）。 */
  app.get('/users', async (c) => {
    const { tenant } = c.get('ctx');
    const users = (await deps.repo.listUsers(tenant.id)).filter((u) => u.status === 'active');
    return c.json({ users: users.map((u) => ({ id: u.id, name: u.displayName, email: u.email })) });
  });

  /**
   * 帳簿をまとめて ZIP で書き出す（解約のときに渡す。第30.17節・ADR-0054）。管理者だけ。まとめて書き出したことを監査ログに残す。
   */
  app.post('/books/export', async (c) => {
    const { tenant, user } = c.get('ctx');
    if (!user.roles.includes('admin')) return c.json({ error: '帳簿をまとめて書き出すのは管理者です' }, 403);
    const r = await deps.hr.books.build(tenant.id, user.id);
    c.header('Content-Type', 'application/zip');
    c.header('Content-Disposition', `attachment; filename="${r.filename}"`);
    c.header('X-Books-Files', String(r.summary.files));
    return c.body(r.bytes as unknown as ArrayBuffer);
  });

  /** 労働者名簿を CSV・Excel で書き出す（監査ログに残す）。 */
  app.get('/roster', async (c) => {
    const { tenant, user } = c.get('ctx');
    const format = c.req.query('format') === 'xlsx' ? 'xlsx' : 'csv';
    const { columns, rows } = await service.rosterRows(tenant.id, user.id);
    const bytes = await renderSheet('労働者名簿', columns, rows, format);
    const date = new Date().toISOString().slice(0, 10);
    c.header('Content-Type', format === 'csv' ? 'text/csv; charset=utf-8' : 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    c.header('Content-Disposition', `attachment; filename="roster-${date}.${format}"`);
    return c.body(bytes as unknown as ArrayBuffer);
  });

  return app;
}
