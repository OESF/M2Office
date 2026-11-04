/**
 * @file 一覧へ戻るボタンと、業務の題名の行（仕様書 第6.1.2.2節）。
 *
 * 2026-10-20 に三浦さんが、戻るリンクが題名の下に小さく出ていて分かりにくいこと、長い画面ではいちばん上まで
 * スクロールしないと戻れないこと、言い方がそろっていないこと（「← 一覧」「← 在庫」「一覧に戻る」など）を挙げた。
 * 枠のあるボタンにして見つけやすくし、画面の終わりにも置く。押したら、戻った画面をいちばん上から見せる。
 *
 * 2026-11-04 に三浦さんが、ボタンをもっと分かりやすくし、業務の題名と同じ行の右端に置くよう求めた。
 * 上のボタンは、業務の題名の行（{@link ViewTitle}）の右端の枠へ出す。題名の行が無い画面（運営の画面など）では、その場の左に出す。
 */

import { useCallback, useSyncExternalStore, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { Icon } from './nav.js';

/** 業務の題名の行の右端の枠（同時に開く業務は 1 つなので、1 つだけ持つ）。 */
let headSlot: HTMLElement | null = null;
const listeners = new Set<() => void>();
const subscribe = (fn: () => void) => { listeners.add(fn); return () => { listeners.delete(fn); }; };
const slotNow = () => headSlot;

/**
 * 業務の題名の行。題名（`h1`）の右端に、詳しい画面の「一覧へ戻る」ボタンが入る枠を持つ。
 *
 * @param children 題名（業務の名前と「？」）
 */
export function ViewTitle({ children }: { children: ReactNode }) {
  const ref = useCallback((el: HTMLSpanElement | null) => {
    if (el) headSlot = el;
    else if (headSlot && !headSlot.isConnected) headSlot = null;
    for (const fn of listeners) fn();
  }, []);
  return (
    <div className="view-head">
      <h1>{children}</h1>
      <span className="view-head-slot" ref={ref} />
    </div>
  );
}

/**
 * 一覧へ戻るボタン。上のボタンは業務の題名の行の右端に出す（題名の行が無ければ、その場の左に出す）。
 *
 * @param label 戻る先の名前（「品目の一覧」など。「へ戻る」は付けない）
 * @param place 画面の上（既定）か下か（下は画面の終わりの左に、上との間を空けて置く）
 */
export function BackButton({ label, onClick, place = 'top' }: { label: string; onClick: () => void; place?: 'top' | 'bottom' }) {
  const slot = useSyncExternalStore(subscribe, slotNow, slotNow);
  const go = (e: React.MouseEvent<HTMLButtonElement>) => {
    // 長い画面の下から戻っても、戻った画面をいちばん上から見せる（中身を流す枠と、画面全体の両方）
    let el: HTMLElement | null = e.currentTarget.parentElement;
    while (el) {
      if (el.scrollTop > 0) el.scrollTop = 0;
      el = el.parentElement;
    }
    window.scrollTo({ top: 0 });
    onClick();
  };
  const button = (
    <button type="button" className={`back-btn back-${place}`} onClick={go}>
      <Icon name="back" />{label}へ戻る
    </button>
  );
  return place === 'top' && slot?.isConnected ? createPortal(button, slot) : button;
}
