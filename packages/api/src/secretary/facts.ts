/**
 * @file 秘書が先に話しかけるときの材料（仕様書 第6.1.4節 音声の第一声、第6.1.5節 最初の画面）を集める。
 *
 * 音声の中継と最初の画面の API の双方から使う。**取れたものだけを渡す。** 取れなかったものは渡さず、詫びさせない。
 * 渡すのは材料であり、読み上げる原稿ではない。予定とお知らせの題名は外から来た文字を含みうるので、受け取る側は指示として扱わない（不変則 I-6）。
 */

import { canDecide } from '@m2office/shared';
import type { Logger } from '@m2office/core';
import type { AppDeps } from '../context.js';

/** 最初の画面に題名を添える未読のお知らせの数の上限。 */
const UNREAD_TITLES = 3;
/** 未読のお知らせを数える件数の上限（超えたら「〇件以上」と伝える）。 */
const UNREAD_SCAN = 200;

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
 * 最初の画面の材料を集める（第一声の材料に、未読のお知らせのすべての数と、新しいものの題名を足す）。
 *
 * @remarks 数は題名を添えた分ではなく未読のすべてで伝える。題名だけを渡すと、AI が題名の数を未読の数として話してしまう
 */
export async function homeFacts(
  deps: AppDeps, tenantId: string, userId: string, log: Logger,
): Promise<string[]> {
  const facts = await greetingFacts(deps, tenantId, userId, log);
  try {
    const all = await deps.repo.listNotifications(tenantId, userId, UNREAD_SCAN);
    const unread = all.filter((n) => !n.readAt);
    if (unread.length > 0) {
      const count = all.length >= UNREAD_SCAN && unread.length === all.length ? `${UNREAD_SCAN} 件以上` : `${unread.length} 件`;
      const titles = unread.slice(0, UNREAD_TITLES).map((n) => `「${n.title}」`).join('');
      facts.push(`まだ見ていないお知らせが全部で ${count}。新しいものは ${titles}`);
    }
  } catch (err) {
    log.warn('最初の画面のお知らせを取れませんでした', { err });
  }
  return facts;
}
