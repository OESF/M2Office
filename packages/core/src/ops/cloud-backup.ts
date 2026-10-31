/**
 * @file クラウドの形の社外の控えの様子（仕様書 第20.4.6節「控え」、ADR-0120）。運営の画面の「稼働状況」に出す。
 *
 * 毎晩の控え（`deploy/vps/backup/m2office-backup.sh`）が機械の置き場に書く結果のファイルと、
 * PostgreSQL の変更の記録（WAL）を送った様子（`pg_stat_archiver`）、`update.sh` が残す更新の前の戻す点を合わせる。
 * どれも読むだけで、外（Google Cloud）へは見に行かない（第23.8.7節「控えの様子」）。
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
  /** 置き場にあるもの（第 0.504.0 版から。前の版の結果には無い）。 */
  inventory?: CloudBackupInventory | null;
}

/** 置き場にある控えの数と期間（毎晩の控えの後に、pgBackRest の `info` と restic の `snapshots`・`stats` から作る）。 */
export interface CloudBackupInventory {
  /** 置き場（Google Cloud Storage のバケットとプロジェクト）。 */
  location: { kind: 'gcs'; bucket: string; project: string | null } | null;
  /** データベースのまるごとの控え。`oldest` はいちばん古い控えが終わった時刻で、これより後に戻せる。 */
  database: { count: number; oldest: string | null; newest: string | null; bytes: number } | null;
  /** ファイルの控え（restic の回）。`bytes` は置き場の中の大きさ。 */
  files: { count: number; oldest: string | null; newest: string | null; bytes: number | null } | null;
}

/** 更新の前の戻す点（`update.sh` が `restore-points.json` に残す）。pgBackRest の `--type=name` で、この時点に戻せる。 */
export interface RestorePoint {
  name: string;
  at: string;
  lsn: string | null;
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
  /** データベースを戻せる範囲（いちばん古いまるごとの控えの終わり 〜 変更の記録を最後に送った時刻）。分からない端は `null`。 */
  recoverable: { from: string | null; to: string | null };
  /** 更新の前の戻す点（新しい順）。`restorable` は戻せる範囲の中にあるか。 */
  restorePoints: (RestorePoint & { restorable: boolean })[];
  /** 次の毎晩の控えの予定（日本時間の 2 時。実際は最大 20 分遅れる）。 */
  nextRunAt: string;
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

/** 更新の前の戻す点を読む（無い・壊れているときは空）。 */
export async function readRestorePoints(file: string): Promise<RestorePoint[]> {
  try {
    const j = JSON.parse(await readFile(file, 'utf8')) as unknown;
    return Array.isArray(j) ? j.filter((p): p is RestorePoint => !!p && typeof p.name === 'string' && typeof p.at === 'string') : [];
  } catch {
    return [];
  }
}

/** `now` より後の、いちばん近い日本時間の 2 時（毎晩の控えの予定。`m2office-backup.timer` の `OnCalendar`）。 */
export function nextNightlyRun(now: number): string {
  const day = 86_400_000;
  // 日本時間の 2 時 = 協定世界時の前の日の 17 時
  let t = Math.floor(now / day) * day + 17 * 3_600_000;
  while (t <= now) t += day;
  return new Date(t).toISOString();
}

/**
 * 運営の画面に出す形にまとめる。
 *
 * @param last 毎晩の控えの最後の結果
 * @param archive 変更の記録を送った様子（読めなければ `null`）
 * @param points 更新の前の戻す点（古い順のまま渡してよい）
 */
export function cloudBackupView(last: CloudBackupRun | null, archive: WalArchiveStatus | null, now: number = Date.now(), points: RestorePoint[] = []): CloudBackupView {
  const failing = !!archive?.enabled && !!archive.lastFailedAt
    && (!archive.lastArchivedAt || Date.parse(archive.lastFailedAt) > Date.parse(archive.lastArchivedAt));
  const from = last?.inventory?.database?.oldest ?? null;
  return {
    configured: last !== null || !!archive?.enabled,
    last,
    stale: last !== null && now - Date.parse(last.at) > CLOUD_BACKUP_STALE_MS,
    archive,
    archiveFailing: failing,
    recoverable: { from, to: archive?.lastArchivedAt ?? null },
    restorePoints: [...points].sort((a, b) => Date.parse(b.at) - Date.parse(a.at))
      .map((p) => ({ ...p, restorable: from !== null && Date.parse(p.at) >= Date.parse(from) })),
    nextRunAt: nextNightlyRun(now),
  };
}
