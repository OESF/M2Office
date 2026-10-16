/**
 * @file 画面でその場で録る録音（仕様書 第9.4.5.1節、ADR-0099）。
 *
 * 画面は 16 kHz・モノラル・16 ビットの PCM を 10 秒ごとの欠片にして送り、止めたときにサーバーが順につないで 1 つの WAV にする。
 * できた WAV は、渡された録音と同じ道（文字にする・録音を消す）を通る。欠片はファイルの置き場に置き、止めずに 1 日たったら見回りが消す。
 */

import { randomUUID } from 'node:crypto';
import type { StoredFile } from '@m2office/shared';
import type { LiveRecording, Repository } from '../repository/types.js';
import type { FileStore } from './store.js';
import { saveFile } from './service.js';
import { MAX_AUDIO_SECONDS } from './formats.js';
import { silentLogger, type Logger } from '../log/logger.js';

/** その場で録る録音の標本化の周波数。Gemini は音声を 16 kHz 相当に落として扱うため、これより細かくしても聞き取りは良くならない。 */
export const LIVE_SAMPLE_RATE = 16_000;
/** 1 秒あたりの大きさ（モノラル・16 ビット）。 */
const BYTES_PER_SEC = LIVE_SAMPLE_RATE * 2;
/** 1 つの欠片の上限（画面は 10 秒ごとに送る。遅れてまとめて送るときの余裕を見て 30 秒分）。 */
export const LIVE_PART_MAX_BYTES = BYTES_PER_SEC * 30;
/** 欠片の番号の上限（10 秒ごとで 3 時間なら 1,080。送り直しの余裕を見る）。 */
const LIVE_SEQ_MAX = 100_000;
/** 途中の録音の合わせた大きさの上限（3 時間分）。 */
export const LIVE_MAX_BYTES = BYTES_PER_SEC * MAX_AUDIO_SECONDS;
/** 止めずに残った途中の録音を持つ長さ（ミリ秒）。 */
export const LIVE_RECORDING_STALE_MS = 24 * 3_600_000;

/** 途中の録音の操作が断られたときの例外。`status` は HTTP の状態に使う。 */
export class LiveRecordingError extends Error {
  constructor(message: string, readonly status: 400 | 404 | 409 | 413) {
    super(message);
    this.name = 'LiveRecordingError';
  }
}

/** 欠片を置く名前（ファイルの置き場の決まりに合わせ、英数字とハイフンだけ）。 */
const partKey = (recordingId: string, seq: number) => `${recordingId}-${String(seq).padStart(6, '0')}`;

/** 録った長さ（秒）。 */
export const liveSeconds = (bytes: number) => Math.floor(bytes / BYTES_PER_SEC);

/**
 * 16 kHz・モノラル・16 ビットの WAV の見出し（44 バイト）。
 *
 * @param dataBytes 音の部分の大きさ
 */
