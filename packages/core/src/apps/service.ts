/**
 * @file 外部のアプリ（仕様書 第13.4.1節、ADR-0090）。管理者のアプリの扱い（登録・名前・承認・鍵の出し直し・停止・削除）と、
 * アプリが呼ぶときの確かめ（鍵・機能の道・回数の上限・呼び出しの数）と、書き込みの通知を二重に数えない仕組みを受け持つ。
 *
 * 機能ごとの業務（在庫・会社の基本情報など）は、それぞれの部品が受け持ち、ここは機能に共通のことだけを持つ。
 */

import { createHash, randomBytes, randomUUID } from 'node:crypto';
import {
  APP_FUNCTIONS, APP_JOB_RISKS, EXTERNAL_APP_MAX, type AppFunctionId, type AppFunctionRequirement, type AppSettingOptions, type AppSettings, type AuditEvent,
  type ExternalApp, type InventoryCatalogScope, type RiskLevel, type TenantSettings,
} from '@m2office/shared';
import type { Repository } from '../repository/types.js';
import { dateIn } from '../cards/service.js';
import type { AppRecord, AppStore } from './store.js';

/** 鍵の頭。漏れたときに見つけやすくする。 */
export const APP_KEY_PREFIX = 'm2oa_';
/** 鍵の形（頭 + base64url の 32 字）。 */
export const APP_KEY_PATTERN = /^m2oa_[A-Za-z0-9_-]{32}$/;
/** アプリごとの、1 分あたりの呼び出しの上限。 */
export const APP_RATE_PER_MINUTE = 120;
/** 処理の途中の通知を、やり直してよいとみなすまでの時間（ミリ秒）。 */
const STALE_EVENT_MS = 5 * 60_000;
/** 範囲から外した品目を覚えておく数。 */
const REMOVED_KEEP = 500;

/** 機能ごとの道（認証の段で、鍵で呼べる道をここだけに絞る）。 */
const FUNCTION_ROUTES: { fn: AppFunctionId; method: string; path: RegExp }[] = [
  { fn: 'company.profile', method: 'GET', path: /^\/v1\/company\/profile$/ },
  { fn: 'inventory.catalog', method: 'GET', path: /^\/v1\/inventory\/catalog$/ },
  { fn: 'inventory.sales', method: 'POST', path: /^\/v1\/inventory\/sales-events$/ },
  { fn: 'inventory.receipts', method: 'POST', path: /^\/v1\/inventory\/receipts$/ },
  { fn: 'accounts.link', method: 'POST', path: /^\/v1\/accounts\/(?:link-requests|links)$/ },
  { fn: 'accounts.link', method: 'DELETE', path: /^\/v1\/accounts\/links\/[^/]+$/ },
  { fn: 'knowledge.search', method: 'POST', path: /^\/v1\/knowledge\/search$/ },
  { fn: 'knowledge.rules', method: 'PUT', path: /^\/v1\/knowledge\/rules\/[^/]+$/ },
  { fn: 'knowledge.rules', method: 'POST', path: /^\/v1\/knowledge\/rules\/[^/]+\/retire$/ },
  { fn: 'inquiries.intake', method: 'POST', path: /^\/v1\/inquiries\/intake$/ },
  { fn: 'notices.post', method: 'POST', path: /^\/v1\/notices(?:\/[^/]+\/withdraw)?$/ },
  { fn: 'reservations.book', method: 'GET', path: /^\/v1\/reservations\/availability$/ },
  { fn: 'reservations.book', method: 'POST', path: /^\/v1\/reservations$/ },
  { fn: 'reservations.book', method: 'DELETE', path: /^\/v1\/reservations\/[^/]+$/ },
  { fn: 'members.points', method: 'POST', path: /^\/v1\/members\/points$/ },
  { fn: 'columns.read', method: 'GET', path: /^\/v1\/columns\/published(?:\/[^/]+\/cover\.png)?$/ },
  { fn: 'jobs.run', method: 'POST', path: /^\/v1\/jobs$/ },
  { fn: 'jobs.run', method: 'GET', path: /^\/v1\/runs\/[^/]+$/ },
];

