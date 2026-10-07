/**
 * @file ローカルの形の社外の控え（仕様書 第8.6.5節）。会社が選んだときだけ、毎晩の控えを restic で暗号化して、
 * 会社が契約した S3 互換の置き場へ送る。
 *
 * 暗号化の合言葉は導入のときに機械の上で作り、紙の「戻すための控え」に書いて会社に渡す。運営は合言葉も置き場の鍵も持たない。
 * restic は送る前に暗号化し、前回と同じ部分は送らない。控えの置き場の 1 回分（`db.dump` と `files/`）を、
 * その中から相対の道で送るので、毎晩の名前が違っても前回の控えを親にでき、変わったところだけを読む。
 * 残す数は社内の控えと同じ（毎日 14 回・毎週 8 回・毎月 12 回）。毎月 1 回、置き場の中身の一部を読み戻して壊れていないかを確かめる。
 */

import { spawn } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

/** 社外の控えの設定。 */
export interface OffsiteConfig {
  /** restic の置き場（`s3:https://<口>/<バケット>/<道>`）。 */
  repository: string;
  /** 暗号化の合言葉（導入のときに機械の上で作る）。 */
  password: string;
  /** 置き場の鍵（会社が契約した S3 互換の置き場のアクセスキー）。 */
  accessKeyId: string;
  secretAccessKey: string;
  /** 地域（要る置き場だけ）。 */
  region: string | null;
  /** restic の道（Homebrew で入れたもの）。無ければ PATH から探す。 */
  resticBin: string | null;
  /** restic の手元の索引の置き場（専用の利用者は家の置き場を持たないため）。 */
  cacheDir: string;
}

/** 社外の控えの 1 回。 */
export interface OffsiteRecord {
  /** 送った社内の控えの名前。 */
  name: string;
  at: string;
  ok: boolean;
  /** restic の控えの番号。 */
  snapshot: string | null;
  /** 新しく送った量（バイト）。 */
  bytesAdded: number;
  error: string | null;
}

/** 社外の控えの状態（控えの置き場の `offsite.json`）。 */
export interface OffsiteStatus {
  last: OffsiteRecord | null;
  /** 最後にうまくいった restic の控えの番号（次の回の親）。 */
  lastOkSnapshot: string | null;
  /** 毎月の、置き場の中身が壊れていないかの確かめ。 */
  check: { at: string; ok: boolean; error: string | null } | null;
}

const STATUS = 'offsite.json';
/** restic の控えに付ける印と機械の名前（残す数を数えるまとまり）。 */
const TAG = 'm2office';
const HOST = 'm2office';
/** 社内の控えと同じ残し方（第8.6.5節）。 */
export const OFFSITE_KEEP = ['--keep-daily', '14', '--keep-weekly', '8', '--keep-monthly', '12'] as const;
/** 毎月の確かめで読み戻す割合。 */
const CHECK_SUBSET = '5%';
/** 1 回に待つ長さ（最初の回は量が多いため長くとる）。 */
const RESTIC_TIMEOUT_MS = 8 * 3_600_000;

/** 環境変数から設定を読む（置き場・合言葉・鍵がそろっていなければ `null`）。 */
export function offsiteConfigFromEnv(env: Record<string, string | undefined>, machineDir: string): OffsiteConfig | null {
  const repository = env['M2O_OFFSITE_REPOSITORY']?.trim();
  const password = env['M2O_OFFSITE_PASSWORD'];
  const accessKeyId = env['M2O_OFFSITE_ACCESS_KEY_ID']?.trim();
  const secretAccessKey = env['M2O_OFFSITE_SECRET_ACCESS_KEY'];
  if (!repository || !password || !accessKeyId || !secretAccessKey || !repository.startsWith('s3:')) return null;
  return {
    repository, password, accessKeyId, secretAccessKey,
    region: env['M2O_OFFSITE_REGION']?.trim() || null,
    resticBin: env['M2O_RESTIC_BIN']?.trim() || null,
    cacheDir: join(machineDir, 'restic-cache'),
  };
}

/** 社外の控えの状態を読む（無ければ空）。 */
export async function readOffsiteStatus(backupDir: string): Promise<OffsiteStatus> {
  try {
    return JSON.parse(await readFile(join(backupDir, STATUS), 'utf8')) as OffsiteStatus;
  } catch {
    return { last: null, lastOkSnapshot: null, check: null };
  }
}

async function writeStatus(backupDir: string, s: OffsiteStatus): Promise<void> {
  await writeFile(join(backupDir, STATUS), `${JSON.stringify(s, null, 2)}\n`);
}

/**
 * restic を動かす。合言葉と鍵は、子の環境変数にだけ渡す（引数やログに出さない）。
 *
 * @returns 標準出力
 */
