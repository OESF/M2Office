/**
 * @file 動いている環境（仕様書 第8.6.7.1節）。M2Office が動いているソフトと機械の様子を集める。
 *
 * - API とワーカーは、起動のときと 5 分ごとに、自分の M2Office の版・Node.js の版・起動の時刻・機械の様子（OS・CPU・メモリー）を
 *   データベースの `runtime_beats` に置く（移行 156。会社を持たない表）。画面はそれを読む（クラウドの形では、運営の画面の
 *   別のプロセスからも読めるように、機械のファイルではなくデータベースに置く）
 * - API は同じときに、機械の資源（CPU の負荷・メモリー・Swap・ディスク）の標本を `runtime_samples` に置き、7 日より古いものを消す（第23.8.7節「機械の資源の図」）
 * - 外（nodejs.org など）へは見に行かない。Node.js の段階とサポートの終わりは `@m2office/shared` の表で決める
 * - 取れなかった値は `null`（推測で埋めない）。秘密の値・業務の中身・個人の情報は入れない
 * - M2Medical の同じ部品（packages/core/src/runtime.ts。2026-10-22）を、M2Office の形（会社を持たない表・API も知らせを置く）に合わせて写した
 */

import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import os from 'node:os';
import type pg from 'pg';
import {
  nodeSupport, type NodeSecurityNotice, type RuntimeBeat, type RuntimeEnvironment, type RuntimeMachine, type RuntimeProcess, type RuntimeSampleDays, type RuntimeSamplePoint,
} from '@m2office/shared';
import { diskSpace } from './backup.js';
import { createPool } from '../repository/pool.js';
import type { LocalLlmConfig } from '../llm/local.js';

/** 知らせを置く間隔（ミリ秒）。 */
export const RUNTIME_BEAT_INTERVAL_MS = 5 * 60_000;

/** 知らせがこれより古ければ、止まっているかもしれないとする（知らせは 5 分ごと）。 */
export const RUNTIME_BEAT_STALE_MS = 12 * 60_000;

/**
 * ワーカーが動いていることの知らせの間隔（仕様書 第8.6.7.1節「ワーカーが止まったら」）。業務の処理とは別の時計で置くので、
 * 長い業務を動かしている間も途切れない。
 */
export const WORKER_BEAT_INTERVAL_MS = 60_000;

/** ワーカーの知らせがこれより古ければ、止まっているとする（知らせは 1 分ごと）。 */
export const WORKER_DOWN_MS = 3 * 60_000;

/**
 * ワーカーが止まっているか。ワーカーの知らせが無い（一度も動いていない）か、{@link WORKER_DOWN_MS} より古ければ止まっている。
 */
export function workerDown(beats: readonly RuntimeBeat[], now: Date = new Date()): boolean {
  const w = beats.find((b) => b.role === 'worker');
  return !w || now.getTime() - Date.parse(w.at) > WORKER_DOWN_MS;
}

/** 日本の今日（YYYY-MM-DD）。 */
const todayJst = (now: Date) => new Date(now.getTime() + 9 * 3_600_000).toISOString().slice(0, 10);

/** 外のコマンドを、時間を区切って動かす（失敗なら `null`）。 */
function run(cmd: string, args: string[]): Promise<string | null> {
  return new Promise((resolve) => { execFile(cmd, args, { timeout: 2000 }, (err, out) => resolve(err ? null : String(out))); });
}

/** OS の名前（macOS は製品の版。読めなければカーネルの版）。 */
async function osName(): Promise<string> {
  if (process.platform === 'darwin') {
    const v = (await run('sw_vers', ['-productVersion']))?.trim();
    if (v) return `macOS ${v}`;
  }
  return `${os.type()} ${os.release()}`;
}

/**
 * 使えるメモリー（バイト）。macOS は OS の空き（`os.freemem`）が控えの分を含まず少なく出るので、`vm_stat` の
 * 空き・使っていない・先読み・捨てられるページを足す。読めなければ `null`。
 */
export function availableMemoryOf(vmStat: string): number | null {
  const size = Number(/page size of (\d+) bytes/.exec(vmStat)?.[1]);
  if (!size) return null;
  const pages = (name: string) => Number(new RegExp(`Pages ${name}:\\s+(\\d+)`).exec(vmStat)?.[1] ?? 0);
  return (pages('free') + pages('inactive') + pages('speculative') + pages('purgeable')) * size;
}

