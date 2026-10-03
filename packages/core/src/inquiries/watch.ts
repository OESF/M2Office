/**
 * @file 問い合わせの見張り（仕様書 第33.7節・第33.12節）。ワーカーが定期的に呼ぶ。
 *
 * - 次にやることの期限の前の日と、期限を過ぎたときに、担当に 1 回ずつ知らせる
 * - 次にやることが無く、3 営業日動いていない対応中の問い合わせを、残した人に一度だけ知らせる
 * - 会話の履歴の原文（秘書に話した文）を 90 日で消す（要約は残す）
 * - 毎月 1 日の朝に、前の月の振り返り（数はプログラムで数える）を、利用範囲の管理者と窓口の担当に知らせる（第33.9節・第33.18節）
 *
 * 知らせの題と本文に用件の中身は入れない（誰からの、何をする、だけ）。本人が「問い合わせ」の知らせを切っていれば送らない。
 */

import { randomUUID } from 'node:crypto';
import { INQUIRIES_EXTENSION_ID, canUseAgent } from '@m2office/shared';
import type { Repository } from '../repository/types.js';
import { silentLogger, type Logger } from '../log/logger.js';
import { dateIn } from '../cards/service.js';
import type { InquiryStore } from './store.js';
import { MAILBOX_ACTOR } from './service.js';
import { monthStats, previousMonth, reviewText } from './review.js';

/** 月の振り返りを知らせる時刻（日本時間の時。毎月 1 日）。 */
export const INQUIRY_REVIEW_HOUR = 8;

/** 手つかずとみなす営業日の数（第33.7節。案）。 */
export const INQUIRY_IDLE_BUSINESS_DAYS = 3;
/** 原文を残す日数（第33.12節）。 */
export const INQUIRY_BODY_DAYS = 90;

/** 見張りが使うもの。 */
export interface InquiryWatchDeps {
  store: InquiryStore;
  repo: Repository;
  logger?: Logger;
}

