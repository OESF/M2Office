/**
 * @file 押したボタンの回る印（仕様書 第6.8節 原則 u13）の単体テスト。ブラウザの代わりに、最小の見本の部品で動かす。
 *
 * 押した直後に始まった `/v1` の呼び出しを、そのボタンに結び、答えを 0.3 秒より長く待つときだけ `aria-busy` を付けること、
 * 終われば外すこと、数秒ごとの読み直しと、押していない呼び出しには付けないことを確かめる。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

/** 見本の要素（ボタン）。 */
class FakeElement {
  attrs = new Map<string, string>();
  isConnected = true;
  closest() { return this; }
  setAttribute(k: string, v: string) { this.attrs.set(k, v); }
  removeAttribute(k: string) { this.attrs.delete(k); }
  hasAttribute(k: string) { return this.attrs.has(k); }
}

const listeners: Record<string, ((e: { target: unknown }) => void)[]> = {};
const g = globalThis as unknown as Record<string, unknown>;
g['Element'] = FakeElement;
g['document'] = { addEventListener: (type: string, fn: (e: { target: unknown }) => void) => { (listeners[type] ??= []).push(fn); } };
g['location'] = { href: 'https://a.example/', origin: 'https://a.example' };
/** 呼び出しの答えを、テストの側で返す。 */
const answers: (() => void)[] = [];
g['window'] = {
  setTimeout: (fn: () => void, ms: number) => setTimeout(fn, ms) as unknown as number,
  clearTimeout: (id: number) => clearTimeout(id as unknown as NodeJS.Timeout),
  fetch: () => new Promise<Response>((resolve) => { answers.push(() => resolve(new Response('{}'))); }),
};

const press = (el: FakeElement) => { for (const fn of listeners['click'] ?? []) fn({ target: el }); };
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

test('押したボタンが答えを 0.3 秒より長く待つと回る印を出し、終われば外す。読み直しと、押していない呼び出しには付けない', async () => {
  const { installPressTracker } = await import('../src/pressed.js');
  installPressTracker();
  const fetch = (g['window'] as { fetch: typeof globalThis.fetch }).fetch;

  const button = new FakeElement();
  press(button);
  const call = fetch('/v1/columns/c1/submit', { method: 'POST' });
  await wait(100);
  assert.equal(button.hasAttribute('aria-busy'), false, 'すぐ終わる呼び出しでちらつかせない');
  await wait(300);
  assert.equal(button.attrs.get('aria-busy'), 'true', '0.3 秒を過ぎたら回る印');
  answers.shift()!();
  await call;
  await wait(0);
  assert.equal(button.hasAttribute('aria-busy'), false, '答えが来たら外す');

  // 数秒ごとの読み直しは、押した直後でも付けない
  const other = new FakeElement();
  press(other);
  const polled = fetch('/v1/notifications');
  await wait(400);
  assert.equal(other.hasAttribute('aria-busy'), false, '読み直しには付けない');
  answers.shift()!();
  await polled;

  // 押してから時間が経った呼び出しは、ボタンに結ばない
  await wait(1600);
  const late = fetch('/v1/me');
  await wait(400);
  assert.equal(other.hasAttribute('aria-busy'), false, '押していない呼び出しには付けない');
  answers.shift()!();
  await late;

  // ほかのサイトへの呼び出しは結ばない
  const third = new FakeElement();
  press(third);
  const outside = fetch('https://other.example/v1/x');
  await wait(400);
  assert.equal(third.hasAttribute('aria-busy'), false, '同じ場所のサーバーへの呼び出しだけ');
  answers.shift()!();
  await outside;
});
