/**
 * @file 名刺管理（内蔵の拡張）の API。取り込み・一覧と検索・詳細・その場の修正・範囲・分ける・ごみ箱と消去・画像・vCard・会った日の予定。
 *
 * 会社が名刺管理を切っているときと、利用範囲の外の人には、どの口も使わせない。
 * 自分だけの名刺は、置き場の行単位の制限で本人だけに絞られる（管理者も見られない）。
 *
 * @see 仕様書 第27章 名刺管理
 */

import { Hono, type Context } from 'hono';
import { CARD_BATCH_MAX, canManage, toVCard, type CardUpload, type CardViewer } from '@m2office/core';
import type { CardFields, ContactScope } from '@m2office/shared';
import type { AppDeps } from '../context.js';
import type { AppEnv } from '../middleware/tenant.js';

/** 名刺の口の環境。会社の既定の範囲を、入口で確かめたときに持たせる。 */
type CardsEnv = { Variables: AppEnv['Variables'] & { cardsDefaultScope: ContactScope } };

/** 呼んだ人として見る。 */
const who = (c: Context<CardsEnv>): CardViewer => {
  const { tenant, user } = c.get('ctx');
  return { tenantId: tenant.id, userId: user.id };
};

/** 会った日の予定を引く日数の上限（交換した日が多い人でも、呼ぶたびの Google への問い合わせを抑える）。 */
const MEETING_DAYS_MAX = 5;

/**
 * 名刺管理の API（仕様書 第27章）。
 *
 * @remarks
 * 読み取りは後ろで進める。受け付けは待たせずに返し、進み具合は一覧の `progress` で返す（第27.4節）。
 * 会った日の予定は、開くたびに Google から引いて返すだけで保存しない（第27.8節、Q-78）
 */
