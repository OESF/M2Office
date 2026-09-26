/**
 * @file 昇華（個人の記憶を組織知識へ引き上げる）で共通に使う小さな決まり。仕様書 第11.3節、ADR-0028。
 *
 * 第 0.115.0 版から、会社の知識にするかは秘書が判断する（`memory/learn.ts`）。
 * 本人と管理者の二重の承認（ADR-0016）はやめ、その API もなくした。
 */

/** 昇華した知識の題名（先頭の 30 字）。 */
export function promotionTitle(text: string): string {
  return text.length <= 30 ? text : `${text.slice(0, 30)}…`;
}
