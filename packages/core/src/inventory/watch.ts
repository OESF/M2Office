/**
 * @file 在庫の見張り（仕様書 第29.14節）。入出庫のたびと毎朝に見直し、残りわずか・無くなる見込み・使用期限を知らせる。
 *
 * 知らせる相手は、在庫管理の利用範囲の人のうち、最近（30 日）在庫を記録した人。いなければ利用範囲の管理者。
 * 知らせる人の一覧を人に作らせない（ADR-0028）。同じ品目・同じ知らせは、その日のうちに二度は送らない。
 * 本人が「在庫」の知らせを切っていれば送らない（第6.5.5節）。数を扱うだけで、社外には何も送らない。
 */

import { randomUUID } from 'node:crypto';
import { canUseAgent, INVENTORY_EXTENSION_ID } from '@m2office/shared';
import type { Repository } from '../repository/types.js';
import { silentLogger, type Logger } from '../log/logger.js';
import { dateIn } from '../cards/service.js';
import type { InventoryService } from './service.js';
import { EXPIRY_NOTICE_DAYS, type ForecastRow } from './forecast.js';

/** 知らせる相手を探す期間（日）。 */
const RECENT_DAYS = 30;

/** 見張りに要るもの。 */
export interface InventoryWatchDeps {
  repo: Repository;
  service: InventoryService;
  logger?: Logger;
}

const qty = (r: Pick<ForecastRow, 'unit' | 'packUnit' | 'packSize'>, n: number) => {
  const v = Math.round(n * 1000) / 1000;
  return r.packUnit && r.packSize && v !== 0 ? `${v} ${r.unit}（${Math.round((v / r.packSize) * 100) / 100} ${r.packUnit}）` : `${v} ${r.unit}`;
};

/** 発注の案の 1 行（「発注の案: 2 箱（10 本）を文具店へ」）。 */
export function proposalLine(r: ForecastRow): string | null {
  const p = r.proposal;
  if (!p) return null;
  const amount = p.packs && r.packUnit ? `${p.packs} ${r.packUnit}（${p.qty} ${r.unit}）` : `${p.qty} ${r.unit}`;
  return `発注の案: ${amount}${p.supplierName ? `を${p.supplierName}へ` : ''}（${p.reason}）`;
}

/** 品目 1 つの状況の 1 行。 */
export function statusLine(r: ForecastRow): string {
  const parts = [`使える数 ${qty(r, r.available)}`];
  if (r.runningOut && r.daysLeft !== null) parts.push(`あと ${r.daysLeft} 日で無くなる見込み（仕入れに ${r.leadDays} 日）`);
  else if (r.low) parts.push('残りわずか');
  return `${r.name}: ${parts.join('・')}`;
}

/**
 * 在庫の見張り。
 *
 * @remarks テナント境界: 会社ごとに、その会社の記録と利用者だけを読む（不変則 I-2）
 */
export class InventoryWatch {
  private readonly log: Logger;

  constructor(private readonly deps: InventoryWatchDeps) {
    this.log = deps.logger ?? silentLogger;
  }

  /**
   * 知らせる相手。最近在庫を記録した利用範囲の人、いなければ利用範囲の管理者。
   */
  async recipients(tenantId: string): Promise<string[]> {
    const { repo } = this.deps;
    const settings = await repo.getTenantSettings(tenantId);
    if (!settings.inventory.enabled) return [];
    const users = (await repo.listUsers(tenantId)).filter((u) => u.status === 'active');
    const inScope = async (userId: string) => canUseAgent(settings.access, INVENTORY_EXTENSION_ID, userId, await repo.listUserGroupIds(tenantId, userId));
    const since = new Date(Date.now() - RECENT_DAYS * 86_400_000).toISOString();
    const recent = new Set((await this.deps.service.history(tenantId, { since, limit: 2000 })).map((m) => m.createdBy));
    const active = users.filter((u) => recent.has(u.id));
    const chosen: string[] = [];
    for (const u of active) if (await inScope(u.id)) chosen.push(u.id);
    if (chosen.length) return chosen;
    for (const u of users.filter((x) => x.roles.includes('admin'))) if (await inScope(u.id)) chosen.push(u.id);
    return chosen;
  }