/** 内蔵の拡張を入れているか（機能を選べる条件）。 */
function extensionOn(settings: TenantSettings, r: AppFunctionRequirement): boolean {
  switch (r) {
    case 'inventory': return settings.inventory.enabled;
    case 'inquiries': return settings.inquiries.enabled;
    case 'reservations': return settings.reservations.enabled;
    case 'members': return settings.members.enabled;
    case 'web-columns': return settings.webColumns.enabled;
  }
}

/** 鍵のハッシュ（SHA-256）。 */
export function appKeyHash(key: string): string {
  return createHash('sha256').update(key).digest('hex');
}

/**
 * この要求がどの機能の道か。どの機能の道でもなければ `null`（鍵では呼べない）。
 *
 * @remarks 管理者ページ（`/v1/admin`）と本人の道（`/v1/me`）は、どの機能にも入れない
 */
export function appFunctionFor(method: string, path: string): AppFunctionId | null {
  const m = method === 'HEAD' ? 'GET' : method;
  return FUNCTION_ROUTES.find((r) => r.method === m && r.path.test(path))?.fn ?? null;
}

/** 書き込みの通知の受け方の結果。 */
export type ClaimResult =
  | { kind: 'new' }
  | { kind: 'replay'; response: unknown }
  | { kind: 'conflict' }
  | { kind: 'busy' };

/** 外部のアプリに要るもの。 */
export interface ExternalAppsDeps {
  store: AppStore;
  repo: Repository;
  /** 使っている品目の ID（「商品の一覧を読む」の範囲を承認するとき、止めた品目を外すため）。 */
  activeItemIds?: (tenantId: string) => Promise<string[]>;
  /** 予約できるもの（「予約の空きを読む・予約を入れる」で見せるものを選ぶため）。 */
  reservableItems?: (tenantId: string) => Promise<{ id: string; name: string }[]>;
  /** 会社で使える業務と、その危険度（使うツールのいちばん強い危険度。「業務を依頼して結果を受け取る」で選ぶため）。 */
  agents?: (tenantId: string) => Promise<{ id: string; name: string; risk: RiskLevel }[]>;
}

/**
 * 外部のアプリ。
 *
 * @remarks アプリの扱いは管理者だけが呼べる（呼ぶ側の API で確かめる）。どれも監査ログに残す。
 * テナント境界: 鍵のハッシュから会社を引く 1 行だけ返す関数のほかは、会社の中だけを読む（不変則 I-2）
 */
export class ExternalApps {
  private readonly hits = new Map<string, number[]>();

  constructor(private readonly deps: ExternalAppsDeps) {}

  get store(): AppStore {
    return this.deps.store;
  }

  /** 記録した人として残す名前（入出庫の記録の「記録した人」など）。 */
  static actorOf(appId: string): string {
    return `app:${appId}`;
  }

  /** この会社で選べる機能（その拡張を切っている会社では、拡張の機能を選べない）。 */
  async available(tenantId: string): Promise<AppFunctionId[]> {
    const settings = await this.deps.repo.getTenantSettings(tenantId);
    return APP_FUNCTIONS.filter((f) => !f.requires || extensionOn(settings, f.requires)).map((f) => f.id);
  }

  /** 内蔵の拡張を入れているか（機能の道が、切った会社では 404 を返すため）。 */
  async extensionOn(tenantId: string, r: AppFunctionRequirement): Promise<boolean> {
    return extensionOn(await this.deps.repo.getTenantSettings(tenantId), r);
  }

  /** 機能ごとの設定を選ぶための候補（宛先のグループ・予約できるもの・権限区画・業務）。 */
  async settingOptions(tenantId: string): Promise<AppSettingOptions> {
    const [groups, compartments, items, agents] = await Promise.all([
      this.deps.repo.listGroups(tenantId), this.deps.repo.listCompartments(tenantId),
      this.deps.reservableItems ? this.deps.reservableItems(tenantId) : Promise.resolve([]), this.deps.agents ? this.deps.agents(tenantId) : Promise.resolve([]),
    ]);
    return {
      groups: groups.map((g) => ({ id: g.id, name: g.name })), reservableItems: items, compartments: compartments.map((c) => c.name),
      agents: agents.filter((a) => APP_JOB_RISKS.includes(a.risk)),
    };
  }

