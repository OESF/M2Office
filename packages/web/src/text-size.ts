/**
 * @file 文字の大きさ（70% から 130% まで 10% ずつ）の反映と、「小さく」「大きく」「標準」での変更（仕様書 第6.1節、ADR-0122）。
 *
 * 段はその人の設定としてサーバーに覚える（どの端末でも同じ）。読み込みの途中で大きさが変わらないよう、
 * 最後に使った段を端末にも写しておき、`index.html` が描画の前に当てる。
 * 標準（100%）のときは `<html>` に属性を付けず、ほかの段のときだけ `data-text-size`（`90` など）を付ける（倍率は `styles.css`）。
 */

import { useEffect, useState } from 'react';
import { TEXT_SIZE_STANDARD, normalizeTextSize, stepTextSize, type TextSize } from '@m2office/shared';
import { api } from './api.js';

const KEY = 'm2office.textSize';
const EVENT = 'm2office:text-size';

/** いま画面に当てている段。属性が無ければ標準。 */
export function currentTextSize(): TextSize {
  return normalizeTextSize(document.documentElement.getAttribute('data-text-size')) ?? TEXT_SIZE_STANDARD;
}

/**
 * 段を画面に当て、端末にも写す。ログインしたあとと、秘書が変えたときに呼ぶ。
 *
 * @param size 当てる段
 */
export function applyTextSize(size: TextSize): void {
  const root = document.documentElement;
  if (size === TEXT_SIZE_STANDARD) root.removeAttribute('data-text-size');
  else root.setAttribute('data-text-size', String(size));
  try {
    if (size === TEXT_SIZE_STANDARD) localStorage.removeItem(KEY);
    else localStorage.setItem(KEY, String(size));
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
 * 個人設定の「小さく」「大きく」「標準」で使う。押したらすぐ当て、サーバーに覚える。
 *
 * @returns いまの段・1 段動かす関数・標準に戻す関数・覚えられなかったときの知らせ
 */
export function useTextSize(): { size: TextSize; step: (dir: 1 | -1) => void; reset: () => void; error: string | null } {
  const [size, setSize] = useState<TextSize>(currentTextSize());
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    const onChange = () => setSize(currentTextSize());
    window.addEventListener(EVENT, onChange);
    return () => window.removeEventListener(EVENT, onChange);
  }, []);
  const change = (next: TextSize) => {
    const before = currentTextSize();
    if (next === before) return;
    applyTextSize(next);
    setError(null);
    api.saveMySettings('display', { textSize: next }).catch(() => {
      // 覚えられなければ元に戻す（次に入ったときに大きさが変わって驚かせない）
      applyTextSize(before);
      setError('文字の大きさを保存できませんでした');
    });
  };
  return {
    size,
    step: (dir) => change(stepTextSize(currentTextSize(), dir)),
    reset: () => change(TEXT_SIZE_STANDARD),
    error,
  };
}
