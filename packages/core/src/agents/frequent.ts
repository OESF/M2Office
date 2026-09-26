/**
 * @file よく使う業務を決める（仕様書 第6.1.1節「業務の並び」）。
 *
 * 左のメニューは、よく使う業務だけを上に出し、ほかはたたむ。よく使う業務は本人が選ばず、使った回数から決める（ADR-0028）。
 */

/** よく使う業務として上に出す数。 */
export const FREQUENT_MAX = 6;

/** 数える期間（日）。 */
export const FREQUENT_DAYS = 30;

/** 使った記録がまだ少ないときに埋める標準の組（仕様書 第6.1.1節）。 */
export const DEFAULT_FREQUENT = ['minutes', 'inbox-triage', 'knowledge-qa', 'scheduling', 'slides', 'document-draft'];

/**
 * よく使う業務の ID を、多い順に返す。
 *
 * @param mine 本人の実行（業務の ID と始めた時刻）。秘書に頼んだものも含める
 * @param company 会社全体の実行
 * @param candidates メニューに出せる業務の ID（利用範囲の内・メニューに出すもの）
 * @returns 最大 {@link FREQUENT_MAX} 件。本人 → 会社 → 標準の組の順に埋める
 */
export function pickFrequent(
  mine: { agentId: string; startedAt: string }[],
  company: { agentId: string; startedAt: string }[],
  candidates: string[],
  now: Date = new Date(),
): string[] {
  const since = now.getTime() - FREQUENT_DAYS * 86_400_000;
  const allowed = new Set(candidates);
  const ranked = (rows: { agentId: string; startedAt: string }[]) => {
    const counts = new Map<string, number>();
    for (const r of rows) {
      if (!allowed.has(r.agentId) || Date.parse(r.startedAt) < since) continue;
      counts.set(r.agentId, (counts.get(r.agentId) ?? 0) + 1);
    }
    return [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([id]) => id);
  };
  const out: string[] = [];
  for (const id of [...ranked(mine), ...ranked(company), ...DEFAULT_FREQUENT.filter((x) => allowed.has(x)), ...candidates]) {
    if (!out.includes(id)) out.push(id);
    if (out.length >= FREQUENT_MAX) break;
  }
  return out;
}
