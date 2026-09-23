/**
 * @file 通知の控えを Chat へ送る送信口と、その見本の実装。
 *
 * 画面内のお知らせが正であり、ここで送るのはその控えである（仕様書 第6.5.5.2節、ADR-0011）。
 * 送るのは種類・題名・画面へのリンクだけで、本文は載せない。
 *
 * 実際の送信は、会社の Google Chat アプリの登録（B-2）のあとに実装する。メールは送らない（Q-86）。
 * それまでは見本の送信口で、設定・時間帯・重複の除き方まで通しで確かめる（ADR-0003 と同じ進め方）。
 */

import type { DataSource } from '../connectors/types.js';
import type { Logger } from '../log/logger.js';
import { silentLogger } from '../log/logger.js';

/** 届ける先の種類。 */
export type NotificationChannel = 'chat';

/** 控えとして送る中身。本文は持たない（仕様書 第6.5.5.2節）。 */
export interface NotificationEnvelope {
  tenantId: string;
  /** 届ける相手。会社のメールアドレスで指す（Chat も同じ人を指す）。 */
  email: string;
  userId: string;
  /** 種類の表示名（例: 承認依頼）。 */
  kindLabel: string;
  title: string;
  /** M2Office の画面へのリンク。 */
  link: string;
}

/**
 * 通知の控えの送信口。
 *
 * @remarks
 * 実装は `mock`（見本）と、のちの `google`（会社の Chat アプリ）。
 * どちらも出どころ（`source`）を持ち、見本を本物と取り違えないようにする。
 */
export interface NotificationSender {
  source: DataSource;
  /** 会社の Chat アプリから、本人への個別メッセージとして送る。 */
  chat(envelope: NotificationEnvelope): Promise<void>;
}

/** 見本の送信口が記録する 1 通。 */
export interface SentNotification extends NotificationEnvelope {
  channel: NotificationChannel;
  sentAt: string;
}

/**
 * 見本の送信口。実際には送らず、送った内容を控える。
 *
 * @remarks 本番では使わない。`CONNECTOR_MODE=mock` の間の送信口である。
 */
export class MockNotificationSender implements NotificationSender {
  readonly source: DataSource = 'mock';
  /** 送ったことにした控え。動作確認とテストで見る。 */
  readonly outbox: SentNotification[] = [];

  constructor(private readonly log: Logger = silentLogger) {}

  async chat(envelope: NotificationEnvelope): Promise<void> {
    this.record('chat', envelope);
  }

  private record(channel: NotificationChannel, envelope: NotificationEnvelope): void {
    this.outbox.push({ ...envelope, channel, sentAt: new Date().toISOString() });
    this.log.info('通知の控えを送ったことにしました（見本の送信口）', {
      tenantId: envelope.tenantId, channel, to: envelope.email, title: envelope.title,
    });
  }
}
