/**
 * @file ファイルの保存（メタデータと SHA-256 の記録）と、権限を確かめたうえでの読み出し。
 *
 * @see 仕様書 第9.4.1節 文書を扱う共通ツール
 */

import { createHash, randomUUID } from 'node:crypto';
import type { StoredFile } from '@m2office/shared';
import type { Repository } from '../repository/types.js';
import type { FileStore } from './store.js';
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
  if (meta.ownerUserId !== who.id && !who.roles.includes('approver')) return null;
  const bytes = await store.get(tenantId, id);
  return bytes ? { meta, bytes } : null;
}
