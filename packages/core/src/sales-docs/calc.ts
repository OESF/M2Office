/**
 * @file 販売の書類の決まった計算（仕様書 第42.3節・第42.4.2節）。金額・支払期限・締めの区切りを、推論を使わずに出す。
 *
 * 金額は見積書と同じ計算（{@link quoteTotals}）で、消費税は税率ごとに合計してから 1 回だけ端数を処理する。
 */

import type { SalesItem, SalesTaxLine } from '@m2office/shared';
import { quoteItemAmount, quoteTotals } from '../tools/quote.js';

/** 書類の金額（小計・消費税・合計・税率ごと）。 */
export function docTotals(items: SalesItem[], rounding: 'floor' | 'round' | 'ceil'): { subtotal: number; tax: number; total: number; taxLines: SalesTaxLine[] } {
  const t = quoteTotals(items, rounding);
  return { subtotal: t.subtotal, tax: t.tax, total: t.total, taxLines: t.byRate };
}

/** 品目の金額（数量×単価−値引き）。 */
export const itemAmount = (i: SalesItem): number => quoteItemAmount(i);

/** 日本時間の今日（`YYYY-MM-DD`）。 */
export const jstToday = (now: Date = new Date()): string => new Date(now.getTime() + 9 * 3_600_000).toISOString().slice(0, 10);

/** 月末の日（`YYYY-MM-DD`）。`months` か月先の月の末日。 */
function monthEnd(day: string, months: number): string {
  const [y, m] = day.split('-').map(Number) as [number, number];
  const d = new Date(Date.UTC(y, m - 1 + months + 1, 0));
  return d.toISOString().slice(0, 10);
}

/** `months` か月先の月の `date` 日（その月に無ければ末日）。 */
function monthDay(day: string, months: number, date: number): string {
  const end = monthEnd(day, months);
  const last = Number(end.slice(8));
  return `${end.slice(0, 8)}${String(Math.min(date, last)).padStart(2, '0')}`;
}

/** 日を足す。 */
export function addDays(day: string, n: number): string {
  return new Date(Date.parse(`${day}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
}

const KANJI: Record<string, number> = { 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10 };

/**
 * 支払い条件の言い方から、支払期限の日付を出す（第42.4.2節）。発行日から数える。
 *
 * 読める言い方: 「当月末」「翌月末」「翌々月末」「翌月 10 日」「翌々月 15 日」「30 日以内」「発行から 14 日」。
 *
 * @returns 読めなければ `null`（推測で日付を作らない）
 */
export function dueDateFrom(terms: string, issuedOn: string): string | null {
  const t = terms.normalize('NFKC').replace(/\s+/g, '');
  if (!t) return null;
  const months = /翌々月/.test(t) ? 2 : /翌月/.test(t) ? 1 : /当月/.test(t) ? 0 : null;
  if (months !== null) {
    const date = /(?:翌々月|翌月|当月)(\d{1,2})日/.exec(t);
    if (date) return monthDay(issuedOn, months, Number(date[1]));
    if (/(?:翌々月|翌月|当月)末/.test(t)) return monthEnd(issuedOn, months);
  }
  const within = /(\d{1,3}|[一二三四五六七八九十])日(?:以内|後|まで)/.exec(t);
  if (within) {
    const n = Number(within[1]) || KANJI[within[1]!] || 0;
    if (n > 0) return addDays(issuedOn, n);
  }
  return null;
}

/**
 * 支払い条件の言い方から締め日を読む（「20 日締め」は 20、「月末締め」は 0）。
 *
 * @returns 読めなければ `null`
 */
export function closingDayFrom(terms: string): number | null {
  const t = terms.normalize('NFKC').replace(/\s+/g, '');
  if (/(月末|末日)締/.test(t)) return 0;
  const m = /(\d{1,2})日締/.exec(t);
  if (!m) return null;
  const n = Number(m[1]);
  return n >= 1 && n <= 28 ? n : n >= 29 ? 0 : null;
}

/**
 * 締めの区切り（この日までの納品書をまとめて請求する。第42.4.2節）。
 *
 * @param closingDay 締め日（0 か `null` は月末締めで、今日までのすべてをまとめる）
 * @returns 今日以前で、いちばん近い締め日
 */
export function closingCutoff(today: string, closingDay: number | null): string {
  if (!closingDay) return today;
  const thisMonth = monthDay(today, 0, closingDay);
  return thisMonth <= today ? thisMonth : monthDay(today, -1, closingDay);
}

/** 金額の表記（`110,000 円`）。 */
export const yenText = (n: number): string => `${n.toLocaleString('ja-JP')} 円`;

/** 金額の表記（`￥110,000`）。帳票の表に使う（同梱の書体に半角の「¥」が無いため全角）。 */
export const yenMark = (n: number): string => `${n < 0 ? '-' : ''}￥${Math.abs(n).toLocaleString('ja-JP')}`;
