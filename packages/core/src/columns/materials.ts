/**
 * @file コラムのテーマ案の材料を、ほかの拡張から集める（仕様書 第32.6節・第32.18.4節）。
 *
 * 検索の言葉（Web の振り返り）・競合の話題（競合の分析）・よく来る質問（問い合わせの記録）・書き直しの案（Web の振り返りの直すべき所）。
 * その拡張を会社が切っていれば空を返す。**誰からの問い合わせかは渡さない**（話題だけ）。
 */

import type { Repository } from '../repository/types.js';
import type { WebReviewService } from '../web-review/service.js';
import type { CompetitorStore } from '../competitors/store.js';
import type { InquiryService } from '../inquiries/service.js';
import type { ColumnThemeMaterials } from './planner.js';

/**
 * ほかの拡張の処理から、テーマ案の材料の口を作る。
 */
export function columnMaterialsFrom(deps: {
  repo: Repository;
  webReview?: WebReviewService;
  competitorStore?: CompetitorStore;
  inquiries?: InquiryService;
}): ColumnThemeMaterials {
  const settings = (tenantId: string) => deps.repo.getTenantSettings(tenantId);
  return {
    async searchWords(tenantId) {
      if (!deps.webReview || !(await settings(tenantId)).webReview.enabled) return [];
      const [findings, report] = await Promise.all([deps.webReview.findings(tenantId), deps.webReview.report(tenantId)]);
      const words = [
        ...findings.filter((f) => f.kind === 'missingContent').map((f) => f.target),
        ...(report?.figures.search?.risingQueries ?? []).map((q) => q.query),
      ];
      return [...new Set(words)].slice(0, 10);
    },
    async competitorThemes(tenantId) {
      if (!deps.competitorStore || !(await settings(tenantId)).competitors.enabled) return [];
      return (await deps.competitorStore.reports(tenantId, 1))[0]?.themes ?? [];
    },
    async questions(tenantId) {
      if (!deps.inquiries || !(await settings(tenantId)).inquiries.enabled) return [];
      return (await deps.inquiries.faq({ tenantId, userId: 'system' })).map((t) => t.topic);
    },
    async rewrites(tenantId) {
      if (!deps.webReview || !(await settings(tenantId)).webReview.enabled) return [];
      return (await deps.webReview.findings(tenantId))
        .filter((f) => f.columnId && (f.kind === 'fading' || f.kind === 'nearFirstPage'))
        .map((f) => ({ columnId: f.columnId!, theme: `「${f.title}」の書き直し`, why: f.advice.split('\n')[0]!.slice(0, 200) }));
    },
  };
}
