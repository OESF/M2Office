/**
 * @file 日ごとのシフト（時間の帯）と張り出し用の PDF（仕様書 第30.6.2節）の試験。
 *
 * 行の並び・休みの人・1 時間ごとの人数と要る人数・時刻の軸・日をまたぐ勤務と、PDF が日ごとの紙になること。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PDFDocument } from 'pdf-lib';
import type { HrShift, HrShiftSettings } from '@m2office/shared';
import { buildShiftBoard, renderShiftBoardPdf, boardDateLabel } from '../src/hr/shift-board.js';

const settings: HrShiftSettings = {
  variable: false, special44: false,
  patterns: [
    { id: 'early', name: '早番', start: '7:00', end: '16:00', breakMinutes: 60 },
    { id: 'late', name: '遅番', start: '14:00', end: '23:00', breakMinutes: 60 },
  ],
  // 2026-11-02 は月曜
  needs: [{ day: 1, patternId: 'early', count: 2 }, { day: 1, patternId: 'late', count: 1 }],
};
const members = [{ employeeId: 'a', name: '伊藤 翔太' }, { employeeId: 'b', name: '井上 結衣' }, { employeeId: 'c', name: '加藤 恵' }];
const shift = (employeeId: string, date: string, patternId: string | null): HrShift => {
  const p = settings.patterns.find((x) => x.id === patternId);
  return { employeeId, date, patternId, start: p?.start ?? '', end: p?.end ?? '', breakMinutes: p?.breakMinutes ?? 0 };
};

test('始業の早い順に並べ、休みの人を分け、時刻の軸を勤務と要る人数の型に合わせる', () => {
  const b = buildShiftBoard([{ date: '2026-11-02', status: 'published', settings, members, shifts: [shift('c', '2026-11-02', 'late'), shift('a', '2026-11-02', 'early'), shift('b', '2026-11-02', null)] }]);
  assert.equal(b.fromHour, 7);
  assert.equal(b.toHour, 23);
  const d = b.days[0]!;
  assert.deepEqual(d.rows.map((r) => [r.name, r.patternName, r.start]), [['伊藤 翔太', '早番', '7:00'], ['加藤 恵', '遅番', '14:00']]);
  assert.deepEqual(d.off, ['井上 結衣']);
});

test('1 時間ごとの人数と要る人数を、その時間の真ん中で数える', () => {
  const b = buildShiftBoard([{ date: '2026-11-02', status: 'published', settings, members, shifts: [shift('a', '2026-11-02', 'early'), shift('c', '2026-11-02', 'late')] }]);
  const at = (h: number) => b.days[0]!.hours.find((x) => x.hour === h)!;
  assert.deepEqual([at(8).count, at(8).need], [1, 2]);
  assert.deepEqual([at(15).count, at(15).need], [2, 3]);
  assert.deepEqual([at(22).count, at(22).need], [1, 1]);
});

test('日をまたぐ勤務は、軸を 24 時より先へ伸ばして数える', () => {
  const night: HrShiftSettings = { ...settings, needs: [], patterns: [{ id: 'n', name: '夜勤', start: '22:00', end: '6:00', breakMinutes: 60 }] };
  const b = buildShiftBoard([{ date: '2026-11-03', status: 'draft', settings: night, members, shifts: [{ employeeId: 'a', date: '2026-11-03', patternId: 'n', start: '22:00', end: '6:00', breakMinutes: 60 }] }]);
  assert.equal(b.fromHour, 22);
  assert.equal(b.toHour, 30);
  assert.equal(b.days[0]!.hours.find((x) => x.hour === 25)!.count, 1);
});

test('シフトが無い日は、ふつうの勤務の時間を軸にする', () => {
  const b = buildShiftBoard([{ date: '2026-11-08', status: 'none', settings: { ...settings, needs: [] }, members, shifts: [] }]);
  assert.deepEqual([b.fromHour, b.toHour], [9, 18]);
  assert.equal(b.days[0]!.rows.length, 0);
});

test('PDF は 1 日 1 枚の A4 横になる', async () => {
  const days = ['2026-11-02', '2026-11-03'].map((date) => ({ date, status: 'published' as const, settings, members, shifts: [shift('a', date, 'early'), shift('c', date, 'late')] }));
  const bytes = await renderShiftBoardPdf({ board: buildShiftBoard(days), company: '見本株式会社', createdAt: '2026-10-31 12:00' });
  const pdf = await PDFDocument.load(bytes);
  assert.equal(pdf.getPageCount(), 2);
  const { width, height } = pdf.getPage(0).getSize();
  assert.ok(width > height);
  assert.equal(boardDateLabel('2026-11-02'), '2026年11月2日（月）');
});
