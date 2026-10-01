/**
 * @file 名刺管理（内蔵の拡張）の API。取り込み・一覧と検索・詳細・その場の修正・範囲・分ける・ごみ箱と消去・画像・vCard・会った日の予定。
 *
 * 会社が名刺管理を切っているときと、利用範囲の外の人には、どの口も使わせない。
 * 自分だけの名刺は、置き場の行単位の制限で本人だけに絞られる（管理者も見られない）。
 *
 * @see 仕様書 第27章 名刺管理
 */

import { Hono, type Context } from 'hono';
import {
  AI_NOT_CONFIGURED_MESSAGE, CARD_BATCH_MAX, CARD_BULK_MAIL, CARD_TABLE_MAX_ROWS, aiAvailable, canManage, draftThanksMail, enqueueJob, readSheet, renderSheet, toVCard,
  type CardUpload, type CardViewer,
} from '@m2office/core';
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
/** 表から取り込むファイルの大きさの上限（第27.4節）。 */
const TABLE_MAX_BYTES = 5 * 1024 * 1024;

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
        // 交換した日の範囲（まとめてのメールの宛先を探す。第27.9.1節）
        ...(/^\d{4}-\d{2}-\d{2}$/.test(c.req.query('from') ?? '') ? { receivedFrom: c.req.query('from')! } : {}),
        ...(/^\d{4}-\d{2}-\d{2}$/.test(c.req.query('to') ?? '') ? { receivedTo: c.req.query('to')! } : {}),
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
   * 表（CSV・Excel）から名刺を取り込む（第27.4節「表から取り込む」）。本文は multipart の `file`（1 つ）と `scope`。
   *
   * @remarks 列の見出しはよくある言い方と推論で読む。1 行を 1 枚の名刺として、その場で登録する（読み取りを待たない。画像が無いため）
   */
  app.post('/import', async (c) => {
    const v = who(c);
    const form = await c.req.parseBody();
    const f = form['file'];
    if (!(f instanceof File)) return c.json({ error: 'CSV か Excel のファイルを選んでください' }, 400);
    if (f.size > TABLE_MAX_BYTES) return c.json({ error: 'ファイルが大きすぎます（5 MB まで）' }, 413);
    const bytes = new Uint8Array(await f.arrayBuffer());
    const kind = (bytes[0] === 0x50 && bytes[1] === 0x4b) || /\.xlsx$/i.test(f.name) ? 'xlsx' : 'csv';
    let rows;
    try {
      rows = (await readSheet(bytes, kind, { maxRows: CARD_TABLE_MAX_ROWS + 1 })).rows;
    } catch {
      return c.json({ error: '表として読めませんでした（CSV か Excel のファイルを選んでください）' }, 400);
    }
    if (rows.length < 2) return c.json({ error: '見出しの行と、名刺の行が要ります' }, 400);
    const scopeIn = String(form['scope'] ?? '');
    const scope: ContactScope = scopeIn === 'company' || scopeIn === 'personal' ? scopeIn : c.get('cardsDefaultScope');
    return c.json(await service.importTable(v, rows, scope));
  });

  /**
   * 会社で共有の名刺を CSV・Excel で書き出す（第27.10節「書き出し」）。管理者だけ。`format`: `csv`（既定）・`xlsx`。
   *
   * @remarks 自分だけの名刺は入れない（管理者も見られないため）。監査ログに件数と形式を残す
   */
  app.get('/export', async (c) => {
    const { user } = c.get('ctx');
    if (!user.roles.includes('admin')) return c.json({ error: '名刺をまとめて書き出せるのは管理者です' }, 403);
    const format = c.req.query('format') === 'xlsx' ? 'xlsx' : 'csv';
    const { columns, rows } = await service.exportTable(who(c), format);
    const bytes = await renderSheet('名刺', columns, rows, format);
    const date = new Date().toISOString().slice(0, 10);
    c.header('Content-Type', format === 'csv' ? 'text/csv; charset=utf-8' : 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    c.header('Content-Disposition', `attachment; filename="business-cards-${date}.${format}"`);
    return c.body(bytes as unknown as ArrayBuffer);
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
  /**
   * まとめてのメールの下書きを作る（第27.9.1節）。本文は `contactIds`・`subject`・`body`。宛先は見られる連絡先だけを写す。
   */
  app.post('/bulk-mails', async (c) => {
    const body = await c.req.json<{ contactIds?: unknown; subject?: unknown; body?: unknown }>().catch(() => ({} as Record<string, unknown>));
    const res = await deps.cards.bulk.createDraft(who(c), {
      contactIds: Array.isArray(body.contactIds) ? body.contactIds.map(String).slice(0, 500) : [],
      subject: typeof body.subject === 'string' ? body.subject : '', body: typeof body.body === 'string' ? body.body : '',
    });
    return 'error' in res ? c.json({ error: res.error }, 400) : c.json(res, 201);
  });

  /** まとめてのメールの宛先・除いた人と理由・見本・送れない理由・送った数（第27.9.1節）。作った本人だけが見られる。 */
  app.get('/bulk-mails/:bulkId', async (c) => {
    const v = who(c);
    await syncAwaiting(v, c.req.param('bulkId'));
    const p = await deps.cards.bulk.preview(v, c.req.param('bulkId'));
    return p ? c.json(p) : c.json({ error: 'まとめてのメールが見つかりません' }, 404);
  });

  /** まとめてのメールの下書きを直す（宛先・件名・本文）。承認待ちにした後は直せない。 */
  app.put('/bulk-mails/:bulkId', async (c) => {
    const v = who(c);
    await syncAwaiting(v, c.req.param('bulkId'));
    const body = await c.req.json<{ contactIds?: unknown; subject?: unknown; body?: unknown }>().catch(() => ({} as Record<string, unknown>));
    const err = await deps.cards.bulk.update(v, c.req.param('bulkId'), {
      ...(Array.isArray(body.contactIds) ? { contactIds: body.contactIds.map(String).slice(0, 500) } : {}),
      ...(typeof body.subject === 'string' ? { subject: body.subject } : {}),
      ...(typeof body.body === 'string' ? { body: body.body } : {}),
    });
    return err ? c.json({ error: err }, 409) : c.json({ ok: true });
  });

  /** まとめてのメールの下書きを削除する（送ったものは削除しない）。 */
  app.delete('/bulk-mails/:bulkId', async (c) => {
    const err = await deps.cards.bulk.remove(who(c), c.req.param('bulkId'));
    return err ? c.json({ error: err }, 409) : c.json({ ok: true });
  });

  /**
   * まとめてのメールを承認へ進める（業務「まとめてのメール」を始め、本人の承認を待つ。第27.9.1節）。
   *
   * @returns 実行の ID。送れない理由があれば 400
   */
  app.post('/bulk-mails/:bulkId/submit', async (c) => {
    const { tenant, user } = c.get('ctx');
    const v = who(c);
    const id = c.req.param('bulkId');
    await syncAwaiting(v, id);
    const p = await deps.cards.bulk.preview(v, id);
    if (!p) return c.json({ error: 'まとめてのメールが見つかりません' }, 404);
    if (p.status !== 'draft') return c.json({ error: 'すでに承認へ進めています' }, 409);
    if (p.problems.length > 0) return c.json({ error: p.problems.join('／') }, 400);
    const def = (await deps.tenantView(tenant.id)).resolve(CARD_BULK_MAIL.id, CARD_BULK_MAIL.version);
    if (!def) return c.json({ error: 'まとめてのメールの業務が見つかりません' }, 404);
    if (!aiAvailable(await deps.ai.llmFor(tenant.id))) return c.json({ error: AI_NOT_CONFIGURED_MESSAGE }, 409);
    const { runId } = await enqueueJob(deps.repo, {
      tenantId: tenant.id, requestedBy: user.id, def, input: { bulkMailId: id }, origin: 'menu', actor: { type: 'user', id: user.id },
    });
    await deps.cards.bulk.markAwaiting(v, id, runId);
    return c.json({ runId }, 201);
  });

  /** 承認待ちのまとめてのメールで、実行が承認を待たなくなっていれば（却下・失敗）、下書きに戻す。 */
  const syncAwaiting = async (v: CardViewer, id: string): Promise<void> => {
    const mail = await deps.cards.bulk.store.getMail(v, id);
    if (mail?.status !== 'awaiting' || !mail.runId) return;
    const run = await deps.repo.getRun(v.tenantId, mail.runId);
    if (!run || ['completed', 'failed', 'cancelled', 'expired'].includes(run.status)) await deps.cards.bulk.backToDraft(v, id);
  };

  app.get('/:id', async (c) => {
    const v = who(c);
    const { user } = c.get('ctx');
    const d = await service.detail(v, c.req.param('id'));
    if (!d) return c.json({ error: '名刺が見つかりません' }, 404);
    const users = await deps.repo.listUsers(v.tenantId);
    // メールの署名から新しくしたもの（system）は人の名前を出さない（第27.6.1節）
    const nameOf = (id: string | null) => (id && id !== 'system' ? users.find((u) => u.id === id)?.displayName ?? '（取得できませんでした）' : null);
    return c.json({
      contact: d.contact,
      ownerName: nameOf(d.contact.ownerUserId),
      updatedByName: nameOf(d.contact.updatedBy),
      cards: d.cards.map((x) => ({
        id: x.id, receivedOn: x.receivedOn, receivedBy: nameOf(x.ownerUserId), mine: x.ownerUserId === user.id,
        hasFront: !!x.frontFileId, hasBack: !!x.backFileId, frontRotation: x.frontRotation, backRotation: x.backRotation,
        frontCorners: x.frontCorners, backCorners: x.backCorners,
        note: x.failureReason,
      })),
      history: d.history,
      // メールの署名から新しくした記録。誰のメールからかは出さない（第27.6.1節）
      changes: d.changes.map((x) => ({ id: x.id, occurredAt: x.occurredAt, fields: x.fields })),
      // 自分がこの人に送ったまとめてのメール（第27.9.1節）
      bulkMails: await deps.cards.bulk.store.sentForContact(v, d.contact.id),
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

  /** メールの署名から新しくした記録を戻す（第27.6.1節）。見られる人の全員が戻せる。 */
  app.post('/:id/changes/:changeId/revert', async (c) => {
    const err = await service.revertChange(who(c), c.req.param('id'), c.req.param('changeId'));
    return err ? c.json({ error: err }, 404) : c.json({ ok: true });
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

  /**
   * 名刺交換のお礼のメールの件名と本文を作る（第27.8節「メールを書く」）。画面が Gmail の新しいメールの画面に入れて開く。
   *
   * @remarks **送らない。** 送るのは本人が Gmail で行う。推論が使えなければ定型の文を返す
   */
  app.post('/:id/mail-draft', async (c) => {
    const v = who(c);
    const { tenant, user } = c.get('ctx');
    const contact = await store.getContact(v, c.req.param('id'));
    if (!contact) return c.json({ error: '名刺が見つかりません' }, 404);
    const mine = (await store.listCardsOfContact(v, contact.id)).find((x) => x.ownerUserId === user.id && x.status === 'done');
    const settings = await deps.repo.getTenantSettings(tenant.id);
    const llm = await deps.ai.llmFor(tenant.id).catch(() => null);
    const draft = await draftThanksMail(llm, {
      contact, receivedOn: mine?.receivedOn ?? null, today: await service.today(v), senderName: user.displayName,
      companyName: settings.company.shortName || settings.company.legalName || tenant.name, style: settings.writingStyle,
    });
    return c.json({ to: contact.emails[0] ?? '', ...draft });
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
