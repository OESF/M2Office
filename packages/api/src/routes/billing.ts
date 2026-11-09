/**
 * @file 管理者ページの「ご利用料金」の API（仕様書 第23.4.5節「画面」）。管理者だけが使う。
 *
 * クラスと人数・契約の形・支払いの方法・請求書の一覧・解約。カードの番号はここを通らない
 * （1 回限りの札を作って申し込みの口へ移し、Stripe の支払いのページで登録する）。
 *
 * @remarks 危険度: 高（お金に関わる。支払いの方法の登録と解約は管理者が自分で決める。ADR-0028）
 */

import { createHash, randomBytes } from 'node:crypto';
import { Hono } from 'hono';
import { billingRefusal } from '@m2office/core';
import type { ContractTerm } from '@m2office/shared';
import type { AppDeps } from '../context.js';
import { requireRole, type AppEnv } from '../middleware/tenant.js';
import { tenantOrigin } from '../tenant-origin.js';

/**
 * 会社の画面のオリジンから、申し込みの口のオリジンを作る。
 *
 * @example `https://acme.example.jp` と `acme` → `https://signup.example.jp`
 */
export function signupOrigin(origin: string, subdomain: string): string {
  const u = new URL(origin);
  u.hostname = u.hostname.replace(new RegExp(`^${subdomain.replace(/[^a-z0-9-]/g, '')}\\.`), 'signup.');
  return u.origin;
}

/** 本文の契約の形を読む（無ければ null。スターターが支払いの方法を選ぶときだけ送る）。 */
const termOf = (v: unknown): ContractTerm | null => (v === 'monthly' || v === 'annual' ? v : null);

/** ご利用料金の API を作る。 */
export function billingRoute(deps: AppDeps) {
  const app = new Hono<AppEnv>();
  app.use('*', requireRole('admin'));

  app.get('/', async (c) => {
    const { tenant } = c.get('ctx');
    const view = await deps.billing.store.view(tenant.id);
    return c.json({ ...view, cardReady: deps.billing.cardReady });
  });

  // 契約の形を選ぶ（お金に関わるので管理者が決める。年間へは翌月 1 日から、月間へは更新のときだけ）
  app.post('/term', async (c) => {
    const { tenant, user } = c.get('ctx');
    const b = await c.req.json<{ term?: unknown }>().catch(() => ({} as { term?: unknown }));
    const term = termOf(b.term);
    if (!term) return c.json({ error: '契約の形の値が違います', code: 'term_invalid' }, 400);
    try {
      await deps.billing.store.setTerm(tenant.id, user.id, term);
    } catch (err) {
      const code = billingRefusal(err);
      if (code === 'not_billable') return c.json({ error: 'この会社には請求がありません', code }, 409);
      if (code === 'contract_by_operator') return c.json({ error: 'このクラスの契約は運営との取り決めで決まります', code }, 409);
      throw err;
    }
    return c.json({ ok: true });
  });

  // 銀行振込を選ぶ（運営の確かめを待たない。Q-304）
  app.post('/transfer', async (c) => {
    const { tenant, user } = c.get('ctx');
    const b = await c.req.json<{ billingName?: string; term?: unknown }>().catch(() => ({} as { billingName?: string; term?: unknown }));
    const term = termOf(b.term);
    try {
      if (term) await deps.billing.store.setTerm(tenant.id, user.id, term);
      await deps.billing.store.chooseTransfer(tenant.id, user.id, b.billingName ?? '');
    } catch (err) {
      const code = billingRefusal(err);
      if (code === 'transfer_unavailable') return c.json({ error: 'いまは銀行振込を選べません（振込先を準備中です）', code }, 409);
      if (code === 'not_billable') return c.json({ error: 'この会社には請求がありません', code }, 409);
      if (code === 'contract_by_operator') return c.json({ error: 'このクラスの契約は運営との取り決めで決まります', code }, 409);
      throw err;
    }
    return c.json({ ok: true });
  });

  // カードの登録へ移る。札の値は応答で 1 度だけ返し、データベースにはハッシュだけを置く
  app.post('/card', async (c) => {
    const { tenant, user } = c.get('ctx');
    if (!deps.billing.cardReady) return c.json({ error: 'いまはカードを登録できません（準備中です）', code: 'card_unavailable' }, 409);
    const b = await c.req.json<{ billingName?: string; term?: unknown; back?: unknown }>().catch(() => ({} as { billingName?: string; term?: unknown; back?: unknown }));
    const term = termOf(b.term);
    const origin = tenantOrigin(c.req.header('origin'), c.req.header('host'));
    // セットアップウィザードの招待の段から来たときは、登録の後にその段へ戻す（仕様書 第6.10.3節、ADR-0130）
    const back = b.back === 'setup' ? '/setup' : '/admin/billing';
    const ticket = randomBytes(32).toString('base64url');
    try {
      if (term) await deps.billing.store.setTerm(tenant.id, user.id, term);
      await deps.billing.store.cardTicket(tenant.id, user.id, createHash('sha256').update(ticket).digest('hex'), `${origin}${back}`, b.billingName ?? '');
    } catch (err) {
      const code = billingRefusal(err);
      if (code === 'not_billable') return c.json({ error: 'この会社には請求がありません', code }, 409);
      if (code === 'contract_by_operator') return c.json({ error: 'このクラスの契約は運営との取り決めで決まります', code }, 409);
      throw err;
    }
    return c.json({ url: `${signupOrigin(origin, tenant.subdomain)}/billing/card?ticket=${encodeURIComponent(ticket)}` });
  });

  // 解約を申し出る・取り下げる（月間はその月の末、年間は契約の終わりの日まで使える）
  app.post('/cancel', async (c) => {
    const { tenant, user } = c.get('ctx');
    const b = await c.req.json<{ cancel?: boolean }>().catch(() => ({} as { cancel?: boolean }));
    try {
      return c.json({ cancelOn: await deps.billing.store.setCancel(tenant.id, user.id, b.cancel !== false) });
    } catch (err) {
      const code = billingRefusal(err);
      if (code === 'not_billable' || code === 'contract_by_operator') return c.json({ error: 'この会社は、ここからは解約できません', code }, 409);
      throw err;
    }
  });

  return app;
}
