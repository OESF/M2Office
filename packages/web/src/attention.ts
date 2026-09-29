/**
 * @file 本人がこの画面を見て操作しているかを見分ける（仕様書 第10.11.7節「受け取る画面」、ADR-0047）。
 *
 * まだ伝えていない調べもの・朝のブリーフを受け取るのは、見えていて本人が操作している画面だけにする。
 * 開いたまま離れた画面・裏のタブが受け取ると、誰も見ないまま「伝えた」になる（2026-09-28 に朝のブリーフで起きた）。
 */

import { useEffect, useRef } from 'react';

/** 操作が無くなってから「見ていない」とみなすまで（ミリ秒）。 */
export const ATTENTION_IDLE_MS = 2 * 60 * 1000;

/** 最後に本人が操作した時刻。読み込んだときは操作したものとみなす（開いた直後の画面は本人が見ている）。 */
let lastActivity = Date.now();

/** 操作とみなす出来事。 */
const ACTIVITY_EVENTS = ['pointerdown', 'keydown', 'wheel', 'touchstart'] as const;

/**
 * いま本人がこの画面を見て操作しているか。
 *
 * @remarks 見えていて（前面のタブ）、窓に入力の焦点があり、{@link ATTENTION_IDLE_MS} 以内に操作があったとき
 */
export function isAttended(now: number = Date.now()): boolean {
  if (typeof document === 'undefined') return true;
  return document.visibilityState === 'visible' && document.hasFocus() && now - lastActivity <= ATTENTION_IDLE_MS;
}

/**
 * 操作を覚え、見ていなかった画面に本人が戻ってきたら `onReturn` を呼ぶ。
 *
 * @remarks 戻ってきた時点で、待っていたものを受け取れるようにするため（次の定期の読み直しを待たせない）
 */
export function useAttention(onReturn: () => void): void {
  const cb = useRef(onReturn);
  cb.current = onReturn;
  useEffect(() => {
    const touch = () => {
      const was = isAttended();
      lastActivity = Date.now();
      if (!was && isAttended()) cb.current();
    };
    const back = () => {
      if (document.visibilityState === 'visible') touch();
    };
    for (const e of ACTIVITY_EVENTS) window.addEventListener(e, touch, { passive: true });
    window.addEventListener('focus', touch);
    document.addEventListener('visibilitychange', back);
    return () => {
      for (const e of ACTIVITY_EVENTS) window.removeEventListener(e, touch);
      window.removeEventListener('focus', touch);
      document.removeEventListener('visibilitychange', back);
    };
  }, []);
}
