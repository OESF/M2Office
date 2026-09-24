/**
 * @file 保存のボタンと、その結果。**結果は押したボタンのすぐ横に出す**（仕様書 第6.10.4.2節）。
 *
 * 画面の隅に出すと、目線がボタンから離れて気づけない。押した場所で返す。
 */

import { useEffect, useRef, useState } from 'react';
import { describeError } from './api.js';

/** うまくいった知らせを消すまでの時間（ミリ秒）。 */
const OK_MS = 4000;

/**
 * 保存のボタン。押すと `run` を呼び、結果をボタンの横に出す。
 *
 * @param run 保存の処理。投げた例外は画面の言葉に直して出す
 * @param label ボタンの文字。既定は「保存」
 * @param done うまくいったときに出す文。保存の結果から作ることもできる。既定は「保存しました」
 * @param disabled 押せない理由があるとき
 *
 * @remarks
 * **うまくいった知らせは数秒で消える。失敗の知らせは消えない**（読んで直してもらう必要がある）。
 * 押している間はボタンを止め、二重に保存させない。
 */
export function SaveButton<R>({ run, label = '保存', done = '保存しました', disabled = false }: {
  run: () => Promise<R>;
  label?: string;
  done?: string | ((result: R) => string);
  disabled?: boolean;
}) {
  const [busy, setBusy] = useState(false);
  const [ok, setOk] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);

  async function press() {
    setBusy(true);
    setOk(null);
    setError(null);
    try {
      const result = await run();
      setOk(typeof done === 'function' ? done(result) : done);
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => setOk(null), OK_MS);
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
        {ok && <span className="saved">{ok}</span>}
        {error && <span className="error-inline">{error}</span>}
      </span>
    </span>
  );
}
