/**
 * @file 左のメニューの業務を、ピン止めしたものと「ほかの業務」に分ける（仕様書 第6.1.1節「業務の並び」）。
 *
 * ピン止めは本人だけが変える。使った回数では変えない（第 0.129.0 版）。
 */

import { DEFAULT_PINNED } from '@m2office/shared';

/**
 * ピン止めした業務の ID。まだ一度も変えていなければ（`null`・`undefined`）標準の組。
 */
export function pinnedIds(pinned: string[] | null | undefined): string[] {
  return pinned ?? DEFAULT_PINNED;
}

/**
 * メニューの業務を、ピン止めしたもの（上に出す）とほかの業務（たたむ）に分ける。並びは渡された順のまま。
 *
 * @param agents メニューに出す業務（メニューの順に並べたもの）
 */
export function splitMenu<T extends { id: string }>(agents: T[], pinned: string[] | null | undefined): { top: T[]; others: T[] } {
  const ids = pinnedIds(pinned);
  return { top: agents.filter((a) => ids.includes(a.id)), others: agents.filter((a) => !ids.includes(a.id)) };
}

/** ピン止めを切り替えた後の ID の並び（止めていれば外し、外していれば止める）。 */
export function togglePinned(pinned: string[] | null | undefined, id: string): string[] {
  const ids = pinnedIds(pinned);
  return ids.includes(id) ? ids.filter((x) => x !== id) : [...ids, id];
}
