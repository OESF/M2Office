/**
 * @file ローカルの形の控え（仕様書 第8.6.5節）。毎晩、データベース（論理の控え）とファイルの置き場を、RAID とは別のディスクに取る。
 * 毎月 1 回、控えを別のデータベースに戻せるかを確かめる。
 *
 * データベースは `pg_dump`（独自の形式）、ファイルは `rsync`（前の控えと同じファイルは共有して場所を取らない）。
 * 開発ではデータベースがコンテナの中にあるため、`M2O_PG_DOCKER` でコンテナの名前を渡すと、その中の道具を使う。
 * 残す数は毎日 14 回・毎週 8 回・毎月 12 回（{@link backupsToKeep}）。
 */

import { execFile, spawn } from 'node:child_process';
import { createReadStream, createWriteStream, existsSync } from 'node:fs';
import { mkdir, readdir, readFile, rm, stat, statfs, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import pg from 'pg';

const run = promisify(execFile);

/** 控えの設定。 */
export interface BackupConfig {
  /** 控えの置き場（RAID とは別のディスク）。 */
  dir: string;
  /** ファイルの置き場（`FILE_STORAGE_DIR`）。 */
  filesDir: string;
  /** データベースの所有者の接続（`MIGRATION_DATABASE_URL`）。 */
  ownerUrl: string;
  /** PostgreSQL の道具のある場所（同梱した実行環境）。無ければ PATH から探す。 */
  pgBin?: string | null;
  /** 開発用: データベースのコンテナの名前。あればその中の道具を使う。 */
  pgDocker?: string | null;
}

/** 1 回の控え。 */
export interface BackupRecord {
  /** 控えの名前（`YYYYMMDD-HHMMSS`。日本時間）。 */
  name: string;
  at: string;
  ok: boolean;
  /** データベースの控えの大きさ（バイト）。 */
  dbBytes: number;
  error: string | null;
}

/** 控えの状態（`status.json`）。 */
export interface BackupStatus {
  last: BackupRecord | null;
  /** 最後にうまくいった控え。 */
  lastOk: string | null;
  restoreTest: { at: string; ok: boolean; name: string; tables: number; error: string | null } | null;
}

const STATUS = 'status.json';
const REQUEST = 'backup-request';
const NAME = /^\d{8}-\d{6}$/;

/** 日本時間の控えの名前。 */
export function backupName(now: Date): string {
  const j = new Date(now.getTime() + 9 * 3_600_000).toISOString();
  return `${j.slice(0, 10).replace(/-/g, '')}-${j.slice(11, 19).replace(/:/g, '')}`;
}

/**
 * 残す控えを選ぶ（新しいものから毎日 14 回・毎週 8 回・毎月 12 回）。
 *
 * @param names 控えの名前（`YYYYMMDD-HHMMSS`）
 * @returns 残す名前
 */
export function backupsToKeep(names: string[]): Set<string> {
  const sorted = names.filter((n) => NAME.test(n)).sort().reverse();
  const keep = new Set<string>();
  const pick = (key: (n: string) => string, limit: number) => {
    const seen = new Set<string>();
    for (const n of sorted) {
      const k = key(n);
      if (seen.has(k)) continue;
      seen.add(k);
      keep.add(n);
      if (seen.size >= limit) break;
    }
  };
  const day = (n: string) => n.slice(0, 8);
  const week = (n: string) => {
    const d = new Date(Date.UTC(Number(n.slice(0, 4)), Number(n.slice(4, 6)) - 1, Number(n.slice(6, 8))));
    return String(Math.floor((d.getTime() / 86_400_000 + 3) / 7));
  };
  pick(day, 14);
  pick(week, 8);
  pick((n) => n.slice(0, 6), 12);
  return keep;
}

/** 控えの状態を読む（無ければ空）。 */
export async function readBackupStatus(dir: string): Promise<BackupStatus> {
  try {
    return JSON.parse(await readFile(join(dir, STATUS), 'utf8')) as BackupStatus;
  } catch {
    return { last: null, lastOk: null, restoreTest: null };
  }
}

async function writeStatus(dir: string, s: BackupStatus): Promise<void> {
  await writeFile(join(dir, STATUS), `${JSON.stringify(s, null, 2)}\n`);
}

/** 「今すぐ控えを取る」の頼みを置く（ワーカーが次の見回りで取る）。 */
export async function requestBackup(dir: string, by: string): Promise<void> {
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, REQUEST), JSON.stringify({ by, at: new Date().toISOString() }));
}

