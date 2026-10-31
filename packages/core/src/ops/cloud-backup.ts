/**
 * @file クラウドの形の社外の控えの様子（仕様書 第20.4.6節「控え」、ADR-0120）。運営の画面の「稼働状況」に出す。
 *
 * 毎晩の控え（`deploy/vps/backup/m2office-backup.sh`）が機械の置き場に書く結果のファイルと、
 * PostgreSQL の変更の記録（WAL）を送った様子（`pg_stat_archiver`）を合わせる。どちらも読むだけで、外へは見に行かない。
 */

import { readFile } from 'node:fs/promises';

/** 毎晩の控えの 1 回の結果（`cloud-backup.json`）。 */
export interface CloudBackupRun {
  at: string;
  startedAt: string;
  ok: boolean;
  database: { ok: boolean; error: string | null };
  files: { ok: boolean; error: string | null; snapshot: string | null };
  /** 月に 1 回の、壊れていないかの確かめ。 */
  check: { at: string; ok: boolean; error: string | null } | null;
}

/** 変更の記録を送った様子。 */
export interface WalArchiveStatus {
  /** `archive_mode` が `on` か。 */
  enabled: boolean;
  lastArchivedAt: string | null;
  lastFailedAt: string | null;
  failedCount: number;
}

/** 社外の控えの様子（運営の画面の形）。 */
export interface CloudBackupView {
  /** 結果のファイルがあるか（無ければ、まだ入れていないか一度も取っていない）。 */
  configured: boolean;
  last: CloudBackupRun | null;
  /** 最後の結果が 26 時間より古い（毎晩の控えが止まっている）。 */
  stale: boolean;
  archive: WalArchiveStatus | null;
  /** 最後に送れなかったのが、最後に送れたのより新しい（いま送れていない）。 */
  archiveFailing: boolean;
}

/** 毎晩の控えが止まっているとみなす長さ（26 時間）。 */
export const CLOUD_BACKUP_STALE_MS = 26 * 3_600_000;

/** 結果のファイルを読む（無い・壊れているときは `null`）。 */
export async function readCloudBackupRun(file: string): Promise<CloudBackupRun | null> {
  try {
    const j = JSON.parse(await readFile(file, 'utf8')) as CloudBackupRun;
    return typeof j.at === 'string' && typeof j.ok === 'boolean' ? j : null;
  } catch {
    return null;
  }
}

/**
 * 運営の画面に出す形にまとめる。
 *
 * @param last 毎晩の控えの最後の結果
 * @param archive 変更の記録を送った様子（読めなければ `null`）
 */
export function cloudBackupView(last: CloudBackupRun | null, archive: WalArchiveStatus | null, now: number = Date.now()): CloudBackupView {
  const failing = !!archive?.enabled && !!archive.lastFailedAt
    && (!archive.lastArchivedAt || Date.parse(archive.lastFailedAt) > Date.parse(archive.lastArchivedAt));
  return {
    configured: last !== null || !!archive?.enabled,
    last,
    stale: last !== null && now - Date.parse(last.at) > CLOUD_BACKUP_STALE_MS,
    archive,
    archiveFailing: failing,
  };
}
