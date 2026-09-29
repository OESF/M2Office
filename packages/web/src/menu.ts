/**
 * @file 左のメニューの業務を、ピン止めしたもの・カテゴリーごと・「ほかの業務」に分ける（仕様書 第6.1.1節「業務の並び」）。
 *
 * ピン止めとカテゴリーは本人だけが変える。使った回数では変えない（第 0.129.0 版）。
 * ピン止めが優先し、ピン止めした業務はカテゴリーに入っていても上に出す。外すと入っているカテゴリーに戻る（第 0.166.0 版）。
 */

import { DEFAULT_PINNED, MENU_CATEGORY_MAX, MENU_CATEGORY_NAME_MAX, type MenuCategory } from '@m2office/shared';

/** 左のメニューの設定のうち、並べ方に使うもの。 */
export interface MenuLayout {
  pinned?: string[] | null;
  categories?: MenuCategory[];
  categoryOf?: Record<string, string>;
}

/** たたんで見せる 1 つのまとまり。`category` が `null` なら「ほかの業務」（どのカテゴリーにも入れていない業務）。 */
export interface MenuSection<T> {
  category: MenuCategory | null;
  items: T[];
}

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

/**
 * メニューの業務を、ピン止めしたもの・カテゴリーごと（作った順）・「ほかの業務」に分ける。
 *
 * @param agents メニューに出す業務（メニューの順に並べたもの）
 * @returns 中身の無いカテゴリーと、空の「ほかの業務」は含めない
 */
export function groupMenu<T extends { id: string }>(agents: T[], layout: MenuLayout): { top: T[]; sections: MenuSection<T>[] } {
  const { top, others } = splitMenu(agents, layout.pinned);
  const cats = layout.categories ?? [];
  const of = layout.categoryOf ?? {};
  const known = new Set(cats.map((c) => c.id));
  const sections: MenuSection<T>[] = cats
    .map((c) => ({ category: c, items: others.filter((a) => of[a.id] === c.id) }))
    .filter((s) => s.items.length > 0);
  const rest = others.filter((a) => !of[a.id] || !known.has(of[a.id]!));
  if (rest.length) sections.push({ category: null, items: rest });
  return { top, sections };
}

/** ピン止めを切り替えた後の ID の並び（止めていれば外し、外していれば止める）。 */
export function togglePinned(pinned: string[] | null | undefined, id: string): string[] {
  const ids = pinnedIds(pinned);
  return ids.includes(id) ? ids.filter((x) => x !== id) : [...ids, id];
}

/**
 * 業務を入れるカテゴリーを変えた後の対応。
 *
 * @param categoryId 入れるカテゴリー。`null` なら「カテゴリーに入れない」
 */
export function assignCategory(categoryOf: Record<string, string> | undefined, itemId: string, categoryId: string | null): Record<string, string> {
  const next = { ...(categoryOf ?? {}) };
  if (categoryId) next[itemId] = categoryId;
  else delete next[itemId];
  return next;
}

/** カテゴリーの名前を確かめる。よければ整えた名前、だめなら理由。 */
export function checkCategoryName(categories: MenuCategory[] | undefined, name: string, exceptId?: string): { name: string } | { error: string } {
  const n = name.trim();
  if (!n) return { error: '名前を入れてください' };
  if ([...n].length > MENU_CATEGORY_NAME_MAX) return { error: `${MENU_CATEGORY_NAME_MAX} 字までです` };
  if ((categories ?? []).some((c) => c.name === n && c.id !== exceptId)) return { error: '同じ名前があります' };
  return { name: n };
}

/**
 * カテゴリーを作る。
 *
 * @returns 作ったあとの一覧と新しいカテゴリー。数や名前が決まりに合わなければ理由
 */
export function addCategory(categories: MenuCategory[] | undefined, name: string): { categories: MenuCategory[]; category: MenuCategory } | { error: string } {
  const list = categories ?? [];
  if (list.length >= MENU_CATEGORY_MAX) return { error: `カテゴリーは ${MENU_CATEGORY_MAX} 個までです` };
  const checked = checkCategoryName(list, name);
  if ('error' in checked) return checked;
  const category = { id: `c-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`, name: checked.name };
  return { categories: [...list, category], category };
}

/** カテゴリーを消した後の一覧と対応。中の業務は「カテゴリーに入れない」に戻す（業務は消えない）。 */
export function removeCategory(layout: MenuLayout, categoryId: string): { categories: MenuCategory[]; categoryOf: Record<string, string> } {
  return {
    categories: (layout.categories ?? []).filter((c) => c.id !== categoryId),
    categoryOf: Object.fromEntries(Object.entries(layout.categoryOf ?? {}).filter(([, v]) => v !== categoryId)),
  };
}
