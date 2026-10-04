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
 * @remarks 承認の依頼は承認トレイ、実行に結び付くもの（完了・失敗など）は実行の詳細、在庫の見張りは在庫管理、問い合わせの知らせは問い合わせの記録、ほかは最初の画面
 */
export function notificationPath(n: { kind: string; runId: string | null }): string {
  if (n.kind === 'approval') return '/approvals';
  if (n.kind === 'inventory') return '/inventory';
  if (n.kind === 'signage') return '/signage';
  // 問い合わせの次にやることの知らせは、問い合わせの記録を開く（期限の近い順に並ぶ。第33.7節）
  if (n.kind === 'inquiry') return '/inquiries';
  // 競合を探し終えた・見回り終えた知らせは、競合の分析を開く（第36.18節）
  if (n.kind === 'competitor') return '/competitors';
  // お知らせを出せなかった出し先の知らせは、お知らせの作成を開く（第35.17節）
  if (n.kind === 'announcement') return '/announcements';
  // Web の振り返りの月の便りは、Web の振り返りを開く（第34.18節）
  if (n.kind === 'webReview') return '/web-review';
  if (n.runId && RUN_ID.test(n.runId)) return `/runs/${encodeURIComponent(n.runId)}`;
  return '/';
}