function restic(cfg: OffsiteConfig, args: string[], cwd?: string): Promise<string> {
  const env: Record<string, string> = {
    PATH: process.env['PATH'] ?? '/usr/bin:/bin',
    RESTIC_REPOSITORY: cfg.repository,
    RESTIC_PASSWORD: cfg.password,
    AWS_ACCESS_KEY_ID: cfg.accessKeyId,
    AWS_SECRET_ACCESS_KEY: cfg.secretAccessKey,
    RESTIC_CACHE_DIR: cfg.cacheDir,
    ...(cfg.region ? { AWS_DEFAULT_REGION: cfg.region } : {}),
  };
  return new Promise((resolve, reject) => {
    const p = spawn(cfg.resticBin || 'restic', args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    const timer = setTimeout(() => p.kill('SIGTERM'), RESTIC_TIMEOUT_MS);
    p.stdout.on('data', (d) => { out += String(d); });
    p.stderr.on('data', (d) => { err += String(d); });
    p.on('error', (e) => { clearTimeout(timer); reject(e); });
    p.on('close', (code, signal) => {
      clearTimeout(timer);
      if (code === 0) { resolve(out); return; }
      const reason = signal ? `restic を ${RESTIC_TIMEOUT_MS / 3_600_000} 時間で打ち切りました` : err.trim().split('\n').slice(-2).join(' ') || `restic が ${code} で終わりました`;
      reject(new Error(reason));
    });
  });
}

/** restic の `backup --json` の最後の要約から、控えの番号と新しく送った量を取る。 */
export function parseBackupSummary(out: string): { snapshot: string | null; bytesAdded: number } {
  for (const line of out.trim().split('\n').reverse()) {
    try {
      const j = JSON.parse(line) as { message_type?: string; snapshot_id?: string; data_added?: number };
      if (j.message_type === 'summary') return { snapshot: j.snapshot_id ?? null, bytesAdded: j.data_added ?? 0 };
    } catch { /* 要約でない行 */ }
  }
  return { snapshot: null, bytesAdded: 0 };
}

/**
 * 社内の控えの 1 回分を、社外へ送る。送ったら、残す数を超えた古い控えを置き場から消す。
 *
 * @param backupDir 控えの置き場
 * @param name 送る社内の控えの名前（うまくいったもの）
 * @remarks 危険度: 社外への送信。ただし会社が導入のときに選び、会社が契約した置き場へ、会社だけが合言葉を持つ暗号化をしてから送る（第8.6.5節）。中身は運営にも置き場の事業者にも読めない
 */
export async function runOffsite(backupDir: string, name: string, cfg: OffsiteConfig, now: Date = new Date()): Promise<OffsiteRecord> {
  const status = await readOffsiteStatus(backupDir);
  const at = now.toISOString();
  let record: OffsiteRecord;
  try {
    await mkdir(cfg.cacheDir, { recursive: true });
    const args = ['backup', '--json', '--tag', TAG, '--host', HOST, ...(status.lastOkSnapshot ? ['--parent', status.lastOkSnapshot] : []), 'db.dump', 'files'];
    const sum = parseBackupSummary(await restic(cfg, args, join(backupDir, name)));
    if (!sum.snapshot) throw new Error('restic が控えの番号を返しませんでした');
    // 古い控えを消す。道が毎晩違うため、印と機械の名前でまとめて数える
    await restic(cfg, ['forget', '--tag', TAG, '--group-by', 'host,tags', ...OFFSITE_KEEP, '--prune']);
    record = { name, at, ok: true, snapshot: sum.snapshot, bytesAdded: sum.bytesAdded, error: null };
  } catch (err) {
    record = { name, at, ok: false, snapshot: null, bytesAdded: 0, error: err instanceof Error ? err.message.slice(0, 300) : String(err) };
  }
  await writeStatus(backupDir, { ...(await readOffsiteStatus(backupDir)), last: record, lastOkSnapshot: record.ok ? record.snapshot : status.lastOkSnapshot });
  return record;
}

/**
 * 置き場の中身が壊れていないかを確かめる（毎月 1 回。中身の一部を読み戻す）。
 *
 * @remarks 危険度: 読み取り（置き場から読むだけ）
 */
export async function checkOffsite(backupDir: string, cfg: OffsiteConfig, now: Date = new Date()): Promise<NonNullable<OffsiteStatus['check']>> {
  let check: NonNullable<OffsiteStatus['check']>;
  try {
    await mkdir(cfg.cacheDir, { recursive: true });
    await restic(cfg, ['check', `--read-data-subset=${CHECK_SUBSET}`]);
    check = { at: now.toISOString(), ok: true, error: null };
  } catch (err) {
    check = { at: now.toISOString(), ok: false, error: err instanceof Error ? err.message.slice(0, 300) : String(err) };
  }
  await writeStatus(backupDir, { ...(await readOffsiteStatus(backupDir)), check });
  return check;
}
