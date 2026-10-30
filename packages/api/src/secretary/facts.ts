/**
 * @file 秘書が先に話しかけるときの材料（仕様書 第6.1.4節 音声の第一声、第6.1.5節 最初の画面）を集める。
 *
 * 音声の中継と最初の画面の API の双方から使う。**取れたものだけを渡す。** 取れなかったものは渡さず、詫びさせない。
 * 渡すのは材料であり、読み上げる原稿ではない。予定とお知らせの題名は外から来た文字を含みうるので、受け取る側は指示として扱わない（不変則 I-6）。
 */

import { canDecide } from '@m2office/shared';
import type { Logger } from '@m2office/core';
import type { AppDeps } from '../context.js';

/** 最初の画面に添える未読のお知らせの数の上限。 */
const UNREAD_MAX = 3;
/** 未読のお知らせを見る長さ（ミリ秒）。 */
const UNREAD_WINDOW_MS = 24 * 3_600_000;

/**
 * 音声を始めたときの第一声の材料を集める（このあとの予定と、本人が判断できる承認待ち）。
 *
 * @remarks 失敗しても会話は始める。挨拶のために対話そのものを止めない
 */
export async function greetingFacts(
  deps: AppDeps, tenantId: string, userId: string, log: Logger,
): Promise<string[]> {
  const facts: string[] = [];
  const day = new Date();
  const from = new Date(day.getFullYear(), day.getMonth(), day.getDate()).toISOString();
  const to = new Date(day.getFullYear(), day.getMonth(), day.getDate() + 1).toISOString();
  try {
    const events = await deps.connector.calendar.list({ tenantId, userId }, { from, to });
    const ahead = events.filter((e) => Date.parse(e.start) > Date.now());
    if (ahead.length > 0) {
      const next = ahead[0]!;
      const at = new Date(next.start).toLocaleTimeString('ja-JP', {
        hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Tokyo',
      });
      facts.push(`このあとの予定は ${ahead.length} 件。次は ${at} から「${next.title}」`);
    } else if (events.length > 0) {
      facts.push('今日の予定はすべて終わっている');
    }
  } catch (err) {
    // 取れなければ触れない。「取得できませんでした」と言わせない
    log.warn('第一声の予定を取れませんでした', { err });
  }
  try {
    const mine = (await deps.repo.listPendingApprovals(tenantId))
      .filter((a) => canDecide(a, { id: userId, roles: [] }));
    if (mine.length > 0) facts.push(`あなたが判断できる承認待ちが ${mine.length} 件`);
  } catch (err) {
    log.warn('第一声の承認待ちを取れませんでした', { err });
  }
  return facts;
}

/**
 * 最初の画面の材料を集める（第一声の材料に、この 24 時間の未読のお知らせの題名を足す）。
 */
export async function homeFacts(
  deps: AppDeps, tenantId: string, userId: string, log: Logger, now: number = Date.now(),
): Promise<string[]> {
  const facts = await greetingFacts(deps, tenantId, userId, log);
  try {
    const unread = (await deps.repo.listNotifications(tenantId, userId, 20))
      .filter((n) => !n.readAt && now - Date.parse(n.createdAt) < UNREAD_WINDOW_MS)
      .slice(0, UNREAD_MAX);
    for (const n of unread) facts.push(`まだ見ていないお知らせ「${n.title}」`);
  } catch (err) {
    log.warn('最初の画面のお知らせを取れませんでした', { err });
  }
  return facts;
}
