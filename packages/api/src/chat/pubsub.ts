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
 * @remarks 1 回の見回りで、会社ごとに 10 件まで読む。読めない会社は記録に残して次の会社へ進む
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
      for (const tenantId of await this.deps.repo.listTenantIds()) {
        if (this.deps.isMock(tenantId)) continue;
        const cred = await this.deps.repo.getTenantCredential(tenantId, 'google_chat_app').catch(() => null);
        const subscription = typeof cred?.meta['subscription'] === 'string' ? cred.meta['subscription'] : '';
        if (!cred?.secretEnc || !subscription) continue;
        try {
          const client = await this.clients.for(tenantId);
          if (!client) continue;
          const got = await client.pull(subscription);
          for (const m of got) {
            await this.deps.bridge.handle(tenantId, m.event).catch((err: unknown) => this.deps.log.warn('Chat の依頼を扱えませんでした', { tenantId, error: String(err) }));
            handled++;
          }
          await client.ack(subscription, got.map((m) => m.ackId));
        } catch (err) {
          this.deps.log.warn('Pub/Sub から Chat の出来事を取れませんでした', { tenantId, err });
        }
      }
    } finally {
      this.running = false;
    }
    return handled;
  }
}
