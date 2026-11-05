/**
 * @file 文字の大きさ（小さい・標準・大きい）の反映と、「小さく」「大きく」での変更（仕様書 第6.1節、ADR-0122）。
 *
 * 段はその人の設定としてサーバーに覚える（どの端末でも同じ）。読み込みの途中で大きさが変わらないよう、
 * 最後に使った段を端末にも写しておき、`index.html` が描画の前に当てる。
 * 標準のときは `<html>` に属性を付けず、小さい・大きいのときだけ `data-text-size` を付ける（倍率は `styles.css`）。
 */

import { useEffect, useState } from 'react';
import { stepTextSize, type TextSize } from '@m2office/shared';
import { api } from './api.js';

const KEY = 'm2office.textSize';
const EVENT = 'm2office:text-size';

/** いま画面に当てている段。属性が無ければ標準。 */
export function currentTextSize(): TextSize {
  const v = document.documentElement.getAttribute('data-text-size');
  return v === 'small' || v === 'large' ? v : 'normal';
}

/**
 * 段を画面に当て、端末にも写す。ログインしたあとと、秘書が変えたときに呼ぶ。
 *
 * @param size 当てる段
 */
export function applyTextSize(size: TextSize): void {
  const root = document.documentElement;
  if (size === 'normal') root.removeAttribute('data-text-size');
  else root.setAttribute('data-text-size', size);
  try {
    if (size === 'normal') localStorage.removeItem(KEY);
    else localStorage.setItem(KEY, size);
  } catch {
    // 写せなくても、いまの画面には当てる
  }
  window.dispatchEvent(new CustomEvent(EVENT));
}

/**
 * ログインの前の画面では標準に戻す（仕様書 第6.1節「ログインの前の画面」）。端末に写した段は消さない
 * （同じ人がまた入ったときに、読み込みの途中で大きさが変わらないように）。
 */
export function resetTextSizeForLogin(): void {
  document.documentElement.removeAttribute('data-text-size');
}

/**
 * 個人設定の「小さく」「大きく」で使う。押したらすぐ当て、サーバーに覚える。
 *
 * @returns いまの段・1 段動かす関数・覚えられなかったときの知らせ
 */
export function useTextSize(): { size: TextSize; step: (dir: 1 | -1) => void; error: string | null } {
  const [size, setSize] = useState<TextSize>(currentTextSize());
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    const onChange = () => setSize(currentTextSize());
    window.addEventListener(EVENT, onChange);
    return () => window.removeEventListener(EVENT, onChange);
  }, []);
  const step = (dir: 1 | -1) => {
    const before = currentTextSize();
    const next = stepTextSize(before, dir);
    if (next === before) return;
    applyTextSize(next);
    setError(null);
    api.saveMySettings('display', { textSize: next }).catch(() => {
      // 覚えられなければ元に戻す（次に入ったときに大きさが変わって驚かせない）
      applyTextSize(before);
      setError('文字の大きさを保存できませんでした');
    });
  };
  return { size, step, error };
}