/** 頼みがあれば取り除いて `true`。 */
export async function takeBackupRequest(dir: string): Promise<boolean> {
  if (!existsSync(join(dir, REQUEST))) return false;
  await rm(join(dir, REQUEST), { force: true });
  return true;
}

/** 接続の URL を道具の引数にする。 */
function conn(url: string) {
  const u = new URL(url);
  return { user: decodeURIComponent(u.username), password: decodeURIComponent(u.password), host: u.hostname, port: u.port || '5432', db: u.pathname.slice(1) };
}

/**
 * PostgreSQL の道具を動かす（同梱の道具か、開発ではコンテナの中の道具）。
 *
 * @param input 標準入力に流すファイル（戻すとき）
 * @param output 標準出力を書くファイル（控えを取るとき）
 */
function pgTool(cfg: BackupConfig, tool: string, args: string[], dbUrl: string, io: { input?: string; output?: string } = {}): Promise<void> {
  const c = conn(dbUrl);
  const [cmd, full] = cfg.pgDocker
    // コンテナの中では、データベースは自分の 5432 番で受けている
    ? ['docker', ['exec', '-i', '-e', `PGPASSWORD=${c.password}`, cfg.pgDocker, tool, '-h', '127.0.0.1', '-p', '5432', '-U', c.user, ...args]]
    : [cfg.pgBin ? join(cfg.pgBin, tool) : tool, ['-h', c.host, '-p', c.port, '-U', c.user, ...args]];
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, full, { env: { ...process.env, PGPASSWORD: c.password }, stdio: ['pipe', io.output ? 'pipe' : 'ignore', 'pipe'] });
    let err = '';
    p.stderr!.on('data', (d) => { err += String(d); });
    // 書き出しが終わるのを待ってから終える（道具が先に終わっても、ファイルの最後が書き切れていないことがある）
    const written = io.output ? new Promise<void>((ok, ng) => { const w = createWriteStream(io.output!); p.stdout!.pipe(w); w.on('finish', () => ok()); w.on('error', ng); }) : Promise.resolve();
    if (io.input) createReadStream(io.input).pipe(p.stdin!); else p.stdin!.end();
    p.on('error', reject);
    p.on('close', (code) => {
      if (code !== 0) { reject(new Error(err.trim().split('\n').slice(-2).join(' ') || `${tool} が ${code} で終わりました`)); return; }
      written.then(resolve, reject);
    });
  });
}

/**
 * 控えを 1 回取る。古い控えを片付ける。
 *
 * @remarks 危険度: 社内の書き込み（控えの置き場だけ）。データベースは読むだけ
 */
