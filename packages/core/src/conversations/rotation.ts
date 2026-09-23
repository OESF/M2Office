/**
 * @file 会話ログ（逐語）と、秘書に渡したファイルの入れ替え。
 *
 * 逐語は 4 週で消す。会社の設定でも延ばせない（Q-50。仕様書 第11.9.6節、ADR-0014）。
 * **秘書に渡しただけのファイルも、同じ 4 週で消す**（第10.10.5節）。
 * 業務に渡したファイルは実行に紐づいており、ここでは消さない。
 */

import type { Repository } from '../repository/types.js';
import type { FileStore } from '../files/store.js';
import { silentLogger, type Logger } from '../log/logger.js';

/** 逐語を残す期間（日）。会社の設定では変えられない（Q-50）。 */
export const CONVERSATION_RETENTION_DAYS = 28;

export interface ConversationRotationDeps {
  repo: Repository;
  /** ファイルの中身の置き場。渡されれば、記録とあわせて実体も消す。 */
  files?: FileStore;
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
    let files = 0;
    for (const tenantId of await this.deps.repo.listTenantIds()) {
      try {
        removed += await this.deps.repo.deleteConversationsBefore(tenantId, before);
        files += await this.sweepFiles(tenantId, before);
      } catch (err) {
        // 1 社の失敗で、ほかの会社の入れ替えを止めない
        this.log.error('会話ログの入れ替えで例外が発生しました', { tenantId, err });
      }
    }
    if (removed > 0) this.log.info('保持期間を過ぎた会話ログを消しました', { removed, before });
    if (files > 0) this.log.info('保持期間を過ぎた、秘書に渡したファイルを消しました', { files, before });
    return removed;
  }

  /**
   * 秘書に渡しただけのファイルを消す（仕様書 第10.10.5節）。
   *
   * @returns 消した件数
   * @remarks
   * 記録を先に消し、そのあと実体を消す。逆にすると、実体だけ消えた記録が残る。
   * 実体を消せなくても記録は消えている。次の見回りで取りこぼしを拾えないため、失敗は記録に残す。
   */
  private async sweepFiles(tenantId: string, before: string): Promise<number> {
    const ids = await this.deps.repo.deleteLooseUploadsBefore(tenantId, before);
    if (!this.deps.files) return ids.length;
    for (const id of ids) {
      try {
        await this.deps.files.remove(tenantId, id);
      } catch (err) {
        this.log.error('ファイルの実体を消せませんでした', { tenantId, fileId: id, err });
      }
    }
    return ids.length;
  }
}
