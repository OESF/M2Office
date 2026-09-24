/**
 * @file 保存などの結果を、押した場所の近くではなく**画面の決まった場所**に出す知らせ。
 *
 * 保存のボタンと、結果の文が離れていると、押した人は保存できたのか分からない。
 * 出す場所を 1 つに決め、どの画面でも同じところに出す（仕様書 第6.10.4.2節）。
 *
 * @see 仕様書 第6.10.4.2節 操作の結果を知らせる
 */

import { useEffect, useState } from 'react';

/** 知らせ 1 件。 */
interface Note {
  id: number;
  text: string;
  kind: 'ok' | 'error';
}

/** 知らせを出す合図の名前。 */
const EVENT = 'm2o:toast';

/** うまくいった知らせを消すまでの時間（ミリ秒）。 */
const OK_MS = 3500;

let seq = 0;

/**
 * 操作の結果を知らせる。
 *
 * @param text 知らせる文。**何が起きたかを言い切る**（「保存しました」）
 * @param kind `error` は自分では消えない。読んで、直してもらう必要があるため
 */
export function toast(text: string, kind: 'ok' | 'error' = 'ok'): void {
  seq += 1;
  window.dispatchEvent(new CustomEvent<Note>(EVENT, { detail: { id: seq, text, kind } }));
}

/**
 * 知らせの置き場。画面に 1 つだけ置く。
 *
 * @remarks
 * うまくいった知らせは数秒で消える。**失敗の知らせは消えない**（押すと消える）。
 */
export function Toaster() {
  const [notes, setNotes] = useState<Note[]>([]);
  useEffect(() => {
    const on = (e: Event) => {
      const note = (e as CustomEvent<Note>).detail;
      setNotes((xs) => [...xs, note]);
      if (note.kind === 'ok') {
        setTimeout(() => setNotes((xs) => xs.filter((x) => x.id !== note.id)), OK_MS);
      }
    };
    window.addEventListener(EVENT, on);
    return () => window.removeEventListener(EVENT, on);
  }, []);
  if (notes.length === 0) return null;
  return (
    <div className="toaster" role="status" aria-live="polite">
      {notes.map((n) => (
        <button
          key={n.id} className={`toast ${n.kind}`} title="押すと消えます"
          onClick={() => setNotes((xs) => xs.filter((x) => x.id !== n.id))}
        >
          {n.text}
        </button>
      ))}
    </div>
  );
}
