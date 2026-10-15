/**
 * @file 文字にしないまま残った録音を消す見回り（仕様書 第9.4.5節。録音は残さない）。
 *
 * 録音はふつう、業務が文字にした時点で文字起こしに置き換わる（`to-text.ts`）。ここで消すのは、その手前で残ったもの ——
 * 業務に渡さずに 1 日たった録音と、入力にした業務の実行がすべて終わった（失敗・取り消しで文字にならなかった）録音。
 */

import { randomUUID } from 'node:crypto';
import type { Repository } from '../repository/types.js';
import type { FileStore } from './store.js';
import { silentLogger, type Logger } from '../log/logger.js';

/** 業務に渡さなかった録音を残す長さ（ミリ秒）。上げてから業務に渡すまでの間だけ持つ。 */
export const RECORDING_UNUSED_MS = 24 * 3_600_000;

/**
 * 文字にしないまま残った録音を、全部の会社で消す（ワーカーが 10 分ごとに呼ぶ）。
 *
 * @returns 消した数
 * @remarks テナント境界: 会社ごとに、その会社のファイルだけを消す（不変則 I-2）。記録を先に消し、そのあと実体を消す。
 * 監査ログ `file.audio_discard`（大きさだけ。中身は残さない）
 */
export async function discardStaleRecordings(repo: Repository, files: FileStore, now: Date = new Date(), logger: Logger = silentLogger): Promise<number> {
  const before = new Date(now.getTime() - RECORDING_UNUSED_MS).toISOString();
  let removed = 0;
  for (const tenantId of await repo.listTenantIds()) {
    try {
      for (const f of await repo.listStaleRecordings(tenantId, before)) {
        await repo.deleteFile(tenantId, f.id);
        await files.remove(tenantId, f.id).catch((err) => logger.error('録音の実体を消せませんでした', { tenantId, fileId: f.id, err }));
        await repo.appendAudit({
          id: randomUUID(), tenantId, actorType: 'system', actorId: 'recordings', action: 'file.audio_discard', targetType: 'file', targetId: f.id,
          detail: { size: f.size, transcribed: false }, occurredAt: now.toISOString(),
        });
        removed++;
      }
    } catch (err) {
      // 1 社の失敗で、ほかの会社の見回りを止めない
      logger.error('残った録音の見回りで例外が発生しました', { tenantId, err });
    }
  }
  return removed;
}
