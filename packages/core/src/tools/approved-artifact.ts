/**
 * @file 承認で確かめた成果物を引く（仕様書 第9.5.2節、ADR-0010・ADR-0025）。
 *
 * 組織知識への登録（`knowledge.register`）と、Google ドキュメントへの保存（`docs.create` の `artifactId`）が使う。
 * どちらも本文を推論から受け取らず、承認した人が見た成果物の本文をそのまま使う。
 * 記録に紛れ込んだ指示で、承認した人が見ていない文を入れさせないため（不変則 I-6）。
 */

import type { Artifact } from '@m2office/shared';
import type { ToolContext } from './registry.js';

/**
 * この実行の成果物のうち、**最初の承認で止めた時点にあった**もの（すべての承認で承認した人が見たもの）を返す。
 *
 * @returns 成果物か、使えない理由（利用者と推論に返す文）
 *
 * @remarks
 * 承認①のあとに推論が作り直したものは使えない。操作の確認（`:confirm`）は内容の承認とみなさない。
 * 本文の無い成果物（ファイルだけのもの）も使えない。
 */
export async function approvedArtifact(
  ctx: Pick<ToolContext, 'repo' | 'tenantId' | 'runId'>, artifactId: string,
): Promise<{ artifact: Artifact } | { reason: string }> {
  const artifact = (await ctx.repo.listArtifacts(ctx.tenantId, ctx.runId)).find((a) => a.id === artifactId);
  if (!artifact) return { reason: 'この実行で作った成果物が見つかりません' };
  if (!artifact.body.trim()) return { reason: '本文のない成果物は使えません' };
  const steps = await ctx.repo.listRunSteps(ctx.tenantId, ctx.runId);
  const firstGate = steps
    .filter((s) => s.kind === 'approval' && s.status === 'succeeded' && !s.stepId.endsWith(':confirm'))
    .sort((a, b) => a.seq - b.seq)[0];
  const shown = (firstGate?.input as { artifactIds?: unknown } | null)?.artifactIds;
  if (!Array.isArray(shown) || !shown.includes(artifact.id)) return { reason: '承認で確かめた成果物ではありません' };
  return { artifact };
}

/**
 * 日本時間の日付（YYYY-MM-DD）。
 *
 * @remarks 知識と文書の題名に添える。同じ会議名の議事録（毎週の定例など）を見分けるため
 */
export function jstDate(iso: string): string {
  return new Date(Date.parse(iso) + 9 * 3_600_000).toISOString().slice(0, 10);
}
