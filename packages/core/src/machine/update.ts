/**
 * @file ローカルの形の更新の様子（仕様書 第8.6.4節・第8.6.7節、ADR-0077）。
 *
 * 更新そのものは、機械の上の `deploy/onsite/update.sh`（管理者の権限で夜に動く）が行い、結果を「機械」の置き場の
 * `update.json` に書く。ここはそれを読むことと、会社の管理者が「機械」の画面で更新を止める・延ばす印（`update-hold.json`）を書くこと、
 * 失敗を 1 度だけ知らせるための印（`update-notified.json`）を扱う。M2Office のプロセスから更新を始めることはしない
 * （専用の利用者には、プログラムを入れ替える権限を持たせないため）。
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

/** 1 回の更新の結果（update.sh が書く）。 */
export interface UpdateRecord {
  at: string;
  /** 前の版（タグ）。 */
  from: string;
  /** 入れようとした版（タグ）。 */
  to: string;
  /** `updated` 入れた・`rolled-back` 確かめに失敗して前の版に戻した・`failed` 入れる前に止めた（署名・取得など）・`none` 新しい版が無かった。 */
  result: 'updated' | 'rolled-back' | 'failed' | 'none';
  error?: string;
}

/** 更新の設定（setup.sh が書く）。 */
export interface UpdateSettings {
  /** 夜に自動で入れるか（タグの署名の鍵が入っているときだけ）。 */
  auto: boolean;
  /** タグの署名を確かめる鍵が入っているか。 */
  signed: boolean;
  /** 自動の更新の時刻（日本時間の時）。 */
  hour: number;
}

/** 「機械」に出す更新の様子。 */
export interface UpdateStatus {
  settings: UpdateSettings | null;
  last: UpdateRecord | null;
  history: UpdateRecord[];
  /** 会社の管理者が止めている（延ばしている）なら、その期限。 */
  heldUntil: string | null;
}

async function readJson<T>(path: string): Promise<T | null> {
  try { return JSON.parse(await readFile(path, 'utf8')) as T; } catch { return null; }
}

/** 更新の様子を読む。 */
export async function readUpdateStatus(dir: string, now: Date = new Date()): Promise<UpdateStatus> {
  const [settings, file, hold] = await Promise.all([
    readJson<UpdateSettings>(join(dir, 'update-settings.json')),
    readJson<{ history?: UpdateRecord[] }>(join(dir, 'update.json')),
    readJson<{ until?: string }>(join(dir, 'update-hold.json')),
  ]);
  const history = (file?.history ?? []).filter((r) => r && typeof r.at === 'string').slice(-10);
  const until = hold?.until && Date.parse(hold.until) > now.getTime() ? hold.until : null;
  return { settings, last: history[history.length - 1] ?? null, history, heldUntil: until };
}

/**
 * 自動の更新を止める（延ばす）か、止めるのをやめる。
 *
 * @param days 延ばす日数（1〜30）。`null` なら止めるのをやめる
 * @returns 止めている期限（やめたら `null`）
 */
export async function holdUpdates(dir: string, days: number | null, by: string, now: Date = new Date()): Promise<string | null> {
  await mkdir(dir, { recursive: true });
  const until = days === null ? null : new Date(now.getTime() + Math.min(30, Math.max(1, Math.round(days))) * 86_400_000).toISOString();
  await writeFile(join(dir, 'update-hold.json'), JSON.stringify({ until, by, at: now.toISOString() }));
  return until;
}

/**
 * まだ知らせていない失敗の更新を返し、知らせた印を付ける（ワーカーが見回りで呼ぶ）。
 *
 * @returns 知らせる更新の結果。無ければ `null`
 */
export async function takeUnnotifiedUpdateFailure(dir: string): Promise<UpdateRecord | null> {
  const { last } = await readUpdateStatus(dir);
  if (!last || (last.result !== 'rolled-back' && last.result !== 'failed')) return null;
  const done = await readJson<{ at?: string }>(join(dir, 'update-notified.json'));
  if (done?.at === last.at) return null;
  await writeFile(join(dir, 'update-notified.json'), JSON.stringify({ at: last.at }));
  return last;
}
