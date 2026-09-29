/**
 * @file 人事・給与の担当者の API（仕様書 第30章。段 1: 台帳・雇用条件・入退社の手続き・取り込み・労働者名簿）。
 *
 * 会社で入れていて、**人事区画に入っている人だけ**が使える（第30.2節）。それ以外は 403。
 * 他人の台帳を見ただけでも監査ログに残す（第30.21節。処理側で残す）。
 */

import { Hono } from 'hono';
import { readSheet, renderSheet, HR_IMPORT_MAX_ROWS, type EmployeeInput, type TermsInput } from '@m2office/core';
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