/** Linux の `/proc/meminfo` から Swap（バイト）を読む。読めなければ `null`。 */
export function linuxSwapOf(meminfo: string): { total: number; free: number } | null {
  const kb = (name: string) => { const m = new RegExp(`^${name}:\\s+(\\d+) kB`, 'm').exec(meminfo); return m ? Number(m[1]) * 1024 : null; };
  const total = kb('SwapTotal');
  const free = kb('SwapFree');
  return total === null || free === null ? null : { total, free };
}

/** macOS の `sysctl vm.swapusage`（`total = 2048.00M  used = 1024.50M  free = 1023.50M`）から Swap（バイト）を読む。読めなければ `null`。 */
export function macSwapOf(swapusage: string): { total: number; free: number } | null {
  const unit = { K: 1024, M: 1024 ** 2, G: 1024 ** 3 } as const;
  const size = (name: string) => { const m = new RegExp(`${name} = ([\\d.]+)([KMG])`).exec(swapusage); return m ? Number(m[1]) * unit[m[2] as keyof typeof unit] : null; };
  const total = size('total');
  const free = size('free');
  return total === null || free === null ? null : { total: Math.round(total), free: Math.round(free) };
}

/** Swap（バイト）。Linux と macOS だけ読む。 */
async function swapSpace(): Promise<{ total: number; free: number } | null> {
  if (process.platform === 'linux') return linuxSwapOf(await readFile('/proc/meminfo', 'utf8').catch(() => ''));
  if (process.platform === 'darwin') return macSwapOf((await run('sysctl', ['-n', 'vm.swapusage'])) ?? '');
  return null;
}

/**
 * いまの機械の様子（OS・CPU・メモリー・負荷・Swap・ディスク）。
 *
 * @param diskPath ディスクの使用量を見る場所（ファイルの置き場）。無ければディスクは `null`
 */
export async function currentMachine(diskPath?: string): Promise<RuntimeMachine> {
  const [name, vm, swap, disk] = await Promise.all([
    osName().catch(() => null), process.platform === 'darwin' ? run('vm_stat', []) : Promise.resolve(null),
    swapSpace().catch(() => null), diskPath ? diskSpace(diskPath) : Promise.resolve(null),
  ]);
  const cpus = os.cpus();
  // Windows は平均の負荷を持たない（いつも 0 を返す）
  const load = process.platform === 'win32' ? null : (os.loadavg() as [number, number, number]);
  return {
    os: name, arch: process.arch, cpu: cpus[0]?.model?.trim() || null, cores: cpus.length || null,
    memTotal: os.totalmem(), memFree: (vm && availableMemoryOf(vm)) || os.freemem(),
    load, swapTotal: swap?.total ?? null, swapFree: swap?.free ?? null, diskTotal: disk?.total ?? null, diskFree: disk?.free ?? null,
  };
}

/** 推論の説明（ローカル AI のモデルと外部の AI。秘密の値・口の URL は入れない）。 */
export function inferenceText(local: LocalLlmConfig | null, deployment: 'onsite' | 'cloud'): string {
  const parts: string[] = [];
  if (local) parts.push(`ローカル AI（${[...new Set(Object.values(local.models))].join('・')}）`);
  parts.push(deployment === 'onsite' ? '外部の AI: Gemini（会社の AI の方針が許すときだけ）' : '外部の AI: Gemini（会社ごとの鍵か運営の鍵）');
  return parts.join('・');
}

/** 動いている知らせの置き場。 */
export interface RuntimeBeatStore {
  /** 知らせを置く（同じ役割の行を置き換える）。 */
  write(beat: Omit<RuntimeBeat, 'at'>): Promise<void>;
  /** 置いてある知らせ。 */
  read(): Promise<RuntimeBeat[]>;
  /** PostgreSQL の版（取れなければ `null`）。 */
  postgresVersion(): Promise<string | null>;
  /** 機械の資源の標本を置き、7 日より古いものを消す（API だけが呼ぶ）。 */
  writeSample(machine: RuntimeMachine): Promise<void>;
  /** 機械の資源の推移（使っている割合 %）。 */
  samples(days: RuntimeSampleDays): Promise<RuntimeSamplePoint[]>;
  /** データベースの大きさと接続の数・上限（取れなければ `null`）。 */
  database(): Promise<RuntimeEnvironment['database']>;
}

