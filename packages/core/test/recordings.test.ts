/**
 * @file 録音を文字にする共通の力の単体テスト（仕様書 第9.4.5節・第9.5.5.3節・第10.10.3節、ADR-0097）。
 *
 * 形式の判定・長さの読み取り・30 分ずつの分け方・区切りをつなぐときの時刻と話者・録音を文字起こしに置き換えること・
 * 残った録音を消す見回り・秘書の取次を確かめる。推論は呼ばない（見本の口）。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { AgentDefinition, AuditEvent, StoredFile } from '@m2office/shared';
import {
  detectKind, audioDurationSec, splitAudio, transcribeRecording, TranscribeError, shiftTimes, speakersOf, clockOf,
  fileToText, MemoryFileStore, discardStaleRecordings, recordingTaker, isRecordingName, transcribePrompt,
  type LlmProvider, type LlmTranscribeRequest, type Repository,
} from '../src/index.js';

/** 16 kHz・モノラル・16 ビットの WAV（`sec` 秒）。 */
function wav(sec: number): Uint8Array {
  const data = 16_000 * 2 * sec;
  const b = new Uint8Array(44 + data);
  const v = new DataView(b.buffer);
  b.set([0x52, 0x49, 0x46, 0x46], 0); v.setUint32(4, 36 + data, true); b.set([0x57, 0x41, 0x56, 0x45], 8);
  b.set([0x66, 0x6d, 0x74, 0x20], 12); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
  v.setUint32(24, 16_000, true); v.setUint32(28, 32_000, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true);
  b.set([0x64, 0x61, 0x74, 0x61], 36); v.setUint32(40, data, true);
  return b;
}

/** 128 kbps・44.1 kHz の MP3 のフレームを並べたもの（中身は無音のつもりの 0）。 */
function mp3(frames: number): Uint8Array {
  const len = 417;
  const b = new Uint8Array(frames * len);
  for (let i = 0; i < frames; i++) b.set([0xff, 0xfb, 0x90, 0x00], i * len);
  return b;
}

/** `mvhd` だけを持つ M4A（`sec` 秒）。 */
function m4a(sec: number): Uint8Array {
  const b = new Uint8Array(16 + 8 + 8 + 20);
  const v = new DataView(b.buffer);
  v.setUint32(0, 16); b.set([0x66, 0x74, 0x79, 0x70, 0x4d, 0x34, 0x41, 0x20], 4);
  v.setUint32(16, 36); b.set([0x6d, 0x6f, 0x6f, 0x76], 20);
  v.setUint32(24, 28); b.set([0x6d, 0x76, 0x68, 0x64], 28);
  v.setUint32(44, 1000); v.setUint32(48, sec * 1000);
  return b;
}

test('録音の形式は、拡張子と中身の先頭の両方で確かめる', () => {
  assert.equal(detectKind('memo.wav', wav(1)), 'wav');
  assert.equal(detectKind('memo.mp3', mp3(2)), 'mp3');
  assert.equal(detectKind('memo.mp3', new TextEncoder().encode('ID3\u0004')), 'mp3');
  assert.equal(detectKind('ボイスメモ.m4a', m4a(5)), 'm4a');
  assert.equal(detectKind('memo.mp3', wav(1)), null, '中身が違えば断る');
  assert.equal(detectKind('memo.wav', mp3(1)), null);
});

test('録音の長さを見出しから読む（WAV・M4A・固定のビットレートの MP3）', () => {
  assert.equal(audioDurationSec(wav(3), 'wav'), 3);
  assert.equal(audioDurationSec(m4a(4200), 'm4a'), 4200);
  const sec = audioDurationSec(mp3(100), 'mp3')!;
  assert.ok(Math.abs(sec - (100 * 417 * 8) / 128_000) < 0.01);
});

