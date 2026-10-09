/**
 * @file ローカルの形の「機械」（仕様書 第8.6.5節・第8.6.7節）の公開窓口。控え（社内と社外）と、機械の様子。
 */

import { appPath } from '../app-root.js';
import type { BackupConfig } from './backup.js';
import type { MachineConfig } from './status.js';
import { heartbeatConfigFromEnv } from './heartbeat.js';
import { offsiteConfigFromEnv } from './offsite.js';
import { frontDir } from './maintenance.js';

export {
  runBackup, restoreTest, readBackupStatus, requestBackup, takeBackupRequest, backupsToKeep, backupName, diskSpace,
  type BackupConfig, type BackupRecord, type BackupStatus,
} from './backup.js';
export {
  runOffsite, checkOffsite, readOffsiteStatus, offsiteConfigFromEnv, parseBackupSummary, OFFSITE_KEEP,
  type OffsiteConfig, type OffsiteRecord, type OffsiteStatus,
} from './offsite.js';
export { machineStatus, writeWorkerBeat, type MachineConfig, type MachineStatus } from './status.js';
export { readUpdateStatus, holdUpdates, takeUnnotifiedUpdateFailure, type UpdateRecord, type UpdateSettings, type UpdateStatus } from './update.js';
export {
  readMaintenanceStatus, requestMaintenance, frontDir, takeClosedMaintenanceSessions, MAINTENANCE_DEFAULT_HOURS, MAINTENANCE_MAX_HOURS,
  type MaintenanceSession, type MaintenanceStatus,
} from './maintenance.js';
export {
  heartbeatConfigFromEnv, heartbeatPayload, readHeartbeatStatus, setHeartbeatOff, sendHeartbeat, HEARTBEAT_INTERVAL_MS,
  type HeartbeatConfig, type HeartbeatPayload, type HeartbeatStatus,
} from './heartbeat.js';

/** 機械の様子の知らせを置く場所（`M2O_MACHINE_DIR`。無ければ `.data/machine`）。 */
export function machineDir(env: Record<string, string | undefined>): string {
  return env['M2O_MACHINE_DIR'] || appPath('.data', 'machine');
}

/**
 * 控えの設定（`M2O_BACKUP_DIR` があるときだけ。第8.6.5節）。
 *
 * @remarks 道具は `M2O_PG_BIN`（同梱した PostgreSQL の bin）か PATH。開発では `M2O_PG_DOCKER` にデータベースのコンテナの名前
 */
export function backupConfigFromEnv(env: Record<string, string | undefined>): BackupConfig | null {
  const dir = env['M2O_BACKUP_DIR'];
  if (!dir) return null;
  return {
    dir,
    filesDir: env['FILE_STORAGE_DIR'] || appPath('.data', 'files'),
    ownerUrl: env['MIGRATION_DATABASE_URL'] ?? 'postgres://m2office:m2office@localhost:3105/m2office',
    pgBin: env['M2O_PG_BIN'] || null,
    pgDocker: env['M2O_PG_DOCKER'] || null,
  };
}

/** 「機械」の様子の材料（第8.6.7節）。 */
export function machineConfigFromEnv(env: Record<string, string | undefined>, version: string): MachineConfig {
  const base = env['APP_BASE_URL'] ?? '';
  const host = base && !base.includes('{tenant}') ? (() => { try { return new URL(base).hostname; } catch { return null; } })() : null;
  return {
    dir: machineDir(env),
    version,
    databaseUrl: env['DATABASE_URL'] ?? 'postgres://m2office_app:m2office_app@localhost:3105/m2office',
    filesDir: env['FILE_STORAGE_DIR'] || appPath('.data', 'files'),
    backupDir: env['M2O_BACKUP_DIR'] || null,
    host,
    localLlm: env['LOCAL_LLM_URL'] ? { url: env['LOCAL_LLM_URL'], model: env['LOCAL_LLM_MODEL'] || null } : null,
    heartbeat: heartbeatConfigFromEnv(env),
    offsite: !!env['M2O_BACKUP_DIR'] && offsiteConfigFromEnv(env, machineDir(env)) !== null,
    frontDir: frontDir(env),
  };
}
