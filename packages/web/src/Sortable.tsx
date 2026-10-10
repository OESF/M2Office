/**
 * @file つかんで動かして並べ替える一覧（個人設定のメニューの並び・サイネージの流れ。仕様書 第6.5.6節・第31.6節）。
 *
 * 行の左のつまみをつかんで上下に動かすと、つかんだ行が指に付いて動き、ほかの行がよけて、離したところに置く。
 * 動かしている間は画面の要素の順番を変えず、見た目だけをずらす（要素を入れ替えると、つかんでいるポインターが外れて止まるため）。
 * マウスとタッチの両方で動くよう、ブラウザのドラッグ＆ドロップではなくポインターの操作で作る。つかんだまま端に寄せると、一覧を送る。
 * キーボードでは、つまみを選んで ↑・↓ キーで 1 つずつ動かす。
 */

import { useEffect, useRef, useState, type ReactNode } from 'react';

/** 並びの中の 1 つを、別の位置へ動かした並びを返す。 */
export function moveItem<T>(list: readonly T[], from: number, to: number): T[] {
  const out = [...list];
  const [x] = out.splice(from, 1);
  out.splice(Math.max(0, Math.min(out.length, to)), 0, x!);
  return out;
}

/**
 * つかんだ行の真ん中の位置から、置く位置を決める（ほかの行の真ん中を越えたら、その行の位置）。
 *
 * @param mids つかむ前の各行の真ん中
 * @param from つかんだ行の位置
 * @param center つかんだ行の、いまの真ん中
 */
export function dropIndex(mids: readonly number[], from: number, center: number): number {
  let over = from;
  for (let i = from + 1; i < mids.length; i++) if (center > mids[i]!) over = i;
  for (let i = from - 1; i >= 0; i--) if (center < mids[i]!) over = i;
  return over;
}

/** つかんでいる間の様子。 */
interface DragState {
  key: string;
  from: number;
  over: number;
  /** つかんだ行の、指に付いてずれた量（送った分を含む）。 */
  dy: number;
  /** ほかの行がよける量（つかんだ行の高さと、行の間のすき間）。 */
  height: number;
}

/** 端に寄せたときに一覧を送り始める幅（px）。 */
const EDGE = 48;

/**
 * つかんで動かして並べ替える一覧。
 *
 * @param items 並べるもの（いまの順）
 * @param keyOf 1 つずつを見分ける値
 * @param nameOf つまみの読み上げに使う名前
 * @param render 行の中身（つまみの右に出す）
 * @param onMove 置いたときに、新しい並びで呼ぶ
 * @param className 一覧に足す見た目の名前（行の中身の並べ方を画面ごとに決める）
 */