/** `YYYY-MM-DD` に日を足す。 */
function addDays(date: string, n: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/** 土日を除いて、営業日を数えてさかのぼった日時（祝日は数えに入れない）。 */
export function businessDaysAgo(now: Date, days: number): Date {
  const d = new Date(now);
  let left = days;
  while (left > 0) {
    d.setUTCDate(d.getUTCDate() - 1);
    const wd = d.getUTCDay();
    if (wd !== 0 && wd !== 6) left -= 1;
  }
  return d;
}

/** 誰からかの一言（名前か会社。無ければ「お客様」）。 */
const whoOf = (from: { name: string; company: string }) => (from.name ? `${from.name}さん` : from.company || 'お客様');

/** 問い合わせの見張り。 */
export class InquiryWatch {
  /**
   * 毎月 1 日の朝（日本時間）に、前の月の振り返りを、利用範囲の管理者と窓口の担当に 1 回だけ知らせる。
   *
   * @returns 知らせた数
   */
  private async monthly(tenantId: string, mailboxOwner: string | null, now: Date): Promise<number> {
    const jst = new Date(now.getTime() + 9 * 3_600_000);
    if (jst.getUTCDate() !== 1 || jst.getUTCHours() < INQUIRY_REVIEW_HOUR) return 0;
    const stats = await monthStats(this.deps.store, tenantId, previousMonth(now));
    if (!(await this.deps.store.saveReview(tenantId, stats))) return 0;
    const admins = (await this.deps.repo.listUsers(tenantId)).filter((u) => u.status === 'active' && u.roles.includes('admin')).map((u) => u.id);
    const to = [...new Set([...admins, ...(mailboxOwner ? [mailboxOwner] : [])])];
    let n = 0;
    for (const userId of to) {
      if (await this.notify(tenantId, userId, `${Number(stats.month.slice(5))} 月の問い合わせの振り返り`, reviewText(stats), now)) n += 1;
    }
    return n;
  }

  private readonly log: Logger;

  constructor(private readonly deps: InquiryWatchDeps) {
    this.log = deps.logger ?? silentLogger;
  }

  /** 1 人に知らせる。止めた人・利用範囲の外の人・「問い合わせ」の知らせを切った人には送らない。 */
  private async notify(tenantId: string, userId: string, title: string, body: string, now: Date): Promise<boolean> {
    const { repo } = this.deps;
    const user = await repo.findUserById(tenantId, userId);
    if (!user || user.status !== 'active') return false;
    const settings = await repo.getTenantSettings(tenantId);
    if (!canUseAgent(settings.access, INQUIRIES_EXTENSION_ID, userId, await repo.listUserGroupIds(tenantId, userId))) return false;
    const prefs = await repo.getUserSettings(tenantId, userId);
    if (prefs.notifications.kinds.inquiry === false) return false;
    await repo.createNotification({
      id: randomUUID(), tenantId, userId, kind: 'inquiry', title, body, runId: null, readAt: null, createdAt: now.toISOString(),
    });
    return true;
  }

  /**
   * 1 回分の見張り。問い合わせの記録を入れている会社だけを見る。
   *
   * @returns 知らせた数と、原文を消した数
   */
  async tick(now: Date = new Date()): Promise<{ notified: number; forgotten: number }> {
    const { repo, store } = this.deps;
    let notified = 0;
    let forgotten = 0;
    for (const tenantId of await repo.listTenantIds()) {
      try {
        const settings = await repo.getTenantSettings(tenantId);
        if (!settings.inquiries.enabled) continue;
        const today = dateIn('Asia/Tokyo', now);
        const tomorrow = addDays(today, 1);
        for (const t of await store.dueTasks(tenantId, tomorrow)) {
          const inquiry = await store.get(tenantId, t.inquiryId);
          if (!inquiry) continue;
          if (t.due === tomorrow && !t.notifiedBeforeAt) {
            if (await this.notify(tenantId, t.assignee, `明日が期限の問い合わせ: ${whoOf(inquiry.from)}`, `${t.what}（期限 ${t.due}）`, now)) notified += 1;
            await store.markNotified(tenantId, t.id, 'before');
          } else if (t.due! < today && !t.notifiedOverdueAt) {
            if (await this.notify(tenantId, t.assignee, `期限を過ぎた問い合わせ: ${whoOf(inquiry.from)}`, `${t.what}（期限 ${t.due}）。済んだら秘書に言うか、画面で「済み」にしてください`, now)) notified += 1;
            await store.markNotified(tenantId, t.id, 'overdue');
          }
        }
        // 手つかず: 「閉じてよいか」と聞かず、済んだなら言ってもらう（第33.7節）
        for (const i of await store.idle(tenantId, businessDaysAgo(now, INQUIRY_IDLE_BUSINESS_DAYS).toISOString())) {
          // 窓口のアカウントが残したものは、窓口の担当（つないだ管理者）に知らせる
          const to = i.createdBy === MAILBOX_ACTOR ? settings.inquiries.mailbox?.connectedBy ?? '' : i.createdBy;
          if (to && await this.notify(tenantId, to, `対応中のままの問い合わせ: ${whoOf(i.from)}`, '対応が済んだなら秘書に言ってください。次にやることがあれば、問い合わせの画面で足せます', now)) notified += 1;
          await store.update(tenantId, i.id, { idleNotifiedAt: now.toISOString() });
        }
        forgotten += await store.forgetBodies(tenantId, new Date(now.getTime() - INQUIRY_BODY_DAYS * 86_400_000).toISOString());
        notified += await this.monthly(tenantId, settings.inquiries.mailbox?.connectedBy ?? null, now);
      } catch (err) {
        this.log.warn('inquiry.watch_failed', { tenantId, error: err instanceof Error ? err.message : String(err) });
      }
    }
    return { notified, forgotten };
  }
}
