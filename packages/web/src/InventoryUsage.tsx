/**
 * @file 在庫の減り具合と需要の予測を見る（仕様書 第29.14.1節、Q-243）。
 *
 * 「減り具合」のタブ（品目ごとの 1 日の使用・前の 4 週との増減・あと何日・次の 4 週の見込み・予測の倍率と理由）と、
 * 品目の詳細の週ごとの使用のグラフ（直近 12 週と次の 4 週の見込み）。数は見張りと同じ計算で、人に入れさせない。
 */
import { useEffect, useState } from 'react';
import { inventoryKindLabel, type InventoryUsageRow, type InventoryWeeklyUsage } from '@m2office/shared';
import { api, describeError } from './api.js';

/** 数の表記（小数第 1 位まで）。 */
const n1 = (v: number) => (Math.round(v * 10) / 10).toLocaleString('ja-JP');

/** 前の 4 週との増減の表記。 */
function Change({ pct }: { pct: number | null }) {
  if (pct === null) return <span className="muted">—</span>;
  if (pct === 0) return <span className="muted">±0%</span>;
  return <span className={pct > 0 ? 'usage-up' : 'usage-down'}>{pct > 0 ? '↑' : '↓'} {Math.abs(pct)}%</span>;
}

/**
 * 「減り具合」のタブ。一覧の絞り込み（区分・分類・状態）をそのまま効かせる。
 *
 * @param itemIds 一覧の絞り込みに当たる品目
 */
export function UsagePanel({ itemIds, onOpenItem }: { itemIds: Set<string>; onOpenItem: (id: string) => void }) {
  const [rows, setRows] = useState<InventoryUsageRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => { api.inventory.usage().then((r) => setRows(r.rows)).catch((e) => setError(describeError(e, '読み込めませんでした'))); }, []);
  const shown = (rows ?? []).filter((r) => itemIds.has(r.itemId));
  return (
    <div className="card inventory-usage">
      {error && <p className="error small">{error}</p>}
      {!rows && !error && <p className="muted small">読み込み中…</p>}
      {rows && shown.length === 0 && <p className="muted small">当たる品目はありません</p>}
      {shown.length > 0 && (
        <div className="table-scroll"><table className="table">
          <thead>
            <tr><th>品名</th><th>区分</th><th className="num">1 日の出庫</th><th className="num">前の 4 週から</th><th className="num">あと</th><th className="num">次の 4 週の見込み</th><th>予測</th></tr>
          </thead>
          <tbody>
            {shown.map((r) => (
              <tr key={r.itemId} className="clickable" onClick={() => onOpenItem(r.itemId)}>
                <td><button className="link" onClick={(e) => { e.stopPropagation(); onOpenItem(r.itemId); }}>{r.name}</button></td>
                <td className="small nowrap">{inventoryKindLabel(r.kind)}</td>
                <td className="num">{r.daily > 0 ? `${n1(r.daily)} ${r.unit}` : <span className="muted">使っていない</span>}</td>
                <td className="num"><Change pct={r.changePct} /></td>
                <td className="num">{r.daysLeft === null ? <span className="muted">—</span> : `${r.daysLeft} 日`}</td>
                <td className="num"><strong>{r.next4w > 0 ? `${n1(r.next4w)} ${r.unit}` : '—'}</strong>{r.booked ? <span className="muted small"> うち予約 {n1(r.booked)}</span> : null}</td>
                <td className="small">
                  {r.factor !== 1 ? `${r.factor} 倍${r.note ? `（${r.note}）` : ''}` : <span className="muted">いつもどおり</span>}
                  {/* 曜日の波（第29.14.3節） */}
                  {r.weekdayNote && <span className="badge"> {r.weekdayNote}</span>}
                </td>
              </tr>
            ))}
          </tbody>
        </table></div>
      )}
    </div>
  );
}

