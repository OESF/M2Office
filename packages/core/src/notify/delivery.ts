/**
 * @file 通知の控えを Chat へ届ける見回り役。
 *
 * 画面内のお知らせはすぐ作り、控えはここが後から届ける（仕様書 第6.5.5.2節、ADR-0011）。
 * 本人の控える時（既定は 21:00〜翌 7:00 と会社の営業日でない日。第10.16.5節、ADR-0138）の間は送らず、
 * 明けてから、たまった分を 1 通にまとめて送る。本人が Chat に送らないと決めた種類は送らない（画面内には届いている）。
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

/** 1 通にまとめたとき、題名を並べる数。残りは数だけ添える。 */
const BUNDLE_LINES = 10;

/** 通知の種類の表示名。控えの見出しと、秘書が種類を言うときに使う。 */
export const NOTIFICATION_KIND_LABELS: Record<string, string> = {
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
  contract: '契約書の管理',
  reservation: '予約',
  subsidy: '補助金・助成金',
  decision: '意思決定支援',
  member: '会員',
  print: '販促物の作成',
  usage: 'AI の利用',
  usageSelf: 'AI の利用',
  effect: '効果のレポート',
  knowledgeGap: '知識',
  notice: '社内のお知らせ',
  machine: 'サーバー',
  service: 'ご利用',
  support: 'サポートの閲覧',
  mail: '急ぎのメール',
  attendance: '給与・勤怠',
  library: 'ナレッジの整理',
  site: 'サイトの更新',
  billing: 'ご利用料金',
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

/** その時間帯での「今日」（`YYYY-MM-DD`）。 */
export function localDay(now: Date, timeZone: string): string {
  return new Intl.DateTimeFormat('sv-SE', { timeZone: timeZone || 'Asia/Tokyo' }).format(now);
}

/**
 * いまが本人の控える時か（第10.16.5節）。時間帯の中か、休みの日に送らない人で会社の営業日でない日なら控える。
 *
 * @param businessDay その日が会社の営業日か。無ければ休みの日は見ない
 */
export async function inQuietTime(
  settings: UserSettings, now: Date, businessDay?: (day: string) => Promise<boolean>,
): Promise<boolean> {
  const tz = settings.profile.timezone;
  if (inQuietHours(localHm(now, tz), settings.notifications.quietHours)) return true;
  if (settings.notifications.quietDaysOff !== false && businessDay) {
    const open = await businessDay(localDay(now, tz)).catch(() => true);
    if (!open) return true;
  }
  return false;
}

/** 本人の設定から、控えを届ける先を決める。 */
export function channelsOf(settings: UserSettings): NotificationChannel[] {
  const c = settings.notifications.channels;
  return c.chat ? ['chat'] : [];
}

export interface NotificationDeliveryDeps {
  repo: Repository;
  sender: NotificationSender;
  /** 会社の画面の入口（例: `https://a.m2office.net`）。お知らせごとの画面の道を後ろに足す（仕様書 第6.1.6節）。 */
  linkFor(tenant: Tenant): string;
  /** その日（`YYYY-MM-DD`）が会社の営業日か（第6.6.1節）。休みの日に送らない決まりに使う。無ければ休みの日は見ない。 */
  businessDay?(tenantId: string, day: string): Promise<boolean>;
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
        // 人ごとにまとめる（たまった分は 1 通にして送る。第10.16.5節「明けたとき」）
        const byUser = new Map<string, Notification[]>();
        for (const n of await this.deps.repo.listUndeliveredNotifications(tenantId, SWEEP_LIMIT)) {
          byUser.set(n.userId, [...(byUser.get(n.userId) ?? []), n]);
        }
        for (const list of byUser.values()) {
          const r = await this.deliver(tenant, list, now);
          sent += r.sent;
          held += r.held;
        }
      } catch (err) {
        // 1 社の失敗で、ほかの会社の見回りを止めない
        this.log.error('通知の転送の見回りで例外が発生しました', { tenantId, err });
      }
    }
    return { sent, held };
  }

  /** 1 人分の、まだ届けていない通知を届ける（1 件ならそのまま、2 件以上なら 1 通にまとめる）。 */
  private async deliver(tenant: Tenant, list: Notification[], now: Date): Promise<{ sent: number; held: number }> {
    const { repo } = this.deps;
    const at = now.toISOString();
    const userId = list[0]!.userId;
    const doneAll = async (items: Notification[], note: string) => {
      for (const n of items) await repo.markNotificationDelivered(tenant.id, n.id, at, note);
    };
    const user = await repo.findUserById(tenant.id, userId);
    if (!user || user.status !== 'active') {
      await doneAll(list, '届け先の利用者が使えません');
      return { sent: 0, held: 0 };
    }
    const settings = await repo.getUserSettings(tenant.id, userId);
    const channels = channelsOf(settings);
    if (channels.length === 0) {
      // 画面内だけで受け取る人。見回りの対象から外す
      await doneAll(list, '画面内のみ');
      return { sent: 0, held: 0 };
    }
    // 本人が Chat に送らないと決めた種類（第10.16.5節「種類ごとの Chat」）。画面内には届いている
    const off = new Set(settings.notifications.chatOff ?? []);
    await doneAll(list.filter((n) => off.has(n.kind)), 'Chat に送らない種類');
    const pending = list.filter((n) => !off.has(n.kind));
    if (pending.length === 0) return { sent: 0, held: 0 };
    // 控える時（夜・休みの日）の間は送らず、明けてから送る（画面内のお知らせはすでに届いている）
    const businessDay = this.deps.businessDay ? (day: string) => this.deps.businessDay!(tenant.id, day) : undefined;
    if (await inQuietTime(settings, now, businessDay)) return { sent: 0, held: pending.length };

    const base = this.deps.linkFor(tenant).replace(/\/+$/, '');
    const label = (n: Notification) => NOTIFICATION_KIND_LABELS[n.kind] ?? 'お知らせ';
    const envelope = pending.length === 1
      ? {
        tenantId: tenant.id, userId: user.id, email: user.email, kindLabel: label(pending[0]!), title: pending[0]!.title,
        // 承認の依頼は承認トレイ、実行に結び付くものは実行の詳細へ直接入れるようにする（仕様書 第6.1.6節）
        link: `${base}${notificationPath(pending[0]!)}`,
      }
      : {
        tenantId: tenant.id, userId: user.id, email: user.email, kindLabel: `知らせ ${pending.length} 件`, title: bundleTitle(pending, label),
        link: `${base}/`, items: pending.slice(0, BUNDLE_LINES).map((n) => ({ kindLabel: label(n), title: n.title })),
        more: Math.max(0, pending.length - BUNDLE_LINES),
      };
    try {
      for (const channel of channels) {
        if (channel === 'chat') await this.deps.sender.chat(envelope);
      }
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      this.log.warn('通知の転送を送れませんでした', { tenantId: tenant.id, userId, count: pending.length, err });
      // あきらめる時刻を過ぎていなければ、届け終えたことにせず、次の見回りでもう一度試す
      let held = 0;
      for (const n of pending) {
        const giveUp = Date.parse(n.createdAt) + GIVE_UP_HOURS * 3_600_000 <= now.getTime();
        if (!giveUp) held++;
        await repo.markNotificationDelivered(tenant.id, n.id, giveUp ? at : null, `送れませんでした: ${reason}`);
      }
      return { sent: 0, held };
    }
    const source = this.deps.sender.sourceFor?.(tenant.id) ?? this.deps.sender.source;
    for (const n of pending) {
      await repo.markNotificationDelivered(tenant.id, n.id, at, pending.length > 1 ? `${channels.join('・')}（まとめて ${pending.length} 件）` : channels.join('・'));
      await repo.appendAudit({
        id: randomUUID(), tenantId: tenant.id, actorType: 'system', actorId: 'notifier',
        action: 'notification.deliver', targetType: 'notification', targetId: n.id,
        detail: { channels, kind: n.kind, source, ...(pending.length > 1 ? { bundled: pending.length } : {}) }, occurredAt: at,
      });
    }
    return { sent: pending.length, held: 0 };
  }
}

/** まとめた 1 通の題名（「承認依頼 2 件・業務の完了 3 件」）。多い種類から並べる。 */
export function bundleTitle(list: Notification[], label: (n: Notification) => string): string {
  const counts = new Map<string, number>();
  for (const n of list) counts.set(label(n), (counts.get(label(n)) ?? 0) + 1);
  return [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([k, c]) => `${k} ${c} 件`).join('・');
}
