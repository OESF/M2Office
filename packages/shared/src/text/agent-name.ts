/**
 * @file 業務の名前を画面に出す（仕様書 第6.2.4節・第6.2.5節）。定義が見つからないときも、ID をそのまま出さない。
 *
 * 業務を削除した後も、承認トレイの「判断したもの」・実行の一覧・ダッシュボードには、その業務の実行が残る。
 * そのとき業務の ID（`skill.slack-post:slack-post` など）をそのまま出すと、何の承認か分からなかった（2026-10-04）。
 */

/**
 * 業務の名前。定義が見つかればその名前、無ければ依頼のときに残した名前、それも無ければ「削除した業務（…）」。
 *
 * @param found いまの定義の名前（見つからなければ `undefined`）
 * @param agentId 業務の ID（`拡張機能:業務` の形）
 * @param saved 依頼のときに残した名前（移行 078 より前の依頼には無い）
 * @remarks 名前を推測で作らない。ID の業務の部分を、削除したことが分かる形で添えるだけにする
 */
export function agentDisplayName(found: string | undefined | null, agentId: string, saved?: string | null): string {
  if (found) return found;
  if (saved) return saved;
  if (!agentId) return '不明な業務';
  const part = agentId.split(':').pop()!.replace(/^skill\./, '');
  return `削除した業務（${part}）`;
}
