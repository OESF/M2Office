/**
 * @file 押したボタンが、サーバーの答えを待つ間に回る印を出す（仕様書 第6.8節 原則 u13。第 0.599.0 版）。
 *
 * 画面ごとに「処理中」の表示を作ると、付け忘れる（ボタンを押せなくするだけの画面が多かった）。
 * そこで、サーバーを呼ぶ共通の入口（ブラウザの `fetch`）で、直前に押したボタンに印を付ける。
 * ボタンを押した直後に始まった `/v1` の呼び出しを、そのボタンに結び、答えを 0.3 秒より長く待つときだけ `aria-busy` を付ける。
 * 見た目は `styles.css` の `[aria-busy="true"]`（ボタンの文字の前に回る印）。画面の部品に手を入れずに、どの画面にも効く。
 */

/** 押してから、呼び出しをそのボタンに結ぶまでの時間（ミリ秒）。押した処理の中で、先に別の処理を待つことがあるため少し長めにする。 */
const PRESS_WINDOW_MS = 1500;
/** 回る印を出すまでの時間（ミリ秒）。すぐ終わる呼び出しでちらつかせない。 */
const SHOW_AFTER_MS = 300;
/** 数秒ごとの読み直しの口（人が押したものではないので印を付けない。`api.ts` の読み直しと同じ）。 */
const POLLED = /^\/v1\/(notifications|approvals|jobs|agents|secretary\/lookups|mail\/count)(\?|$)|^\/v1\/secretary\/lookups\/claim$/;

/** 直前に押したボタンと時刻。 */
let last: { el: HTMLElement; at: number } | null = null;
/** ボタンごとの、待っている呼び出しの数と、印を出す予約。 */
const pending = new WeakMap<HTMLElement, { count: number; timer: number | null }>();

/** 印を外す。 */
function clear(el: HTMLElement, state: { count: number; timer: number | null }): void {
  if (state.timer !== null) window.clearTimeout(state.timer);
  pending.delete(el);
  el.removeAttribute('aria-busy');
}

/**
 * 呼び出しを、直前に押したボタンに結ぶ。答えを待つ間、そのボタンに回る印を出す。
 *
 * @param quiet 数秒ごとの読み直しなど、人が押したのではない呼び出し（結ばない）
 * @returns 渡した呼び出しそのもの（結果も失敗もそのまま返す）
 */
export function trackPress<T>(call: Promise<T>, quiet = false): Promise<T> {
  const el = !quiet && last && performance.now() - last.at <= PRESS_WINDOW_MS && last.el.isConnected ? last.el : null;
  if (!el) return call;
  const state = pending.get(el) ?? { count: 0, timer: null };
  state.count += 1;
  if (state.timer === null && !el.hasAttribute('aria-busy')) {
    state.timer = window.setTimeout(() => { state.timer = null; if (el.isConnected) el.setAttribute('aria-busy', 'true'); }, SHOW_AFTER_MS);
  }
  pending.set(el, state);
  const done = () => {
    state.count -= 1;
    if (state.count <= 0) clear(el, state);
  };
  call.then(done, done);
  return call;
}

/** 呼び出しの道（`/v1/...`）。同じ場所のサーバーへの呼び出しでなければ `null`。 */
function pathOf(input: RequestInfo | URL): string | null {
  const raw = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  try {
    const u = new URL(raw, location.href);
    return u.origin === location.origin && u.pathname.startsWith('/v1/') ? `${u.pathname}${u.search}` : null;
  } catch {
    return null;
  }
}

/**
 * 押したボタンを覚え、サーバーの呼び出しを結ぶ口を付ける（画面の始めに 1 回呼ぶ）。
 *
 * @remarks
 * 押す処理より先に動くよう、捕まえる段（capture）で聞く。Enter で送るフォームのボタンも同じに扱う。
 * `fetch` は、同じ場所のサーバー（`/v1`）への呼び出しだけを結ぶ。呼び出しそのものは変えない
 */
export function installPressTracker(): void {
  const remember = (target: EventTarget | null) => {
    const el = target instanceof Element ? target.closest<HTMLElement>('button, [role="button"], input[type="submit"]') : null;
    if (el) last = { el, at: performance.now() };
  };
  document.addEventListener('click', (e) => remember(e.target), true);
  document.addEventListener('submit', (e) => remember((e as SubmitEvent).submitter ?? null), true);
  const original = window.fetch.bind(window);
  window.fetch = (input: RequestInfo | URL, init?: RequestInit) => {
    const call = original(input, init);
    const path = pathOf(input);
    if (!path) return call;
    const method = (init?.method ?? (input instanceof Request ? input.method : 'GET')).toUpperCase();
    return trackPress(call, POLLED.test(path) && method === 'GET');
  };
}
