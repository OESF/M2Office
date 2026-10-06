/**
 * @file 会員とポイント（内蔵の拡張）の API（ログインした従業員）。会員の一覧・作る・1 件・直す・削除・まとめる、
 * 来店・購入・特典を使う・調整・取り消し、会員証の QR と紙のカード、店員が読んだ会員証から会員を引く、特典を作る・直す。
 *
 * 会社が切っているときと、利用範囲の外の人には、どの口も使わせない。**購入の金額は保存しない**（第40.6節）。
 *
 * @see 仕様書 第40章
 */

import { Hono, type Context } from 'hono';
import { memberCardKeyOf } from '@m2office/shared';
import { memberCardUrl, memberQrSvg, renderMemberCard, type MemberViewer } from '@m2office/core';
import type { AppDeps } from '../context.js';
import type { AppEnv } from '../middleware/tenant.js';
import { tenantOrigin } from '../tenant-origin.js';

const ID = /^[A-Za-z0-9_-]{1,80}$/;

/**
 * 会員とポイントの API（仕様書 第40章）。
 *
 * @remarks 監査ログは処理（MemberService）が残す
 */
export function membersRoute(deps: AppDeps) {
  const app = new Hono<AppEnv>();
  const { service } = deps.members;
  const who = (c: Context<AppEnv>): MemberViewer => {
    const { tenant, user } = c.get('ctx');
    return { tenantId: tenant.id, userId: user.id };
  };
  const origin = (c: Context<AppEnv>) => tenantOrigin(c.req.header('origin'), c.req.header('host'));
  const body = (c: Context<AppEnv>) => c.req.json<Record<string, unknown>>().catch(() => ({} as Record<string, unknown>));
  /** 失敗の文から状態の番号を決める。 */
  const status = (e: string) => (e.includes('見つかりません') ? 404 : e.includes('管理者だけ') ? 403 : 400);
  const result = (c: Context<AppEnv>, r: { error: string } | Record<string, unknown>) => ('error' in r ? c.json(r, status(String(r['error']))) : c.json(r));

  // 会員とポイントを使えない会社・人には、どの口も使わせない（第12.13節・第16.7.3節）
  app.use('*', async (c, next) => {
    const { tenant, user } = c.get('ctx');
    if (!(await deps.members.access(tenant.id, user.id))) {
      return c.json({ error: '会員とポイントは使えません（会社で切っているか、利用範囲の外です）' }, 403);
    }
    await next();
  });

  /** 一覧（`q`: 呼び名・会員番号・電話）と、会社の率と、本人が管理者か。 */
  app.get('/', async (c) => {
    const w = who(c);
    const s = await service.settings(w.tenantId);
    return c.json({
      items: await service.list(w, (c.req.query('q') ?? '').slice(0, 50)),
      settings: { visitPoints: s.visitPoints, yenPerPoint: s.yenPerPoint, expiryDays: s.expiryDays, line: !!(s.liffId && s.lineLoginChannelId) },
      admin: c.get('ctx').user.roles.includes('admin'),
    });
  });

  /** 店頭で会員を作る。会員証の URL を返す。 */
  app.post('/', async (c) => {
    const r = await service.create(who(c), await body(c));
    if ('error' in r) return c.json(r, 400);
    return c.json({ member: r.member, cardUrl: memberCardUrl(origin(c), r.cardKey) }, 201);
  });

  /** 問い合わせの連絡先と同じ人の会員（`phone` と、`inquiryId` に結び付いた LINE のお客様。第40.8節）。 */
  app.get('/lookup', async (c) => {
    const w = who(c);
    const inquiryId = c.req.query('inquiryId') ?? '';
    // LINE のお客様の ID は画面に出さず、問い合わせから引く（問い合わせを使える人のときだけ）
    const lineUserId = ID.test(inquiryId) && await deps.inquiries.access(w.tenantId, w.userId)
      ? await deps.inquiries.service.lineUserIdOf(w.tenantId, inquiryId).catch(() => null) : null;
    const member = await service.findForContact(w.tenantId, { phone: c.req.query('phone') ?? null, lineUserId });
    return c.json({ member });
  });

  /** 店員が読んだ会員証（QR の URL か鍵）から、会員と使える特典。 */
  app.get('/card', async (c) => {
    const v = await service.byCard(who(c).tenantId, memberCardKeyOf(c.req.query('code') ?? ''));
    if (!v) return c.json({ error: '会員証が見つかりません' }, 404);
    const { cardKey: _k, ...rest } = v;
    return c.json(rest);
  });

  /** 会員への LINE の知らせ（新しい順）と、宛先ごとの LINE でつながっている会員の数（第40.18節）。 */
  app.get('/messages', async (c) => {
    const w = who(c);
    return c.json({ items: await service.messages(w), counts: await service.audienceCounts(w) });
  });

  /** 会員への LINE の知らせを用意して、承認へ進める（管理者だけ。送るのは承認の後）。 */
  app.post('/messages', async (c) => {
    const r = await service.prepareMessage(who(c), await body(c));
    return 'error' in r ? c.json(r, status(r.error)) : c.json(r, 201);
  });

  /** 特典（止めたものも含む）。 */
  app.get('/rewards', async (c) => c.json({ items: await service.rewards(who(c)) }));

  /** 特典を作る（管理者だけ）。 */
  app.post('/rewards', async (c) => {
    const r = await service.createReward(who(c), await body(c));
    return 'error' in r ? c.json(r, status(r.error)) : c.json(r, 201);
  });

  /** 特典を直す・止める（管理者だけ）。 */
  app.patch('/rewards/:id', async (c) => {
    const id = c.req.param('id');
    if (!ID.test(id)) return c.json({ error: '特典が見つかりません' }, 404);
    const problem = await service.updateReward(who(c), id, await body(c));
    return problem ? c.json({ error: problem }, status(problem)) : c.json({ ok: true });
  });

  /** 記録を取り消す（その日は店員、前の日は管理者）。 */
  app.post('/points/:id/undo', async (c) => {
    const id = c.req.param('id');
    if (!ID.test(id)) return c.json({ error: '記録が見つかりません' }, 404);
    const problem = await service.undo(who(c), id);
    return problem ? c.json({ error: problem }, status(problem)) : c.json({ ok: true });
  });

  /** 1 件と、ポイントの記録と、まとめる候補と、会員証の URL。 */
  app.get('/:id', async (c) => {
    const id = c.req.param('id');
    const w = who(c);
    const r = ID.test(id) ? await service.get(w, id) : null;
    if (!r) return c.json({ error: '会員が見つかりません' }, 404);
    const key = await service.cardKeyOf(w, id);
    return c.json({ ...r, cardUrl: key ? memberCardUrl(origin(c), key) : null });
  });

  /** 呼び名と電話を直す。 */
  app.patch('/:id', async (c) => {
    const problem = await service.update(who(c), c.req.param('id'), await body(c));
    return problem ? c.json({ error: problem }, status(problem)) : c.json({ ok: true });
  });

  /** 削除（退会。管理者だけ）。 */
  app.delete('/:id', async (c) => {
    const problem = await service.remove(who(c), c.req.param('id'));
    return problem ? c.json({ error: problem }, status(problem)) : c.json({ ok: true });
  });

  /** 来店（1 日 1 回まで）。 */
  app.post('/:id/visit', async (c) => result(c, await service.visit(who(c), c.req.param('id'))));
  /** 購入（`amount` 円。ポイントにしたら金額は捨てる）。 */
  app.post('/:id/purchase', async (c) => result(c, await service.purchase(who(c), c.req.param('id'), (await body(c))['amount'])));
  /** 特典を使う（`rewardId`）。 */
  app.post('/:id/reward', async (c) => result(c, await service.useReward(who(c), c.req.param('id'), String((await body(c))['rewardId'] ?? ''))));
  /** 調整（`points`・`note`）。 */
  app.post('/:id/adjust', async (c) => { const b = await body(c); return result(c, await service.adjust(who(c), c.req.param('id'), b['points'], b['note'])); });

  /** 同じ人の会員をまとめる（`into` にまとめる。管理者だけ）。 */
  app.post('/:id/merge', async (c) => {
    const problem = await service.merge(who(c), c.req.param('id'), String((await body(c))['into'] ?? ''));
    return problem ? c.json({ error: problem }, status(problem)) : c.json({ ok: true });
  });

  /** 会員証の QR（SVG）。 */
  app.get('/:id/qr.svg', async (c) => {
    const key = await service.cardKeyOf(who(c), c.req.param('id'));
    if (!key) return c.json({ error: '会員が見つかりません' }, 404);
    c.header('Content-Type', 'image/svg+xml');
    c.header('Cache-Control', 'no-store');
    return c.body(await memberQrSvg(memberCardUrl(origin(c), key)));
  });

  /** 紙の会員証（名刺の大きさの PDF）。 */
  app.get('/:id/card.pdf', async (c) => {
    const w = who(c);
    const r = await service.get(w, c.req.param('id'));
    const key = r ? await service.cardKeyOf(w, r.member.id) : null;
    if (!r || !key) return c.json({ error: '会員が見つかりません' }, 404);
    const company = (await deps.repo.getTenantSettings(w.tenantId)).company;
    const bytes = await renderMemberCard({ number: r.member.number, nickname: r.member.nickname, url: memberCardUrl(origin(c), key) }, company.shortName || company.legalName);
    c.header('Content-Type', 'application/pdf');
    c.header('Content-Disposition', `attachment; filename="member-${r.member.number}.pdf"`);
    c.header('Cache-Control', 'no-store');
    return c.body(bytes as unknown as ArrayBuffer);
  });

  return app;
}