  /** すべてのアプリ（登録した順）。承認した人の名前とこの 7 日の呼び出しの数を添える。 */
  async list(tenantId: string, now: Date = new Date()): Promise<ExternalApp[]> {
    const since = dateIn('Asia/Tokyo', new Date(now.getTime() - 6 * 86_400_000));
    const [rows, users, calls] = await Promise.all([this.deps.store.listApps(tenantId), this.deps.repo.listUsers(tenantId), this.deps.store.countCalls(tenantId, since)]);
    return rows.map((a) => {
      const approver = a.approvedBy ? users.find((u) => u.id === a.approvedBy)?.displayName : undefined;
      return {
        id: a.id, name: a.name, status: a.status, functions: a.functions, settings: a.settings, approvedBy: a.approvedBy, ...(approver ? { approvedByName: approver } : {}),
        approvedAt: a.approvedAt, createdAt: a.createdAt, lastUsedAt: a.lastUsedAt, callsLast7Days: calls.get(a.id) ?? 0,
      };
    });
  }

  /** アプリ 1 つ（管理者に見せる形）。 */
  async view(tenantId: string, id: string): Promise<ExternalApp | null> {
    return (await this.list(tenantId)).find((a) => a.id === id) ?? null;
  }

  /** アプリの記録（機能の業務が、承認した設定を読むため）。 */
  async get(tenantId: string, id: string): Promise<AppRecord | null> {
    return this.deps.store.getApp(tenantId, id);
  }

  /** アプリを登録する。鍵はこの答えでだけ見せる。承認するまで、どの機能も使えない。 */
  async create(tenantId: string, userId: string, name: string): Promise<{ app: ExternalApp; key: string } | { error: string }> {
    const n = name.replace(/[\r\n]+/g, ' ').trim().slice(0, 40);
    if (!n) return { error: 'アプリの名前（レジ・M2Medical など）を入れてください' };
    if ((await this.deps.store.listApps(tenantId)).length >= EXTERNAL_APP_MAX) return { error: `外部のアプリは ${EXTERNAL_APP_MAX} まで登録できます` };
    const key = APP_KEY_PREFIX + randomBytes(24).toString('base64url');
    const at = new Date().toISOString();
    const rec: AppRecord = {
      id: randomUUID(), name: n, keyHash: appKeyHash(key), status: 'active', functions: [], settings: {}, catalogRemoved: [],
      approvedBy: null, approvedAt: null, createdBy: userId, createdAt: at, lastUsedAt: null,
    };
    await this.deps.store.createApp(tenantId, rec);
    await this.audit(tenantId, userId, 'app.create', rec.id, { name: n });
    return { app: (await this.view(tenantId, rec.id))!, key };
  }

  /** 名前を変える（承認し直さない）。 */
  async rename(tenantId: string, userId: string, id: string, name: string): Promise<ExternalApp | { error: string }> {
    const n = name.replace(/[\r\n]+/g, ' ').trim().slice(0, 40);
    if (!n) return { error: '名前を入れてください' };
    if (!(await this.deps.store.getApp(tenantId, id))) return { error: 'アプリが見つかりません' };
    await this.deps.store.updateApp(tenantId, id, { name: n });
    await this.audit(tenantId, userId, 'app.rename', id, { name: n });
    return (await this.view(tenantId, id))!;
  }

