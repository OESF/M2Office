/**
 * @file 競合の分析からほかの拡張へのつなぎ（仕様書 第36.9節・第36.21節）。Web の振り返りが読む、月の動きの数と、話題を載せている競合の数。
 *
 * **競合の名前は渡さない。** 数だけを渡す（地図で見つけた競合の名前は残さない決まりがあり、Web の振り返りの便りと直すべき所は残る文のため。第36.13節）。
 * 競合の分析を切っている会社では、何も返さない。
 */

import { COMPETITOR_FACT_LABELS, type CompetitorFactKind } from '@m2office/shared';
import type { Repository } from '../repository/types.js';
import type { CompetitorStore } from './store.js';

/** Web の振り返りから見た競合の分析。 */
export interface CompetitorLinks {
  /**
   * その月（`YYYY-MM`。日本時間）に作ったレポートの、前の回からの動きの数（種類ごと）。
   *
   * @returns 競合の分析を使っていない・レポートが無ければ `null`
   */
  monthMoves(tenantId: string, month: string): Promise<{ changes: number; kinds: { label: string; count: number }[] } | null>;
  /**
   * 検索の言葉ごとに、その話題をページに載せている競合の数（いちばん新しい回の事実の文に、言葉のすべての語が出るもの）。
   */
  topicCounts(tenantId: string, words: string[]): Promise<Map<string, number>>;
}

/**
 * 競合の分析の置き場から、つなぎの口を作る。
 */
export function competitorLinksFrom(deps: { store: CompetitorStore; repo: Repository }): CompetitorLinks {
  const enabled = async (tenantId: string) => (await deps.repo.getTenantSettings(tenantId)).competitors.enabled;
  return {
    async monthMoves(tenantId, month) {
      if (!(await enabled(tenantId))) return null;
      const jstMonth = (iso: string) => new Date(Date.parse(iso) + 9 * 3_600_000).toISOString().slice(0, 7);
      const reports = (await deps.store.reports(tenantId, 60)).filter((r) => jstMonth(r.createdAt) === month);
      if (!reports.length) return null;
      const kinds: Partial<Record<CompetitorFactKind, number>> = {};
      for (const r of reports) for (const [k, n] of Object.entries(r.changeKinds ?? {})) kinds[k as CompetitorFactKind] = (kinds[k as CompetitorFactKind] ?? 0) + (n ?? 0);
      return {
        changes: reports.reduce((t, r) => t + r.changes, 0),
        kinds: Object.entries(kinds).filter(([, n]) => n).map(([k, n]) => ({ label: COMPETITOR_FACT_LABELS[k as CompetitorFactKind], count: n! })).sort((a, b) => b.count - a.count),
      };
    },
    async topicCounts(tenantId, words) {
      const out = new Map<string, number>();
      if (!words.length || !(await enabled(tenantId))) return out;
      const watching = (await deps.store.list(tenantId)).filter((c) => c.status === 'watching');
      const texts: string[] = [];
      for (const c of watching) {
        const facts = await deps.store.facts(tenantId, c.id);
        const latest = facts.reduce((m, f) => (f.period > m ? f.period : m), '');
        texts.push(facts.filter((f) => f.period === latest).map((f) => f.text).join(' ').toLowerCase());
      }
      for (const w of words) {
        const parts = w.toLowerCase().split(/[\s　]+/).filter((p) => p.length >= 2);
        if (!parts.length) continue;
        out.set(w, texts.filter((t) => parts.every((p) => t.includes(p))).length);
      }
      return out;
    },
  };
}
