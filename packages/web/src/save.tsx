/**
 * @file 保存のボタンと、その結果。**結果は押したボタンのすぐ横に出す**（仕様書 第6.10.4.2節）。
 *
 * 画面の隅に出すと、目線がボタンから離れて気づけない。押した場所で返す。
 */

import { useEffect, useRef, useState } from 'react';
import { describeError } from './api.js';

/** うまくいった知らせを消すまでの時間（ミリ秒）。 */
const OK_MS = 4000;

/** 保存のあとに出す知らせ。文だけなら成功、`warn` なら注意（保存はした）。 */
export type SaveDone = string | { text: string; warn?: boolean };

/**
 * 保存のボタン。押すと `run` を呼び、結果をボタンの横に出す。
 *
 * @param run 保存の処理。投げた例外は画面の言葉に直して出す
 * @param label ボタンの文字。既定は「保存」
 * @param done うまくいったときに出す文。保存の結果から作ることもできる。既定は「保存しました」。
 *   空の文を返すと何も出さない（確かめの画面で取りやめたときなど）。
 *   `{ text, warn: true }` を返すと、**保存はしたが注意が要る**知らせとして出す
 * @param disabled 押せない理由があるとき
 *
 * @remarks
 * **うまくいった知らせは数秒で消える。失敗と注意の知らせは消えない**（読んで直してもらう必要がある）。
 * 注意を成功の色で出さない。「確かめられなかった」を「確かめた」ように見せないためである（仕様書 第14.3.3節）。
 * 押している間はボタンを止め、二重に保存させない。
 */
export function SaveButton<R>({ run, label = '保存', done = '保存しました', disabled = false }: {
  run: () => Promise<R>;
  label?: string;
  done?: SaveDone | ((result: R) => SaveDone);
  disabled?: boolean;
}) {
  const [busy, setBusy] = useState(false);
  const [ok, setOk] = useState<{ text: string; warn: boolean } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);

  async function press() {
    setBusy(true);
    setOk(null);
    setError(null);
    try {
      const result = await run();
      const d = typeof done === 'function' ? done(result) : done;
      const next = typeof d === 'string' ? { text: d, warn: false } : { text: d.text, warn: !!d.warn };
      setOk(next.text ? next : null);
      if (timer.current) clearTimeout(timer.current);
      if (!next.warn) timer.current = setTimeout(() => setOk(null), OK_MS);
    } catch (e) {
      setError(describeError(e, '保存できませんでした'));
    } finally {
      setBusy(false);
    }
  }

  return (
    <span className="save-row">
      <button className="btn" disabled={busy || disabled} onClick={() => void press()}>
        {busy ? '保存しています…' : label}
      </button>
      {/* 読み上げにも届くようにする。画面を見ていない人にも結果が伝わる */}
      <span className="save-result" role="status" aria-live="polite">
        {ok && <span className={`saved${ok.warn ? ' warn' : ''}`}>{ok.text}</span>}
        {error && <span className="error-inline">{error}</span>}
      </span>
    </span>
  );
}
