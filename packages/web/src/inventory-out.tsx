/**
 * @file 出庫を速くする部品（仕様書 第29.9.1節、Q-247）。用途のボタンと、記録したあとの「取り消す」の行。
 *
 * 用途は販売・社内消費・廃棄・その他の 4 つで、文は打たない。既定はその品目で前に選んだ用途（無ければ区分から）。
 * パソコンの在庫の画面（一覧の行の「出庫」・品目の詳細）とスマホの出庫で使う。
 */

import { INVENTORY_OUT_PURPOSES, defaultOutPurpose, type InventoryItemView, type InventoryOutPurpose } from '@m2office/shared';

/** 品目の用途の既定（API が返した既定。無ければ区分から）。 */
export const purposeOf = (item: InventoryItemView): InventoryOutPurpose => item.outPurpose ?? defaultOutPurpose(item);

/**
 * 用途のボタン。押した 1 つを選ぶ。
 *
 * @param className スマホでは大きく（`m-purposes`）
 */
export function PurposeChips({ value, onChange, className = '' }: { value: InventoryOutPurpose; onChange: (p: InventoryOutPurpose) => void; className?: string }) {
  return (
    <div className={`segmented purposes ${className}`.trim()} role="radiogroup" aria-label="用途">
      {INVENTORY_OUT_PURPOSES.map((p) => (
        <button key={p.id} type="button" role="radio" aria-checked={value === p.id} className={value === p.id ? 'on' : ''} onClick={() => onChange(p.id)}>{p.label}</button>
      ))}
    </div>
  );
}

/** 記録した結果の 1 行。取り消せる記録なら「取り消す」を添える。 */
export interface OutDone {
  text: string;
  /** 取り消す記録（一緒に足した記録はまとめて戻る）。取り消したら `null`。 */
  moveId: string | null;
}

/** 記録した結果の行と「取り消す」（その日のうちの取り消し。第29.9節）。 */
export function OutDoneLine({ done, onUndo, className = 'small muted' }: { done: OutDone; onUndo: () => void; className?: string }) {
  return (
    <p className={className} role="status">
      {done.text}
      {done.moveId && <> <button type="button" className="link" onClick={onUndo}>取り消す</button></>}
    </p>
  );
}