export function wavHeader(dataBytes: number, sampleRate: number = LIVE_SAMPLE_RATE): Uint8Array {
  const b = new Uint8Array(44);
  const v = new DataView(b.buffer);
  const ascii = (at: number, s: string) => { for (let i = 0; i < s.length; i++) b[at + i] = s.charCodeAt(i); };
  ascii(0, 'RIFF'); v.setUint32(4, 36 + dataBytes, true); ascii(8, 'WAVE');
  ascii(12, 'fmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
  v.setUint32(24, sampleRate, true); v.setUint32(28, sampleRate * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true);
  ascii(36, 'data'); v.setUint32(40, dataBytes, true);
  return b;
}

/**
 * 録音を始める。本人の途中の録音がすでにあれば、新しく作らずにそれを返す（`resumed: true`。画面は続けるか使うかを選ばせる）。
 *
 * @remarks 録音を受け取れる会社か（ローカルの方針・AI の設定）は、呼び出し側が先に確かめる
 */
export async function startLiveRecording(repo: Repository, who: { tenantId: string; userId: string }, now: Date = new Date()): Promise<{ recording: LiveRecording; resumed: boolean }> {
  const existing = await repo.getLiveRecording(who.tenantId, who.userId);
  if (existing) return { recording: existing, resumed: true };
  const id = `lr-${randomUUID()}`;
  const created = await repo.createLiveRecording({ id, tenantId: who.tenantId, userId: who.userId, createdAt: now.toISOString() });
  const recording = await repo.getLiveRecording(who.tenantId, who.userId);
  if (!recording) throw new LiveRecordingError('録音を始められませんでした', 409);
  return { recording, resumed: !created };
}

/** 本人の途中の録音で、ID が合うものを返す。無ければ断る（他人の録音の存在は示さない）。 */
async function ownRecording(repo: Repository, who: { tenantId: string; userId: string }, recordingId: string): Promise<LiveRecording> {
  const rec = await repo.getLiveRecording(who.tenantId, who.userId);
  if (!rec || rec.id !== recordingId) throw new LiveRecordingError('録音が見つかりません', 404);
  return rec;
}

/**
 * 欠片を 1 つ受ける。同じ番号をもう一度受けたら置き換える（送り直しで 2 つにならない）。
 *
 * @throws LiveRecordingError 本人の録音でない・欠片の形が違う・3 時間を超える
 */
export async function putLiveRecordingPart(
  repo: Repository, store: FileStore, who: { tenantId: string; userId: string }, recordingId: string, seq: number, bytes: Uint8Array, now: Date = new Date(),
): Promise<LiveRecording> {
  if (!Number.isInteger(seq) || seq < 0 || seq > LIVE_SEQ_MAX) throw new LiveRecordingError('欠片の番号が正しくありません', 400);
  if (bytes.byteLength === 0 || bytes.byteLength % 2 !== 0) throw new LiveRecordingError('録音の欠片の形が正しくありません', 400);
  if (bytes.byteLength > LIVE_PART_MAX_BYTES) throw new LiveRecordingError('録音の欠片が大きすぎます', 413);
  const rec = await ownRecording(repo, who, recordingId);
  const same = (await repo.listLiveRecordingParts(who.tenantId, recordingId)).find((p) => p.seq === seq);
  if (rec.bytes - (same?.size ?? 0) + bytes.byteLength > LIVE_MAX_BYTES) throw new LiveRecordingError('録音が 3 時間を超えました', 413);
  await store.put(who.tenantId, partKey(recordingId, seq), bytes);
  await repo.putLiveRecordingPart(who.tenantId, recordingId, seq, bytes.byteLength, now.toISOString());
  return (await repo.getLiveRecording(who.tenantId, who.userId))!;
}

/** 録音の名前（「録音 2026-10-16 14-30.wav」。始めた日本時間）。 */
export function liveRecordingName(startedAt: string): string {
  const p = Object.fromEntries(new Intl.DateTimeFormat('ja-JP', {
    timeZone: 'Asia/Tokyo', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(new Date(startedAt)).map((x) => [x.type, x.value]));
  return `録音 ${p.year}-${p.month}-${p.day} ${p.hour}-${p.minute}.wav`;
}

/**
 * 録音を止めて、欠片を順につないだ 1 つの WAV のファイルにする。欠片と途中の録音は消す。
 *
 * @returns できたファイルと、録った長さ（秒）
 * @throws LiveRecordingError 本人の録音でない・何も録れていない
 * @remarks 番号が飛んでいても（画面を閉じて失った欠片）、ある分を順につなぐ
 */
export async function finishLiveRecording(
  repo: Repository, store: FileStore, who: { tenantId: string; userId: string }, recordingId: string,
): Promise<{ file: StoredFile; seconds: number }> {
  const rec = await ownRecording(repo, who, recordingId);
  const parts = await repo.listLiveRecordingParts(who.tenantId, recordingId);
  const chunks: Uint8Array[] = [];
  for (const p of parts) {
    const b = await store.get(who.tenantId, partKey(recordingId, p.seq));
    if (b) chunks.push(b);
  }
  const dataBytes = chunks.reduce((n, c) => n + c.byteLength, 0);
  if (dataBytes === 0) throw new LiveRecordingError('録音されていません', 400);
  const bytes = new Uint8Array(44 + dataBytes);
  bytes.set(wavHeader(dataBytes), 0);
  let at = 44;
  for (const c of chunks) { bytes.set(c, at); at += c.byteLength; }
  const file = await saveFile(repo, store, {
    tenantId: who.tenantId, ownerUserId: who.userId, name: liveRecordingName(rec.createdAt), kind: 'wav', bytes, origin: 'upload', runId: null,
  });
  await removeLiveRecording(repo, store, who.tenantId, recordingId, parts);
  return { file, seconds: liveSeconds(dataBytes) };
}

/** 途中の録音を消す（「削除」「キャンセル」）。本人のものだけ。 */
export async function discardLiveRecording(repo: Repository, store: FileStore, who: { tenantId: string; userId: string }, recordingId: string): Promise<LiveRecording> {
  const rec = await ownRecording(repo, who, recordingId);
  await removeLiveRecording(repo, store, who.tenantId, recordingId, await repo.listLiveRecordingParts(who.tenantId, recordingId));
  return rec;
}

async function removeLiveRecording(repo: Repository, store: FileStore, tenantId: string, recordingId: string, parts: { seq: number }[]): Promise<void> {
  await repo.deleteLiveRecording(tenantId, recordingId);
  for (const p of parts) await store.remove(tenantId, partKey(recordingId, p.seq));
}

/**
 * 止めずに 1 日たった途中の録音を、全部の会社で消す（ワーカーが 10 分ごとに呼ぶ。録音は残さない）。
 *
 * @returns 消した数
 * @remarks テナント境界: 会社ごとに、その会社の録音だけを消す（不変則 I-2）。監査ログ `file.audio_discard`（大きさ・長さだけ。中身は残さない）
 */
export async function discardStaleLiveRecordings(repo: Repository, store: FileStore, now: Date = new Date(), logger: Logger = silentLogger): Promise<number> {
  const before = new Date(now.getTime() - LIVE_RECORDING_STALE_MS).toISOString();
  let removed = 0;
  for (const tenantId of await repo.listTenantIds()) {
    try {
      for (const rec of await repo.listStaleLiveRecordings(tenantId, before)) {
        await removeLiveRecording(repo, store, tenantId, rec.id, await repo.listLiveRecordingParts(tenantId, rec.id));
        await repo.appendAudit({
          id: randomUUID(), tenantId, actorType: 'system', actorId: 'recordings', action: 'file.audio_discard', targetType: 'live_recording', targetId: rec.id,
          detail: { size: rec.bytes, seconds: liveSeconds(rec.bytes), transcribed: false, live: true }, occurredAt: now.toISOString(),
        });
        removed++;
      }
    } catch (err) {
      // 1 社の失敗で、ほかの会社の見回りを止めない
      logger.error('途中の録音の見回りで例外が発生しました', { tenantId, err });
    }
  }
  return removed;
}
