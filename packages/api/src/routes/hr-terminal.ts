/**
 * @file 共有の端末（打刻の画面）の API（仕様書 第30.6.3節、ADR-0085）。登録の番号・登録されたかの問い合わせ・QR・名前と番号での打刻。
 *
 * **ログインを使わない。** 会社はアドレスで決まり、端末は端末の鍵（`Authorization: Bearer`）で名乗る（店頭サイネージと同じ。第31.5.1節）。
 * 鍵は URL に載せない。鍵が無い・効かない・違う会社の鍵は 401、人事・給与を使っていない会社は 404。
 * 端末の鍵で読めるのは、その端末の QR と、会社が許したときの名前の一覧（番号を決めた人だけ）だけ。勤怠の中身は返さない。
 */

import { Hono, type Context } from 'hono';
import QRCode from 'qrcode';
import { PUNCH_LABELS, type HrTerminal } from '@m2office/core';
import type { AttPunchKind } from '@m2office/shared';
import type { AppDeps } from '../context.js';
import type { AppEnv } from '../middleware/tenant.js';
import { tenantOrigin } from '../tenant-origin.js';

/** 登録の番号を作れる回数（同じ接続元から 1 時間に）。 */
const PAIRING_PER_HOUR = 20;
const KINDS: AttPunchKind[] = ['in', 'out', 'break_start', 'break_end'];

type Env = AppEnv & { Variables: { terminal: HrTerminal } };

/**
 * 共有の端末の API（`/v1/hr-terminal`）。
 *
 * @remarks テナント境界: 会社はアドレスで決まり、端末の鍵はその会社の中でだけ引く（不変則 I-2）
 */
export function hrTerminalRoute(deps: AppDeps) {
  const app = new Hono<Env>();
  const terminals = deps.hr.terminals;
  const pairingHits = new Map<string, number[]>();
  const bearer = (c: Context<Env>) => /^Bearer\s+(\S+)$/.exec(c.req.header('authorization') ?? '')?.[1] ?? null;

  app.use('*', async (c, next) => {
    const tenant = c.get('tenant');
    if (!(await deps.repo.getTenantSettings(tenant.id)).hr.enabled) return c.json({ error: '人事・給与を使っていません' }, 404);
    if (c.req.path.includes('/pairings')) return next();
    const terminal = await terminals.byKey(tenant.id, bearer(c));
    if (!terminal) return c.json({ error: '端末の鍵が効きません' }, 401);
    c.set('terminal', terminal);
    await next();
  });

  /** 登録の番号を作る（本文: 登録の合言葉 `secret`）。 */
  app.post('/pairings', async (c) => {
    const tenant = c.get('tenant');
    const who = (c.req.header('x-forwarded-for') ?? '').split(',')[0]!.trim() || 'local';
    const now = Date.now();
    const hits = (pairingHits.get(who) ?? []).filter((t) => now - t < 3_600_000);
    if (hits.length >= PAIRING_PER_HOUR) return c.json({ error: '登録の番号を作りすぎました。しばらく待ってからお試しください' }, 429);
    pairingHits.set(who, [...hits, now]);
    const b = await c.req.json<{ secret?: unknown }>().catch(() => ({} as { secret?: unknown }));
    const r = await terminals.createPairing(tenant.id, b.secret);
    return 'error' in r ? c.json(r, 400) : c.json(r, 201);
  });

  /** 登録されたか（本文: 登録の合言葉 `secret`）。登録されていれば端末の鍵を 1 度だけ返す。 */
  app.post('/pairings/poll', async (c) => {
    const tenant = c.get('tenant');
    const b = await c.req.json<{ secret?: unknown }>().catch(() => ({} as { secret?: unknown }));
    return c.json(await terminals.pollPairing(tenant.id, b.secret));
  });

  /** 端末の名前・QR の期限・名前と番号での打刻を許すか・その一覧（番号を決めた人の名前だけ）。 */
  app.get('/state', async (c) => {
    const tenant = c.get('tenant');
    const terminal = c.get('terminal');
    const s = (await deps.repo.getTenantSettings(tenant.id)).hr;
    const qr = terminals.qrToken(tenant.id, terminal);
    const people = s.terminal.pinAllowed ? await terminals.pinPeople(tenant.id, await deps.hr.service.deps.store.listEmployees(tenant.id)) : [];
    // QR に描く URL も返す（端末の鍵を持つ端末は QR を出せるので、同じものである）
    const qrUrl = `${tenantOrigin(c.req.header('origin'), c.req.header('host'))}/m/punch?t=${encodeURIComponent(qr.token)}`;
    return c.json({ terminal: { name: terminal.name }, tenantName: tenant.name, expiresAt: qr.expiresAt, qrUrl, pinAllowed: s.terminal.pinAllowed, people });
  });

  /** 本人のスマホで読む QR（30 秒ごとに変わる。打刻のページの URL だけを描く）。 */
  app.get('/qr.svg', async (c) => {
    const tenant = c.get('tenant');
    const { token } = terminals.qrToken(tenant.id, c.get('terminal'));
    const url = `${tenantOrigin(c.req.header('origin'), c.req.header('host'))}/m/punch?t=${encodeURIComponent(token)}`;
    const svg = await QRCode.toString(url, { type: 'svg', errorCorrectionLevel: 'M', margin: 2 });
    return c.body(svg, 200, { 'content-type': 'image/svg+xml', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
  });

  /** 名前と番号で打刻する（会社が許したときだけ。本文: `employeeId`・`pin`・`kind`）。 */
  app.post('/pin-punch', async (c) => {
    const tenant = c.get('tenant');
    const terminal = c.get('terminal');
    if (!(await deps.repo.getTenantSettings(tenant.id)).hr.terminal.pinAllowed) return c.json({ error: '名前と番号での打刻は使っていません' }, 403);
    const b = await c.req.json<{ employeeId?: unknown; pin?: unknown; kind?: unknown }>().catch(() => ({} as { employeeId?: unknown; pin?: unknown; kind?: unknown }));
    if (!KINDS.includes(b.kind as AttPunchKind)) return c.json({ error: '打刻の種類が違います' }, 400);
    const employee = typeof b.employeeId === 'string' ? await deps.hr.service.deps.store.getEmployee(tenant.id, b.employeeId) : null;
    if (!employee || employee.status !== 'active') return c.json({ error: '名前が見つかりません' }, 404);
    const ok = await terminals.checkPin(tenant.id, employee, b.pin);
    if ('error' in ok) return c.json({ error: ok.error }, ok.status as 401);
    const r = await deps.hr.attendance.punch(tenant.id, `terminal:${terminal.id}`, employee, b.kind as AttPunchKind, 'terminal', terminal.id);
    return 'error' in r ? c.json(r, 409) : c.json({ name: employee.name, label: PUNCH_LABELS[b.kind as AttPunchKind], at: r.punch.at }, 201);
  });

  return app;
}
