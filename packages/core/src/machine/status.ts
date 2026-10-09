/**
 * @file ローカルの形の「機械」の様子（仕様書 第8.6.7節）。版・各部の動き（データベース・ワーカー・入口と証明書・ローカル AI）・
 * ディスクの空き・控えの結果を集める。管理者ページの「機械」が見る。
 *
 * ワーカーの動きは、ワーカーが決まった場所に書く知らせ（{@link writeWorkerBeat}）で見る（API とワーカーは同じ機械で動く）。
 * 業務のデータには触れない。
 */

import { connect as tlsConnect } from 'node:tls';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import pg from 'pg';
import { diskSpace, readBackupStatus, type BackupStatus } from './backup.js';
import { readOffsiteStatus, type OffsiteStatus } from './offsite.js';
import { readUpdateStatus, type UpdateStatus } from './update.js';
import { readMaintenanceStatus, type MaintenanceStatus } from './maintenance.js';
import { readHeartbeatStatus, type HeartbeatConfig, type HeartbeatStatus } from './heartbeat.js';

/** ワーカーの知らせが、これより古ければ止まっているとみなす（ミリ秒）。 */
const WORKER_STALE_MS = 3 * 60_000;

/** 「機械」の様子の材料。 */
export interface MachineConfig {
  /** 様子の知らせを置く場所。 */
  dir: string;
  version: string;
  /** データベース（アプリのロール）。 */
  databaseUrl: string;
  filesDir: string;
  /** 控えの置き場。設定していなければ `null`。 */
  backupDir: string | null;
  /** 入口の名前（`APP_BASE_URL` の名前）。無ければ `null`。 */
  host: string | null;
  /** ローカル AI の口とモデル。無ければ `null`。 */
  localLlm: { url: string; model: string | null } | null;
  /** 運営への稼働の知らせの受け口（第8.6.8節）。無ければ `null`。 */
  heartbeat?: HeartbeatConfig | null;
  /** 社外の控えを設定しているか（第8.6.5節）。 */
  offsite?: boolean;
  /** 共通の入口の置き場（第8.6.9節）。ほかの製品が遠隔の保守を持つかを見る。 */
  frontDir?: string | null;
}

/** 「機械」の様子。 */
export interface MachineStatus {
  version: string;
  checkedAt: string;
  database: { ok: boolean; ms: number | null; error: string | null };
  worker: { ok: boolean; lastSeen: string | null; version: string | null };
  entrance: { host: string | null; certExpires: string | null; certDaysLeft: number | null; error: string | null };
  localAi: { configured: boolean; ok: boolean; models: string[]; error: string | null };
  disk: { data: { free: number; total: number } | null; backup: { free: number; total: number } | null };
  backup: { configured: boolean; status: BackupStatus | null; offsite: { configured: boolean; status: OffsiteStatus | null } };
  /** 更新（第8.6.4節）。update.sh が書いた結果と、止めている期限。 */
  update: UpdateStatus;
  /** 遠隔の保守（第8.6.4節）。 */
  maintenance: MaintenanceStatus;
  /** 運営への稼働の知らせ（第8.6.8節）。 */
  heartbeat: HeartbeatStatus;
}

/** ワーカーが動いていることを書く（見回りのたび。30 秒より短い間隔では書かない）。 */
let lastBeat = 0;
export async function writeWorkerBeat(dir: string, version: string, now: Date = new Date()): Promise<void> {
  if (now.getTime() - lastBeat < 30_000) return;
  lastBeat = now.getTime();
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'worker.json'), JSON.stringify({ at: now.toISOString(), version, pid: process.pid }));
}

/** 失敗の理由（つながらないときは中身の無い例外が来るため、理由の符号か決まった文にする）。 */
const why = (err: unknown) => (err instanceof Error ? err.message || (err as { code?: string }).code || 'つながりませんでした' : String(err));