/**
 * 品目の詳細の、週ごとの使用のグラフ（直近 12 週の棒と、次の 4 週の見込み）。
 */
export function UsageChart({ weekly, usage, unit }: { weekly: InventoryWeeklyUsage[]; usage: InventoryUsageRow | null; unit: string }) {
  if (weekly.length === 0) return null;
  const nextWeek = usage ? usage.next4w / 4 : 0;
  const max = Math.max(1, ...weekly.map((w) => w.qty), nextWeek);
  const W = 560;
  const H = 120;
  // 実績の週と、来週の見込みの 1 本（4 週の見込みは同じ高さになるため 1 本にまとめる）
  const slots = weekly.length + 1;
  const bw = W / slots;
  const y = (v: number) => H - (v / max) * (H - 16);
  return (
    <div className="usage-chart">
      <h3>減り具合</h3>
      <p className="small">
        {usage && usage.daily > 0
          ? <>1 日 {n1(usage.daily)} {unit}（前の 4 週から <Change pct={usage.changePct} />）{usage.daysLeft !== null && `・あと ${usage.daysLeft} 日`}・次の 4 週の見込み <strong>{n1(usage.next4w)} {unit}</strong>{usage.booked ? `（うち予約 ${n1(usage.booked)} ${unit}）` : ''}{usage.factor !== 1 && `（${usage.factor} 倍${usage.note ? `。${usage.note}` : ''}）`}{usage.weekdayNote && `・${usage.weekdayNote}`}</>
          : <span className="muted">最近 4 週は使っていません</span>}
      </p>
      <svg viewBox={`0 0 ${W} ${H + 18}`} role="img" aria-label={`直近 ${weekly.length} 週の出庫と来週の見込み`} className="usage-svg">
        {weekly.map((w, k) => (
          <g key={w.week}>
            <rect x={k * bw + 3} y={y(w.qty)} width={bw - 6} height={H - y(w.qty)} className="usage-bar"><title>{`${w.week} の週: ${n1(w.qty)} ${unit}`}</title></rect>
            {k % 2 === 0 && <text x={k * bw + bw / 2} y={H + 13} textAnchor="middle" className="usage-label">{w.week.slice(5).replace('-', '/')}</text>}
          </g>
        ))}
        {nextWeek > 0 && (
          <>
            <rect x={weekly.length * bw + 3} y={y(nextWeek)} width={bw - 6} height={H - y(nextWeek)} className="usage-bar next"><title>{`来週の見込み: ${n1(nextWeek)} ${unit}`}</title></rect>
            <text x={weekly.length * bw + bw / 2} y={y(nextWeek) - 4} textAnchor="middle" className="usage-label">{n1(nextWeek)}</text>
          </>
        )}
        <text x={weekly.length * bw + bw / 2} y={H + 13} textAnchor="middle" className="usage-label">来週</text>
      </svg>
      {usage?.weekdays && <WeekdayBars weights={usage.weekdays} />}
    </div>
  );
}

/** 曜日ごとの棒（月曜はじまりの 7 本。重み 1 が営業日の平均。第29.14.3節）。 */
function WeekdayBars({ weights }: { weights: number[] }) {
  const order = [1, 2, 3, 4, 5, 6, 0];
  const names = ['日', '月', '火', '水', '木', '金', '土'];
  const max = Math.max(1, ...weights);
  return (
    <>
    <div className="muted small weekday-caption">曜日ごと</div>
    <div className="weekday-bars" role="img" aria-label={`曜日ごとの出庫: ${order.map((d) => `${names[d]} ${weights[d]}`).join('・')}`}>
      {order.map((d) => (
        <div key={d} className="weekday-bar" title={`${names[d]}曜: 平均の ${weights[d]} 倍`}>
          <span className="weekday-fill" style={{ height: `${Math.round((weights[d]! / max) * 100)}%` }} />
          <span className="weekday-name">{names[d]}</span>
        </div>
      ))}
    </div>
    </>
  );
}