export function cardsRoute(deps: AppDeps) {
  const app = new Hono<CardsEnv>();
  const { service, store } = deps.cards;

  // 名刺管理を使えない会社・人には、どの口も使わせない（第12.13節・第16.7.3節）
  app.use('*', async (c, next) => {
    const { tenant, user } = c.get('ctx');
    const access = await deps.cards.access(tenant.id, user.id);
    if (!access) return c.json({ error: '名刺管理は使えません（会社で切っているか、利用範囲の外です）' }, 403);
    c.set('cardsDefaultScope', access.defaultScope);
    await next();
  });

  /** 一覧と検索（第27.8節）。本人の読み取り中・読み取れなかった名刺と、進み具合も返す。 */
  app.get('/', async (c) => {
    const v = who(c);
    const scope = c.req.query('scope');
    const [items, unresolved, batches] = await Promise.all([
      store.listContacts(v, {
        q: (c.req.query('q') ?? '').slice(0, 100),
        scope: scope === 'company' || scope === 'personal' ? scope : 'all',
        status: c.req.query('trash') === '1' ? 'trash' : 'active',
        limit: 100, offset: Math.max(0, Number(c.req.query('offset')) || 0),
      }),
      store.listUnresolvedCards(v),
      store.activeBatches(v),
    ]);
    const progress = batches.length > 0
      ? { total: batches.reduce((n, b) => n + b.total, 0), finished: batches.reduce((n, b) => n + b.done + b.failed, 0) }
      : null;
    return c.json({
      items, progress,
      unresolved: unresolved.map((x) => ({ id: x.id, status: x.status, failureReason: x.failureReason, frontFileId: x.frontFileId, createdAt: x.createdAt })),
      defaultScope: c.get('cardsDefaultScope'),
      hasMore: items.length === 100,
    });
  });

  /**
   * 名刺のファイルを受け付ける（第27.4節）。本文は multipart。`file` を何個でも（50 まで）、`backOf` は JSON の配列。
   *
   * @remarks 読み取りを待たずに返す（202）。範囲を選ばなければ会社の既定
   */
  app.post('/', async (c) => {
    const v = who(c);
    const form = await c.req.parseBody({ all: true });
    const raw = form['file'];
    const list = (Array.isArray(raw) ? raw : raw ? [raw] : []).filter((f): f is File => f instanceof File);
    if (list.length === 0) return c.json({ error: 'file を指定してください' }, 400);
    if (list.length > CARD_BATCH_MAX) return c.json({ error: `1 回に渡せるのは ${CARD_BATCH_MAX} 枚までです` }, 400);
    let backOf: (number | null)[] = [];
    try { backOf = JSON.parse(String(form['backOf'] ?? '[]')) as (number | null)[]; } catch { backOf = []; }
    const scopeIn = String(form['scope'] ?? '');
    const scope: ContactScope = scopeIn === 'company' || scopeIn === 'personal' ? scopeIn : c.get('cardsDefaultScope');
    const uploads: CardUpload[] = [];
    for (const [i, f] of list.entries()) {
      uploads.push({ name: f.name || `card-${i + 1}.jpg`, bytes: new Uint8Array(await f.arrayBuffer()), backOf: typeof backOf[i] === 'number' ? backOf[i] : null });
    }
    const res = await service.accept(v, uploads, scope);
    return c.json(res, res.queued > 0 ? 202 : 400);
  });

  /** 名刺の画像（表・裏）。見られる名刺のものだけを返す。 */
  app.get('/card/:cardId/:side{front|back}', async (c) => {
    const v = who(c);
    const card = await store.getCard(v, c.req.param('cardId'));
    const fileId = c.req.param('side') === 'back' ? card?.backFileId : card?.frontFileId;
    if (!card || !fileId) return c.json({ error: '画像が見つかりません' }, 404);
    const meta = await deps.repo.getFile(v.tenantId, fileId);
    const bytes = meta ? await deps.files.get(v.tenantId, fileId) : null;
    if (!meta || !bytes) return c.json({ error: '画像が見つかりません' }, 404);
    return new Response(Buffer.from(bytes), {
      headers: {
        'content-type': meta.mime,
        'x-content-type-options': 'nosniff',
        'cache-control': 'private, max-age=3600',
        // ページだけの PDF は画面の中で見せる。中身を画面の権限で動かさないよう、囲いの中で開かせる
        ...(meta.kind === 'pdf' ? { 'content-security-policy': 'sandbox' } : {}),
      },
    });
  });

  /** 受け取った日を直す（第27.3節）。受け取った本人だけ。本文 `{ receivedOn: "YYYY-MM-DD" }`。 */
  app.put('/card/:cardId/received', async (c) => {
    const body = await c.req.json<{ receivedOn?: unknown }>().catch(() => ({ receivedOn: undefined }));
    const err = await service.setReceivedOn(who(c), c.req.param('cardId'), String(body.receivedOn ?? ''));
    return err ? c.json({ error: err }, err.includes('見つかりません') ? 404 : 400) : c.json({ ok: true });
  });

  /** 読み取れなかった名刺を、待たずに消す（取り込んだ本人だけ）。 */
  app.delete('/card/:cardId', async (c) => {
    const ok = await service.dismissFailed(who(c), c.req.param('cardId'));
    return ok ? c.json({ ok: true }) : c.json({ error: '読み取れなかった名刺が見つかりません' }, 404);
  });

  /** 詳細（第27.8節）。項目・名刺（表と裏）・交換の記録（誰が・いつ）・名刺の履歴・操作できるか。 */
  app.get('/:id', async (c) => {
    const v = who(c);
    const { user } = c.get('ctx');
    const d = await service.detail(v, c.req.param('id'));
    if (!d) return c.json({ error: '名刺が見つかりません' }, 404);
    const users = await deps.repo.listUsers(v.tenantId);
    const nameOf = (id: string | null) => (id ? users.find((u) => u.id === id)?.displayName ?? '（取得できませんでした）' : null);
    return c.json({
      contact: d.contact,
      ownerName: nameOf(d.contact.ownerUserId),
      updatedByName: nameOf(d.contact.updatedBy),
      cards: d.cards.map((x) => ({
        id: x.id, receivedOn: x.receivedOn, receivedBy: nameOf(x.ownerUserId), mine: x.ownerUserId === user.id,
        hasFront: !!x.frontFileId, hasBack: !!x.backFileId, frontRotation: x.frontRotation, backRotation: x.backRotation,
        note: x.failureReason,
      })),
      history: d.history,
      canManage: canManage(d.contact, user),
    });
  });

  /** 項目とメモをその場で直す（第27.5節・第27.8節）。見られる人の全員が直せる。 */
  app.patch('/:id', async (c) => {
    const body = await c.req.json<Partial<CardFields> & { note?: string }>().catch(() => ({}));
    const ok = await service.updateFields(who(c), c.req.param('id'), body);
    return ok ? c.json({ ok: true }) : c.json({ error: '名刺が見つかりません' }, 404);
  });

  /** 範囲を変える（第27.7節）。 */
  app.put('/:id/scope', async (c) => {
    const { user } = c.get('ctx');
    const body = await c.req.json<{ scope?: string }>().catch(() => ({ scope: undefined }));
    if (body.scope !== 'company' && body.scope !== 'personal') return c.json({ error: 'scope は company か personal です' }, 400);
    const err = await service.setScope(who(c), user, c.req.param('id'), body.scope);
    return err ? c.json({ error: err }, 403) : c.json({ ok: true });
  });

  /** まとめた名刺を別の連絡先に分ける（第27.6節）。 */
  app.post('/:id/split', async (c) => {
    const { user } = c.get('ctx');
    const body = await c.req.json<{ cardId?: string }>().catch(() => ({ cardId: undefined }));
    const res = await service.split(who(c), user, c.req.param('id'), String(body.cardId ?? ''));
    return 'error' in res ? c.json({ error: res.error }, 400) : c.json(res);
  });

  /** ごみ箱へ移す（30 日で本当に消す）。 */
  app.delete('/:id', async (c) => {
    const { user } = c.get('ctx');
    const err = await service.trash(who(c), user, c.req.param('id'));
    return err ? c.json({ error: err }, 403) : c.json({ ok: true });
  });

  /** ごみ箱から戻す。 */
  app.post('/:id/restore', async (c) => {
    const { user } = c.get('ctx');
    const err = await service.restore(who(c), user, c.req.param('id'));
    return err ? c.json({ error: err }, 403) : c.json({ ok: true });
  });

  /** ごみ箱の名刺を、いま本当に消す（名刺の相手から消去を求められたとき。第27.7節）。 */
  app.delete('/:id/purge', async (c) => {
    const { user } = c.get('ctx');
    const err = await service.purgeNow(who(c), user, c.req.param('id'));
    return err ? c.json({ error: err }, 403) : c.json({ ok: true });
  });

  /** vCard で書き出す（1 件。見られる人が書き出せる。第27.10節）。 */
  app.get('/:id/vcard', async (c) => {
    const contact = await store.getContact(who(c), c.req.param('id'));
    if (!contact) return c.json({ error: '名刺が見つかりません' }, 404);
    return new Response(toVCard(contact), {
      headers: {
        'content-type': 'text/vcard; charset=utf-8',
        'content-disposition': `attachment; filename*=UTF-8''${encodeURIComponent(`${contact.name || contact.company || 'contact'}.vcf`)}`,
      },
    });
  });

  /**
   * 会った場面（第27.8節）。本人が名刺を受け取った日の、本人の予定をカレンダーから引いて返す。**保存しない**（Q-78）。
   *
   * @remarks 引けなかったときは、引けなかったと返す（予定が無いとは言わない）
   */
  app.get('/:id/meetings', async (c) => {
    const v = who(c);
    const cards = (await store.listCardsOfContact(v, c.req.param('id'))).filter((x) => x.ownerUserId === v.userId && x.status === 'done');
    const days = [...new Set(cards.map((x) => x.receivedOn))].slice(0, MEETING_DAYS_MAX);
    const out: { date: string; events: { title: string; start: string; end: string; allDay: boolean }[] }[] = [];
    try {
      for (const date of days) {
        const from = new Date(`${date}T00:00:00+09:00`).toISOString();
        const to = new Date(new Date(from).getTime() + 86_400_000).toISOString();
        const events = await deps.connector.calendar.list(v, { from, to });
        out.push({ date, events: events.slice(0, 10).map((e) => ({ title: e.title, start: e.start, end: e.end, allDay: !!e.allDay })) });
      }
    } catch {
      return c.json({ available: false, reason: '予定を取得できませんでした' });
    }
    return c.json({ available: true, days: out });
  });

  return app;
}