  /**
   * この内容で許す（押した管理者が承認者）。機能と機能ごとの設定を一度に承認する（第9.4.0節）。
   *
   * @remarks 選べない機能は断る。「商品の一覧を読む」の範囲から外した品目は覚えておき、`updatedSince` の答えに `active: false` として 1 度入れる
   */
  async approve(tenantId: string, userId: string, id: string, input: { functions: AppFunctionId[]; settings: AppSettings }): Promise<ExternalApp | { error: string }> {
    const app = await this.deps.store.getApp(tenantId, id);
    if (!app) return { error: 'アプリが見つかりません' };
    const allowed = new Set(await this.available(tenantId));
    const functions = [...new Set(input.functions)];
    const bad = functions.filter((f) => !allowed.has(f));
    if (bad.length) return { error: `この会社では選べない機能です: ${bad.join('・')}` };
    if (functions.length === 0) return { error: '機能を 1 つ以上選んでください' };
    const settings: AppSettings = {};
    let removed = app.catalogRemoved;
    if (functions.includes('inventory.catalog')) {
      const c = input.settings.catalog;
      if (!c || c.itemIds.length === 0) return { error: '「商品の一覧を読む」で渡す品目を選んでください' };
      // 止めた品目・知らない品目は範囲に入れない
      const active = new Set(this.deps.activeItemIds ? await this.deps.activeItemIds(tenantId) : c.itemIds);
      const itemIds = [...new Set(c.itemIds)].filter((x) => active.has(x));
      settings.catalog = { itemIds, showCount: !!c.showCount, price: !!c.price, employeePrice: !!c.employeePrice };
    }
    const needs = functions.map((f) => APP_FUNCTIONS.find((x) => x.id === f)?.needs).find((n) => n && !functions.includes(n));
    if (needs) return { error: `「${APP_FUNCTIONS.find((x) => x.id === needs)!.label}」も選んでください（本人の権限で行う機能のため）` };
    const more = await this.functionSettings(tenantId, functions, input.settings);
    if ('error' in more) return more;
    Object.assign(settings, more);
    const at = new Date().toISOString();
    const before = new Set(app.functions.includes('inventory.catalog') ? app.settings.catalog?.itemIds ?? [] : []);
    const after = new Set(settings.catalog?.itemIds ?? []);
    removed = [...removed.filter((r) => !after.has(r.itemId)), ...[...before].filter((x) => !after.has(x)).map((itemId) => ({ itemId, at }))].slice(-REMOVED_KEEP);
    await this.deps.store.updateApp(tenantId, id, { functions, settings, catalogRemoved: removed, approvedBy: userId, approvedAt: at });
    await this.audit(tenantId, userId, 'app.approve', id, {
      name: app.name, functions,
      ...(settings.notices ? { noticeAll: settings.notices.all, noticeGroups: settings.notices.groupIds.length } : {}),
      ...(settings.reservations ? { reservationAll: settings.reservations.all, reservationItems: settings.reservations.itemIds.length } : {}),
      ...(settings.knowledgeRules ? { ruleCompartments: settings.knowledgeRules.compartments } : {}),
      ...(settings.jobs ? { jobAgents: settings.jobs.agentIds, jobMaxRisk: settings.jobs.maxRisk } : {}), ...(settings.catalog ? { catalogItems: settings.catalog.itemIds.length, showCount: settings.catalog.showCount, price: settings.catalog.price, employeePrice: settings.catalog.employeePrice } : {}),
    });
    return (await this.view(tenantId, id))!;
  }

  /** 鍵を出し直す。前の鍵はすぐ使えなくなる。新しい鍵はこの答えでだけ見せる。 */
  async rekey(tenantId: string, userId: string, id: string): Promise<{ app: ExternalApp; key: string } | { error: string }> {
    const app = await this.deps.store.getApp(tenantId, id);
    if (!app) return { error: 'アプリが見つかりません' };
    const key = APP_KEY_PREFIX + randomBytes(24).toString('base64url');
    await this.deps.store.updateApp(tenantId, id, { keyHash: appKeyHash(key) });
    await this.audit(tenantId, userId, 'app.rekey', id, { name: app.name });
    return { app: (await this.view(tenantId, id))!, key };
  }

  /** 止める・動かす。止めたアプリの鍵では、どの道も 404 になる。 */
  async setStatus(tenantId: string, userId: string, id: string, status: 'active' | 'stopped'): Promise<ExternalApp | { error: string }> {
    const app = await this.deps.store.getApp(tenantId, id);
    if (!app) return { error: 'アプリが見つかりません' };
    await this.deps.store.updateApp(tenantId, id, { status });
    await this.audit(tenantId, userId, status === 'stopped' ? 'app.stop' : 'app.resume', id, { name: app.name });
    return (await this.view(tenantId, id))!;
  }

