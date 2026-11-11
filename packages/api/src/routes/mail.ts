/**
 * @file メールの画面の API（仕様書 第9.5.1.1節、ADR-0131）。メールを M2Office の中で片付ける。
 *
 * - `GET /v1/mail` 一覧（返事が要る・対応が要る・返事待ち・目を通すだけ、宣伝・お知らせの件数、見回りの様子）
 * - `GET /v1/mail/count` 返事が要るものの件数（左のメニューの数）
 * - `GET /v1/mail/threads/:id` 1 件（本文は Gmail から読み、残さない。「目を通すだけ」は開いたら片付く）
 * - `PUT /v1/mail/threads/:id/draft` 下書きを直して残す
 * - `POST /v1/mail/threads/:id/redraft` 秘書に下書きを作ってもらう・直してもらう（`instruction`）
 * - `POST /v1/mail/threads/:id/done` 済みにする
 * - `POST /v1/mail/threads/:id/send` 本人が確かめた宛先・CC・本文で送る（業務「メールの返事を送る」を始め、本人の承認の後に送る）
 * - `POST /v1/mail/threads/:id/gmail-draft` Gmail の下書きに入れる
 * - `GET /v1/mail/lessons` 覚えていること（メールの学び。第9.5.1.1.2節）・`DELETE /v1/mail/lessons/:id` 1 つ消す
 *
 * 見られるのは本人だけ。運営の代理アクセスでは 404（本人の私的な中身を見せない）。
 */

import { Hono } from 'hono';
import { randomUUID } from 'node:crypto';
import { AI_NOT_CONFIGURED_MESSAGE, MAIL_REPLY_SEND, aiAvailable, enqueueJob } from '@m2office/core';
import type { AppDeps } from '../context.js';
import { passCorrection } from '../corrections.js';
import type { AppEnv } from '../middleware/tenant.js';

/** メールの画面の API。 */
export function mailRoute(deps: AppDeps) {
  const app = new Hono<AppEnv>();
  const service = deps.mail.service;
  const owner = (c: { get(k: 'ctx'): { tenant: { id: string }; user: { id: string } } }) => {
    const { tenant, user } = c.get('ctx');
    return { tenantId: tenant.id, userId: user.id };
  };

  app.use('*', async (c, next) => {
    if (c.get('auth').method === 'proxy') return c.json({ error: 'メールが見つかりません' }, 404);
    await next();
  });

  app.get('/', async (c) => {
    const o = owner(c);
    // まだ一度も見ていなければ、待たずに見る（最初の 1 回。本物の会社は API のプロセスからでも Google を読める）
    const w = await service.store.watch(o);
    if (!w?.checkedAt) await deps.mail.watch.runFor(o, new Date(), true).catch(() => null);
    return c.json(await service.overview(o));
  });

  app.get('/count', async (c) => c.json({ reply: await service.replyCount(owner(c)) }));

  // メールの学び（第9.5.1.1.2節「見る・直す・消す」）。「記憶とデータ」の画面に「メールの傾向」として並べる
  app.get('/lessons', async (c) => c.json({ items: await service.lessonsView(owner(c)) }));
  app.delete('/lessons/:id', async (c) => {
    const ok = await service.deleteLesson(owner(c), c.req.param('id'));
    if (ok) {
      await deps.repo.appendAudit({
        id: randomUUID(), tenantId: owner(c).tenantId, actorType: 'user', actorId: owner(c).userId, action: 'mail.lesson.delete',
        targetType: 'user', targetId: owner(c).userId, detail: {}, occurredAt: new Date().toISOString(),
      });
    }
    return ok ? c.json({ ok: true }) : c.json({ error: '見つかりません' }, 404);
  });

  app.get('/threads/:id', async (c) => {
    const d = await service.detail(owner(c), c.req.param('id'));
    return d ? c.json(d) : c.json({ error: 'メールが見つかりません' }, 404);
  });

  app.put('/threads/:id/draft', async (c) => {
    const body = await c.req.json<{ draft?: unknown }>().catch(() => ({ draft: undefined }));
    if (typeof body.draft !== 'string') return c.json({ error: 'draft に下書きを入れてください' }, 400);
    return (await service.saveDraft(owner(c), c.req.param('id'), body.draft)) ? c.json({ ok: true }) : c.json({ error: 'メールが見つかりません' }, 404);
  });

  app.post('/threads/:id/redraft', async (c) => {
    const body = await c.req.json<{ instruction?: unknown }>().catch(() => ({ instruction: undefined }));
    const instruction = typeof body.instruction === 'string' ? body.instruction : undefined;
    // 下書きを直す頼みは、直しとして学ぶ（第11.13.7節 ②）。メールの下書きの好みとして覚え、次の下書きに渡す
    if (instruction?.trim()) passCorrection(deps, { ...owner(c), kind: 'remake', agentId: 'mail', agentName: 'メールの返事の下書き', correction: instruction });
    const res = await service.redraft(owner(c), c.req.param('id'), instruction);
    return 'error' in res ? c.json({ error: res.error }, res.status) : c.json(res);
  });

  app.post('/threads/:id/done', async (c) => {
    return (await service.done(owner(c), c.req.param('id'))) ? c.json({ ok: true }) : c.json({ error: 'メールが見つかりません' }, 404);
  });

  /**
   * 本人が確かめた返事を送る。控えを残し、業務「メールの返事を送る」を始める。承認するのは本人だけ（画面の 2 回目の「送る」）。
   *
   * @returns 実行の ID
   */
  app.post('/threads/:id/send', async (c) => {
    const { tenant, user } = c.get('ctx');
    const o = owner(c);
    const id = c.req.param('id');
    const body = await c.req.json<{ to?: unknown; cc?: unknown; body?: unknown }>().catch(() => ({ to: undefined, cc: undefined, body: undefined }));
    const def = (await deps.tenantView(tenant.id)).resolve(MAIL_REPLY_SEND.id, MAIL_REPLY_SEND.version);
    if (!def) return c.json({ error: 'メールの返事を送る業務が見つかりません' }, 404);
    if (!aiAvailable(await deps.ai.llmFor(tenant.id))) return c.json({ error: AI_NOT_CONFIGURED_MESSAGE }, 409);
    const prepared = await service.prepareSend(o, id, { to: body.to, cc: body.cc, body: body.body });
    if ('error' in prepared) return c.json({ error: prepared.error }, prepared.status);
    const { runId } = await enqueueJob(deps.repo, {
      tenantId: tenant.id, requestedBy: user.id, def, input: { threadId: id }, origin: 'menu', actor: { type: 'user', id: user.id },
    });
    await service.attachSendRun(o, id, runId);
    await deps.repo.appendAudit({
      id: randomUUID(), tenantId: tenant.id, actorType: 'user', actorId: user.id, action: 'mail.send.requested',
      targetType: 'run', targetId: runId, detail: { to: prepared.row.outgoing?.to.length ?? 0, cc: prepared.row.outgoing?.cc.length ?? 0 },
      occurredAt: new Date().toISOString(),
    });
    return c.json({ runId }, 201);
  });

  app.post('/threads/:id/gmail-draft', async (c) => {
    const res = await service.toGmailDraft(owner(c), c.req.param('id')).catch((err: unknown) => ({ error: err instanceof Error ? err.message : String(err) }));
    if (!res) return c.json({ error: 'メールが見つかりません' }, 404);
    if ('error' in res) return c.json({ error: `Gmail の下書きに入れられませんでした（${res.error}）` }, 502);
    return c.json({ draftId: res.draftId, url: 'https://mail.google.com/mail/u/0/#drafts' });
  });

  return app;
}