  /** 1 人に知らせる。本人が「在庫」の知らせを切っていれば送らない。同じ題の未読があれば送らない。 */
  private async notify(tenantId: string, userId: string, title: string, body: string, now: Date): Promise<boolean> {
    const { repo } = this.deps;
    const prefs = await repo.getUserSettings(tenantId, userId);
    if (!prefs.notifications.kinds.inventory) return false;
    const recent = await repo.listNotifications(tenantId, userId, 50);
    if (recent.some((n) => n.kind === 'inventory' && n.title === title)) return false;
    await repo.createNotification({
      id: randomUUID(), tenantId, userId, kind: 'inventory', title, body, runId: null, readAt: null, createdAt: now.toISOString(),
    });
    return true;
  }

  /**
   * 入出庫のあとに、その品目を見直す（その場で知らせる）。残りわずか・無くなる見込みになった品目を知らせる。
   *
   * @remarks 知らせの題に日付を入れ、その日のうちに同じ品目を二度知らせない。失敗しても記録は止めない（呼ぶ側で握りつぶす）
   */
  async afterMoves(tenantId: string, itemIds: string[], now: Date = new Date()): Promise<number> {
    const settings = await this.deps.repo.getTenantSettings(tenantId);
    if (!settings.inventory.enabled || itemIds.length === 0) return 0;
    const ids = new Set(itemIds);
    const rows = (await this.deps.service.forecast(tenantId)).filter((r) => ids.has(r.itemId) && (r.low || r.runningOut));
    if (rows.length === 0) return 0;
    const day = dateIn('Asia/Tokyo', now);
    const recipients = await this.recipients(tenantId);
    let sent = 0;
    for (const r of rows) {
      const title = `在庫: ${r.name}が${r.runningOut ? '無くなりそうです' : '残りわずかです'}（${day.slice(5).replace('-', '/')}）`;
      const body = [statusLine(r), proposalLine(r)].filter(Boolean).join('\n');
      for (const u of recipients) if (await this.notify(tenantId, u, title, body, now)) sent++;
    }
    return sent;
  }

  /**
   * 毎朝の見直し。無くなる見込み・残りわずかの品目と、使用期限の 30 日前・7 日前・当日のロットを 1 通にまとめて知らせる。
   *
   * @returns 送った知らせの数
   */
  async daily(tenantId: string, now: Date = new Date()): Promise<number> {
    const settings = await this.deps.repo.getTenantSettings(tenantId);
    if (!settings.inventory.enabled) return 0;
    const rows = await this.deps.service.forecast(tenantId);
    const short = rows.filter((r) => r.runningOut || r.low);
    const expiring = rows.flatMap((r) => r.expiring
      .filter((e) => (EXPIRY_NOTICE_DAYS as readonly number[]).includes(e.days) || e.days === 0)
      .map((e) => `${r.name}${e.lot ? `（ロット ${e.lot}）` : ''}: ${qty(r, e.qty)}が${e.days === 0 ? '今日' : ` ${e.days} 日後`}に期限`));
    if (short.length === 0 && expiring.length === 0) return 0;
    const day = dateIn('Asia/Tokyo', now);
    const title = `在庫の見張り（${day.slice(5).replace('-', '/')}）`;
    const body = [
      ...(short.length ? ['■ 足りなくなりそうなもの', ...short.slice(0, 20).flatMap((r) => [statusLine(r), ...(proposalLine(r) ? [`  ${proposalLine(r)}`] : [])])] : []),
      ...(expiring.length ? ['■ 使用期限', ...expiring.slice(0, 20)] : []),
    ].join('\n');
    let sent = 0;
    for (const u of await this.recipients(tenantId)) if (await this.notify(tenantId, u, title, body, now)) sent++;
    return sent;
  }

  /** すべての会社を毎朝見直す（ワーカーが 1 日 1 回呼ぶ）。会社ごとの失敗はほかの会社を止めない。 */
  async dailyAll(now: Date = new Date()): Promise<number> {
    let sent = 0;
    for (const tenantId of await this.deps.repo.listTenantIds()) {
      try {
        sent += await this.daily(tenantId, now);
      } catch (err) {
        this.log.warn('在庫の見張りに失敗しました', { tenantId, error: String(err) });
      }
    }
    return sent;
  }
}
