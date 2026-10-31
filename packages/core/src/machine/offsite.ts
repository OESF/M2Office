/**
 * @file ローカルの形の別の置き場の控え（仕様書 第8.6.5節）。会社が選んだときだけ、毎晩の控えを restic で暗号化して、
 * 社内の NAS の rest-server（足せるが消せない形）か、会社が契約した S3 互換の置き場へ送る（ADR-0120）。
 *
 * 暗号化の合言葉は導入のときに機械の上で作り、紙の「戻すための控え」に書いて会社に渡す。運営は合言葉も置き場の鍵も持たない。
 * restic は送る前に暗号化し、前回と同じ部分は送らない。控えの置き場の 1 回分（`db.dump` と `files/`）を、
 * その中から相対の道で送るので、毎晩の名前が違っても前回の控えを親にでき、変わったところだけを読む。
 * 残す数は社内の控えと同じ（毎日 14 回・毎週 8 回・毎月 12 回）。ただし NAS の rest-server は足せるが消せない形で受けるので、
 * 機械は古い控えを消さない（間引くのは NAS の管理者）。毎月 1 回、置き場の中身の一部を読み戻して壊れていないかを確かめる。
 */

import { spawn } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

/** 別の置き場の控えの設定。 */
export interface OffsiteConfig {
  /** restic の置き場（`s3:https://<口>/<バケット>/<道>` か、NAS の `rest:https://<NAS>:<ポート>/<道>`）。 */
  repository: string;
  /** 暗号化の合言葉（導入のときに機械の上で作る）。 */
  password: string;
  /** 置き場の鍵（S3 互換の置き場のアクセスキー。NAS では `null`）。 */
  accessKeyId: string | null;
  secretAccessKey: string | null;
  /** NAS の rest-server の利用者と合言葉（S3 互換の置き場では無し）。 */
  restUser?: string | null;
  restPassword?: string | null;
  /** NAS が自分で作った証明書のファイル（要るときだけ）。 */
  cacert?: string | null;
  /** 地域（要る置き場だけ）。 */
  region: string | null;
  /** restic の道（Homebrew で入れたもの）。無ければ PATH から探す。 */
  resticBin: string | null;
  /** restic の手元の索引の置き場（専用の利用者は家の置き場を持たないため）。 */
  cacheDir: string;
}

/** 別の置き場の控えの 1 回。 */
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

/** 別の置き場の控えの状態（控えの置き場の `offsite.json`）。 */
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

/**
 * 置き場が NAS の rest-server か。rest-server は足せるが消せない形（`--append-only`）で受ける前提なので、
 * 機械は古い控えを消さない（ADR-0120）。
 */
export function isAppendOnly(cfg: Pick<OffsiteConfig, 'repository'>): boolean {
  return cfg.repository.startsWith('rest:');
}

/**
 * 環境変数から設定を読む。置き場と合言葉に加え、S3 互換の置き場ならアクセスキー、NAS の rest-server なら利用者と合言葉が
 * そろっていなければ `null`。
 */
export function offsiteConfigFromEnv(env: Record<string, string | undefined>, machineDir: string): OffsiteConfig | null {
  const repository = env['M2O_OFFSITE_REPOSITORY']?.trim();
  const password = env['M2O_OFFSITE_PASSWORD'];
  if (!repository || !password) return null;
  const common = {
    repository, password,
    region: env['M2O_OFFSITE_REGION']?.trim() || null,
    resticBin: env['M2O_RESTIC_BIN']?.trim() || null,
    cacheDir: join(machineDir, 'restic-cache'),
    cacert: env['M2O_OFFSITE_CACERT']?.trim() || null,
  };
  if (repository.startsWith('s3:')) {
    const accessKeyId = env['M2O_OFFSITE_ACCESS_KEY_ID']?.trim();
    const secretAccessKey = env['M2O_OFFSITE_SECRET_ACCESS_KEY'];
    if (!accessKeyId || !secretAccessKey) return null;
    return { ...common, accessKeyId, secretAccessKey, restUser: null, restPassword: null };
  }
  if (repository.startsWith('rest:')) {
    const restUser = env['M2O_OFFSITE_REST_USER']?.trim();
    const restPassword = env['M2O_OFFSITE_REST_PASSWORD'];
    if (!restUser || !restPassword) return null;
    return { ...common, accessKeyId: null, secretAccessKey: null, restUser, restPassword };
  }
  return null;
}

/** 別の置き場の控えの状態を読む（無ければ空）。 */
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
    RESTIC_CACHE_DIR: cfg.cacheDir,
    ...(cfg.accessKeyId && cfg.secretAccessKey ? { AWS_ACCESS_KEY_ID: cfg.accessKeyId, AWS_SECRET_ACCESS_KEY: cfg.secretAccessKey } : {}),
    ...(cfg.region ? { AWS_DEFAULT_REGION: cfg.region } : {}),
    ...(cfg.restUser && cfg.restPassword ? { RESTIC_REST_USERNAME: cfg.restUser, RESTIC_REST_PASSWORD: cfg.restPassword } : {}),
    ...(cfg.cacert ? { RESTIC_CACERT: cfg.cacert } : {}),
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
 * 社内の控えの 1 回分を、別の置き場へ送る。S3 互換の置き場では、送ったら残す数を超えた古い控えを置き場から消す。
 * NAS の rest-server は足せるが消せない形なので消さない。
 *
 * @param backupDir 控えの置き場
 * @param name 送る社内の控えの名前（うまくいったもの）
 * @remarks 危険度: 社外への送信（S3 互換の置き場のとき）。ただし会社が導入のときに選び、会社が契約した置き場へ、会社だけが合言葉を持つ暗号化をしてから送る（第8.6.5節）。中身は運営にも置き場の事業者にも読めない。NAS のときは社内の送信
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
    // 古い控えを消す。道が毎晩違うため、印と機械の名前でまとめて数える。足せるが消せない置き場では消さない
    if (!isAppendOnly(cfg)) await restic(cfg, ['forget', '--tag', TAG, '--group-by', 'host,tags', ...OFFSITE_KEEP, '--prune']);
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
