/**
 * @file ローカルの形の遠隔の保守（仕様書 第8.6.4節「遠隔の保守」、ADR-0077）。
 *
 * 外向きのトンネル（Tailscale）は、ふだんは切っておき、**会社の管理者が「機械」で時間を限って開ける**（既定 4 時間）。運営は自分で開けられない。
 * M2Office のプロセス（専用の利用者）はトンネルに触れる権限を持たないため、ここは「開けてほしい」という印（`maintenance-request.json`）を書くだけにする。
 * 管理者の権限で動く `deploy/onsite/maintenance.sh` が印を見て開け閉めし、様子（開いているか・期限・つないだ相手）を `maintenance.json` に書く。
 * ワーカーは、閉じた回を会社の監査ログに残す（開けた時刻・つないだ相手・閉じた時刻）。
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

/** 開けておく時間の既定と上限（時間）。 */
export const MAINTENANCE_DEFAULT_HOURS = 4;
export const MAINTENANCE_MAX_HOURS = 24;

/** 開けた 1 回（maintenance.sh が書く）。 */
export interface MaintenanceSession {
  openedAt: string;
  /** 開けた会社の管理者（M2Office の利用者の番号）。 */
  by: string;
  until: string;
  closedAt: string | null;
  /** つないだ相手（Tailscale の機械の名前）。 */
  peers: string[];
}

/** 遠隔の保守の様子。 */
export interface MaintenanceStatus {
  /** 導入のときに遠隔の保守を入れたか。 */
  configured: boolean;
  /** いま開いているか（maintenance.sh が確かめた様子）。 */
  open: boolean;
  /** 開いている期限（開けてほしい印の期限）。 */
  until: string | null;
  /** 直近の回（新しい順に 10 回）。 */
  sessions: MaintenanceSession[];
}

async function readJson<T>(path: string): Promise<T | null> {
  try { return JSON.parse(await readFile(path, 'utf8')) as T; } catch { return null; }
}

/** 遠隔の保守の様子を読む。 */
export async function readMaintenanceStatus(dir: string, now: Date = new Date()): Promise<MaintenanceStatus> {
  const [settings, state, req] = await Promise.all([
    readJson<{ configured?: boolean }>(join(dir, 'maintenance-settings.json')),
    readJson<{ open?: boolean; sessions?: MaintenanceSession[] }>(join(dir, 'maintenance.json')),
    readJson<{ until?: string | null }>(join(dir, 'maintenance-request.json')),
  ]);
  const until = req?.until && Date.parse(req.until) > now.getTime() ? req.until : null;
  return {
    configured: !!settings?.configured,
    open: !!state?.open,
    until,
    sessions: (state?.sessions ?? []).slice(-10).reverse(),
  };
}

/**
 * 開けてほしい（`hours` 時間）か、閉じてほしい（`null`）という印を書く。
 *
 * @returns 開けておく期限（閉じるなら `null`）
 */
export async function requestMaintenance(dir: string, hours: number | null, by: string, now: Date = new Date()): Promise<string | null> {
  await mkdir(dir, { recursive: true });
  const until = hours === null ? null
    : new Date(now.getTime() + Math.min(MAINTENANCE_MAX_HOURS, Math.max(1, Math.round(hours))) * 3_600_000).toISOString();
  await writeFile(join(dir, 'maintenance-request.json'), JSON.stringify({ until, by, at: now.toISOString() }));
  return until;
}

/**
 * まだ監査ログに残していない、閉じた回を返し、残した印を付ける（ワーカーが見回りで呼ぶ）。
 */
export async function takeClosedMaintenanceSessions(dir: string): Promise<MaintenanceSession[]> {
  const state = await readJson<{ sessions?: MaintenanceSession[] }>(join(dir, 'maintenance.json'));
  const done = await readJson<{ openedAt?: string[] }>(join(dir, 'maintenance-audited.json'));
  const seen = new Set(done?.openedAt ?? []);
  const fresh = (state?.sessions ?? []).filter((s) => s.closedAt && !seen.has(s.openedAt));
  if (fresh.length) {
    await writeFile(join(dir, 'maintenance-audited.json'), JSON.stringify({ openedAt: [...seen, ...fresh.map((s) => s.openedAt)].slice(-50) }));
  }
  return fresh;
}