type Num = string | number | null;
interface BeatRow {
  role: 'api' | 'worker'; version: string | null; node: string; started_at: Date; at: Date; os_name: string | null; arch: string | null; cpu: string | null; cores: number | null;
  mem_total: Num; mem_free: Num; load1?: Num; load5?: Num; load15?: Num; swap_total?: Num; swap_free?: Num; disk_total?: Num; disk_free?: Num;
}
const numOrNull = (v: unknown) => (v === null || v === undefined ? null : Number(v));

/** 行から知らせへ（運営の置き場からも使う）。 */
export function beatFromRow(r: BeatRow): RuntimeBeat {
  const load = [numOrNull(r.load1), numOrNull(r.load5), numOrNull(r.load15)];
  return {
    role: r.role, version: r.version, node: r.node, startedAt: new Date(r.started_at).toISOString(), at: new Date(r.at).toISOString(),
    machine: {
      os: r.os_name, arch: r.arch, cpu: r.cpu, cores: r.cores, memTotal: numOrNull(r.mem_total), memFree: numOrNull(r.mem_free),
      load: load.every((x) => x !== null) ? (load as [number, number, number]) : null,
      swapTotal: numOrNull(r.swap_total), swapFree: numOrNull(r.swap_free), diskTotal: numOrNull(r.disk_total), diskFree: numOrNull(r.disk_free),
    },
  };
}

/** 推移の行から点へ（運営の置き場からも使う）。 */
export function samplePointFromRow(r: { at: Date | string; cpu: Num; memory: Num; swap: Num; disk: Num }): RuntimeSamplePoint {
  const pct = (v: Num) => (v === null ? null : Math.round(Number(v) * 10) / 10);
  return { at: new Date(r.at).toISOString(), cpu: pct(r.cpu), memory: pct(r.memory), swap: pct(r.swap), disk: pct(r.disk) };
}

/** 推移の長さを 1 日か 7 日にそろえる（画面から来た値をそのまま使わない）。 */
export const sampleDays = (v: unknown): RuntimeSampleDays => (String(v) === '7' ? 7 : 1);

/** データベースの大きさと接続の数・上限を読む SQL（運営の置き場からも使う。どのロールでも読める値だけ）。 */
export const DATABASE_USAGE_SQL = `select pg_database_size(current_database()) as bytes,
  (select count(*) from pg_stat_activity where datname = current_database()) as connections,
  current_setting('max_connections')::int as max`;

/** 行からデータベースの様子へ。 */
export function databaseFromRow(r: { bytes: Num; connections: Num; max: Num } | undefined): RuntimeEnvironment['database'] {
  return r ? { bytes: Number(r.bytes), connections: Number(r.connections), max: Number(r.max) } : null;
}

/** PostgreSQL の置き場（会社を持たない表 `runtime_beats`）。 */
export class PostgresRuntimeBeatStore implements RuntimeBeatStore {
  private readonly pool: pg.Pool;

  constructor(connectionString: string) {
    this.pool = createPool(connectionString, { max: 1, name: 'runtime' });
  }

  async write(b: Omit<RuntimeBeat, 'at'>): Promise<void> {
    await this.pool.query(
      `insert into runtime_beats (role, version, node, started_at, at, os_name, arch, cpu, cores, mem_total, mem_free, load1, load5, load15, swap_total, swap_free, disk_total, disk_free)
       values ($1,$2,$3,$4,now(),$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)
       on conflict (role) do update set version = excluded.version, node = excluded.node, started_at = excluded.started_at, at = now(),
         os_name = excluded.os_name, arch = excluded.arch, cpu = excluded.cpu, cores = excluded.cores, mem_total = excluded.mem_total, mem_free = excluded.mem_free,
         load1 = excluded.load1, load5 = excluded.load5, load15 = excluded.load15, swap_total = excluded.swap_total, swap_free = excluded.swap_free,
         disk_total = excluded.disk_total, disk_free = excluded.disk_free`,
      [b.role, b.version, b.node, b.startedAt, b.machine.os, b.machine.arch, b.machine.cpu, b.machine.cores, b.machine.memTotal, b.machine.memFree,
        b.machine.load?.[0] ?? null, b.machine.load?.[1] ?? null, b.machine.load?.[2] ?? null, b.machine.swapTotal, b.machine.swapFree, b.machine.diskTotal, b.machine.diskFree]);
  }