/** 時間を区切って待つ。 */
const within = <T>(ms: number, p: Promise<T>): Promise<T> => Promise.race([p, new Promise<T>((_, rej) => setTimeout(() => rej(new Error('時間内に答えがありませんでした')), ms))]);

/** 入口の証明書の期限（443 番につないで確かめる）。 */
async function certExpiry(host: string): Promise<string> {
  return within(5000, new Promise<string>((resolve, reject) => {
    const s = tlsConnect({ host, port: 443, servername: host, rejectUnauthorized: false }, () => {
      const c = s.getPeerCertificate();
      s.end();
      if (!c?.valid_to) reject(new Error('証明書を読めませんでした')); else resolve(new Date(c.valid_to).toISOString());
    });
    s.on('error', reject);
  }));
}

/**
 * 「機械」の様子を集める。
 *
 * @remarks どの確かめも数秒で打ち切り、確かめられなかったことを理由と一緒に返す（推測で埋めない）
 */
export async function machineStatus(cfg: MachineConfig, now: Date = new Date()): Promise<MachineStatus> {
  const database = await (async () => {
    const started = Date.now();
    const c = new pg.Client({ connectionString: cfg.databaseUrl, connectionTimeoutMillis: 3000 });
    try {
      await c.connect();
      await within(3000, c.query('select 1'));
      return { ok: true, ms: Date.now() - started, error: null };
    } catch (err) {
      return { ok: false, ms: null, error: why(err) };
    } finally {
      await c.end().catch(() => undefined);
    }
  })();
  const worker = await (async () => {
    try {
      const w = JSON.parse(await readFile(join(cfg.dir, 'worker.json'), 'utf8')) as { at: string; version: string };
      return { ok: now.getTime() - Date.parse(w.at) < WORKER_STALE_MS, lastSeen: w.at, version: w.version };
    } catch {
      return { ok: false, lastSeen: null, version: null };
    }
  })();
  const entrance = await (async () => {
    if (!cfg.host) return { host: null, certExpires: null, certDaysLeft: null, error: null };
    try {
      const exp = await certExpiry(cfg.host);
      return { host: cfg.host, certExpires: exp, certDaysLeft: Math.floor((Date.parse(exp) - now.getTime()) / 86_400_000), error: null };
    } catch (err) {
      return { host: cfg.host, certExpires: null, certDaysLeft: null, error: why(err) };
    }
  })();
  const localAi = await (async () => {
    if (!cfg.localLlm) return { configured: false, ok: false, models: [], error: null };
    try {
      const res = await within(4000, fetch(`${cfg.localLlm.url.replace(/\/$/, '')}/models`));
      if (!res.ok) throw new Error(`ローカル AI が ${res.status} を返しました`);
      const body = await res.json() as { data?: { id?: string }[] };
      return { configured: true, ok: true, models: (body.data ?? []).map((m) => m.id ?? '').filter(Boolean).slice(0, 10), error: null };
    } catch (err) {
      return { configured: true, ok: false, models: [], error: why(err) };
    }
  })();
  return {
    version: cfg.version,
    checkedAt: now.toISOString(),
    database, worker, entrance, localAi,
    disk: { data: await diskSpace(cfg.filesDir), backup: cfg.backupDir ? await diskSpace(cfg.backupDir) : null },
    backup: {
      configured: !!cfg.backupDir,
      status: cfg.backupDir ? await readBackupStatus(cfg.backupDir) : null,
      offsite: { configured: !!(cfg.offsite && cfg.backupDir), status: cfg.offsite && cfg.backupDir ? await readOffsiteStatus(cfg.backupDir) : null },
    },
    update: await readUpdateStatus(cfg.dir, now),
    maintenance: await readMaintenanceStatus(cfg.dir, now, cfg.frontDir ?? null),
    heartbeat: await readHeartbeatStatus(cfg.dir, cfg.heartbeat ?? null),
  };
}
