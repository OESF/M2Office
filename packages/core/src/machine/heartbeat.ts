/**
 * @file ローカルの形の、運営への稼働の知らせ（仕様書 第8.6.8節、Q-209）。
 *
 * 保守の契約で運営が機械を見守るために、ワーカーが 1 時間に 1 回、運営のマスター管理画面の受け口（`M2O_HEARTBEAT_URL`）へ送る。
 * **件数と状態だけを送る**。人の名前・業務の中身・会社の利用の数・会社の名前やアドレスは送らない。
 * 入れるかは導入のときに保守の契約に合わせて決め（受け口と鍵を入れたときだけ送る）、会社の管理者は「機械」で切れる。
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { MachineStatus } from './status.js';

/** 送る間隔（ミリ秒）。 */
export const HEARTBEAT_INTERVAL_MS = 60 * 60_000;

/** 稼働の知らせの設定（環境変数から）。 */
export interface HeartbeatConfig {
  url: string;
  token: string;
  /** 機械の番号（運営が付けた呼び名。会社の名前は入れない）。 */
  machineId: string;
}

/** 稼働の知らせの中身。件数と状態だけ。 */
export interface HeartbeatPayload {
  machineId: string;
  version: string;
  at: string;
  parts: { database: boolean; worker: boolean; entrance: boolean; localAi: boolean | null };
  backup: { configured: boolean; lastAt: string | null; lastOk: boolean | null; restoreOk: boolean | null };
  disk: { dataFree: number | null; dataTotal: number | null; backupFree: number | null };
  cert: { daysLeft: number | null };
  update: { lastAt: string | null; lastResult: string | null; version: string | null };
}

/** 稼働の知らせの様子（「機械」に出す）。 */
export interface HeartbeatStatus {
  /** 受け口と鍵が入っているか。 */
  configured: boolean;
  /** 会社の管理者が切っているか。 */
  off: boolean;
  lastAt: string | null;
  lastOk: boolean | null;
  lastError: string | null;
}

/** 環境変数から設定を読む（受け口と鍵が無ければ `null`）。 */
export function heartbeatConfigFromEnv(env: Record<string, string | undefined>): HeartbeatConfig | null {
  const url = env['M2O_HEARTBEAT_URL']?.trim();
  const token = env['M2O_HEARTBEAT_TOKEN']?.trim();
  if (!url || !token || !/^https:\/\//.test(url)) return null;
  return { url, token, machineId: env['M2O_MACHINE_ID']?.trim() || 'onsite' };
}

/**
 * 機械の様子から、送る中身を作る（純粋な関数）。
 *
 * @remarks 入口の名前（会社のドメイン）とローカル AI のモデルの名前・失敗の文は送らない
 */
export function heartbeatPayload(s: MachineStatus, machineId: string): HeartbeatPayload {
  const b = s.backup.status;
  return {
    machineId,
    version: s.version,
    at: s.checkedAt,
    parts: {
      database: s.database.ok, worker: s.worker.ok,
      entrance: s.entrance.host ? s.entrance.certExpires !== null : false,
      localAi: s.localAi.configured ? s.localAi.ok : null,
    },
    backup: { configured: s.backup.configured, lastAt: b?.last?.at ?? null, lastOk: b?.last ? b.last.ok : null, restoreOk: b?.restoreTest ? b.restoreTest.ok : null },
    disk: { dataFree: s.disk.data?.free ?? null, dataTotal: s.disk.data?.total ?? null, backupFree: s.disk.backup?.free ?? null },
    cert: { daysLeft: s.entrance.certDaysLeft },
    update: { lastAt: s.update.last?.at ?? null, lastResult: s.update.last?.result ?? null, version: s.update.last?.to ?? null },
  };
}

async function readJson<T>(path: string): Promise<T | null> {
  try { return JSON.parse(await readFile(path, 'utf8')) as T; } catch { return null; }
}

/** 稼働の知らせの様子を読む。 */
export async function readHeartbeatStatus(dir: string, cfg: HeartbeatConfig | null): Promise<HeartbeatStatus> {
  const [flag, last] = await Promise.all([
    readJson<{ off?: boolean }>(join(dir, 'heartbeat.json')),
    readJson<{ at?: string; ok?: boolean; error?: string | null }>(join(dir, 'heartbeat-status.json')),
  ]);
  return { configured: !!cfg, off: !!flag?.off, lastAt: last?.at ?? null, lastOk: last?.ok ?? null, lastError: last?.error ?? null };
}

/** 会社の管理者が切る・入れる。 */
export async function setHeartbeatOff(dir: string, off: boolean, by: string, now: Date = new Date()): Promise<void> {
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'heartbeat.json'), JSON.stringify({ off, by, at: now.toISOString() }));
}

/**
 * 稼働の知らせを送る（ワーカーが 1 時間に 1 回呼ぶ）。切っているか、設定が無ければ送らない。
 *
 * @returns 送ったか。送れなかったときは理由を様子に残す（運営の受け口が無い・止まっていても、M2Office は止めない）
 */
export async function sendHeartbeat(
  dir: string, cfg: HeartbeatConfig | null, status: () => Promise<MachineStatus>,
  fetcher: typeof fetch = fetch, now: Date = new Date(),
): Promise<boolean> {
  if (!cfg || (await readHeartbeatStatus(dir, cfg)).off) return false;
  let ok = false;
  let error: string | null = null;
  try {
    const res = await fetcher(cfg.url, {
      method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${cfg.token}` },
      body: JSON.stringify(heartbeatPayload(await status(), cfg.machineId)), signal: AbortSignal.timeout(15_000),
    });
    ok = res.ok;
    if (!ok) error = `受け口が ${res.status} を返しました`;
  } catch (err) {
    error = err instanceof Error ? err.message : String(err);
  }
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'heartbeat-status.json'), JSON.stringify({ at: now.toISOString(), ok, error }));
  return ok;
}