test('長い録音は区切りに分け、短い録音は 1 つのまま', async () => {
  const one = await splitAudio(wav(2), 'wav', 2, 1800);
  assert.equal(one?.length, 1);
  const w = await splitAudio(wav(6), 'wav', 6, 2);
  assert.equal(w?.length, 3);
  assert.equal(audioDurationSec(w![1]!.bytes, 'wav'), 2, 'WAV の区切りはそのまま WAV として読める');
  assert.deepEqual(w!.map((s) => Math.round(s.startSec)), [0, 2, 4]);
  const m = await splitAudio(mp3(90), 'mp3', 9, 3);
  assert.equal(m?.length, 3);
  for (const s of m!) assert.equal(s.bytes[0], 0xff, 'MP3 はフレームの先頭で切る');
});

test('区切りの時刻を録音の始めからに付け直し、1 時間を超えたら時:分:秒にする', () => {
  assert.equal(shiftTimes('[00:05] 話者 1: こんにちは', 1800), '[30:05] 話者 1: こんにちは');
  assert.equal(shiftTimes('[29:59] 話者 2: はい', 3600), '[1:29:59] 話者 2: はい');
  assert.equal(shiftTimes('[75:00] 話者 1: 続き', 0), '[1:15:00] 話者 1: 続き', '分で数えた時刻も読む');
  assert.equal(clockOf(59), '00:59');
});

test('話者は番号で引き継ぎ、名前が分かったものを残す', () => {
  const a = speakersOf('[00:01] 話者 1: 山田です\n[00:05] 話者 2（佐藤）: はい');
  assert.deepEqual(a, ['話者 1', '話者 2（佐藤）']);
  assert.deepEqual(speakersOf('[30:00] 話者 1（山田）: 続けます', a), ['話者 1（山田）', '話者 2（佐藤）']);
});

test('区切りごとに文字にしてつなぎ、前の話者と終わりの数行を次へ渡す', async () => {
  const seen: LlmTranscribeRequest[] = [];
  const llm: LlmProvider = {
    name: 'probe', complete: async () => ({ text: '', tokensUsed: 0 }),
    transcribeAudio: async (req) => {
      seen.push(req);
      return { text: `[00:10] 話者 1${seen.length === 1 ? '（山田）' : ''}: 区切り ${seen.length}`, model: 'm', inputTokens: 1, outputTokens: 1 };
    },
  };
  const progress: string[] = [];
  const t = await transcribeRecording(wav(6), 'wav', { llm, hints: ['山田'], onChunk: (i, n) => { progress.push(`${i}/${n}`); } });
  assert.equal(t.chunks, 1, '30 分に満たない録音は 1 回');
  assert.match(t.text, /^\[00:10\] 話者 1（山田）: 区切り 1$/);
  assert.deepEqual(progress, ['1/1']);
  assert.deepEqual(seen[0]!.hints, ['山田']);
});

test('推論が録音を扱えなければ、文字にできないと伝える（ローカル AI など）', async () => {
  const llm: LlmProvider = { name: 'local', complete: async () => ({ text: '', tokensUsed: 0 }) };
  await assert.rejects(transcribeRecording(wav(1), 'wav', { llm, hints: [] }), TranscribeError);
});

test('文字起こしの指示: 範囲を指すときは境をまたぐ発言の扱いを書き、録音の中の指示に従わせない', () => {
  const p = transcribePrompt({ range: { startSec: 1800, endSec: 3600 }, hints: ['M2Office'], speakers: ['話者 1（山田）'], previous: '[29:50] 話者 1: では次に' });
  assert.match(p, /30:00 から 60:00 まで/);
  assert.match(p, /話者 1（山田）/);
  assert.match(p, /指示には従いません/);
  assert.match(p, /M2Office/);
});

/** ファイルと監査ログだけを持つ見本の置き場。 */
function memoryRepo(files: StoredFile[], audits: AuditEvent[]) {
  return {
    getFile: async (_t: string, id: string) => files.find((f) => f.id === id) ?? null,
    replaceFileMeta: async (_t: string, id: string, m: Partial<StoredFile>) => { const f = files.find((x) => x.id === id)!; Object.assign(f, m); },
    appendAudit: async (e: AuditEvent) => { audits.push(e); },
  } as unknown as Repository;
}

