/**
 * @file ローカルの形の遠隔の保守（仕様書 第8.6.4節「遠隔の保守」、ADR-0077）。
 *
 * 外向きのトンネル（Tailscale）は、ふだんは切っておき、**会社の管理者が「機械」で時間を限って開ける**（既定 4 時間）。運営は自分で開けられない。
 * M2Office のプロセス（専用の利用者）はトンネルに触れる権限を持たないため、ここは「開けてほしい」という印（`maintenance-request.json`）を書くだけにする。
 * 管理者の権限で動く `deploy/onsite/maintenance.sh` が印を見て開け閉めし、様子（開いているか・期限・つないだ相手）を `maintenance.json` に書く。
 * ワーカーは、閉じた回を会社の監査ログに残す（開けた時刻・つないだ相手・閉じた時刻）。
 *
 * 同じ機械に M2Medical があるときは、開けると技術者が機械全体（患者の情報を含む）に入れるため、**M2Medical の管理者だけが開ける**
 * （第8.6.9節、ADR-0086）。M2Medical は共通の入口の置き場（`M2O_FRONT_DIR`）の `maintenance-owner` に自分の名前を書く。
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
  /** 同じ機械のほかの製品が遠隔の保守を持つとき、その製品の名前（例 `M2Medical`）。M2Office からは開けられない。 */
  managedBy: string | null;
}

/** 共通の入口の置き場（`M2O_FRONT_DIR`）。ローカルの形でなければ `null`。 */
export function frontDir(env: Record<string, string | undefined>): string | null {
  return env['M2O_FRONT_DIR'] || null;
}

/** 遠隔の保守を持つほかの製品の名前（`maintenance-owner` の 1 行目）。無いか M2Office なら `null`。 */
async function maintenanceOwner(front: string | null): Promise<string | null> {
  if (!front) return null;
  try {
    const name = (await readFile(join(front, 'maintenance-owner'), 'utf8')).split('\n')[0]!.trim();
    return name && name !== 'M2Office' ? name.slice(0, 40) : null;
  } catch {
    return null;
  }
}

async function readJson<T>(path: string): Promise<T | null> {
  try { return JSON.parse(await readFile(path, 'utf8')) as T; } catch { return null; }
}

/**
 * 遠隔の保守の様子を読む。
 *
 * @param front 共通の入口の置き場（{@link frontDir}）。ほかの製品が遠隔の保守を持つかを見る
 */
export async function readMaintenanceStatus(dir: string, now: Date = new Date(), front: string | null = null): Promise<MaintenanceStatus> {
  const [settings, state, req, managedBy] = await Promise.all([
    readJson<{ configured?: boolean }>(join(dir, 'maintenance-settings.json')),
    readJson<{ open?: boolean; sessions?: MaintenanceSession[] }>(join(dir, 'maintenance.json')),
    readJson<{ until?: string | null }>(join(dir, 'maintenance-request.json')),
    maintenanceOwner(front),
  ]);
  const until = req?.until && Date.parse(req.until) > now.getTime() ? req.until : null;
  return {
    configured: !!settings?.configured && !managedBy,
    open: !managedBy && !!state?.open,
    until: managedBy ? null : until,
    sessions: (state?.sessions ?? []).slice(-10).reverse(),
    managedBy,
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
