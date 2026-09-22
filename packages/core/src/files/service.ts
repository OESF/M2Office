/**
 * @file ファイルの保存（メタデータと SHA-256 の記録）と、権限を確かめたうえでの読み出し。
 *
 * @see 仕様書 第9.4.1節 文書を扱う共通ツール
 */

import { createHash, randomUUID } from 'node:crypto';
import { canDecide, type StoredFile } from '@m2office/shared';
import type { Repository } from '../repository/types.js';
import type { FileStore } from './store.js';
import { canViewRun, type RunViewer } from '../engine/run-access.js';
import { MIME, type FileKind } from './formats.js';

/**
 * ファイルを保存し、メタデータを記録する。
 *
 * @returns 記録したメタデータ
 *
 * @remarks 中身の SHA-256 を残す。後から改ざんされていないかを確かめられるようにするため。
 */
export async function saveFile(
  repo: Repository,
  store: FileStore,
  f: {
    tenantId: string; ownerUserId: string; name: string; kind: FileKind; bytes: Uint8Array;
    origin: StoredFile['origin']; runId: string | null;
  },
): Promise<StoredFile> {
  const meta: StoredFile = {
    id: `f-${randomUUID()}`, tenantId: f.tenantId, ownerUserId: f.ownerUserId,
    name: f.name.slice(0, 200), kind: f.kind, mime: MIME[f.kind], size: f.bytes.byteLength,
    sha256: createHash('sha256').update(f.bytes).digest('hex'),
    origin: f.origin, runId: f.runId, createdAt: new Date().toISOString(),
  };
  await store.put(f.tenantId, meta.id, f.bytes);
  await repo.createFile(meta);
  return meta;
}

/**
 * その利用者がファイルを開けるかを返す（仕様書 第6.2.1節）。
 *
 * @remarks
 * 上げた本人（または業務を依頼した本人）は開ける。業務が作ったファイルは、その実行を見られる人が開ける。
 * 利用者が上げたファイルは、それを入力にした実行の承認を判断できる人も開ける。
 * 承認者の役割を持つだけでは開けない。
 */
async function canOpenFile(
  repo: Repository, tenantId: string, meta: StoredFile, who: RunViewer,
): Promise<boolean> {
  if (meta.ownerUserId === who.id) return true;
  if (meta.runId) {
    const run = await repo.getRun(tenantId, meta.runId);
    const job = run ? await repo.getJob(tenantId, run.jobId) : null;
    if (!run || !job) return false;
    return canViewRun(repo, tenantId, job, run.id, who);
  }
  const approvals = await repo.listApprovalsForFileInput(tenantId, meta.id);
  return approvals.some((a) => canDecide(a, who));
}

/**
 * 利用者が扱ってよいファイルを読み出す。
 *
 * @param who 読もうとしている利用者。所有者か、判断のために中身を見る承認者だけが読める
 * @returns メタデータと中身。見つからない・読めない場合は `null`（存在を示さない）
 */
export async function loadFile(
  repo: Repository,
  store: FileStore,
  tenantId: string,
  id: string,
  who: { id: string; roles: readonly string[] },
): Promise<{ meta: StoredFile; bytes: Uint8Array } | null> {
  const meta = await repo.getFile(tenantId, id);
  if (!meta) return null;
  if (!(await canOpenFile(repo, tenantId, meta, who))) return null;
  const bytes = await store.get(tenantId, id);
  return bytes ? { meta, bytes } : null;
}