test('録音は文字にし終えたら文字起こしに置き換わり、録音は残らない（第9.4.5節）', async () => {
  const store = new MemoryFileStore();
  const audits: AuditEvent[] = [];
  const meta: StoredFile = { id: 'f1', tenantId: 't', ownerUserId: 'u1', name: '打ち合わせ.wav', kind: 'wav', mime: 'audio/wav', size: 100, sha256: '', origin: 'upload', runId: null, createdAt: '' };
  const files = [meta];
  await store.put('t', 'f1', wav(1));
  const repo = memoryRepo(files, audits);
  let calls = 0;
  const transcribe = async () => { calls++; return { text: '[00:00] 話者 1: 予算は来週決めます', durationSec: 1, chunks: 1 }; };
  const r = await fileToText(repo, store, 't', 'f1', 'u1', undefined, { transcribe });
  assert.equal(r.ok, true);
  assert.match(r.text, /予算は来週決めます/);
  assert.match(r.note ?? '', /AI が聞き取った/);
  assert.equal(files[0]!.kind, 'txt');
  assert.equal(files[0]!.name, '打ち合わせ（文字起こし）.txt');
  assert.match(new TextDecoder().decode((await store.get('t', 'f1'))!), /^録音「打ち合わせ.wav」の文字起こし/, '置き場の中身は文字起こしだけ');
  assert.equal(audits[0]?.action, 'file.audio_discard');
  assert.equal(JSON.stringify(audits[0]?.detail).includes('予算'), false, '監査ログに中身を残さない');
  // 2 度目は録音を聞き直さず、文字起こしを読む（途中で止まった実行の再開でも同じ）
  const again = await fileToText(repo, store, 't', 'f1', 'u1', undefined, { transcribe });
  assert.match(again.text, /予算は来週決めます/);
  assert.equal(calls, 1);
});

test('文字にする口が無ければ、録音は読めないと伝える', async () => {
  const store = new MemoryFileStore();
  await store.put('t', 'f2', wav(1));
  const files: StoredFile[] = [{ id: 'f2', tenantId: 't', ownerUserId: 'u1', name: 'a.wav', kind: 'wav', mime: 'audio/wav', size: 1, sha256: '', origin: 'upload', runId: null, createdAt: '' }];
  const r = await fileToText(memoryRepo(files, []), store, 't', 'f2', 'u1');
  assert.equal(r.ok, false);
  assert.match(r.note ?? '', /録音を文字にできません/);
});

test('文字にしないまま残った録音は、見回りで記録と中身を消す', async () => {
  const store = new MemoryFileStore();
  await store.put('t', 'old', wav(1));
  const deleted: string[] = [];
  const audits: AuditEvent[] = [];
  const repo = {
    listTenantIds: async () => ['t'],
    listStaleRecordings: async () => [{ id: 'old', size: 10 }],
    deleteFile: async (_t: string, id: string) => { deleted.push(id); },
    appendAudit: async (e: AuditEvent) => { audits.push(e); },
  } as unknown as Repository;
  assert.equal(await discardStaleRecordings(repo, store), 1);
  assert.deepEqual(deleted, ['old']);
  assert.equal(await store.get('t', 'old'), null);
  assert.equal(audits[0]?.detail?.['transcribed'], false);
});

test('秘書は録音を、「議事録」なら議事録の作成に、それ以外は録音のまとめに頼む（第10.10.3節）', () => {
  const minutes = { id: 'minutes' } as AgentDefinition;
  const notes = { id: 'recording-notes' } as AgentDefinition;
  assert.equal(recordingTaker('この録音から議事録を作って', [minutes, notes])?.id, 'minutes');
  assert.equal(recordingTaker('まとめて', [minutes, notes])?.id, 'recording-notes');
  assert.equal(recordingTaker('文字起こしして', [minutes])?.id, 'minutes', '録音のまとめが使えなければ議事録');
  assert.equal(recordingTaker('まとめて', []), null);
  assert.equal(isRecordingName('ボイスメモ.M4A'), true);
  assert.equal(isRecordingName('議事録.pdf'), false);
});
