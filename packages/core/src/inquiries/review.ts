/**
 * @file 問い合わせの月の振り返り（仕様書 第33.9節・第33.18節）。
 *
 * 件数・経路・どこで知ったか・分類・温度感・窓口の宛先ごとの数と、前の月との違いを、**プログラムで数える**（推論に数えさせない）。
 * 文も決まった形で組む。名前・用件は入れない（個人を特定する情報を集計に入れない。第33.12節）。
 */

import { INQUIRY_CHANNEL_LABELS, INQUIRY_TEMPERATURE_LABELS, type InquiryChannel, type InquiryMonthStats, type InquiryTemperature } from '@m2office/shared';
import type { InquiryStore } from './store.js';

/** `YYYY-MM` の月の、日本時間の始まりと終わり（ISO。終わりは次の月の始まり）。 */
export function monthRange(month: string): { from: string; to: string } {
  const [y, m] = month.split('-').map(Number) as [number, number];
  const start = new Date(Date.UTC(y, m - 1, 1, -9));
  const end = new Date(Date.UTC(y, m, 1, -9));
  return { from: start.toISOString(), to: end.toISOString() };
}

/** 日本時間で、その日時の前の月（`YYYY-MM`）。 */
export function previousMonth(now: Date): string {
  const jst = new Date(now.getTime() + 9 * 3_600_000);
  const d = new Date(Date.UTC(jst.getUTCFullYear(), jst.getUTCMonth() - 1, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

const count = (xs: string[]) => xs.reduce<Record<string, number>>((acc, x) => { acc[x] = (acc[x] ?? 0) + 1; return acc; }, {});

/** その月の問い合わせを数える。 */
export async function monthStats(store: InquiryStore, tenantId: string, month: string): Promise<InquiryMonthStats> {
  const { from, to } = monthRange(month);
  const prev = monthRange(previousMonth(new Date(from)));
  const [rows, prevRows] = await Promise.all([store.monthRows(tenantId, from, to), store.monthRows(tenantId, prev.from, prev.to)]);
  return {
    month, total: rows.length, previousTotal: prevRows.length,
    byChannel: count(rows.map((r) => r.channel)),
    bySource: count(rows.map((r) => r.source || '不明')),
    byCategory: count(rows.map((r) => r.category || 'そのほか')),
    byTemperature: count(rows.map((r) => r.temperature)),
    byMailTo: count(rows.map((r) => r.mailTo).filter((x): x is string => !!x)),
  };
}

/** 多い順に「名前 数」を並べる。 */
function top(rec: Record<string, number>, label: (k: string) => string = (k) => k, n = 5): string {
  return Object.entries(rec).sort((a, b) => b[1] - a[1]).slice(0, n).map(([k, v]) => `${label(k)} ${v}`).join('・');
}

/** 振り返りの文（決まった形。数はそのまま）。 */
export function reviewText(s: InquiryMonthStats): string {
  const m = Number(s.month.slice(5));
  if (s.total === 0) return `${m} 月の問い合わせはありませんでした（前の月は ${s.previousTotal} 件）。`;
  const diff = s.total - s.previousTotal;
  return [
    `${m} 月の問い合わせは ${s.total} 件でした（前の月より${diff === 0 ? '同じ' : diff > 0 ? ` ${diff} 件多い` : ` ${-diff} 件少ない`}）。`,
    `経路: ${top(s.byChannel, (k) => INQUIRY_CHANNEL_LABELS[k as InquiryChannel] ?? k)}。`,
    `どこで知ったか: ${top(s.bySource)}。`,
    `多かった分類: ${top(s.byCategory, undefined, 3)}。`,
    `見込みの強さ: ${top(s.byTemperature, (k) => INQUIRY_TEMPERATURE_LABELS[k as InquiryTemperature] ?? k)}。`,
    Object.keys(s.byMailTo).length > 0 ? `窓口の宛先: ${top(s.byMailTo)}。` : '',
  ].filter(Boolean).join('\n');
}
