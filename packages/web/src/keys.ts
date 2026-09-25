/**
 * @file キーボードの割り当て（仕様書 第6.11節、ADR-0021）。
 *
 * **割り当ての表はここ 1 か所に置く。** 画面の表示も、ショートカットの一覧も、ここから作る。
 * コードの中に散らすと、一覧と実際がずれる。
 *
 * ライブラリを入れていない理由は ADR-0021 に書いた。乗り換える条件もそこにある。
 */

import { useEffect } from 'react';

/** 何のためのショートカットか（一覧の並び順にもなる）。 */
export type KeyGroup = '秘書' | '画面' | '業務';

/** 1 つの割り当て。 */
export interface KeyBinding {
  /** 押すキー。`Mod` は Mac で Command、それ以外で Control（第6.11.2節）。 */
  combo: string;
  /** 何をするか。一覧にそのまま出す。 */
  what: string;
  group: KeyGroup;
}

/**
 * 割り当ての表（仕様書 第6.11.3節）。
 *
 * @remarks
 * `Mod+1`〜`9` は**ブラウザのタブの切り替え**であるため使わない。業務は `Mod+Shift+1`〜`9` とする。
 */
export const KEY_BINDINGS: KeyBinding[] = [
  { combo: 'Mod+J', what: '秘書の入力欄へ移る', group: '秘書' },
  { combo: 'Mod+Enter', what: 'いまの画面の主な操作を行う（実行する・送る）', group: '秘書' },
  { combo: 'Mod+Shift+1', what: 'メニューの 1〜9 番目の業務を開く', group: '業務' },
  { combo: 'Mod+B', what: 'メニューを広げる・狭くする', group: '画面' },
  { combo: 'Mod+I', what: '秘書のキャンバスを開く・閉じる', group: '画面' },
  { combo: 'Mod+,', what: '個人設定を開く', group: '画面' },
  { combo: 'Mod+/', what: 'このショートカットの一覧を出す', group: '画面' },
  { combo: 'Escape', what: '開いているものを閉じる', group: '画面' },
];

/**
 * この端末が Apple のものか（`Mod` が Command になるか）。
 *
 * @remarks
 * `navigator.platform` は古い仕組みだが、どのブラウザでも読める。
 * iPad はデスクトップ版として `MacIntel` を名乗るため、触れる点の数も見る。
 */
function isApple(): boolean {
  if (typeof navigator === 'undefined') return false;
  const p = `${navigator.platform ?? ''} ${navigator.userAgent ?? ''}`;
  return /Mac|iPhone|iPad|iPod/.test(p);
}

/**
 * 外付けのキーボードが無さそうな端末か（仕様書 第6.9節・第6.11.2節）。
 *
 * @remarks
 * **確かめる方法は無い。** 触れる画面で、かつ細かい指し示しができない端末を、そうとみなす。
 * 外れたときに困るのは「使えるのに表示されない」ことだけなので、外す側に倒す。
 */
export function isTouchOnly(): boolean {
  if (typeof window === 'undefined' || !window.matchMedia) return false;
  return window.matchMedia('(hover: none) and (pointer: coarse)').matches;
}

/**
 * 画面に出す文字列（`⌘J` / `Ctrl+J`）。
 *
 * @param combo 割り当ての文字列
 * @returns 触る端末では空文字（出さない）
 */
export function keyLabel(combo: string): string {
  if (isTouchOnly()) return '';
  const apple = isApple();
  const parts = combo.split('+').map((k) => {
    if (k === 'Mod') return apple ? '⌘' : 'Ctrl';
    if (k === 'Shift') return apple ? '⇧' : 'Shift';
    if (k === 'Alt') return apple ? '⌥' : 'Alt';
    if (k === 'Enter') return apple ? '⏎' : 'Enter';
    if (k === 'Escape') return 'Esc';
    return k;
  });
  return apple ? parts.join('') : parts.join('+');
}

/** 押されたキーを、割り当ての文字列と同じ形にする。 */
function comboOf(e: KeyboardEvent): string {
  const parts: string[] = [];
  if (isApple() ? e.metaKey : e.ctrlKey) parts.push('Mod');
  if (e.shiftKey) parts.push('Shift');
  if (e.altKey) parts.push('Alt');
  const key = e.key.length === 1 ? e.key.toUpperCase() : e.key;
  parts.push(key);
  return parts.join('+');
}

/** いま文字を打っている最中か（入力欄・複数行・編集できる場所）。 */
function typing(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  if (!el || !el.tagName) return false;
  if (el.isContentEditable) return true;
  return ['INPUT', 'TEXTAREA', 'SELECT'].includes(el.tagName);
}

/**
 * ショートカットを 1 つ登録する（仕様書 第6.11節）。
 *
 * @param combo `KEY_BINDINGS` にある割り当ての文字列
 * @param run 押されたときに行うこと
 * @param enabled `false` のあいだは効かせない
 *
 * @remarks
 * **文字を打っている最中は、`Mod` を伴う組み合わせと `Esc` だけを効かせる**（第6.11.2節）。
 * 単独のキーを効かせると、文章の中に書けない文字ができてしまう。
 */
export function useHotkey(combo: string, run: () => void, enabled = true): void {
  useEffect(() => {
    if (!enabled) return undefined;
    const onKey = (e: KeyboardEvent) => {
      if (comboOf(e) !== combo) return;
      const bare = !combo.startsWith('Mod') && combo !== 'Escape';
      if (bare && typing(e.target)) return;
      e.preventDefault();
      run();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [combo, run, enabled]);
}

/**
 * `Mod+Shift+1`〜`9` を 1 つにまとめて登録する（メニューの n 番目の業務）。
 *
 * @param run 押された番号（1〜9）を受け取る
 */
export function useNumberHotkeys(run: (n: number) => void, enabled = true): void {
  useEffect(() => {
    if (!enabled) return undefined;
    const onKey = (e: KeyboardEvent) => {
      const mod = isApple() ? e.metaKey : e.ctrlKey;
      if (!mod || !e.shiftKey || e.altKey) return;
      // Shift を押すと e.key は記号になりうる。位置で見る（Digit1〜Digit9）
      const m = /^Digit([1-9])$/.exec(e.code);
      if (!m) return;
      e.preventDefault();
      run(Number(m[1]));
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [run, enabled]);
}
