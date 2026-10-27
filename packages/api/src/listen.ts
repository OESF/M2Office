/**
 * @file API と運営の API の待ち受け先（仕様書 第20.4.6節「プロセスと待ち受け先」）。
 *
 * どの配備の形でも、既定は `127.0.0.1`（その機械の中だけ）にする。インターネットからの通信は Caddy が受け、中の API に渡す。
 * すべての口で待ち受けると、Caddy の守り（WAF・回数の制限・運営の画面の限り）を通らずに API へ届いてしまう（2026-10-23 に見つけた）。
 */

/**
 * 待ち受けるアドレス。`M2O_LISTEN_HOST` で変えられる（コンテナの中など、ほかの機械から受けるときだけ）。
 *
 * @param env 環境変数（テストで差し替える）
 */
export function listenHost(env: NodeJS.ProcessEnv = process.env): string {
  return env['M2O_LISTEN_HOST']?.trim() || '127.0.0.1';
}
