/**
 * @file 外部のアプリ（仕様書 第13.4.1節、ADR-0090）。管理者のアプリの扱い（登録・名前・承認・鍵の出し直し・停止・削除）と、
 * アプリが呼ぶときの確かめ（鍵・機能の道・回数の上限・呼び出しの数）と、書き込みの通知を二重に数えない仕組みを受け持つ。
 *
 * 機能ごとの業務（在庫・会社の基本情報など）は、それぞれの部品が受け持ち、ここは機能に共通のことだけを持つ。
 */

import { createHash, randomBytes, randomUUID } from 'node:crypto';
import {
  APP_FUNCTIONS, EXTERNAL_APP_MAX, type AppFunctionId, type AppSettings, type AuditEvent, type ExternalApp, type InventoryCatalogScope,
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
];

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

  /** この会社で選べる機能（在庫管理を切っている会社では在庫の機能を選べない）。 */
  async available(tenantId: string): Promise<AppFunctionId[]> {
    const settings = await this.deps.repo.getTenantSettings(tenantId);
    return APP_FUNCTIONS.filter((f) => !f.requires || (f.requires === 'inventory' && settings.inventory.enabled)).map((f) => f.id);
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
    const at = new Date().toISOString();
    const before = new Set(app.functions.includes('inventory.catalog') ? app.settings.catalog?.itemIds ?? [] : []);
    const after = new Set(settings.catalog?.itemIds ?? []);
    removed = [...removed.filter((r) => !after.has(r.itemId)), ...[...before].filter((x) => !after.has(x)).map((itemId) => ({ itemId, at }))].slice(-REMOVED_KEEP);
    await this.deps.store.updateApp(tenantId, id, { functions, settings, catalogRemoved: removed, approvedBy: userId, approvedAt: at });
    await this.audit(tenantId, userId, 'app.approve', id, {
      name: app.name, functions, ...(settings.catalog ? { catalogItems: settings.catalog.itemIds.length, showCount: settings.catalog.showCount, price: settings.catalog.price, employeePrice: settings.catalog.employeePrice } : {}),
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
