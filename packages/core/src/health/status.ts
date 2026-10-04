/**
 * @file 接続先の状態の決め方（仕様書 第6.7.6節）。集計から「正常」「遅延」「失敗」「未接続」と、添える数を決める。
 */

import type { HealthSummary } from './store.js';

/** 接続先の状態。 */
export type HealthState = 'ok' | 'slow' | 'fail' | 'off';

/** 見る範囲（分）。 */
export const HEALTH_WINDOW_MIN = 15;
/** 動いている表示にする範囲（分）。 */
export const HEALTH_ACTIVE_MIN = 2;

/** 遅いとみなす平均の時間（ミリ秒）。接続の種類ごと。 */
export const HEALTH_SLOW_MS: Record<'ai' | 'google' | 'mcp', number> = { ai: 20_000, google: 3_000, mcp: 5_000 };

/** 失敗の種類の業務の言葉（原則 u1。技術的な誤りの文は出さない）。 */
export const HEALTH_ERROR_LABELS: Record<string, string> = {
  busy: '混雑', unreachable: '届かない', timeout: '時間切れ', server: '相手の障害',
  setup: '設定が必要', auth: '認証の誤り', 'not-found': '見つからない', error: 'うまくいかない',
};

/** 画面に出す 1 つの接続先の状態。 */
export interface HealthView {
  state: HealthState;
  /** 直近 2 分に呼び出しがあったか（動いている表示）。 */
  active: boolean;
  calls: number;
  fails: number;
  /** 平均の時間（ミリ秒）。呼び出しが無ければ `null`。 */
  avgMs: number | null;
  /** 最後の失敗の種類の言葉。失敗が無ければ `null`。 */
  lastError: string | null;
}

/**
 * 集計から状態を決める。
 *
 * @param s 見る範囲の集計。呼び出しが無ければ `undefined`
 * @param kind 接続の種類（遅いとみなす時間が違う）
 * @param connected 会社がつないでいるか。つないでいなければ「未接続」
 * @remarks 失敗: 失敗が半分以上か、呼び出しのあった最後の 1 分がすべて失敗。遅延: 平均が目安を超える。呼び出しが無ければ正常
 */
export function healthView(s: HealthSummary | undefined, kind: keyof typeof HEALTH_SLOW_MS, connected: boolean, now: Date): HealthView {
  const calls = s ? s.ok + s.fail : 0;
  const fails = s?.fail ?? 0;
  const avgMs = s && calls > 0 ? Math.round(s.totalMs / calls) : null;
  const active = !!s && now.getTime() - Date.parse(s.lastMinute) < (HEALTH_ACTIVE_MIN + 1) * 60_000 - 1;
  const lastError = s?.lastError ? (HEALTH_ERROR_LABELS[s.lastError] ?? HEALTH_ERROR_LABELS['error']!) : null;
  if (!connected) return { state: 'off', active: false, calls, fails, avgMs, lastError };
  let state: HealthState = 'ok';
  if (s && calls > 0 && (fails * 2 >= calls || (s.lastFail > 0 && s.lastOk === 0))) state = 'fail';
  else if (avgMs !== null && avgMs > HEALTH_SLOW_MS[kind]) state = 'slow';
  return { state, active, calls, fails, avgMs, lastError };
}