export function SortableList<T>({ items, keyOf, nameOf, render, onMove, className }: {
  items: readonly T[]; keyOf: (x: T) => string; nameOf: (x: T) => string; render: (x: T) => ReactNode; onMove: (next: T[]) => void; className?: string;
}) {
  const list = useRef<HTMLUListElement>(null);
  const rows = useRef(new Map<string, HTMLLIElement>());
  const [drag, setDrag] = useState<DragState | null>(null);
  const [said, setSaid] = useState('');
  // 最新の並びと呼び先（ポインターの受け手は 1 度だけ作るため、ここから読む）
  const latest = useRef({ items, onMove, nameOf });
  latest.current = { items, onMove, nameOf };
  // つかんだ時点の寸法と、いまの指の位置（画面の更新を待たずに使う）
  const g = useRef<{ box: HTMLElement | null; startY: number; startScroll: number; mids: number[]; y: number; state: DragState | null; timer: number | null }>(
    { box: null, startY: 0, startScroll: 0, mids: [], y: 0, state: null, timer: null });

  // ポインターの受け手（つかんでいる間だけ window に付ける。1 度だけ作り、付けたものと外すものを同じにする）
  const [handlers] = useState(() => {
    const scrollTopOf = (box: HTMLElement | null) => (box ? box.scrollTop : window.scrollY);
    const follow = () => {
      const s = g.current;
      if (!s.state) return;
      const dy = s.y - s.startY + (scrollTopOf(s.box) - s.startScroll);
      const over = dropIndex(s.mids, s.state.from, s.mids[s.state.from]! + dy);
      s.state = { ...s.state, dy, over };
      setDrag(s.state);
    };
    const finish = (commit: boolean) => {
      const s = g.current;
      if (s.timer !== null) cancelAnimationFrame(s.timer);
      s.timer = null;
      const st = s.state;
      s.state = null;
      setDrag(null);
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', cancel);
      if (!commit || !st || st.over === st.from) return;
      const { items: now, onMove: done, nameOf: name } = latest.current;
      const item = now[st.from];
      done(moveItem(now, st.from, st.over));
      if (item !== undefined) setSaid(`${name(item)}を ${st.over + 1} 番目にしました`);
    };
    const move = (e: PointerEvent) => { g.current.y = e.clientY; follow(); };
    const up = (e: PointerEvent) => { g.current.y = e.clientY; follow(); finish(true); };
    const cancel = () => finish(false);
    // 端に寄せている間は一覧を送り続ける（寄せた深さで速くする）
    const step = () => {
      const s = g.current;
      if (!s.state) return;
      const top = s.box ? s.box.getBoundingClientRect().top : 0;
      const bottom = s.box ? s.box.getBoundingClientRect().bottom : window.innerHeight;
      const d = s.y < top + EDGE ? -Math.ceil((top + EDGE - s.y) / 4) : s.y > bottom - EDGE ? Math.ceil((s.y - bottom + EDGE) / 4) : 0;
      if (d) {
        if (s.box) s.box.scrollTop += d; else window.scrollBy(0, d);
        follow();
      }
      s.timer = requestAnimationFrame(step);
    };
    const begin = (clientY: number, key: string, from: number) => {
      let box: HTMLElement | null = list.current?.parentElement ?? null;
      while (box && !(box.scrollHeight > box.clientHeight && /(auto|scroll)/.test(getComputedStyle(box).overflowY))) box = box.parentElement;
      const scroll0 = scrollTopOf(box);
      const mids = latest.current.items.map((x) => {
        const r = rows.current.get(keyOfRef.current(x))?.getBoundingClientRect();
        return r ? r.top + r.height / 2 : 0;
      });
      const gap = list.current ? parseFloat(getComputedStyle(list.current).rowGap) || 0 : 0;
      const height = (rows.current.get(key)?.getBoundingClientRect().height ?? 0) + gap;
      const state: DragState = { key, from, over: from, dy: 0, height };
      g.current = { box, startY: clientY, startScroll: scroll0, mids, y: clientY, state, timer: null };
      setDrag(state);
      window.addEventListener('pointermove', move);
      window.addEventListener('pointerup', up);
      window.addEventListener('pointercancel', cancel);
      g.current.timer = requestAnimationFrame(step);
    };
    return { begin, finish };
  });
  const keyOfRef = useRef(keyOf);
  keyOfRef.current = keyOf;
  // 一覧が消えたら（画面を離れたら）つかむのをやめる
  useEffect(() => () => { if (g.current.state) handlers.finish(false); }, [handlers]);

  /** ほかの行がよける量。 */
  const shiftOf = (i: number): number => {
    if (!drag) return 0;
    if (drag.from < drag.over && i > drag.from && i <= drag.over) return -drag.height;
    if (drag.over < drag.from && i >= drag.over && i < drag.from) return drag.height;
    return 0;
  };

  return (
    <>
      <ul ref={list} className={`sortable${className ? ` ${className}` : ''}${drag ? ' sorting' : ''}`}>
        {items.map((x, index) => {
          const key = keyOf(x);
          const dragging = drag?.key === key;
          return (
            <li key={key} ref={(el) => { if (el) rows.current.set(key, el); else rows.current.delete(key); }} className={dragging ? 'dragging' : undefined}
              style={drag ? { transform: `translateY(${dragging ? drag.dy : shiftOf(index)}px)` } : undefined}>
              <button type="button" className="sortable-handle" aria-label={`${nameOf(x)}を動かす（↑・↓ キー）`}
                onPointerDown={(e) => {
                  if (e.button !== 0) return;
                  e.preventDefault();
                  handlers.begin(e.clientY, key, index);
                }}
                onKeyDown={(e) => {
                  const to = e.key === 'ArrowUp' ? index - 1 : e.key === 'ArrowDown' ? index + 1 : null;
                  if (to === null) return;
                  e.preventDefault();
                  if (to < 0 || to >= items.length) return;
                  onMove(moveItem(items, index, to));
                  setSaid(`${nameOf(x)}を ${to + 1} 番目にしました`);
                  // 動かしたあとも同じつまみを選んだままにする
                  requestAnimationFrame(() => rows.current.get(key)?.querySelector<HTMLButtonElement>('.sortable-handle')?.focus());
                }}>
                <span aria-hidden="true">⠿</span>
              </button>
              <div className="sortable-body">{render(x)}</div>
            </li>
          );
        })}
      </ul>
      <p className="sr-only" aria-live="polite">{said}</p>
    </>
  );
}
