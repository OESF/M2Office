import type { Repository } from '../repository/types.js';

/**
 * 層 1 の照会カタログ（仕様書 第8.9.2節）。
 *
 * LLM を介さずにデータを整形して返す定型の照会を、宣言的に定義する。
 * カタログの追加に実装の変更を伴わせないことが狙いである。
 *
 * @remarks
 * 層 1 は推論を通らないため、事実の誤りが混入しない（第8.9.4節）。
 * 頻度の高い照会ほど正確になるという性質は、信頼の獲得に直接効く。
 */
export interface DirectQuery {
  id: string;
  /** 照会の名前。画面や監査ログに表示する。 */
  label: string;
  /** 言い回しの揺れを拾うためのパターン。 */
  patterns: RegExp[];
  /** 権限区画。区画内のものは本人参照に限る（第16.3.4節）。 */
  compartment: string | null;
  answer(ctx: DirectQueryContext): Promise<DirectAnswer>;
}

export interface DirectQueryContext {
  tenantId: string;
  userId: string;
  repo: Repository;
}

export interface DirectAnswer {
  text: string;
  /** 根拠。サッシパネルに表示する（仕様書 第18.2節）。 */
  evidence: { label: string; value: string }[];
}

/** 承認待ちの件数と一覧を返す。 */
const pendingApprovals: DirectQuery = {
  id: 'pending-approvals',
  label: '承認待ちの確認',
  patterns: [/承認/, /待ち/, /確認すること/],
  compartment: null,
  async answer(ctx) {
    const list = await ctx.repo.listPendingApprovals(ctx.tenantId);
    if (list.length === 0) {
      return { text: '承認待ちはありません。', evidence: [] };
    }
    return {
      text: `承認待ちが ${list.length} 件あります。`,
      evidence: list.slice(0, 5).map((a) => ({ label: '承認待ち', value: a.present })),
    };
  },
};

/** 直近の実行状況を返す。 */
const recentRuns: DirectQuery = {
  id: 'recent-runs',
  label: '実行状況の確認',
  patterns: [/実行/, /状況/, /進捗/, /どうなった/],
  compartment: null,
  async answer(ctx) {
    const runs = await ctx.repo.listRuns(ctx.tenantId, 5);
    if (runs.length === 0) {
      return { text: 'まだ実行の履歴はありません。', evidence: [] };
    }
    const running = runs.filter((r) => r.status === 'running' || r.status === 'queued');
    const waiting = runs.filter((r) => r.status === 'awaiting_approval');
    return {
      text: `直近 ${runs.length} 件のうち、実行中 ${running.length} 件、承認待ち ${waiting.length} 件です。`,
      evidence: runs.map((r) => ({ label: r.id.slice(0, 8), value: r.status })),
    };
  },
};

/**
 * プロトタイプで用意する照会。
 *
 * @remarks
 * 予定・メール・タスクの照会は Google 連携の実装後に追加する
 * （仕様書 第8.9.2節の表）。
 */
export const DIRECT_QUERIES: DirectQuery[] = [pendingApprovals, recentRuns];
