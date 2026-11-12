/**
 * @file Cloud Pub/Sub から Chat の出来事を取りに行く（ローカル・自社運用。仕様書 第10.16.3節「受け口」、ADR-0138）。
 *
 * 外から届かない機械でも、会社の Chat アプリの設定で接続を Cloud Pub/Sub にすれば、出来事は会社の購読にたまる。
 * ここは、購読を登録した会社について、短い間隔で取りに行き、秘書への橋渡しに渡してから、読み終えたと伝える。
 * 購読は会社の Google Cloud のもので、会社の Chat アプリの鍵（サービスアカウント）で読む。
 */

import { ChatAppClients, type Logger, type Repository, type SecretBox } from '@m2office/core';
import type { ChatSecretaryBridge } from './bridge.js';

export interface ChatPubSubDeps {
  repo: Repository;
  box: SecretBox;
  bridge: Pick<ChatSecretaryBridge, 'handle'>;
  log: Logger;
  /** 見本の会社か（見本の会社は取りに行かない）。 */
  isMock(tenantId: string): boolean;
}

/**
 * 購読を登録した会社の出来事を取りに行く見回り役。
 *
 * @remarks 1 回の見回りで、会社ごとに 10 件まで読む。会社ごとに並べて取りに行き、読めない会社は記録に残す
 */
export class ChatPubSubPoller {
  private readonly clients: ChatAppClients;
  private running = false;

  constructor(private readonly deps: ChatPubSubDeps) {
    this.clients = new ChatAppClients({ repo: deps.repo, box: deps.box });
  }

  /** 1 回分の見回り。前の見回りが終わっていなければ何もしない。 */
  async sweep(): Promise<number> {
    if (this.running) return 0;
    this.running = true;
    let handled = 0;
    try {
      // 取りに行く呼び出しは、届いたものが無いとしばらく待つ。会社ごとに並べて待ち、ほかの会社を待たせない
      await Promise.all((await this.deps.repo.listTenantIds()).map(async (tenantId) => {
        if (this.deps.isMock(tenantId)) return;
        const cred = await this.deps.repo.getTenantCredential(tenantId, 'google_chat_app').catch(() => null);
        const subscription = typeof cred?.meta['subscription'] === 'string' ? cred.meta['subscription'] : '';
        if (!cred?.secretEnc || !subscription) return;
        try {
          const client = await this.clients.for(tenantId);
          if (!client) return;
          const got = await client.pull(subscription);
          if (got.length) this.deps.log.info('Pub/Sub から Chat の出来事を取りました', { tenantId, count: got.length });
          for (const m of got) {
            await this.deps.bridge.handle(tenantId, m.event).catch((err: unknown) => this.deps.log.warn('Chat の依頼を扱えませんでした', { tenantId, error: String(err) }));
            handled++;
          }
          // 扱い終えてから読み終えたと伝える（途中で止まっても失わない。扱いが長くて届き直したものは、置き場で 1 回だけにする）
          await client.ack(subscription, got.map((m) => m.ackId));
        } catch (err) {
          this.deps.log.warn('Pub/Sub から Chat の出来事を取れませんでした', { tenantId, err });
        }
      }));
    } finally {
      this.running = false;
    }
    return handled;
  }
}
