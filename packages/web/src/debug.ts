/**
 * @file デバッグモードの画面の側の記録（仕様書 第20.4.1節「デバッグモード」）。画面から呼んだ API の直近 100 件を、この画面のメモリーにだけ持つ。
 *
 * サーバーが `M2O_DEBUG=true` で動いているときだけ記録する（`/v1/me` の `debug`）。保存も送信もしない。
 */

/** 画面から呼んだ API の 1 件。 */
export interface ClientCall {
  id: number;
  at: string;
  method: string;
  path: string;
  /** 応答の番号。通信そのものが失敗したら 0。 */
  status: number;
  ms: number;
  /** 送った本文の先頭（JSON のとき）。 */
  request?: string;
  /** 応答の本文の先頭。 */
  response?: string;
}

/** 持つ件数。 */
export const CLIENT_CALLS_MAX = 100;
/** 本文を持つ長さ（字）。 */
const BODY_MAX = 4000;

let on = false;
let seq = 0;
const calls: ClientCall[] = [];
const listeners = new Set<() => void>();

/** デバッグモードを入れる（`/v1/me` の `debug` が真のとき）。 */
export function setDebugMode(v: boolean): void {
  on = v;
}

/** デバッグモードか。 */
export function debugMode(): boolean {
  return on;
}

/** 1 件記録する（デバッグモードでなければ何もしない）。 */
export function recordCall(call: Omit<ClientCall, 'id' | 'at'>): void {
  if (!on) return;
  const clip = (s?: string) => (s && s.length > BODY_MAX ? `${s.slice(0, BODY_MAX)}…（以下略）` : s);
  calls.push({ ...call, request: clip(call.request), response: clip(call.response), id: ++seq, at: new Date().toISOString() });
  if (calls.length > CLIENT_CALLS_MAX) calls.splice(0, calls.length - CLIENT_CALLS_MAX);
  for (const f of listeners) f();
}

/** 記録（新しい順）。 */
export function clientCalls(): ClientCall[] {
  return [...calls].reverse();
}

/** 記録を消す。 */
export function clearClientCalls(): void {
  calls.length = 0;
  for (const f of listeners) f();
}

/** 記録が増えたら呼ぶ。戻り値で解除する。 */
export function onClientCalls(f: () => void): () => void {
  listeners.add(f);
  return () => { listeners.delete(f); };
}

/** 左のメニューなどから、デバッグの記録を開くための合図の名前。 */
export const OPEN_DEBUG_EVENT = 'm2office:open-debug';

/** デバッグの記録を開く。 */
export function openDebugPanel(): void {
  window.dispatchEvent(new Event(OPEN_DEBUG_EVENT));
}
