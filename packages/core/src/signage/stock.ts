/**
 * @file 店頭サイネージの在庫の入荷と品切れの案内（仕様書 第31.6.7節。第 0.268.0 版）。
 *
 * 在庫の Web への公開（第29.12節）で承認した品目だけを使う。公開の中身を作り直すたびに、前と比べた品切れ・入荷を受け取り、
 * 字を組んだ 1 枚（お知らせのサイネージの画面と同じ組み方）を、すべての画面の、いつもの流れとすべての時間帯の流れの先頭に足す。
 * 入荷の案内は 3 日で、品切れの案内は入荷したら外す。人の承認は挟まない（公開で承認した名前を、会社の中の画面に出すだけ）。
 */

import { createHash } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { renderScreenCard } from '../announcements/screen-image.js';
import type { StockChange } from '../inventory/publication.js';
import type { SignageService } from './service.js';
import { thumbnailPng } from './thumbnail.js';

/** 入荷の案内を流す日数。 */
export const STOCK_BACK_DAYS = 3;
/** 1 回の作り直しで出す品目の数（まとめて入荷したときに流れが案内で埋まらないように）。 */
export const STOCK_NOTICE_MAX = 5;

/** 案内を足す・外すときの操作した人（監査ログ）。 */
const ACTOR = 'system';

/** 案内の 1 枚の文（純粋な関数）。 */
export function stockCardText(name: string, kind: 'back' | 'out'): { headline: string; period: string; detail: string; note: string } {
  return kind === 'back'
    ? { headline: name, period: '入荷しました', detail: '', note: '' }
    : { headline: name, period: 'ただいま品切れです', detail: '入荷までしばらくお待ちください', note: '' };
}

/**
 * 品切れ・入荷を受け取り、案内を足す・外す。在庫管理の公開の作り直し（{@link InventoryPublisher.onStockChange}）から呼ぶ。
 *
 * @param current いま公開している品目の名前（公開から外れた品目の案内は外す）
 * @remarks 危険度: 低（会社の中の画面に出す。社外への送信に当たらない。ADR-0051）。サイネージか案内を切っている会社では何もしない
 */
export async function applyStockChanges(service: SignageService, tenantId: string, changes: StockChange[], current: Set<string>, now: Date = new Date()): Promise<{ added: number; removed: number }> {
  const out = { added: 0, removed: 0 };
  const settings = await service.settings(tenantId);
  if (!settings.enabled || !settings.stockNotices) return out;
  const store = service.deps.store;
  const notices = new Map((await store.listStockNotices(tenantId)).map((n) => [n.itemName, n]));
  const drop = async (name: string) => {
    const n = notices.get(name);
    if (!n) return;
    await service.deleteAsset(tenantId, ACTOR, n.assetId).catch(() => null);
    await store.deleteStockNotice(tenantId, name);
    notices.delete(name);
    out.removed += 1;
  };
  // 公開から外れた品目の案内は外す
  for (const name of [...notices.keys()]) if (!current.has(name)) await drop(name);
  const screens = (await service.overview(tenantId)).screens.map((s) => s.id);
  for (const c of changes.slice(0, STOCK_NOTICE_MAX)) {
    await drop(c.name);
    const text = stockCardText(c.name, c.kind);
    const png = renderScreenCard({ ...text, color: settings.color });
    const dir = await mkdtemp(join(tmpdir(), 'm2o-stock-'));
    try {
      const path = join(dir, 'stock.png');
      await writeFile(path, png);
      const added = await service.addAsset(tenantId, ACTOR, {
        path, bytes: png.length, sha256: createHash('sha256').update(png).digest('hex'), mime: 'image/png',
        name: `在庫: ${c.name}（${c.kind === 'back' ? '入荷' : '品切れ'}）`.slice(0, 60), thumbnail: thumbnailPng(png),
      });
      if ('error' in added) continue;
      for (const s of screens) await service.prependToFlows(tenantId, ACTOR, s, [{ assetId: added.asset.id, seconds: null }]);
      await store.saveStockNotice(tenantId, {
        itemName: c.name, kind: c.kind, assetId: added.asset.id,
        expiresAt: c.kind === 'back' ? new Date(now.getTime() + STOCK_BACK_DAYS * 86_400_000).toISOString() : null,
      });
      out.added += 1;
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }
  return out;
}

/**
 * 期限の過ぎた入荷の案内を外す（ワーカーの見回りから）。サイネージか案内を切った会社では、流している案内をすべて外す。
 *
 * @returns 外した数
 */
export async function sweepStockNotices(service: SignageService, tenantId: string, now: Date = new Date()): Promise<number> {
  const store = service.deps.store;
  const notices = await store.listStockNotices(tenantId);
  if (!notices.length) return 0;
  const settings = await service.settings(tenantId);
  const off = !settings.enabled || !settings.stockNotices;
  let n = 0;
  for (const x of notices) {
    if (!off && !(x.expiresAt && x.expiresAt <= now.toISOString())) continue;
    await service.deleteAsset(tenantId, ACTOR, x.assetId).catch(() => null);
    await store.deleteStockNotice(tenantId, x.itemName);
    n += 1;
  }
  return n;
}
