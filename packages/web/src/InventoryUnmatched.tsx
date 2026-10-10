/**
 * @file 在庫管理のパソコンの画面の「照らせなかった販売」（仕様書 第29.20.1節）。外部のアプリ（販売管理など）が知らせた販売のうち、
 * 品目を照らせなかった行に、在庫管理を使う人が品目を選んで記録する。あるときだけ画面に出す。説明文を常に出さない（原則 u11）。
 */

import { useCallback, useEffect, useState } from 'react';
import type { InventoryItemView, InventorySaleUnmatched } from '@m2office/shared';
import { api, describeError } from './api.js';

/** 日本時間の日時。 */
const when = (iso: string | null) => (iso ? new Date(iso).toLocaleString('ja-JP', { dateStyle: 'medium', timeStyle: 'short' }) : '—');

const ACTION_LABEL = { hold: '注文', use: '販売', return: '返品', receive: '入荷' } as const;

/**
 * 照らせなかった販売。在庫管理を使う人が、行ごとに品目を選んで記録する。
 *
 * @param items 品目の一覧（止めた品目を含まない）
 * @param onChanged 記録したあと（一覧と数を読み直す）
 */
export function SalesUnmatchedPanel({ items, onChanged }: { items: InventoryItemView[]; onChanged: () => void }) {
  const [rows, setRows] = useState<InventorySaleUnmatched[] | null>(null);
  const [pick, setPick] = useState<Record<string, string>>({});
  const [message, setMessage] = useState<string | null>(null);
  const load = useCallback(() => {
    api.inventory.salesUnmatched().then((r) => setRows(r.items)).catch((e) => setMessage(describeError(e, '読み込めませんでした')));
  }, []);
  useEffect(() => { load(); }, [load]);
  const active = items.filter((i) => i.status === 'active');
  const record = async (row: InventorySaleUnmatched) => {
    const itemId = pick[row.id];
    if (!itemId) return;
    try {
      await api.inventory.resolveSalesUnmatched(row.id, itemId);
      setMessage(null);
      load();
      onChanged();
    } catch (e) {
      setMessage(describeError(e, '記録できませんでした'));
    }
  };
  if (!rows) return <div className="card">{message ? <p className="error">{message}</p> : <p className="muted">読み込み中…</p>}</div>;
  return (
    <div className="card sales-unmatched">
      {rows.length === 0 && <p className="muted small">照らせなかった販売はありません</p>}
      {rows.length > 0 && (
        <ul className="plain sales-unmatched-list">
          {rows.map((r) => (
            <li key={r.id}>
              <div><strong>{ACTION_LABEL[r.action]} {r.saleRef}</strong> <span className="muted small">{r.appName}・{when(r.createdAt)}</span></div>
              <div className="small">{[r.itemRef && `品目の ID ${r.itemRef}`, r.code && `自社のコード ${r.code}`, r.barcode && `バーコード ${r.barcode}`].filter(Boolean).join('・')}　数 {r.qty}</div>
              <div className="muted small">{r.reason}</div>
              <div className="row wrap">
                <select value={pick[r.id] ?? ''} onChange={(e) => setPick({ ...pick, [r.id]: e.target.value })} aria-label="品目">
                  <option value="">品目を選ぶ</option>
                  {active.map((i) => <option key={i.id} value={i.id}>{i.name}{i.sku ? `（${i.sku}）` : ''}</option>)}
                </select>
                <button className="btn small" disabled={!pick[r.id]} onClick={() => void record(r)}>記録する</button>
              </div>
            </li>
          ))}
        </ul>
      )}
      {message && <p className="small error" role="status">{message}</p>}
    </div>
  );
}
