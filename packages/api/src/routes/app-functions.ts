/**
 * @file 外部のアプリの機能の道（仕様書 第13.4.1節、ADR-0090）。アプリが鍵で、画面と同じ `/v1` の道を呼ぶ。
 *
 * - `GET /v1/company/profile` 会社の基本情報を読む（`company.profile`）
 * - `GET /v1/inventory/catalog` 商品の一覧を読む（`inventory.catalog`。第29.20.1節）
 * - `POST /v1/inventory/sales-events` 販売を知らせる（`inventory.sales`。第29.20.1節）
 * - `POST /v1/inventory/receipts` 入庫を知らせる（`inventory.receipts`。第13.4.2節）
 * - `/v1/accounts/…` アカウントを結び付ける（`accounts.link`。第11.12節）・`POST /v1/knowledge/search` ナレッジを検索する（`knowledge.search`）
 * - `/v1/knowledge/rules/{ref}` 社内規程を登録・改定する（`knowledge.rules`）・`POST /v1/inquiries/intake` 問い合わせを受ける（`inquiries.intake`）
 * - `/v1/notices` 社内のお知らせを出す（`notices.post`）・`/v1/reservations/…` 予約の空きを読む・予約を入れる（`reservations.book`）
 * - `POST /v1/members/points` 会員のポイント（`members.points`）・`/v1/columns/published` 公開したコラム（`columns.read`）
 * - `POST /v1/jobs`・`GET /v1/runs/{id}` 業務を依頼して結果を受け取る（`jobs.run`）
 *
 * 鍵・会社・機能・回数の上限は認証の段（`authenticate`）で確かめ済み。ここは機能の業務だけを行う。
 * アプリの道だけのものは、画面のログインで呼ばれたら 404。画面と同じ道（お知らせ・予約・業務の依頼）は、画面のログインなら画面の道へ回す。
 * 送られてきた中身はデータとして扱い、指示として読まない（不変則 I-6）。
 */

import { createHash, randomUUID } from 'node:crypto';
import { Hono, type Context } from 'hono';
import { RISK_ORDER, memberCardKeyOf, type RiskLevel } from '@m2office/shared';
import {
  AI_NOT_CONFIGURED_MESSAGE, ExternalApps, KNOWLEDGE_MAX_CHARS, LINK_CODE_TTL_MS, KNOWLEDGE_QUESTION_MAX, KNOWLEDGE_SEARCH_PER_MINUTE, SALES_PAYLOAD_MAX_BYTES, aiAvailable, dateIn, enqueueJob,
  type HookResponse, type SalesItemQuery,
} from '@m2office/core';
import type { AppDeps } from '../context.js';
import type { AppEnv } from '../middleware/tenant.js';

const NOT_FOUND = { error: 'not found' };
/** 小さな本文の上限（アカウントの結び付け・ナレッジの検索・予約・ポイント。第11.12節）。 */
const SMALL_BODY = 4 * 1024;
/** 社内規程の本文を含む要求の上限（バイト）。 */
const RULE_BODY_MAX = KNOWLEDGE_MAX_CHARS * 4;
/** 文書管理のシステムの文書の番号の形。 */
const RULE_REF = /^[A-Za-z0-9._-]{1,64}$/;

/** アプリが登録する社内規程の ID（アプリと文書の番号から決まる。ほかのアプリや管理者の規程には当たらない）。 */
function ruleIdOf(appId: string, ref: string): string {
  return `k-app-${createHash('sha256').update(`${appId}\u0000${ref}`).digest('hex').slice(0, 24)}`;
}

/**
 * JSON（UTF-8）の本文を読む。形が違えば答え（415・413・400）を返す。
 *
 * @returns 読んだオブジェクトか、そのまま返す答え
 */
async function jsonOf(c: Context<AppEnv>, maxBytes: number): Promise<Record<string, unknown> | Response> {
  const type = (c.req.header('content-type') ?? '').toLowerCase();
  if (!type.startsWith('application/json') || (/charset=/.test(type) && !/charset=utf-8/.test(type))) return c.json({ error: 'JSON（UTF-8）で送ってください' }, 415);
  const raw = await c.req.text();
  if (new TextEncoder().encode(raw).length > maxBytes) return c.json({ error: `本文は ${Math.floor(maxBytes / 1024).toLocaleString('ja-JP')} KB までです` }, 413);
  try {
    const v = JSON.parse(raw) as unknown;
    if (!v || typeof v !== 'object' || Array.isArray(v)) return c.json({ error: '本文は JSON のオブジェクトにしてください', field: '' }, 400);
    return v as Record<string, unknown>;
  } catch {
    return c.json({ error: 'JSON として読めません', field: '' }, 400);
  }
}

/** カンマ区切りの絞り込み（同じ名前を重ねても読む）。 */
function listOf(c: Context, name: string): string[] | undefined {
  const all = c.req.queries(name);
  if (!all) return undefined;
  return all.flatMap((v) => v.split(',')).map((v) => v.trim()).filter(Boolean);
}

