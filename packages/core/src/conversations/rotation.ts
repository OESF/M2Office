/**
 * @file 会話ログ（逐語）の入れ替え。保持期間を過ぎたものを消す（仕様書 第11.9.6節、ADR-0014）。
 *
 * 逐語は 4 週で消す。会社の設定でも延ばせない（Q-50）。
 * 要約と、会話からの記憶の候補（圧縮の段階 1・2）は次の段階で足す。
 */

import type { Repository } from '../repository/types.js';
import { silentLogger, type Logger } from '../log/logger.js';

/** 逐語を残す期間（日）。会社の設定では変えられない（Q-50）。 */
export const CONVERSATION_RETENTION_DAYS = 28;

export interface ConversationRotationDeps {
  repo: Repository;
  logger?: Logger;
}

/**
 * 会話ログの入れ替え役。ワーカーが 1 日 1 回ほど `sweep` を呼ぶ。
 *
 * @remarks テナント境界: 会社ごとに、その会社の会話だけを消す（不変則 I-2）。
 */
export class ConversationRotation {
  private readonly log: Logger;

  constructor(private readonly deps: ConversationRotationDeps) {
    this.log = deps.logger ?? silentLogger;
  }

  /**
   * 全社を見回り、保持期間を過ぎた逐語を消す。
   *
   * @param now 現在時刻
   * @returns 消した件数
   */
  async sweep(now: Date = new Date()): Promise<number> {
    const before = new Date(now.getTime() - CONVERSATION_RETENTION_DAYS * 86_400_000).toISOString();
    let removed = 0;
    for (const tenantId of await this.deps.repo.listTenantIds()) {
      try {
        removed += await this.deps.repo.deleteConversationsBefore(tenantId, before);
      } catch (err) {
        // 1 社の失敗で、ほかの会社の入れ替えを止めない
        this.log.error('会話ログの入れ替えで例外が発生しました', { tenantId, err });
      }
    }
    if (removed > 0) this.log.info('保持期間を過ぎた会話ログを消しました', { removed, before });
    return removed;
  }
}
