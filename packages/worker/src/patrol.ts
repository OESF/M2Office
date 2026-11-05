/**
 * @file ワーカーの見回りの繰り返し。1 回ごとに例外を受け止め、データベースの切断があっても繰り返しを抜けない。
 *
 * 見回りの中で受け止めを書き忘れた所があると、例外が繰り返しの外へ抜けて、ワーカーは何もせずに終わってしまう
 * （2026-11-05 に開発の機械で、切断の間に会社の一覧の読み取りから抜け、終了コード 0 で終わったまま戻らなかった）。
 * 1 回分を {@link patrolLoop} に渡して回すことで、どこで投げられても次の回へ進むようにする。
 *
 * @see 仕様書 第8.6.7.1節「止まらないように」
 */

import { isTransientDbError, type Logger } from '@m2office/core';

/** {@link patrolLoop} に渡すもの。 */
export interface PatrolLoopOptions {
  /** 続けてよいか。止める合図（SIGINT・SIGTERM）を受けたら `false` を返す。 */
  running: () => boolean;
  /** 見回りの 1 回分。中で投げられた例外は、ここで受け止める。 */
  once: () => Promise<void>;
  /** 待つ（テストでは時計を進めずに返す）。 */
  sleep: (ms: number) => Promise<void>;
  /** 例外の記録の書き先。 */
  log: Logger;
  /** データベースが切れたとき、次の回まで待つ時間の始まり（ミリ秒）。続けて切れるたびに倍にする。 */
  retryMs?: number;
  /** 待つ時間の上限（ミリ秒）。 */
  retryMaxMs?: number;
}

/** 切れたときに次の回まで待つ時間の既定（1 秒から倍にして 30 秒まで）。 */
export const PATROL_RETRY_MS = 1_000;
/** 待つ時間の上限の既定。 */
export const PATROL_RETRY_MAX_MS = 30_000;

/**
 * 止める合図があるまで、見回りの 1 回分を繰り返す。
 *
 * @param opts 続けてよいか・1 回分・待ち方・ロガー・待つ時間
 * @returns 止める合図を受けて繰り返しを終えたとき
 *
 * @remarks
 * - データベースが一時的に止まった例外（{@link isTransientDbError}）は警告にして、少し待ってから次の回へ進む。
 *   切れている間に見回りを詰めて回し、記録を埋めないよう、続けて切れるたびに待つ時間を倍にする（上限あり）
 * - それ以外の例外も記録して、同じく待ってから次の回へ進む。1 つの見回りの不具合で、ほかの業務（待ち行列・定時実行）まで
 *   止めないため。同じ例外が続いても記録が詰まって流れないよう、待つ時間は同じく倍にしていく
 * - 1 回が例外なく終われば、待つ時間は始まりに戻す
 *
 * @example
 * ```ts
 * await patrolLoop({ running: () => running, once: patrolOnce, sleep, log });
 * ```
 */
export async function patrolLoop(opts: PatrolLoopOptions): Promise<void> {
  const first = opts.retryMs ?? PATROL_RETRY_MS;
  const max = opts.retryMaxMs ?? PATROL_RETRY_MAX_MS;
  let wait = first;
  while (opts.running()) {
    try {
      await opts.once();
      wait = first;
    } catch (err) {
      if (isTransientDbError(err)) opts.log.warn('データベースが一時的に止まりました。少し待って見回りを続けます', { waitMs: wait, err });
      else opts.log.error('見回りの途中で例外が発生しました。少し待って次の回から続けます', { waitMs: wait, err });
      await opts.sleep(wait);
      wait = Math.min(wait * 2, max);
    }
  }
}