  async writeSample(m: RuntimeMachine): Promise<void> {
    await this.pool.query(
      `insert into runtime_samples (load1, cores, mem_total, mem_free, swap_total, swap_free, disk_total, disk_free) values ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [m.load?.[0] ?? null, m.cores, m.memTotal, m.memFree, m.swapTotal, m.swapFree, m.diskTotal, m.diskFree]);
    await this.pool.query(`delete from runtime_samples where at < now() - interval '${RUNTIME_SAMPLE_KEEP_DAYS} days'`);
  }

  async samples(days: RuntimeSampleDays): Promise<RuntimeSamplePoint[]> {
    const { rows } = await this.pool.query('select * from runtime_sample_series($1)', [days]);
    return rows.map(samplePointFromRow);
  }

  async database(): Promise<RuntimeEnvironment['database']> {
    const { rows } = await this.pool.query(DATABASE_USAGE_SQL).catch(() => ({ rows: [] }));
    return databaseFromRow(rows[0]);
  }

  async read(): Promise<RuntimeBeat[]> {
    const { rows } = await this.pool.query<BeatRow>('select * from runtime_beats');
    return rows.map(beatFromRow);
  }

  async postgresVersion(): Promise<string | null> {
    const { rows } = await this.pool.query<{ server_version: string }>('show server_version').catch(() => ({ rows: [] as { server_version: string }[] }));
    return rows[0]?.server_version?.split(' ')[0] ?? null;
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}

/** 機械の資源の標本を残す日数（第23.8.7節「機械の資源の図」）。 */
export const RUNTIME_SAMPLE_KEEP_DAYS = 7;

/**
 * 自分の知らせを置く（起動のときと 5 分ごと）。API は同じ値を機械の資源の標本としても置く（推移の図。ワーカーは同じ機械の値が重なるので置かない）。
 *
 * @param startedAt その処理の起動の時刻
 * @param diskPath ディスクの使用量を見る場所（ファイルの置き場）
 */
export async function writeRuntimeBeat(store: RuntimeBeatStore, role: 'api' | 'worker', version: string | null, startedAt: Date, diskPath?: string): Promise<void> {
  const machine = await currentMachine(diskPath);
  await store.write({ role, version, node: process.version, startedAt: startedAt.toISOString(), machine });
  if (role === 'api') await store.writeSample(machine);
}

/** 下限より古い Node.js で動いている部分（無ければ `null`）。 */
function nodeSecurityOf(parts: ['api' | 'worker', RuntimeProcess | null][]): NodeSecurityNotice | null {
  const out: NodeSecurityNotice = [];
  for (const [role, p] of parts) if (p?.node.insecure && p.node.secure) out.push({ role, version: p.node.version, secure: p.node.secure });
  return out.length ? out : null;
}

/**
 * 置いてある知らせから、動いている環境を組み立てる（画面に出す形）。
 *
 * @param o.deployment 動いている形
 * @param o.debug デバッグモードか
 * @param o.inference 推論の説明（秘密の値を含めない）
 * @param o.database データベースの大きさと接続（取れなければ省く）
 */
export function runtimeEnvironment(beats: RuntimeBeat[], postgres: string | null, o: { deployment: 'onsite' | 'cloud'; debug: boolean; inference: string | null; database?: RuntimeEnvironment['database']; now?: Date }): RuntimeEnvironment {
  const now = o.now ?? new Date();
  const today = todayJst(now);
  const proc = (role: 'api' | 'worker'): RuntimeProcess | null => {
    const b = beats.find((x) => x.role === role);
    return b ? { version: b.version, node: nodeSupport(b.node, today), startedAt: b.startedAt, lastSeen: b.at, stale: now.getTime() - Date.parse(b.at) > RUNTIME_BEAT_STALE_MS } : null;
  };
  const api = proc('api');
  const worker = proc('worker');
  const warned = [api, worker].filter((p): p is RuntimeProcess => !!p && p.node.warn).sort((a, b) => Number(b.node.expired) - Number(a.node.expired))[0];
  return {
    api, worker, postgres,
    machine: (beats.find((x) => x.role === 'api') ?? beats.find((x) => x.role === 'worker'))?.machine ?? null,
    deployment: o.deployment, debug: o.debug, inference: o.inference,
    nodeWarn: warned ? { expired: warned.node.expired, end: warned.node.end, version: warned.node.version } : null,
    nodeSecurity: nodeSecurityOf([['api', api], ['worker', worker]]),
    database: o.database ?? null,
    checkedAt: now.toISOString(),
  };
}
