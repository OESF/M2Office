/**
 * @file お知らせから開く画面の道（仕様書 第6.1.6節「お知らせのリンク」）。
 *
 * 画面（お知らせの一覧）とワーカー（Chat への控え）の両方で使うため、ここに置く。
 * 道には画面の種類と、意味を持たない ID だけを載せる。
 */

/** 実行の ID として道に載せてよい形。 */
const RUN_ID = /^[A-Za-z0-9_.:-]{1,128}$/;

/**
 * お知らせから開く画面の道（`/` から始まる）。
 *
 * @remarks 承認の依頼は承認トレイ、実行に結び付くもの（完了・失敗など）は実行の詳細、ほかは最初の画面
 */
export function notificationPath(n: { kind: string; runId: string | null }): string {
  if (n.kind === 'approval') return '/approvals';
  if (n.runId && RUN_ID.test(n.runId)) return `/runs/${encodeURIComponent(n.runId)}`;
  return '/';
}