  /** 削除する（止めてあるアプリだけ）。機能ごとの記録（販売など）も消える。入出庫の記録などの業務の記録は残る。 */
  async remove(tenantId: string, userId: string, id: string): Promise<{ ok: true } | { error: string }> {
    const app = await this.deps.store.getApp(tenantId, id);
    if (!app) return { error: 'アプリが見つかりません' };
    if (app.status !== 'stopped') return { error: '削除できるのは止めてあるアプリだけです。先に止めてください' };
    await this.deps.store.deleteApp(tenantId, id);
    await this.audit(tenantId, userId, 'app.delete', id, { name: app.name });
    return { ok: true };
  }

  /**
   * 鍵から会社とアプリを引く。形の違う鍵・知らない鍵・止めたアプリは `null`（呼ぶ側はどれも同じ 404 にする）。
   */
  async authenticate(key: string): Promise<{ tenantId: string; appId: string; name: string; functions: AppFunctionId[] } | null> {
    if (!APP_KEY_PATTERN.test(key)) return null;
    const hit = await this.deps.store.findAppByHash(appKeyHash(key));
    if (!hit || hit.status !== 'active') return null;
    return { tenantId: hit.tenantId, appId: hit.id, name: hit.name, functions: hit.functions };
  }

  /** アプリごとの呼び出しの上限（1 分に {@link APP_RATE_PER_MINUTE} 回）。超えたら `false`。 */
  allowHit(appId: string, now: number = Date.now(), limit = APP_RATE_PER_MINUTE, bucket = ''): boolean {
    const k = `${appId}\u0000${bucket}`;
    const recent = (this.hits.get(k) ?? []).filter((t) => now - t < 60_000);
    if (recent.length >= limit) {
      this.hits.set(k, recent);
      return false;
    }
    recent.push(now);
    this.hits.set(k, recent);
    return true;
  }

  /** 呼び出しを 1 つ数える（失敗しても呼び出しは止めない）。 */
  async recordCall(tenantId: string, appId: string, now: Date = new Date()): Promise<void> {
    await this.deps.store.recordCall(tenantId, appId, dateIn('Asia/Tokyo', now), now.toISOString()).catch(() => undefined);
  }

  /**
   * 書き込みの通知を受け始める。同じ番号は 1 度だけ処理し、送り直しには前の答えを返す。
   *
   * @param kind 機能の名前（番号は機能ごとに分ける）
   * @param bodyHash 中身のハッシュ（形を確かめたあとの中身から作る）
   */
  async claimEvent(tenantId: string, appId: string, kind: string, eventRef: string, bodyHash: string, now: Date = new Date()): Promise<ClaimResult> {
    const at = now.toISOString();
    if (await this.deps.store.claimEvent(tenantId, appId, kind, eventRef, bodyHash, at)) return { kind: 'new' };
    const prev = await this.deps.store.getEvent(tenantId, appId, kind, eventRef);
    if (prev && prev.bodyHash !== bodyHash) return { kind: 'conflict' };
    if (prev && prev.response !== null && prev.response !== undefined) return { kind: 'replay', response: prev.response };
    // 処理の途中のまま古くなったもの（途中で止まった）だけをやり直す
    const stale = new Date(now.getTime() - STALE_EVENT_MS).toISOString();
    return (await this.deps.store.reclaimEvent(tenantId, appId, kind, eventRef, stale, at)) ? { kind: 'new' } : { kind: 'busy' };
  }

  /** 書き込みの通知の答えを残す（送り直しにそのまま返す）。 */
  async finishEvent(tenantId: string, appId: string, kind: string, eventRef: string, response: unknown): Promise<void> {
    await this.deps.store.finishEvent(tenantId, appId, kind, eventRef, response);
  }

