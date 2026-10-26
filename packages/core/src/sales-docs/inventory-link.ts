/**
 * @file 販売の書類と受注を在庫管理につなぐ口（仕様書 第42.13.4節）。在庫管理の処理を、受注の引き当て・納品書の出庫に要る口だけに絞る。
 *
 * 取り置きは販売管理の注文と同じ種類（`sales`）で持つため、在庫管理の「予約との引き当て」を切っていても使える数から引かれる。
 */

import { randomUUID } from 'node:crypto';
import type { InventoryService } from '../inventory/service.js';
import type { SalesInventory } from './service.js';

/**
 * 在庫管理の処理から、販売の書類と受注が使う口を作る。
 *
 * @param access その人が在庫管理を使えるか（会社の入り切りと利用範囲）
 */
export function salesInventoryFrom(service: InventoryService, access: (tenantId: string, userId: string) => Promise<unknown | null>): SalesInventory {
  return {
    access,
    items: async (tenantId) => (await service.list(tenantId)).map((i) => ({
      id: i.id, name: i.name, sku: i.sku, unit: i.unit, available: i.available,
      sale: i.kind === 'sale', price: i.price, priceTaxIncluded: i.priceTaxIncluded, taxRate: i.taxRate,
    })),
    hold: async (tenantId, userId, r) => {
      const id = `rs-${randomUUID()}`;
      await service.store.addReservation(tenantId, {
        id, bookingId: null, itemId: r.itemId, qty: Math.round(r.qty * 1000) / 1000, bookingRef: r.ref.slice(0, 200), bookedAt: null,
        source: 'sales', createdBy: userId, at: new Date().toISOString(),
      });
      service.touch(tenantId);
      return id;
    },
    release: async (tenantId, reservationId) => {
      await service.store.setReservationStatus(tenantId, reservationId, 'cancelled', new Date().toISOString());
      service.touch(tenantId);
    },
    out: async (tenantId, userId, r) => {
      const res = await service.recordMove(tenantId, userId, { kind: 'out', itemId: r.itemId, qty: r.qty, reason: r.reason, source: 'sales', sourceId: r.sourceId });
      return res.ok ? res.moves[0]?.id ?? null : null;
    },
    undo: async (tenantId, userId, moveId, reason, sourceId) => {
      await service.reverse(tenantId, userId, moveId, { reason, source: 'sales', sourceId });
    },
  };
}
