/**
 * @file 在庫の品目を区分と分類で選ぶ欄（仕様書 第29.12.3節、Q-245）。Web への公開と、外部のアプリの「商品の一覧を読む」で使う。
 *
 * 区分と分類のボタンを押すと、当たる品目をすべて選び、当たらない品目を外す（条件で選ぶ）。条件は承認する中身として覚え、
 * あとで条件に当たる品目を足すと選んだ状態で並べる。出す・渡すのは承認したときだけ（社外への送信の境界。第9.4.0節）。
 */

import { useMemo } from 'react';
import {
  INVENTORY_ITEM_KINDS, inventoryRuleItemIds, inventoryRuleMatches, type InventoryItemKind, type InventoryItemRule, type InventoryItemView,
} from '@m2office/shared';

/** 選んだ品目と条件。 */
export interface PickedItems {
  itemIds: string[];
  rule?: InventoryItemRule | null;
}

/**
 * 条件に当たる新しい品目を、選んだ状態に足す（開いたとき・品目が変わったときに使う）。条件が無ければそのまま返す。
 *
 * @param active 使っている品目（止めた品目を除く）
 * @returns 選ぶ品目（条件に当たり、外していないもの）。`added` は承認した中身に無かった品目の数
 */
export function withRuleItems<T extends PickedItems>(picked: T, active: InventoryItemView[]): { picked: T; added: number } {
  if (!picked.rule) return { picked, added: 0 };
  const ids = inventoryRuleItemIds(picked.rule, active);
  const before = new Set(picked.itemIds);
  const added = ids.filter((id) => !before.has(id)).length;
  return { picked: { ...picked, itemIds: ids }, added };
}

/**
 * 区分と分類のボタンと、品目のチェックの一覧。
 *
 * @param items 使っている品目（止めた品目を除く）
 * @param value 選んだ品目と条件
 * @param onChange 選び方が変わったとき（品目と条件をまとめて渡す）
 * @param nameOf 一覧に出す名前（公開では公開する名前を先に出す）
 */
export function InventoryItemPicker<T extends PickedItems>({ items, value, onChange, nameOf = (i) => i.name }: {
  items: InventoryItemView[];
  value: T;
  onChange: (v: T) => void;
  nameOf?: (i: InventoryItemView) => string;
}) {
  const rule = value.rule ?? null;
  const kinds = rule?.kinds ?? [];
  const categories = rule?.categories ?? [];
  const chosen = new Set(value.itemIds);
  // 区分は品目のあるものだけ、分類は選んだ区分に品目のあるものだけを出す
  const kindsInUse = INVENTORY_ITEM_KINDS.filter((k) => items.some((i) => i.kind === k.id));
  const categoriesInUse = useMemo(() => [...new Set(items
    .filter((i) => kinds.length === 0 || kinds.includes(i.kind)).map((i) => i.category).filter(Boolean))], [items, kinds]);
  const shown = rule ? items.filter((i) => inventoryRuleMatches(rule, i)) : items;

  /** 条件を変える。区分も分類も無くなれば条件なしにし、選んだ品目はそのまま残す。 */
  const setRule = (k: InventoryItemKind[], c: string[]) => {
    // 区分を変えて当たらなくなった分類は外す
    const cats = c.filter((x) => items.some((i) => i.category === x && (k.length === 0 || k.includes(i.kind))));
    if (k.length === 0 && cats.length === 0) { onChange({ ...value, rule: null }); return; }
    const next: InventoryItemRule = { kinds: k, categories: cats, excluded: [] };
    onChange({ ...value, rule: next, itemIds: inventoryRuleItemIds(next, items) });
  };
  const toggleKind = (k: InventoryItemKind) => setRule(kinds.includes(k) ? kinds.filter((x) => x !== k) : [...kinds, k], categories);
  const toggleCategory = (c: string) => setRule(kinds, categories.includes(c) ? categories.filter((x) => x !== c) : [...categories, c]);

  const toggleItem = (id: string, on: boolean) => {
    const itemIds = on ? [...new Set([...value.itemIds, id])] : value.itemIds.filter((x) => x !== id);
    if (!rule) { onChange({ ...value, itemIds }); return; }
    // 条件で選んでいるときは、外した品目を覚える（条件に当たっても外したままにする）
    const excluded = on ? rule.excluded.filter((x) => x !== id) : [...new Set([...rule.excluded, id])];
    onChange({ ...value, itemIds, rule: { ...rule, excluded } });
  };
  /** いま並んでいる品目をすべて選ぶ・外す。 */
  const setAll = (on: boolean) => {
    if (!rule) { onChange({ ...value, itemIds: on ? items.map((i) => i.id) : [] }); return; }
    const ids = shown.map((i) => i.id);
    onChange({ ...value, itemIds: on ? ids : [], rule: { ...rule, excluded: on ? [] : ids } });
  };

  return (
    <div className="publish-items">
      <div className="publish-items-head">
        <span className="small">品目 {value.itemIds.length} / {items.length}</span>
        <button className="link small" onClick={() => setAll(true)}>すべて</button>
        <button className="link small" onClick={() => setAll(false)}>外す</button>
      </div>
      {kindsInUse.length > 1 && (
        <div className="publish-categories" role="group" aria-label="区分">
          <span className="picker-label">区分</span>
          {kindsInUse.map((k) => (
            <button key={k.id} className={`chip-btn small${kinds.includes(k.id) ? ' on' : ''}`} aria-pressed={kinds.includes(k.id)} onClick={() => toggleKind(k.id)}>{k.label}</button>
          ))}
        </div>
      )}
      {categoriesInUse.length > 1 && (
        <div className="publish-categories" role="group" aria-label="分類">
          <span className="picker-label">分類</span>
          {categoriesInUse.map((c) => (
            <button key={c} className={`chip-btn small${categories.includes(c) ? ' on' : ''}`} aria-pressed={categories.includes(c)} onClick={() => toggleCategory(c)}>{c}</button>
          ))}
        </div>
      )}
      <ul>
        {shown.map((i) => (
          <li key={i.id}>
            <label className="check">
              <input type="checkbox" checked={chosen.has(i.id)} onChange={(e) => toggleItem(i.id, e.target.checked)} />
              <span>{nameOf(i)}</span>
              {i.category && <span className="muted small">{i.category}</span>}
            </label>
          </li>
        ))}
      </ul>
    </div>
  );
}