  /**
   * 機能ごとの設定（お知らせの宛先・予約できるもの・規程の区画・業務）を確かめる。知らないグループ・もの・区画・業務は断る。
   */
  private async functionSettings(tenantId: string, functions: AppFunctionId[], input: AppSettings): Promise<Omit<AppSettings, 'catalog'> | { error: string }> {
    const out: Omit<AppSettings, 'catalog'> = {};
    // 候補は、設定の要る機能を選んだときだけ読む
    const needsOptions = functions.some((f) => f === 'notices.post' || f === 'reservations.book' || f === 'knowledge.rules' || f === 'jobs.run');
    const options = needsOptions ? await this.settingOptions(tenantId) : { groups: [], reservableItems: [], compartments: [], agents: [] };
    if (functions.includes('notices.post')) {
      const n = input.notices ?? { all: false, groupIds: [] };
      const known = new Set(options.groups.map((g) => g.id));
      const groupIds = [...new Set(n.groupIds ?? [])];
      if (!n.all && groupIds.length === 0) return { error: '「社内のお知らせを出す」で出してよい宛先（全員かグループ）を選んでください' };
      if (groupIds.some((g) => !known.has(g))) return { error: '宛先のグループが見つかりません' };
      out.notices = { all: !!n.all, groupIds: n.all ? [] : groupIds };
    }
    if (functions.includes('reservations.book')) {
      const r = input.reservations ?? { all: true, itemIds: [] };
      const known = new Set(options.reservableItems.map((i) => i.id));
      const itemIds = [...new Set(r.itemIds ?? [])].filter((x) => known.has(x));
      if (!r.all && itemIds.length === 0) return { error: '「予約の空きを読む・予約を入れる」で見せてよい予約できるものを選んでください' };
      out.reservations = { all: !!r.all, itemIds: r.all ? [] : itemIds };
    }
    if (functions.includes('knowledge.rules')) {
      const known = new Set(options.compartments);
      const compartments = [...new Set(input.knowledgeRules?.compartments ?? [])];
      if (compartments.some((c) => !known.has(c))) return { error: '権限区画が見つかりません' };
      out.knowledgeRules = { compartments };
    }
    if (functions.includes('jobs.run')) {
      const j = input.jobs ?? { agentIds: [], maxRisk: 'read' as RiskLevel };
      if (!APP_JOB_RISKS.includes(j.maxRisk)) return { error: '危険度の上限を選んでください' };
      const known = new Map(options.agents.map((a) => [a.id, a]));
      const agentIds = [...new Set(j.agentIds ?? [])];
      if (agentIds.length === 0) return { error: '「業務を依頼して結果を受け取る」で依頼してよい業務を選んでください' };
      if (agentIds.some((a) => !known.has(a))) return { error: '業務が見つかりません（使えない業務か、お金の確定を行う業務です）' };
      out.jobs = { agentIds, maxRisk: j.maxRisk };
    }
    return out;
  }

  /** 承認した機能ごとの設定（機能の業務が読む）。承認していなければ `null`。 */
  async settingsOf(tenantId: string, appId: string): Promise<AppSettings | null> {
    const app = await this.deps.store.getApp(tenantId, appId);
    return app ? app.settings : null;
  }

  /** 「商品の一覧を読む」で承認した範囲と、範囲から外した品目。承認していなければ `null`。 */
  async catalogScope(tenantId: string, appId: string): Promise<{ scope: InventoryCatalogScope; removed: { itemId: string; at: string }[] } | null> {
    const app = await this.deps.store.getApp(tenantId, appId);
    if (!app || !app.functions.includes('inventory.catalog') || !app.settings.catalog) return null;
    return { scope: app.settings.catalog, removed: app.catalogRemoved };
  }

  private async audit(tenantId: string, userId: string, action: string, targetId: string, detail: Record<string, unknown>): Promise<void> {
    const ev: AuditEvent = {
      id: randomUUID(), tenantId, actorType: 'user', actorId: userId, action, targetType: 'external_app', targetId, detail, occurredAt: new Date().toISOString(),
    };
    await this.deps.repo.appendAudit(ev);
  }
}
