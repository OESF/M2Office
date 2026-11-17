/**
 * @file 定型の照会（予定・未読メール・タスク）の答えが、中身を本文に並べることの単体テスト（仕様書 第10.9.2節）。
 *
 * 2026-11-17 に「今週の予定」に「今後 7 日間の予定は 5 件です」とだけ答え、予定の中身は「根拠」に隠れていた。
 * 「詳細を表示して」と頼んでも同じ答えだった。中身は本文に並べ、根拠には出どころだけを残す。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DIRECT_QUERIES, eventLine } from '../src/secretary/catalog.js';

const q = (id: string) => DIRECT_QUERIES.find((x) => x.id === id)!;
const day = (offset: number, h = 0) => {
  const d = new Date(Date.now() + offset * 86_400_000);
  const ymd = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Tokyo' }).format(d);
  return new Date(`${ymd}T${String(h).padStart(2, '0')}:00:00+09:00`).toISOString();
};

test('予定の照会は、件数だけでなく予定の中身を本文に並べる。終日の予定に 0 時と出さない', async () => {
  const events = [
    { id: 'e1', title: '燃えるごみ', start: day(0), end: day(1), attendees: [], location: null, allDay: true },
    { id: 'e2', title: '企画会議', start: day(1, 10), end: day(1, 11), attendees: [], location: '会議室 A' },
  ];
  const ctx = {
    tenantId: 't', userId: 'u', message: '今週の予定は？',
    connector: { sourceFor: () => 'google', calendar: { list: async () => events } },
  } as never;
  const a = await q('calendar-range').answer(ctx);
  const lines = a.text.split('\n');
  assert.equal(lines[0], '今後 7 日間の予定は 2 件です。');
  assert.match(lines[2]!, /^- \d+\/\d+\(.\) 終日　燃えるごみ$/);
  assert.match(lines[3]!, /^- \d+\/\d+\(.\) 10:00〜11:00　企画会議（会議室 A）$/);
  assert.equal(a.evidence.length, 0, '中身を根拠に隠さない（出どころだけ）');
  assert.equal(eventLine(events[1]!, false), '- 10:00〜11:00　企画会議（会議室 A）', '今日の予定は時刻だけ');
});

test('未読メールとタスクの照会も、中身を本文に並べる', async () => {
  const mail = await q('mail-unread').answer({
    tenantId: 't', userId: 'u', message: '未読メールは？',
    connector: { sourceFor: () => 'google', mail: { unread: async () => ({ total: 7, more: false, items: [{ from: '"山田 太郎" <yamada@client.example>', subject: '見積の件' }] }) } },
  } as never);
  assert.equal(mail.text, '受信トレイに未読のメールが 7 件あります。\n\n- 山田 太郎: 見積の件\n- ほか 6 件');
  const tasks = await q('tasks-today').answer({
    tenantId: 't', userId: 'u', message: '今日のタスクは？',
    connector: { sourceFor: () => 'google', tasks: { list: async () => [{ id: 'k1', title: '請求書を出す', due: day(-1) }] } },
  } as never);
  assert.match(tasks.text, /\n\n- （期限切れ）請求書を出す$/);
});
