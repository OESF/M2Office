/**
 * @file 問い合わせの記録からほかの拡張へのつなぎ（仕様書 第34.9節・第34.20節）。Webの分析の月の便りに並べる、月の問い合わせの件数。
 *
 * **件数だけを渡す**（プログラムが数える）。名前・用件・連絡先は渡さない（ADR-0067 決定 7）。
 * 問い合わせの記録を切っている会社では、何も返さない。
 */

import { INQUIRY_SOURCE_UNKNOWN } from '@m2office/shared';
import type { Repository } from '../repository/types.js';
import type { InquiryStore } from './store.js';

/** Webの分析から見た問い合わせの記録。 */
export interface InquiryCounts {
  /**
   * その月（`YYYY-MM`。日本時間）に届いた問い合わせの件数と、前の月の件数、どこで知ったかの内訳（多い順）。
   *
   * @returns 問い合わせの記録を使っていなければ `null`
   */
  monthCounts(tenantId: string, month: string): Promise<{ value: number; previous: number; bySource: { label: string; count: number }[] } | null>;
}

/**
 * 問い合わせの記録の置き場から、件数の口を作る。
 */
export function inquiryCountsFrom(deps: { store: InquiryStore; repo: Repository }): InquiryCounts {
  return {
    async monthCounts(tenantId, month) {
      if (!(await deps.repo.getTenantSettings(tenantId)).inquiries.enabled) return null;
      const [y, m] = month.split('-').map(Number) as [number, number];
      const prevMonth = new Date(Date.UTC(y, m - 2, 1)).toISOString().slice(0, 7);
      // 前の月の初め（日本時間）より後に動いた問い合わせを読み、届いた月で数える
      const since = new Date(Date.parse(`${prevMonth}-01T00:00:00+09:00`)).toISOString();
      const list = await deps.store.list(tenantId, { status: 'all', since, limit: 5000 });
      const monthOf = (iso: string) => new Date(Date.parse(iso) + 9 * 3_600_000).toISOString().slice(0, 7);
      const cur = list.filter((i) => monthOf(i.createdAt) === month);
      const sources = new Map<string, number>();
      for (const i of cur) sources.set(i.source || INQUIRY_SOURCE_UNKNOWN, (sources.get(i.source || INQUIRY_SOURCE_UNKNOWN) ?? 0) + 1);
      return {
        value: cur.length,
        previous: list.filter((i) => monthOf(i.createdAt) === prevMonth).length,
        bySource: [...sources.entries()].map(([label, count]) => ({ label, count })).sort((a, b) => b.count - a.count),
      };
    },
  };
}
