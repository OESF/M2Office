/**
 * @file 発注書の PDF（仕様書 第29.14.5節、Q-249）。会社の帳票の体裁（見積書と同じロゴ・差出人・印影）で、発注の品目と数を載せる。
 *
 * **金額は載せない**（仕入価格は目安で、お金の確定は仕入先の請求と会計で行う。第29.18節）。
 * 作った発注書は会社のファイルとして残し、発注の記録から開く。メールの発注では発注のメールに添える（送るのは承認の後）。
 */

import type { InventoryItem, InventoryOrder, StoredFile } from '@m2office/shared';
import type { Repository } from '../repository/types.js';
import type { FileStore } from '../files/store.js';
import { loadInvoiceStyle } from '../files/invoice-style.js';
import { renderPurchaseOrder } from '../files/pdf-render.js';
import { saveFile } from '../files/service.js';

/** 数の書き方（入り数があれば仕入れの単位を先に。例: `2 箱（10 個）`）。 */
export function orderQuantityText(item: Pick<InventoryItem, 'unit' | 'packUnit' | 'packSize'>, qty: number): string {
  const v = Math.round(qty * 1000) / 1000;
  if (item.packUnit && item.packSize && item.packSize > 0) {
    const packs = Math.round((v / item.packSize) * 100) / 100;
    return `${packs} ${item.packUnit}（${v} ${item.unit}）`;
  }
  return `${v} ${item.unit}`;
}

/**
 * 発注書の PDF を作って会社のファイルとして残す。
 *
 * @param items 品目（品番と単位を引く）
 * @returns 残したファイル
 * @remarks 危険度: なし（社内のファイルを作るだけ。送るのは発注のメールの業務が承認の後に行う）
 */
export async function createOrderSheet(
  deps: { repo: Repository; files: FileStore },
  tenantId: string, userId: string, order: InventoryOrder, items: Map<string, InventoryItem>,
): Promise<StoredFile> {
  const style = await loadInvoiceStyle({ repo: deps.repo, files: deps.files, tenantId });
  const issued = new Date(Date.now() + 9 * 3_600_000).toISOString().slice(0, 10);
  const bytes = await renderPurchaseOrder({
    to: `${order.supplierName} 御中`,
    fields: [
      { label: '発注番号', value: order.number },
      { label: '発注日', value: issued },
      ...(order.dueOn ? [{ label: '希望納期', value: order.dueOn }] : []),
    ],
    greeting: '下記のとおり発注いたします。',
    rows: order.lines.map((l) => {
      const item = items.get(l.itemId);
      return { name: item?.name ?? l.itemName ?? '', code: item?.sku ?? '', quantity: item ? orderQuantityText(item, l.qty) : `${l.qty} ${l.unit ?? ''}` };
    }),
    notes: ['納品の際は、発注番号を書いた納品書を添えてください。'],
    style: { logo: style.logo ?? null, from: style.from ?? [], sealBox: style.sealBox ?? false, seal: style.seal ?? null },
  });
  return saveFile(deps.repo, deps.files, {
    tenantId, ownerUserId: userId, name: `発注書_${order.number}_${order.supplierName.replace(/[\\/:*?"<>|\s]+/g, '')}.pdf`.slice(0, 200),
    kind: 'pdf', bytes, origin: 'generated', runId: null,
  });
}
