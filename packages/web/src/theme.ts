/**
 * @file 画面の明るさ（ライト・ダーク・端末に合わせる）の選択と反映。
 *
 * 選択は端末（ブラウザ）ごとに覚える。ダークは `<html data-theme="dark">`、ライトは `data-theme="light"`、
 * 端末に合わせるときは属性を付けず、CSS の `prefers-color-scheme` に任せる。
 *
 * @see 仕様書 第6.1.2節 画面の明るさ（ライト・ダーク）
 */

import { useEffect, useState } from 'react';

export type ThemeChoice = 'light' | 'dark' | 'system';

const KEY = 'm2office.theme';
const EVENT = 'm2office:theme';

/** 覚えている選択。読めなければ「端末に合わせる」。 */
export function getThemeChoice(): ThemeChoice {
  try {
    const v = localStorage.getItem(KEY);
    return v === 'light' || v === 'dark' ? v : 'system';
  } catch {
    return 'system';
  }
}

/** いま実際に使っている明るさ。 */
export function effectiveTheme(choice: ThemeChoice = getThemeChoice()): 'light' | 'dark' {
  if (choice !== 'system') return choice;
  return window.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

/** 選択を画面に反映する。起動の直後にも呼ぶ（読み込みの途中で明るさが変わらないように）。 */
export function applyTheme(choice: ThemeChoice = getThemeChoice()): void {
  const root = document.documentElement;
  if (choice === 'system') root.removeAttribute('data-theme');
  else root.setAttribute('data-theme', choice);
}

/** 選択を覚えて反映し、画面の各所に知らせる。 */
export function setThemeChoice(choice: ThemeChoice): void {
  try {
    if (choice === 'system') localStorage.removeItem(KEY);
    else localStorage.setItem(KEY, choice);
  } catch {
    // 保存できなくても、いまの画面には反映する
  }
  applyTheme(choice);
  window.dispatchEvent(new CustomEvent(EVENT));
}

/** 選択と、実際の明るさを読む。上部のボタンと個人設定で同じ値を見る。 */
export function useTheme(): { choice: ThemeChoice; effective: 'light' | 'dark'; set: (c: ThemeChoice) => void } {
  const [choice, setChoice] = useState<ThemeChoice>(getThemeChoice());
  const [, bump] = useState(0);
  useEffect(() => {
    const onChange = () => setChoice(getThemeChoice());
    const media = window.matchMedia?.('(prefers-color-scheme: dark)');
    const onMedia = () => bump((n) => n + 1);
    window.addEventListener(EVENT, onChange);
    media?.addEventListener?.('change', onMedia);
    return () => {
      window.removeEventListener(EVENT, onChange);
      media?.removeEventListener?.('change', onMedia);
    };
  }, []);
  return { choice, effective: effectiveTheme(choice), set: setThemeChoice };
}
