/**
 * @file Google Meet の接続口の単体テスト（仕様書 第14.3.4節「Meet」・第9.5.2.1節）。手元の偽の Google に向けて呼ぶ。
 *
 * 終わった会議（題名はカレンダーの予定から・予定の無い会議は会議のコード・文字起こしの有無）、
 * 文字起こしの読み取り（ページをまたぐ・話した人の名前・題名の後ろの日付・会議の記録の ID）、
 * 参加しただけの会議を予定の会議のコードで探すこと、形の違う ID でほかの口を呼ばないことを確かめる。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { GoogleWorkspaceConnector, SecretBox, type GoogleApiEndpoints, type Repository } from '../src/index.js';
import { conferenceIdOf, meetingCodeOfEvent, splitTitleDate } from '../src/connectors/google/meet.js';

const P = { tenantId: 't1', userId: 'u1' };
const now = Date.now();
const iso = (ms: number) => new Date(ms).toISOString();
const REC1 = { name: 'conferenceRecords/REC1', startTime: iso(now - 2 * 3_600_000), endTime: iso(now - 3_600_000), space: 'spaces/S1' };
const REC2 = { name: 'conferenceRecords/REC2', startTime: iso(now - 5 * 3_600_000), endTime: iso(now - 4 * 3_600_000), space: 'spaces/S2' };
const REC3 = { name: 'conferenceRecords/REC3', startTime: iso(now - 600_000), space: 'spaces/S1' };
const REC9 = { name: 'conferenceRecords/REC9', startTime: iso(now - 26 * 3_600_000), endTime: iso(now - 25 * 3_600_000), space: 'spaces/S9' };

async function fakeMeet() {
  const seen: { path: string; query: URLSearchParams }[] = [];
  const server = createServer((req, res) => {
    const url = new URL(req.url!, 'http://x');
    seen.push({ path: url.pathname, query: url.searchParams });
    const json = (status: number, v: unknown) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(v)); };
    const p = url.pathname;
    if (p === '/oauth/token') return json(200, { access_token: 'at', expires_in: 3599 });
    if (p === '/meet/conferenceRecords') {
      const f = url.searchParams.get('filter') ?? '';
      if (f.startsWith('space.meeting_code="ppp-qqqq-rrr"')) return json(200, { conferenceRecords: [REC9] });
      if (f.startsWith('space.meeting_code=')) return json(200, {});
      return json(200, { conferenceRecords: [REC3, REC1, REC2] });
    }
    if (p === '/meet/conferenceRecords/REC1') return json(200, REC1);
    if (p === '/meet/spaces/S1') return json(200, { name: 'spaces/S1', meetingCode: 'abc-defg-hij' });
    if (p === '/meet/spaces/S2') return json(200, { name: 'spaces/S2', meetingCode: 'xyz-uvwx-stu' });
    if (p === '/meet/spaces/S9') return json(200, { name: 'spaces/S9', meetingCode: 'ppp-qqqq-rrr' });
    if (p === '/meet/conferenceRecords/REC1/transcripts') return json(200, { transcripts: [{ name: 'conferenceRecords/REC1/transcripts/T1', state: 'FILE_GENERATED' }] });
    if (p === '/meet/conferenceRecords/REC9/transcripts') return json(200, { transcripts: [{ name: 'conferenceRecords/REC9/transcripts/T9', state: 'ENDED' }] });
    if (p.endsWith('/transcripts')) return json(200, {});
    if (p === '/meet/conferenceRecords/REC1/transcripts/T1/entries') {
      return url.searchParams.get('pageToken') === 'next'
        ? json(200, { transcriptEntries: [{ participant: 'conferenceRecords/REC1/participants/P1', text: '見積は来週までに作ります。', startTime: REC1.startTime }] })
        : json(200, {
          transcriptEntries: [
            { participant: 'conferenceRecords/REC1/participants/P1', text: '今日は来月の重点顧客を決めます。', startTime: REC1.startTime },
            { participant: 'conferenceRecords/REC1/participants/P2', text: 'A 社を優先しましょう。', startTime: REC1.startTime },
          ],
          nextPageToken: 'next',
        });
    }
    if (p === '/meet/conferenceRecords/REC9/transcripts/T9/entries') return json(200, { transcriptEntries: [{ participant: 'conferenceRecords/REC9/participants/P9', text: '納期は 11 月末です。', startTime: REC9.startTime }] });
    if (p === '/meet/conferenceRecords/REC1/participants/P1') return json(200, { signedinUser: { user: 'users/1', displayName: '山田 花子' } });
    if (p === '/meet/conferenceRecords/REC1/participants/P2') return json(200, { anonymousUser: { displayName: '外部の方' } });
    if (p === '/meet/conferenceRecords/REC9/participants/P9') return json(200, { signedinUser: { displayName: '佐藤 一郎' } });
    if (p === '/cal/calendars/primary/events') {
      return json(200, {
        items: [
          { summary: '営業定例', start: { dateTime: REC1.startTime }, conferenceData: { conferenceId: 'abc-defg-hij' }, organizer: { self: true } },
          { summary: '取引先との打ち合わせ', start: { dateTime: REC9.startTime }, hangoutLink: 'https://meet.google.com/ppp-qqqq-rrr', organizer: { self: false } },
        ],
      });
    }
    json(404, { error: { code: 404 } });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const endpoints: GoogleApiEndpoints = {
    gmail: `${base}/gmail`, calendar: `${base}/cal`, tasks: `${base}/tasks`, chat: `${base}/chat`, drive: `${base}/drive`, driveUpload: `${base}/upload`,
    docs: `${base}/docs`, sheets: `${base}/sheets`, slides: `${base}/slides`, meet: `${base}/meet`,
    oauth: { auth: `${base}/oauth/auth`, token: `${base}/oauth/token`, tokeninfo: `${base}/oauth/tokeninfo`, userinfo: `${base}/oauth/userinfo`, revoke: `${base}/oauth/revoke` },
  };
  const box = new SecretBox('テストの鍵');
  const repo = {
    getGoogleConnection: async () => ({ tenantId: P.tenantId, userId: P.userId, refreshTokenEnc: box.encrypt('rt'), googleEmail: 'u1@x.example', scopes: [], connectedAt: '', checkedAt: '' }),
    getTenantCredential: async () => ({ tenantId: P.tenantId, kind: 'google_oauth', secretEnc: box.encrypt('s'), meta: { clientId: 'cid' }, updatedBy: 'x', updatedAt: '' }),
  } as unknown as Repository;
  return { c: new GoogleWorkspaceConnector(repo, box, endpoints), seen, close: () => new Promise<void>((r) => server.close(() => r())) };
}

test('終わった会議は、題名をカレンダーの予定から引き、予定の無い会議は会議のコードで呼び、文字起こしの有無を返す', async () => {
  const g = await fakeMeet();
  try {
    const ended = await g.c.meet.ended!(P, iso(now - 24 * 3_600_000));
    assert.deepEqual(ended.map((m) => [m.id, m.title, m.organizerSelf, m.hasTranscript]), [
      ['REC1', '営業定例', true, true],
      ['REC2', 'Meet の会議（xyz-uvwx-stu）', true, false],
    ], 'まだ続いている会議（REC3）は入れない');
    assert.match(g.seen.find((s) => s.path === '/meet/conferenceRecords')!.query.get('filter')!, /^end_time>="/);
  } finally { await g.close(); }
});

test('文字起こしをページをまたいで読み、話した人の名前を付ける。題名の後ろの日付で会議を選ぶ', async () => {
  const g = await fakeMeet();
  try {
    const t = await g.c.meet.transcript(P, { query: '営業定例' });
    assert.equal(t?.conference.id, 'REC1');
    assert.equal(t?.conference.title, '営業定例');
    assert.deepEqual(t?.entries.map((e) => e.speaker), ['山田 花子', '外部の方', '山田 花子']);
    assert.equal(t?.entries[2]?.text, '見積は来週までに作ります。');
    assert.equal(g.seen.filter((s) => s.path === '/meet/conferenceRecords/REC1/participants/P1').length, 1, '同じ人の名前は 1 度だけ引く');
    const d = new Date(Date.parse(REC1.endTime) + 9 * 3_600_000);
    const dated = await g.c.meet.transcript(P, { query: `営業定例（${d.getUTCMonth() + 1}/${d.getUTCDate()}）` });
    assert.equal(dated?.conference.id, 'REC1');
    const other = new Date(d.getTime() - 3 * 86_400_000);
    assert.equal(await g.c.meet.transcript(P, { query: `営業定例（${other.getUTCMonth() + 1}/${other.getUTCDate()}）` }), null, '日付が違えば無い');
    assert.equal(await g.c.meet.transcript(P, { query: '無い会議' }), null);
  } finally { await g.close(); }
});

test('参加しただけの会議は、予定の会議のコードで記録を探して読む', async () => {
  const g = await fakeMeet();
  try {
    const t = await g.c.meet.transcript(P, { query: '取引先' });
    assert.equal(t?.conference.id, 'REC9');
    assert.equal(t?.conference.title, '取引先との打ち合わせ');
    assert.equal(t?.entries[0]?.speaker, '佐藤 一郎');
  } finally { await g.close(); }
});

test('会議の記録の ID を渡せばその会議を読み、形の違う ID ではほかの口を呼ばない', async () => {
  const g = await fakeMeet();
  try {
    assert.equal((await g.c.meet.transcript(P, { query: '', meetingId: 'REC1' }))?.conference.id, 'REC1');
    const before = g.seen.length;
    assert.equal(await g.c.meet.transcript(P, { query: '', meetingId: '../../spaces/S1' }), null);
    assert.ok(!g.seen.slice(before).some((s) => s.path.includes('..') || s.path === '/meet/spaces/S1/..'), '形の違う ID で呼ばない');
  } finally { await g.close(); }
});

test('会議のコード・会議の記録の ID・題名の日付を読み分ける', () => {
  assert.equal(meetingCodeOfEvent({ conferenceData: { conferenceId: 'abc-defg-hij' } }), 'abc-defg-hij');
  assert.equal(meetingCodeOfEvent({ hangoutLink: 'https://meet.google.com/ppp-qqqq-rrr?authuser=0' }), 'ppp-qqqq-rrr');
  assert.equal(meetingCodeOfEvent({ conferenceData: { conferenceId: 'zoom-123' } }), null, 'Meet でない会議は読まない');
  assert.equal(conferenceIdOf('conferenceRecords/abc_1-2'), 'abc_1-2');
  assert.equal(conferenceIdOf('conferenceRecords/../x'), null);
  assert.deepEqual(splitTitleDate('営業定例（10/16）'), { query: '営業定例', month: 10, day: 16 });
  assert.deepEqual(splitTitleDate('営業定例'), { query: '営業定例', month: null, day: null });
});
