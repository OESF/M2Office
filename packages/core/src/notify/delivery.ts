/**
 * @file 通知の控えを Chat へ届ける見回り役。
 *
 * 画面内のお知らせはすぐ作り、控えはここが後から届ける（仕様書 第6.5.5.2節、ADR-0011）。
 * 通知しない時間帯の間は送らず、時間帯が明けてから 1 件ずつ送る。
 * 1 つの通知につき送るのは 1 回だけで、送り終えた時刻を通知に記録する。
 */

import { randomUUID } from 'node:crypto';
import { notificationPath, type Notification, type Tenant, type UserSettings } from '@m2office/shared';
import type { Repository } from '../repository/types.js';
import { silentLogger, type Logger } from '../log/logger.js';
import type { NotificationChannel, NotificationSender } from './sender.js';

/** 1 回の見回りで 1 社あたり扱う通知の数。 */
const SWEEP_LIMIT = 50;

/** これを過ぎても送れない通知はあきらめる（時間）。画面内のお知らせは残る。 */
const GIVE_UP_HOURS = 24;

/** 通知の種類の表示名。控えの見出しに使う。 */
const KIND_LABELS: Record<string, string> = {
  approval: '承認依頼',
  run: '業務の完了',
  failure: '業務の失敗',
  brief: 'ブリーフ',
  security: 'セキュリティ',
  inventory: '在庫',
  signage: 'サイネージ',
  inquiry: '問い合わせ',
  competitor: '競合の分析',
  announcement: 'お知らせの作成',
  webReview: 'Webの分析',
  column: 'コラムの作成',
  contract: '契約の管理',
  reservation: '予約',
  subsidy: '補助金・助成金',
  member: '会員',
};

/** 会社が業務を受け付ける状態か（仕様書 第23.8.6節）。停止中の会社へは控えを送らない。 */
function isOperational(tenant: Tenant): boolean {
  return tenant.status === 'trial' || tenant.status === 'active';
}

/** 指定の時間帯（`HH:MM`）の中か。`22:00`〜`07:00` のように日をまたぐ指定も扱う。 */
export function inQuietHours(nowHm: string, quiet: { from: string; to: string } | null): boolean {
  if (!quiet) return false;
  const { from, to } = quiet;
  if (from === to) return false;
  return from < to ? nowHm >= from && nowHm < to : nowHm >= from || nowHm < to;
}

/** その時間帯での「いま」の時刻（`HH:MM`）。利用者の時間帯（既定は日本時間）で見る。 */
export function localHm(now: Date, timeZone: string): string {
  const fmt = new Intl.DateTimeFormat('en-GB', {
    timeZone: timeZone || 'Asia/Tokyo', hour: '2-digit', minute: '2-digit', hour12: false,
  });
  return fmt.format(now);
}

/** 本人の設定から、控えを届ける先を決める。 */
export function channelsOf(settings: UserSettings): NotificationChannel[] {
  const c = settings.notifications.channels;
  return c.chat ? ['chat'] : [];
}

export interface NotificationDeliveryDeps {
  repo: Repository;
  sender: NotificationSender;
  /** 会社の画面の入口（例: `https://a.m2office.online`）。お知らせごとの画面の道を後ろに足す（仕様書 第6.1.6節）。 */
  linkFor(tenant: Tenant): string;
  logger?: Logger;
}

/**
 * 通知の控えの見回り役。ワーカーが一定の間隔で `sweep` を呼ぶ。
 *
 * @remarks
 * テナント境界: 会社ごとに、その会社の通知と利用者だけを扱う（不変則 I-2）。
 */
export class NotificationDelivery {
  private readonly log: Logger;

  constructor(private readonly deps: NotificationDeliveryDeps) {
    this.log = deps.logger ?? silentLogger;
  }

  /**
   * 全社を見回り、まだ届けていない通知の控えを送る。
   *
   * @param now 現在時刻
   * @returns 送った通知の数と、時間帯などで見送った数
   */
  async sweep(now: Date = new Date()): Promise<{ sent: number; held: number }> {
    let sent = 0;
    let held = 0;
    for (const tenantId of await this.deps.repo.listTenantIds()) {
      try {
        const tenant = await this.deps.repo.findTenantById(tenantId);
        // 停止中・解約済みの会社へは送らない（仕様書 第23.8.6節）
        if (!tenant || !isOperational(tenant)) continue;
        for (const n of await this.deps.repo.listUndeliveredNotifications(tenantId, SWEEP_LIMIT)) {
          const result = await this.deliver(tenant, n, now);
          if (result === 'sent') sent++;
          else if (result === 'held') held++;
        }
      } catch (err) {
        // 1 社の失敗で、ほかの会社の見回りを止めない
        this.log.error('通知の控えの見回りで例外が発生しました', { tenantId, err });
      }
    }
    return { sent, held };
  }

  /** 1 件の通知を届ける。 */
  private async deliver(
    tenant: Tenant, n: Notification, now: Date,
  ): Promise<'sent' | 'held' | 'done'> {
    const { repo } = this.deps;
    const at = now.toISOString();
    const user = await repo.findUserById(tenant.id, n.userId);
    if (!user || user.status !== 'active') {
      await repo.markNotificationDelivered(tenant.id, n.id, at, '届け先の利用者が使えません');
      return 'done';
    }
    const settings = await repo.getUserSettings(tenant.id, n.userId);
    const channels = channelsOf(settings);
    if (channels.length === 0) {
      // 画面内だけで受け取る人。見回りの対象から外す
      await repo.markNotificationDelivered(tenant.id, n.id, at, '画面内のみ');
      return 'done';
    }
    // 通知しない時間帯の間は送らず、明けてから送る（画面内のお知らせはすでに届いている）
    if (inQuietHours(localHm(now, settings.profile.timezone), settings.notifications.quietHours)) {
      return 'held';
    }

    const envelope = {
      tenantId: tenant.id, userId: user.id, email: user.email,
      kindLabel: KIND_LABELS[n.kind] ?? 'お知らせ',
      title: n.title,
      // 承認の依頼は承認トレイ、実行に結び付くものは実行の詳細へ直接入れるようにする（仕様書 第6.1.6節）
      link: `${this.deps.linkFor(tenant).replace(/\/+$/, '')}${notificationPath(n)}`,
    };
    try {
      for (const channel of channels) {
        if (channel === 'chat') await this.deps.sender.chat(envelope);
      }
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      this.log.warn('通知の控えを送れませんでした', { tenantId: tenant.id, notificationId: n.id, err });
      // あきらめる時刻を過ぎていなければ、届け終えたことにせず、次の見回りでもう一度試す
      const giveUp = Date.parse(n.createdAt) + GIVE_UP_HOURS * 3_600_000 <= now.getTime();
      await repo.markNotificationDelivered(
        tenant.id, n.id, giveUp ? at : null, `送れませんでした: ${reason}`,
      );
      return giveUp ? 'done' : 'held';
    }
    await repo.markNotificationDelivered(tenant.id, n.id, at, channels.join('・'));
    await repo.appendAudit({
      id: randomUUID(), tenantId: tenant.id, actorType: 'system', actorId: 'notifier',
      action: 'notification.deliver', targetType: 'notification', targetId: n.id,
      detail: { channels, kind: n.kind, source: this.deps.sender.source }, occurredAt: at,
    });
    return 'sent';
  }
}