export async function runBackup(cfg: BackupConfig, now: Date = new Date()): Promise<BackupRecord> {
  const name = backupName(now);
  const at = now.toISOString();
  const dest = join(cfg.dir, name);
  const status = await readBackupStatus(cfg.dir);
  let record: BackupRecord;
  try {
    await mkdir(join(dest, 'files'), { recursive: true });
    const dump = join(dest, 'db.dump');
    await pgTool(cfg, 'pg_dump', ['--format=custom', '--no-owner', '-d', conn(cfg.ownerUrl).db], cfg.ownerUrl, { output: dump });
    const bytes = (await stat(dump)).size;
    if (bytes < 100) throw new Error('データベースの控えが空です');
    // ファイルは、前の控えと同じものを共有する（場所を取らない）
    const prev = status.lastOk && existsSync(join(cfg.dir, status.lastOk, 'files')) ? join(cfg.dir, status.lastOk, 'files') : null;
    if (existsSync(cfg.filesDir)) {
      await run('rsync', ['-a', '--delete', ...(prev ? [`--link-dest=${prev}`] : []), `${cfg.filesDir.replace(/\/$/, '')}/`, `${join(dest, 'files')}/`]);
    }
    await writeFile(join(dest, 'DONE'), at);
    record = { name, at, ok: true, dbBytes: bytes, error: null };
  } catch (err) {
    record = { name, at, ok: false, dbBytes: 0, error: err instanceof Error ? err.message.slice(0, 300) : String(err) };
    await rm(dest, { recursive: true, force: true }).catch(() => undefined);
  }
  // 古い控えを片付ける（うまくいった控えだけを数える）
  const names = (await readdir(cfg.dir).catch(() => [] as string[])).filter((n) => NAME.test(n) && existsSync(join(cfg.dir, n, 'DONE')));
  const keep = backupsToKeep(names);
  for (const n of names) if (!keep.has(n)) await rm(join(cfg.dir, n), { recursive: true, force: true });
  await writeStatus(cfg.dir, { ...status, last: record, lastOk: record.ok ? name : status.lastOk });
  return record;
}

/**
 * いちばん新しい控えを、別のデータベースに戻せるかを確かめる（毎月 1 回。第8.6.5節）。確かめたら別のデータベースは消す。
 *
 * @returns 確かめた結果（控えが無ければ `null`）
 */
export async function restoreTest(cfg: BackupConfig, now: Date = new Date()): Promise<BackupStatus['restoreTest']> {
  const status = await readBackupStatus(cfg.dir);
  if (!status.lastOk) return null;
  const temp = `m2o_restore_test_${Date.now().toString(36)}`;
  const admin = new pg.Client({ connectionString: cfg.ownerUrl });
  let result: NonNullable<BackupStatus['restoreTest']>;
  await admin.connect();
  try {
    await admin.query(`create database ${temp}`);
    const tempUrl = cfg.ownerUrl.replace(/\/[^/?]+(\?|$)/, `/${temp}$1`);
    await pgTool(cfg, 'pg_restore', ['--no-owner', '--no-privileges', '-d', temp], tempUrl, { input: join(cfg.dir, status.lastOk, 'db.dump') });
    const c = new pg.Client({ connectionString: tempUrl });
    await c.connect();
    const tables = Number((await c.query<{ n: string }>(`select count(*) as n from information_schema.tables where table_schema = 'public'`)).rows[0]?.n ?? 0);
    const tenants = Number((await c.query<{ n: string }>('select count(*) as n from tenants').catch(() => ({ rows: [{ n: '0' }] }))).rows[0]?.n ?? 0);
    await c.end();
    if (tables === 0 || tenants === 0) throw new Error('戻した控えに表か会社がありません');
    result = { at: now.toISOString(), ok: true, name: status.lastOk, tables, error: null };
  } catch (err) {
    result = { at: now.toISOString(), ok: false, name: status.lastOk, tables: 0, error: err instanceof Error ? err.message.slice(0, 300) : String(err) };
  } finally {
    await admin.query(`drop database if exists ${temp}`).catch(() => undefined);
    await admin.end();
  }
  await writeStatus(cfg.dir, { ...(await readBackupStatus(cfg.dir)), restoreTest: result });
  return result;
}

/** ディスクの空き（バイト）。分からなければ `null`。 */
export async function diskSpace(path: string): Promise<{ free: number; total: number } | null> {
  try {
    const s = await statfs(path);
    return { free: s.bavail * s.bsize, total: s.blocks * s.bsize };
  } catch {
    return null;
  }
}
