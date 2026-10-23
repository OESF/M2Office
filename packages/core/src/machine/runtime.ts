/**
 * @file 動いている環境（仕様書 第8.6.7.1節）。M2Office が動いているソフトと機械の様子を集める。
 *
 * - API とワーカーは、起動のときと 5 分ごとに、自分の M2Office の版・Node.js の版・起動の時刻・機械の様子（OS・CPU・メモリー）を
 *   データベースの `runtime_beats` に置く（移行 156。会社を持たない表）。画面はそれを読む（クラウドの形では、運営の画面の
 *   別のプロセスからも読めるように、機械のファイルではなくデータベースに置く）
 * - 外（nodejs.org など）へは見に行かない。Node.js の段階とサポートの終わりは `@m2office/shared` の表で決める
 * - 取れなかった値は `null`（推測で埋めない）。秘密の値・業務の中身・個人の情報は入れない
 * - M2Medical の同じ部品（packages/core/src/runtime.ts。2026-10-22）を、M2Office の形（会社を持たない表・API も知らせを置く）に合わせて写した
 */

import { execFile } from 'node:child_process';
import os from 'node:os';
import type pg from 'pg';
import { nodeSupport, type NodeSecurityNotice, type RuntimeBeat, type RuntimeEnvironment, type RuntimeMachine, type RuntimeProcess } from '@m2office/shared';
import { createPool } from '../repository/pool.js';
import type { LocalLlmConfig } from '../llm/local.js';

/** 知らせを置く間隔（ミリ秒）。 */
export const RUNTIME_BEAT_INTERVAL_MS = 5 * 60_000;

/** 知らせがこれより古ければ、止まっているかもしれないとする（知らせは 5 分ごと）。 */
export const RUNTIME_BEAT_STALE_MS = 12 * 60_000;

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

/** いまの機械の様子（OS・CPU・メモリー）。 */
export async function currentMachine(): Promise<RuntimeMachine> {
  const [name, vm] = await Promise.all([osName().catch(() => null), process.platform === 'darwin' ? run('vm_stat', []) : Promise.resolve(null)]);
  const cpus = os.cpus();
  return {
    os: name, arch: process.arch, cpu: cpus[0]?.model?.trim() || null, cores: cpus.length || null,
    memTotal: os.totalmem(), memFree: (vm && availableMemoryOf(vm)) || os.freemem(),
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
}

interface BeatRow { role: 'api' | 'worker'; version: string | null; node: string; started_at: Date; at: Date; os_name: string | null; arch: string | null; cpu: string | null; cores: number | null; mem_total: string | number | null; mem_free: string | number | null }
const numOrNull = (v: unknown) => (v === null || v === undefined ? null : Number(v));

/** 行から知らせへ（運営の置き場からも使う）。 */
export function beatFromRow(r: BeatRow): RuntimeBeat {
  return {
    role: r.role, version: r.version, node: r.node, startedAt: new Date(r.started_at).toISOString(), at: new Date(r.at).toISOString(),
    machine: { os: r.os_name, arch: r.arch, cpu: r.cpu, cores: r.cores, memTotal: numOrNull(r.mem_total), memFree: numOrNull(r.mem_free) },
  };
}

/** PostgreSQL の置き場（会社を持たない表 `runtime_beats`）。 */
export class PostgresRuntimeBeatStore implements RuntimeBeatStore {
  private readonly pool: pg.Pool;

  constructor(connectionString: string) {
    this.pool = createPool(connectionString, { max: 1, name: 'runtime' });
  }

  async write(b: Omit<RuntimeBeat, 'at'>): Promise<void> {
    await this.pool.query(
      `insert into runtime_beats (role, version, node, started_at, at, os_name, arch, cpu, cores, mem_total, mem_free) values ($1,$2,$3,$4,now(),$5,$6,$7,$8,$9,$10)
       on conflict (role) do update set version = excluded.version, node = excluded.node, started_at = excluded.started_at, at = now(),
         os_name = excluded.os_name, arch = excluded.arch, cpu = excluded.cpu, cores = excluded.cores, mem_total = excluded.mem_total, mem_free = excluded.mem_free`,
      [b.role, b.version, b.node, b.startedAt, b.machine.os, b.machine.arch, b.machine.cpu, b.machine.cores, b.machine.memTotal, b.machine.memFree]);
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

/**
 * 自分の知らせを置く（起動のときと 5 分ごと）。失敗しても処理は止めない。
 *
 * @param startedAt その処理の起動の時刻
 */
export async function writeRuntimeBeat(store: RuntimeBeatStore, role: 'api' | 'worker', version: string | null, startedAt: Date): Promise<void> {
  await store.write({ role, version, node: process.version, startedAt: startedAt.toISOString(), machine: await currentMachine() });
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
 */
export function runtimeEnvironment(beats: RuntimeBeat[], postgres: string | null, o: { deployment: 'onsite' | 'cloud'; debug: boolean; inference: string | null; now?: Date }): RuntimeEnvironment {
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
    checkedAt: now.toISOString(),
  };
}