/**
 * 外部のアプリの機能の道。
 *
 * @remarks テナント境界: 認証の段で、鍵の会社と呼んだ名前の会社が合うことを確かめてある。ここは `ctx.tenant` の中だけを読む（不変則 I-2）
 */
export function appFunctionsRoute(deps: AppDeps) {
  const app = new Hono<AppEnv>();

  /** 外部のアプリの鍵で呼ばれたときだけ通す。 */
  const appOf = (c: Context<AppEnv>) => {
    const auth = c.get('auth');
    return auth?.method === 'app' ? auth : null;
  };
  /** 在庫管理を入れている会社か（切っていれば、会社が止まっているときと同じ 404）。 */
  const inventoryOn = async (tenantId: string) => (await deps.repo.getTenantSettings(tenantId)).inventory.enabled;
  const reply = <T>(c: Context<AppEnv>, r: HookResponse<T>) => {
    if (r.status === 200) return c.json(r.body as object, 200);
    return c.json(r.body, r.status, 'retryAfter' in r && r.retryAfter ? { 'Retry-After': String(r.retryAfter) } : {});
  };

  /**
   * 会社の基本情報（第6.6.1節の会社情報のうち、外に出してよいもの）。
   *
   * @remarks 端数処理・締め日・支払サイトなどの経理の設定と、ロゴのファイルは返さない
   */
  app.get('/company/profile', async (c) => {
    if (!appOf(c)) return c.json(NOT_FOUND, 404);
    const { tenant } = c.get('ctx');
    const co = (await deps.repo.getTenantSettings(tenant.id)).company;
    return c.json({
      legalName: co.legalName || tenant.name, shortName: co.shortName || null, postalCode: co.postalCode || null, address: co.address || null,
      phone: co.phone || null, website: co.website || null, invoiceRegistrationNumber: co.invoiceRegistrationNumber || null,
      fiscalYearStartMonth: co.fiscalYearStartMonth, businessDays: [...co.businessDays].sort(), holidaysClosed: co.holidaysClosed,
    });
  });

  /** 商品の一覧（承認した範囲だけ。`updatedSince`・`categories`・`ids`・`codes`・`barcodes`・`limit`・`cursor`）。 */
  app.get('/inventory/catalog', async (c) => {
    const a = appOf(c);
    if (!a) return c.json(NOT_FOUND, 404);
    const { tenant } = c.get('ctx');
    if (!(await inventoryOn(tenant.id))) return c.json(NOT_FOUND, 404);
    const limit = c.req.query('limit');
    const q: SalesItemQuery = {
      ...(c.req.query('updatedSince') !== undefined ? { updatedSince: c.req.query('updatedSince')! } : {}),
      ...(listOf(c, 'categories') ? { categories: listOf(c, 'categories')! } : {}),
      ...(listOf(c, 'ids') ? { ids: listOf(c, 'ids')! } : {}),
      ...(listOf(c, 'codes') ? { codes: listOf(c, 'codes')! } : {}),
      ...(listOf(c, 'barcodes') ? { barcodes: listOf(c, 'barcodes')! } : {}),
      ...(limit !== undefined ? { limit: Number(limit) } : {}),
      ...(c.req.query('cursor') !== undefined ? { cursor: c.req.query('cursor')! } : {}),
    };
    try {
      return reply(c, await deps.inventory.sales.listItems(tenant.id, a.appId, q));
    } catch (err) {
      deps.log.warn('外部のアプリに商品の一覧を返せませんでした', { error: String(err) });
      return c.json({ error: 'internal error' }, 500);
    }
  });

  /** 入庫の通知（入荷・取り消し）。同じ `eventId` の送り直しには、前と同じ答えを返す。 */
  app.post('/inventory/receipts', async (c) => {
    const a = appOf(c);
    if (!a) return c.json(NOT_FOUND, 404);
    const { tenant } = c.get('ctx');
    if (!(await inventoryOn(tenant.id))) return c.json(NOT_FOUND, 404);
    const b = await jsonOf(c, SALES_PAYLOAD_MAX_BYTES);
    if (b instanceof Response) return b;
    try {
      return reply(c, await deps.inventory.sales.postReceipt(tenant.id, a.appId, b));
    } catch (err) {
      deps.log.warn('入庫の通知を受け取れませんでした', { error: String(err) });
      return c.json({ error: 'internal error' }, 500);
    }
  });

  /** 販売の通知（注文・販売・取り消し・返品）。同じ `eventId` の送り直しには、前と同じ答えを返す。 */
  app.post('/inventory/sales-events', async (c) => {
    const a = appOf(c);
    if (!a) return c.json(NOT_FOUND, 404);
    const { tenant } = c.get('ctx');
    if (!(await inventoryOn(tenant.id))) return c.json(NOT_FOUND, 404);
    const type = (c.req.header('content-type') ?? '').toLowerCase();
    if (!type.startsWith('application/json') || (/charset=/.test(type) && !/charset=utf-8/.test(type))) return c.json({ error: 'JSON（UTF-8）で送ってください' }, 415);
    const raw = await c.req.text();
    if (new TextEncoder().encode(raw).length > SALES_PAYLOAD_MAX_BYTES) return c.json({ error: '本文は 64 KB までです' }, 413);
    let body: unknown;
    try {
      body = JSON.parse(raw);
    } catch {
      return c.json({ error: 'JSON として読めません', field: '' }, 400);
    }
    try {
      return reply(c, await deps.inventory.sales.postEvent(tenant.id, a.appId, body));
    } catch (err) {
      deps.log.warn('販売の通知を受け取れませんでした', { error: String(err) });
      return c.json({ error: 'internal error' }, 500);
    }
  });

  // ---- 第11.12節・第13.4.2節の機能 ----

  /**
   * 書き込みの通知を 1 度だけ処理する（`eventId`）。送り直しには前と同じ答えを返す。
   *
   * @param hashOf 中身のハッシュの元（形を確かめたあとの中身）
   * @param run 処理。返す答え（状態の番号と本文）と、答えには出さずに残すもの（取り消しに使う番号など）
   */
  const once = async (
    c: Context<AppEnv>, appId: string, kind: string, eventId: string, hashOf: unknown,
    run: () => Promise<{ status: 200 | 201 | 202 | 400 | 403 | 404 | 409 | 410; body: object; keep?: Record<string, unknown> }>,
  ) => {
    const { tenant } = c.get('ctx');
    const hash = createHash('sha256').update(JSON.stringify(hashOf)).digest('hex');
    const claim = await deps.apps.claimEvent(tenant.id, appId, kind, eventId, hash);
    if (claim.kind === 'conflict') return c.json({ error: 'この eventId は別の中身で受け付け済みです' }, 409);
    if (claim.kind === 'busy') return c.json({ error: 'この eventId は処理の途中です。少し待って同じ中身で送り直してください' }, 409, { 'Retry-After': '10' });
    if (claim.kind === 'replay') {
      const prev = claim.response as { status: 200 | 201 | 202 | 400 | 403 | 404 | 409 | 410; body: object };
      return c.json(prev.body, prev.status);
    }
    const out = await run();
    await deps.apps.finishEvent(tenant.id, appId, kind, eventId, { status: out.status, body: out.body, ...(out.keep ?? {}) });
    return c.json(out.body, out.status);
  };
  /** 結び付いた本人を引く。無効なら 410（結び付けし直す）。 */
  const boundUser = async (c: Context<AppEnv>, appId: string, bindingId: unknown) => deps.appLinks.resolve(c.get('ctx').tenant.id, appId, bindingId);
  const GONE = { error: 'binding_invalid' };
  const evId = (b: Record<string, unknown>) => (typeof b['eventId'] === 'string' && b['eventId'].trim() && b['eventId'].trim().length <= 100 ? b['eventId'].trim() : null);
  const NEED_EVENT = { error: 'eventId は 1〜100 字の文字にしてください', field: 'eventId' };

  /** 結び付けの依頼（`accounts.link`）。アカウントの有無にかかわらず同じ答え。 */
  app.post('/accounts/link-requests', async (c) => {
    const a = appOf(c);
    if (!a) return c.json(NOT_FOUND, 404);
    const b = await jsonOf(c, SMALL_BODY);
    if (b instanceof Response) return b;
    const r = await deps.appLinks.request(c.get('ctx').tenant.id, { id: a.appId, name: a.appName }, b['email']);
    if ('error' in r) return c.json(r, 400);
    return c.json({ accepted: true, expiresInSeconds: LINK_CODE_TTL_MS / 1000 }, 202);
  });

  /** 結び付けの確定（`accounts.link`）。合わない・切れた・回数を超えた・アカウントが無いは、どれも同じ `invalid_code`。 */
  app.post('/accounts/links', async (c) => {
    const a = appOf(c);
    if (!a) return c.json(NOT_FOUND, 404);
    const b = await jsonOf(c, SMALL_BODY);
    if (b instanceof Response) return b;
    const r = await deps.appLinks.confirm(c.get('ctx').tenant.id, { id: a.appId, name: a.appName }, b['email'], b['code']);
    if ('error' in r) return c.json(r, 400);
    return c.json(r, 200);
  });

  /** 結び付きの削除（`accounts.link`）。知らない ID でも 204。 */
  app.delete('/accounts/links/:bindingId', async (c) => {
    const a = appOf(c);
    if (!a) return c.json(NOT_FOUND, 404);
    await deps.appLinks.unlink(c.get('ctx').tenant.id, { id: a.appId, name: a.appName }, c.req.param('bindingId'));
    return c.body(null, 204);
  });

  /**
   * ナレッジの検索（`knowledge.search`）。結び付いた本人が見られる会社の知識だけで答える。
   *
   * @remarks 質問の文と答えの文は残さない（記録にもデバッグの記録にも入れない）。結び付きごとに 1 分 10 回まで
   */
  app.post('/knowledge/search', async (c) => {
    const a = appOf(c);
    if (!a) return c.json(NOT_FOUND, 404);
    const b = await jsonOf(c, SMALL_BODY);
    if (b instanceof Response) return b;
    const q = typeof b['question'] === 'string' ? b['question'].trim() : '';
    if (!q || q.length > KNOWLEDGE_QUESTION_MAX) return c.json({ error: `question は 1〜${KNOWLEDGE_QUESTION_MAX} 字の文字にしてください`, field: 'question' }, 400);
    const user = await boundUser(c, a.appId, b['bindingId']);
    if (!user) return c.json(GONE, 410);
    if (!deps.apps.allowHit(`${a.appId}:${String(b['bindingId'])}`, Date.now(), KNOWLEDGE_SEARCH_PER_MINUTE, 'knowledge.search')) {
      return c.json({ error: 'too many requests' }, 429, { 'Retry-After': '60' });
    }
    return c.json(await deps.appKnowledge.search(c.get('ctx').tenant.id, { id: a.appId, name: a.appName }, user, q));
  });

  /**
   * 社内規程を登録・改定する（`knowledge.rules`）。`ref` は文書管理のシステムの文書の番号で、同じ番号を送れば改定になる。
   *
   * @remarks 版と施行日・前の版を残す・人事・給与の設定との食い違いの確かめは、管理者が登録したとき（`/v1/admin/knowledge`）と同じ。
   * 書けるのは区画なしと承認した権限区画だけ。中身が今の版と同じなら版を足さない
   */
  app.put('/knowledge/rules/:ref', async (c) => {
    const a = appOf(c);
    if (!a) return c.json(NOT_FOUND, 404);
    const { tenant } = c.get('ctx');
    const ref = c.req.param('ref');
    if (!RULE_REF.test(ref)) return c.json({ error: 'ref は英数字・. _ - の 1〜64 字にしてください', field: 'ref' }, 400);
    const b = await jsonOf(c, RULE_BODY_MAX);
    if (b instanceof Response) return b;
    const title = typeof b['title'] === 'string' ? b['title'].trim() : '';
    const text = typeof b['body'] === 'string' ? b['body'].trim() : '';
    if (!title || title.length > 200) return c.json({ error: 'title は 1〜200 字の文字にしてください', field: 'title' }, 400);
    if (!text || text.length > KNOWLEDGE_MAX_CHARS) return c.json({ error: `body は 1〜${KNOWLEDGE_MAX_CHARS} 字の文字にしてください`, field: 'body' }, 400);
    const compartment = typeof b['compartment'] === 'string' && b['compartment'].trim() ? b['compartment'].trim() : null;
    const allowed = (await deps.apps.settingsOf(tenant.id, a.appId))?.knowledgeRules?.compartments ?? [];
    if (compartment && !allowed.includes(compartment)) return c.json({ error: 'この権限区画には書けません（承認した区画だけ）', field: 'compartment' }, 403);
    const today = dateIn('Asia/Tokyo');
    const effectiveFrom = typeof b['effectiveFrom'] === 'string' && b['effectiveFrom'] ? b['effectiveFrom'] : today;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(effectiveFrom) || Number.isNaN(Date.parse(effectiveFrom))) return c.json({ error: 'effectiveFrom は日付（YYYY-MM-DD）にしてください', field: 'effectiveFrom' }, 400);
    const source = (typeof b['source'] === 'string' ? b['source'].trim().slice(0, 500) : '') || title;
    const id = ruleIdOf(a.appId, ref);
    const existing = (await deps.repo.listKnowledge(tenant.id, { all: true })).find((k) => k.id === id) ?? null;
    if (existing && existing.status !== 'active') return c.json({ error: '廃止した規程です。管理者が戻してから改定してください' }, 409);
    if (existing && existing.title === title && existing.body === text && existing.source === source && existing.compartment === compartment) {
      return c.json({ ref, version: existing.version ?? null, unchanged: true });
    }
    const actor = ExternalApps.actorOf(a.appId);
    const saved = await deps.repo.saveRuleVersion({ id, tenantId: tenant.id, kind: 'rule', title, body: text, source, compartment, updatedAt: new Date().toISOString(), effectiveFrom }, actor, today);
    if (!saved) return c.json(NOT_FOUND, 404);
    await deps.repo.appendAudit({
      id: randomUUID(), tenantId: tenant.id, actorType: 'api_client', actorId: actor, action: existing ? 'knowledge.rule.revise' : 'knowledge.rule.create',
      targetType: 'knowledge', targetId: id, detail: { compartment, version: saved.version, applied: saved.applied, effectiveFrom, app: a.appName }, occurredAt: new Date().toISOString(),
    });
    void deps.hr.service.checkRule(tenant.id, text, (raw) => deps.repo.setRuleHrCheck(tenant.id, id, saved.version, { raw })).catch(() => undefined);
    return c.json({ ref, version: saved.version, applied: saved.applied, effectiveFrom, unchanged: false }, existing ? 200 : 201);
  });

  /** 社内規程を廃止する（`knowledge.rules`）。そのアプリが登録した規程だけ。廃止は 1 年のあいだ管理者が戻せる。 */
  app.post('/knowledge/rules/:ref/retire', async (c) => {
    const a = appOf(c);
    if (!a) return c.json(NOT_FOUND, 404);
    const { tenant } = c.get('ctx');
    const ref = c.req.param('ref');
    if (!RULE_REF.test(ref)) return c.json(NOT_FOUND, 404);
    const id = ruleIdOf(a.appId, ref);
    const item = (await deps.repo.listKnowledge(tenant.id, { all: true })).find((k) => k.id === id);
    if (!item) return c.json(NOT_FOUND, 404);
    if (item.status === 'active') {
      await deps.repo.setKnowledgeStatus(tenant.id, id, 'retired', null, null, new Date().toISOString());
      await deps.repo.appendAudit({
        id: randomUUID(), tenantId: tenant.id, actorType: 'api_client', actorId: ExternalApps.actorOf(a.appId), action: 'knowledge.rule.retire',
        targetType: 'knowledge', targetId: id, detail: { app: a.appName }, occurredAt: new Date().toISOString(),
      });
    }
    return c.body(null, 204);
  });

  /**
   * 問い合わせを受ける（`inquiries.intake`）。Web のフォームなどの問い合わせを、経路「Web のフォーム」で残す。
   *
   * @remarks 返事は送らない（返事は会社の人が画面で書き、承認のあとに送る）。次にやることは窓口のアカウントを預けた人（いなければアプリを承認した管理者）に割り当てる
   */
  app.post('/inquiries/intake', async (c) => {
    const a = appOf(c);
    if (!a) return c.json(NOT_FOUND, 404);
    const { tenant } = c.get('ctx');
    if (!(await deps.apps.extensionOn(tenant.id, 'inquiries'))) return c.json(NOT_FOUND, 404);
    const b = await jsonOf(c, SALES_PAYLOAD_MAX_BYTES);
    if (b instanceof Response) return b;
    const eventId = evId(b);
    if (!eventId) return c.json(NEED_EVENT, 400);
    const f = (b['from'] && typeof b['from'] === 'object' ? b['from'] : {}) as Record<string, unknown>;
    const field = (v: unknown, max: number) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
    const from = { name: field(f['name'], 100), company: field(f['company'], 100), phone: field(f['phone'], 40), email: field(f['email'], 254).toLowerCase() };
    if (from.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(from.email)) return c.json({ error: 'from.email はメールアドレスにしてください', field: 'from.email' }, 400);
    const subject = field(b['subject'], 200);
    const body = typeof b['body'] === 'string' ? b['body'].trim() : '';
    if (!body || body.length > 20_000) return c.json({ error: 'body は 1〜20000 字の文字にしてください', field: 'body' }, 400);
    const receivedAt = typeof b['receivedAt'] === 'string' && !Number.isNaN(Date.parse(b['receivedAt'])) ? new Date(b['receivedAt']).toISOString() : new Date().toISOString();
    // 中身のハッシュは送られてきた値で作る（受けた時刻を省いた送り直しも同じ中身とみなす）
    return once(c, a.appId, 'inquiries.intake', eventId, [from, subject, body, b['receivedAt'] ?? null], async () => {
      const settings = (await deps.repo.getTenantSettings(tenant.id)).inquiries;
      const owner = settings.mailbox?.connectedBy ?? (await deps.apps.get(tenant.id, a.appId))?.approvedBy ?? '';
      const r = await deps.inquiries.service.intakeFromApp(tenant.id, ExternalApps.actorOf(a.appId), owner, { from, subject, body, receivedAt });
      return { status: 202, body: { accepted: true, continued: r.kind === 'appended' } };
    });
  });

  /** 社内のお知らせを出す（`notices.post`）。宛先は承認した範囲だけ。Chat には投稿しない。画面のログインのときは画面の道へ回す。 */
  app.post('/notices', async (c, next) => {
    const a = appOf(c);
    if (!a) return next();
    const { tenant } = c.get('ctx');
    const b = await jsonOf(c, SMALL_BODY * 4);
    if (b instanceof Response) return b;
    const eventId = evId(b);
    if (!eventId) return c.json(NEED_EVENT, 400);
    const allowed = (await deps.apps.settingsOf(tenant.id, a.appId))?.notices ?? { all: false, groupIds: [] };
    const all = b['all'] === true;
    const groupIds = Array.isArray(b['groupIds']) ? b['groupIds'].filter((g): g is string => typeof g === 'string').slice(0, 50) : [];
    if (all && !allowed.all) return c.json({ error: '全員宛ては許されていません（承認した宛先だけ）', field: 'all' }, 403);
    if (!all && !allowed.all && groupIds.some((g) => !allowed.groupIds.includes(g))) return c.json({ error: '承認した宛先の外のグループです', field: 'groupIds' }, 403);
    const s = (v: unknown) => (typeof v === 'string' ? v : undefined);
    const input = { title: s(b['title']) ?? '', body: s(b['body']) ?? '', link: s(b['link']) ?? '', all, groupIds, dueOn: s(b['dueOn']) ?? null, until: s(b['until']) ?? null };
    return once(c, a.appId, 'notices.post', eventId, input, async () => {
      const r = await deps.notices.create(tenant.id, ExternalApps.actorOf(a.appId), { ...input, authorName: `外部のアプリ（${a.appName}）` });
      if ('error' in r) return { status: 400, body: { error: r.error } };
      await deps.apps.store.addRef(tenant.id, a.appId, 'notice', r.notice.id, new Date().toISOString());
      return { status: 201, body: { id: r.notice.id, until: r.notice.until } };
    });
  });

  /** お知らせを取り下げる（`notices.post`）。そのアプリが出したものだけ。 */
  app.post('/notices/:id/withdraw', async (c, next) => {
    const a = appOf(c);
    if (!a) return next();
    const { tenant } = c.get('ctx');
    const id = c.req.param('id');
    if (!(await deps.apps.store.hasRef(tenant.id, a.appId, 'notice', id))) return c.json(NOT_FOUND, 404);
    const r = await deps.notices.withdraw(tenant.id, ExternalApps.actorOf(a.appId), id);
    if ('error' in r && r.status === 403) return c.json({ error: r.error }, 403);
    return c.body(null, 204);
  });

  /** 予約の空き（`reservations.book`）。予約できるものと埋まっている時間だけ。予約した人の名前と用件は返さない。 */
  app.get('/reservations/availability', async (c, next) => {
    const a = appOf(c);
    if (!a) return next();
    const { tenant } = c.get('ctx');
    if (!(await deps.apps.extensionOn(tenant.id, 'reservations'))) return c.json(NOT_FOUND, 404);
    const from = Date.parse(c.req.query('from') ?? '');
    const to = Date.parse(c.req.query('to') ?? '');
    if (Number.isNaN(from) || Number.isNaN(to) || to <= from) return c.json({ error: 'from と to は日時（ISO 8601）にし、to を後にしてください', field: 'from' }, 400);
    if (to - from > 15 * 86_400_000) return c.json({ error: '一度に読めるのは 15 日までです', field: 'to' }, 400);
    const allowed = (await deps.apps.settingsOf(tenant.id, a.appId))?.reservations ?? { all: false, itemIds: [] };
    const want = listOf(c, 'itemIds');
    const sys = { tenantId: tenant.id, userId: 'system' };
    const items = (await deps.reservations.service.items(sys))
      .filter((i) => i.status === 'active' && (allowed.all || allowed.itemIds.includes(i.id)) && (!want || want.includes(i.id)));
    const booked = await deps.reservations.service.list(sys, { from: new Date(from).toISOString(), to: new Date(to).toISOString() });
    return c.json({
      from: new Date(from).toISOString(), to: new Date(to).toISOString(),
      items: items.map((i) => ({
        id: i.id, name: i.name, kind: i.kind, capacity: i.capacity,
        busy: booked.filter((r) => r.itemId === i.id).map((r) => ({ startAt: r.startAt, endAt: r.endAt })),
      })),
    });
  });

  /** 予約を入れる（`reservations.book`）。結び付いた本人として入れ、本人の Google カレンダーに予定を入れる。 */
  app.post('/reservations', async (c, next) => {
    const a = appOf(c);
    if (!a) return next();
    const { tenant } = c.get('ctx');
    if (!(await deps.apps.extensionOn(tenant.id, 'reservations'))) return c.json(NOT_FOUND, 404);
    const b = await jsonOf(c, SMALL_BODY);
    if (b instanceof Response) return b;
    const eventId = evId(b);
    if (!eventId) return c.json(NEED_EVENT, 400);
    const itemId = typeof b['itemId'] === 'string' ? b['itemId'] : '';
    const allowed = (await deps.apps.settingsOf(tenant.id, a.appId))?.reservations ?? { all: false, itemIds: [] };
    if (!itemId || (!allowed.all && !allowed.itemIds.includes(itemId))) return c.json({ error: '予約できるものが見つかりません（承認したものだけ）', field: 'itemId' }, 404);
    const user = await boundUser(c, a.appId, b['bindingId']);
    if (!user) return c.json(GONE, 410);
    if (!(await deps.reservations.access(tenant.id, user.id))) return c.json({ error: 'この人は予約を使えません（利用範囲の外です）' }, 403);
    const input = { itemId, startAt: String(b['startAt'] ?? ''), endAt: String(b['endAt'] ?? ''), purpose: typeof b['purpose'] === 'string' ? b['purpose'] : '' };
    return once(c, a.appId, 'reservations.book', eventId, [String(b['bindingId']), input], async () => {
      const r = await deps.reservations.service.book({ tenantId: tenant.id, userId: user.id }, input);
      if ('error' in r) return { status: 400, body: { error: r.error } };
      if ('conflict' in r) return { status: 409, body: { error: 'その時間はもう埋まっています', nextFree: r.conflict.nextFree } };
      await deps.apps.store.addRef(tenant.id, a.appId, 'reservation', r.reservation.id, new Date().toISOString());
      return { status: 201, body: { id: r.reservation.id, itemId: r.reservation.itemId, startAt: r.reservation.startAt, endAt: r.reservation.endAt, calendar: r.calendar } };
    });
  });

  /** 予約を取り消す（`reservations.book`）。そのアプリで入れた、結び付いた本人の予約だけ。 */
  app.delete('/reservations/:id', async (c, next) => {
    const a = appOf(c);
    if (!a) return next();
    const { tenant } = c.get('ctx');
    if (!(await deps.apps.extensionOn(tenant.id, 'reservations'))) return c.json(NOT_FOUND, 404);
    const id = c.req.param('id');
    if (!(await deps.apps.store.hasRef(tenant.id, a.appId, 'reservation', id))) return c.json(NOT_FOUND, 404);
    const user = await boundUser(c, a.appId, c.req.query('bindingId'));
    if (!user) return c.json(GONE, 410);
    const err = await deps.reservations.service.cancel({ tenantId: tenant.id, userId: user.id }, id);
    if (err === '予約が見つかりません') return c.body(null, 204);
    if (err) return c.json({ error: err }, 403);
    return c.body(null, 204);
  });

  /**
   * 会員のポイントを付ける・使う（`members.points`）。レジで読んだ会員証の QR で会員を決める。
   *
   * @remarks 金額はポイントに換算するだけで残さない。答えはポイントの残りとランクだけ（呼び名・電話・誕生日は返さない）。
   * 取り消しは、取り消す通知の `eventId` を `undoEventId` に入れる（その日のものだけ）
   */
  app.post('/members/points', async (c) => {
    const a = appOf(c);
    if (!a) return c.json(NOT_FOUND, 404);
    const { tenant } = c.get('ctx');
    if (!(await deps.apps.extensionOn(tenant.id, 'members'))) return c.json(NOT_FOUND, 404);
    const b = await jsonOf(c, SMALL_BODY);
    if (b instanceof Response) return b;
    const eventId = evId(b);
    if (!eventId) return c.json(NEED_EVENT, 400);
    const action = b['action'];
    if (action !== 'visit' && action !== 'purchase' && action !== 'reward' && action !== 'undo') return c.json({ error: 'action は visit・purchase・reward・undo のどれかにしてください', field: 'action' }, 400);
    const card = typeof b['card'] === 'string' ? memberCardKeyOf(b['card'].trim()) : '';
    const svc = deps.members.service;
    const view = card ? await svc.byCard(tenant.id, card) : null;
    if (!view) return c.json({ error: '会員証が見つかりません', field: 'card' }, 400);
    const who = { tenantId: tenant.id, userId: ExternalApps.actorOf(a.appId) };
    const answer = (m: { balance: number; rank: string }, points: number) => ({ balance: m.balance, rank: m.rank, points });
    const hashOf = [card, action, b['amount'] ?? null, b['rewardId'] ?? null, b['undoEventId'] ?? null];
    return once(c, a.appId, 'members.points', eventId, hashOf, async () => {
      if (action === 'undo') {
        const ref = typeof b['undoEventId'] === 'string' ? b['undoEventId'] : '';
        const prev = ref ? await deps.apps.store.getEvent(tenant.id, a.appId, 'members.points', ref) : null;
        const pointId = (prev?.response as { pointId?: string } | null)?.pointId;
        if (!pointId) return { status: 404, body: { error: '取り消す通知が見つかりません', field: 'undoEventId' } };
        const before = view.member.balance;
        const err = await svc.undo(who, pointId);
        if (err) return { status: 409, body: { error: err } };
        const after = (await svc.byCard(tenant.id, card))!.member;
        return { status: 200, body: answer(after, after.balance - before) };
      }
      const r = action === 'visit' ? await svc.visit(who, view.member.id)
        : action === 'purchase' ? await svc.purchase(who, view.member.id, b['amount'])
          : await svc.useReward(who, view.member.id, typeof b['rewardId'] === 'string' ? b['rewardId'] : '');
      if ('error' in r) return { status: 409, body: { error: r.error } };
      return { status: 200, body: answer(r.member, r.points), keep: { pointId: r.pointId } };
    });
  });

  /** 公開したコラムを読む（`columns.read`）。承認済みで公開の日時を過ぎたものだけ。 */
  app.get('/columns/published', async (c) => {
    const a = appOf(c);
    if (!a) return c.json(NOT_FOUND, 404);
    const { tenant } = c.get('ctx');
    if (!(await deps.apps.extensionOn(tenant.id, 'web-columns')) || !deps.columns.planner) return c.json(NOT_FOUND, 404);
    const since = c.req.query('updatedSince');
    if (since !== undefined && Number.isNaN(Date.parse(since))) return c.json({ error: 'updatedSince は日時（ISO 8601）にしてください', field: 'updatedSince' }, 400);
    const rows = await deps.columns.planner.published(tenant.id, since ? { updatedSince: since } : {});
    return c.json({
      items: rows.map(({ hasCover, ...r }) => ({ ...r, coverUrl: hasCover ? `/v1/columns/published/${encodeURIComponent(r.id)}/cover.png` : null })),
      asOf: new Date().toISOString(),
    });
  });

  /** 公開したコラムのカバー画像（`columns.read`）。 */
  app.get('/columns/published/:id/cover.png', async (c) => {
    const a = appOf(c);
    if (!a) return c.json(NOT_FOUND, 404);
    const { tenant } = c.get('ctx');
    if (!(await deps.apps.extensionOn(tenant.id, 'web-columns')) || !deps.columns.planner) return c.json(NOT_FOUND, 404);
    const bytes = await deps.columns.planner.publishedCover(tenant.id, c.req.param('id')).catch(() => null);
    if (!bytes) return c.json(NOT_FOUND, 404);
    return c.body(bytes as Uint8Array<ArrayBuffer>, 200, { 'Content-Type': 'image/png' });
  });

  /**
   * 業務を依頼する（`jobs.run`）。結び付いた本人として、承認した業務だけを依頼する。
   *
   * @remarks 本人の利用範囲の外・無効にした業務は断る。承認の段に来たら止まり、承認は本人の画面だけで行う（外から承認できない。第13.3節）
   */
  app.post('/jobs', async (c, next) => {
    const a = appOf(c);
    if (!a) return next();
    const { tenant } = c.get('ctx');
    const b = await jsonOf(c, SALES_PAYLOAD_MAX_BYTES);
    if (b instanceof Response) return b;
    const eventId = evId(b);
    if (!eventId) return c.json(NEED_EVENT, 400);
    const agentId = typeof b['agentId'] === 'string' ? b['agentId'] : '';
    const allowed = (await deps.apps.settingsOf(tenant.id, a.appId))?.jobs;
    if (!allowed || !allowed.agentIds.includes(agentId)) return c.json({ error: '依頼できない業務です（承認した業務だけ）', field: 'agentId' }, 403);
    const view = await deps.tenantView(tenant.id);
    const def = view.resolve(agentId, 1);
    if (!def) return c.json({ error: '業務が見つかりません', field: 'agentId' }, 404);
    const risk = view.registry.allowed(def.tools).reduce<RiskLevel>((max, t) => (RISK_ORDER[t.risk] > RISK_ORDER[max] ? t.risk : max), 'read');
    if (RISK_ORDER[risk] > RISK_ORDER[allowed.maxRisk]) return c.json({ error: 'この業務は、承認した危険度の上限を超えます' }, 403);
    const user = await boundUser(c, a.appId, b['bindingId']);
    if (!user) return c.json(GONE, 410);
    if (!(await deps.canUse(tenant.id, user.id, def.id))) return c.json({ error: 'この人はこの業務を使えません（利用範囲の外です）' }, 403);
    if ((await deps.repo.getTenantSettings(tenant.id)).agents.disabled.includes(def.id)) return c.json({ error: 'この業務は管理者によって無効にされています' }, 403);
    if (!aiAvailable(await deps.ai.llmFor(tenant.id))) return c.json({ error: AI_NOT_CONFIGURED_MESSAGE }, 409);
    const input = b['input'] && typeof b['input'] === 'object' && !Array.isArray(b['input']) ? b['input'] as Record<string, unknown> : {};
    return once(c, a.appId, 'jobs.run', eventId, [String(b['bindingId']), agentId, input], async () => {
      const { runId } = await enqueueJob(deps.repo, { tenantId: tenant.id, requestedBy: user.id, def, input, origin: 'api', actor: { type: 'user', id: user.id } });
      await deps.apps.store.addRef(tenant.id, a.appId, 'run', runId, new Date().toISOString());
      return { status: 202, body: { runId, status: 'queued' } };
    });
  });

  /** 依頼した業務の結果（`jobs.run`）。そのアプリで依頼した実行だけ。結果は終わったときだけ返す。 */
  app.get('/runs/:id', async (c, next) => {
    const a = appOf(c);
    if (!a) return next();
    const { tenant } = c.get('ctx');
    const id = c.req.param('id');
    if (!(await deps.apps.store.hasRef(tenant.id, a.appId, 'run', id))) return c.json(NOT_FOUND, 404);
    const run = await deps.repo.getRun(tenant.id, id);
    if (!run) return c.json(NOT_FOUND, 404);
    const job = await deps.repo.getJob(tenant.id, run.jobId);
    const results = run.status === 'completed'
      ? (await deps.repo.listArtifacts(tenant.id, id)).map((x) => ({ kind: x.kind, title: x.title, body: x.body }))
      : [];
    return c.json({
      id: run.id, agentId: job?.agentId ?? null, status: run.status, startedAt: run.startedAt, endedAt: run.endedAt,
      failureReason: run.status === 'failed' ? run.failureReason : null, results,
    });
  });

  return app;
}
