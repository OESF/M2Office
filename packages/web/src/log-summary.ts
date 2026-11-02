/**
 * @file システムログの表の「文」に出す要約（仕様書 第16.10.4節）。
 *
 * 要求の記録は文が「要求」だけなので、何の要求かが表で分かるよう、記録に残っている方法・道・結果・かかった時間を並べる。
 */

import type { SystemLogLineView } from './api.js';

/**
 * 表の「文」に出す要約。要求の記録（`要求`）は、何の要求かが分かるよう、方法・道・結果・かかった時間を並べる。
 * ほかの記録は文と、あれば失敗の理由（`err`）。全部の項目は、行を押すと開く。
 */
export function logSummary(l: Pick<SystemLogLineView, 'msg' | 'fields'>): string {
  const f = l.fields;
  if (typeof f['method'] === 'string' && typeof f['path'] === 'string') {
    const status = typeof f['status'] === 'number' ? ` → ${f['status']}` : '';
    const ms = typeof f['ms'] === 'number' ? `（${f['ms']} ms）` : '';
    return `${l.msg}: ${f['method']} ${f['path']}${status}${ms}`;
  }
  return typeof f['err'] === 'string' && f['err'] ? `${l.msg}: ${f['err']}` : l.msg;
}
