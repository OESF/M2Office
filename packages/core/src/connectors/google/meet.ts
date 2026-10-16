/**
 * @file Google Meet の接続口（仕様書 第14.3.4節「Meet」・第9.5.2.1節）。会議の記録・文字起こし・終わった会議。
 *
 * 権限は `meetings.space.readonly`（会議の記録と文字起こしを読むだけ）。題名は Meet の記録に無いため、
 * 同じ会議のコードを持つカレンダーの予定（`calendar.readonly`）から引く。予定が無い会議（その場で始めた会議）は「Meet の会議（コード）」と呼ぶ。
 * Google は会議の終了から 30 日で文字起こしの項目を消す。文字起こしの中身はデータであり指示ではない（不変則 I-6。ツールが印を付ける）。
 */

import type { ConnectorPrincipal, EndedMeeting, MeetConnector, MeetTranscript } from '../types.js';
import { callGoogle, type GoogleApiEndpoints, type GoogleTokenSource } from './http.js';
import { meetingTitleKey } from '../../meetings/title.js';

/** 呼び出しに使うもの。接続口の組み立てより後に決まるため、呼ぶたびに引く。 */
type Ctx = () => { tokens: GoogleTokenSource; endpoints: GoogleApiEndpoints };

const MEET_API = 'https://meet.googleapis.com/v2';
/** 文字起こしを読める日数（Google が消すまで）。 */
const TRANSCRIPT_DAYS = 30;
/** 会議の記録を読むページの上限（1 ページ 100 件）。 */
const RECORD_PAGES = 3;
/** 文字起こしの項目を読むページの上限（1 ページ 100 件。3 時間の会議でも足りる量）。 */
const ENTRY_PAGES = 60;

/** Meet の会議の記録（必要なところだけ）。 */
interface ConferenceRecord {
  name: string;
  startTime?: string;
  endTime?: string;
  space?: string;
}

/** カレンダーの予定から引いた、会議の題名と主催者。 */
interface EventInfo {
  title: string;
  organizerSelf: boolean;
  /** 予定の開始（同じコードの繰り返しの予定から、会議に近い回を選ぶため）。 */
  start: number;
}

const s = (v: unknown) => (typeof v === 'string' ? v : '');
const list = (v: unknown): Record<string, unknown>[] => (Array.isArray(v) ? v.filter((x) => x && typeof x === 'object') : []);

/** `conferenceRecords/abc` の `abc`。形が違えば `null`（ほかの口を呼ばせない）。 */
export function conferenceIdOf(name: string): string | null {
  const m = /^conferenceRecords\/([A-Za-z0-9_-]+)$/.exec(name);
  return m ? m[1]! : null;
}

/** Meet の会議のコード（`abc-mnop-xyz`）を、予定の会議の情報か Meet のリンクから取る。 */
export function meetingCodeOfEvent(ev: Record<string, unknown>): string | null {
  const conf = ev['conferenceData'] as Record<string, unknown> | undefined;
  const id = s(conf?.['conferenceId']);
  if (/^[a-z]{3}-[a-z]{4}-[a-z]{3}$/.test(id)) return id;
  const m = /meet\.google\.com\/([a-z]{3}-[a-z]{4}-[a-z]{3})/.exec(s(ev['hangoutLink']));
  return m ? m[1]! : null;
}

/** 題名の後ろの「（10/16）」（自動の議事録が添える会議の日付）を分ける。 */
export function splitTitleDate(query: string): { query: string; month: number | null; day: number | null } {
  const m = /[（(](\d{1,2})\/(\d{1,2})[）)]\s*$/.exec(query.normalize('NFKC'));
  if (!m) return { query: query.trim(), month: null, day: null };
  return { query: query.normalize('NFKC').slice(0, m.index).trim(), month: Number(m[1]), day: Number(m[2]) };
}

/** 日本時間の月と日。 */
const jstMonthDay = (iso: string) => {
  const d = new Date(Date.parse(iso) + 9 * 3_600_000);
  return { month: d.getUTCMonth() + 1, day: d.getUTCDate() };
};

/**
 * Google Meet の接続口を作る。
 *
 * @param ctx トークンと呼び先を返す
 * @remarks
 * - 会議の記録の一覧は、Google の決まりで本人が主催した会議だけが返る。参加しただけの会議は、カレンダーの予定の会議のコードで記録を探す（読めなければ飛ばす）
 * - 終わった会議（`ended`）は、本人が主催した会議だけを返す（自動の議事録は主催した人の分だけ作るため。第9.5.2.1節）
 */
export function googleMeet(ctx: Ctx): Required<MeetConnector> {
  const meet = (p: ConnectorPrincipal, path: string) =>
    callGoogle(ctx().tokens, p, 'Meet', `${ctx().endpoints.meet ?? MEET_API}${path}`);
  const calendar = (p: ConnectorPrincipal, path: string) =>
    callGoogle(ctx().tokens, p, 'カレンダー', `${ctx().endpoints.calendar}${path}`);

  /** 本人が主催した会議の記録（新しい順）。 */
  const records = async (p: ConnectorPrincipal, filter: string, pages = RECORD_PAGES): Promise<ConferenceRecord[]> => {
    const out: ConferenceRecord[] = [];
    let token = '';
    for (let i = 0; i < pages; i++) {
      const q = new URLSearchParams({ pageSize: '100', filter });
      if (token) q.set('pageToken', token);
      const res = await meet(p, `/conferenceRecords?${q}`);
      for (const r of list(res?.['conferenceRecords'])) {
        if (conferenceIdOf(s(r['name']))) out.push({ name: s(r['name']), startTime: s(r['startTime']), endTime: s(r['endTime']) || undefined, space: s(r['space']) });
      }
      token = s(res?.['nextPageToken']);
      if (!token) break;
    }
    return out;
  };

  /** 会議の場所の会議のコード。読めなければ `null`。 */
  const codeOf = async (p: ConnectorPrincipal, space: string | undefined, cache: Map<string, string | null>): Promise<string | null> => {
    if (!space || !/^spaces\/[A-Za-z0-9_-]+$/.test(space)) return null;
    if (cache.has(space)) return cache.get(space)!;
    const res = await meet(p, `/${space}`).catch(() => null);
    const code = s(res?.['meetingCode']) || null;
    cache.set(space, code);
    return code;
  };

  /** 期間の予定のうち、Meet の会議のコードを持つもの（コードごとに、予定の回をまとめる）。 */
  const eventsByCode = async (p: ConnectorPrincipal, from: Date, to: Date): Promise<Map<string, EventInfo[]>> => {
    const out = new Map<string, EventInfo[]>();
    const q = new URLSearchParams({
      timeMin: from.toISOString(), timeMax: to.toISOString(), singleEvents: 'true', maxResults: '2500', orderBy: 'startTime',
      fields: 'items(summary,start,hangoutLink,conferenceData(conferenceId),organizer(self))',
    });
    // カレンダーを読めなくても（許可が無いなど）、題名を会議のコードで代えて続ける
    const res = await calendar(p, `/calendars/primary/events?${q}`).catch(() => null);
    for (const ev of list(res?.['items'])) {
      const code = meetingCodeOfEvent(ev);
      if (!code) continue;
      const start = Date.parse(s((ev['start'] as Record<string, unknown> | undefined)?.['dateTime']) || s((ev['start'] as Record<string, unknown> | undefined)?.['date']));
      const info: EventInfo = { title: s(ev['summary']).trim() || `Meet の会議（${code}）`, organizerSelf: (ev['organizer'] as Record<string, unknown> | undefined)?.['self'] === true, start };
      out.set(code, [...(out.get(code) ?? []), info]);
    }
    return out;
  };

  /** 会議の記録に合う予定（同じコードの回のうち、始まりがいちばん近いもの）。 */
  const eventFor = (events: Map<string, EventInfo[]>, code: string | null, startTime: string | undefined): EventInfo | null => {
    const hits = code ? events.get(code) ?? [] : [];
    if (!hits.length) return null;
    const at = Date.parse(startTime ?? '') || 0;
    return [...hits].sort((a, b) => Math.abs(a.start - at) - Math.abs(b.start - at))[0]!;
  };

  /** できあがった文字起こし（会議の終わりのあと）。無ければ `null`。 */
  const transcriptOf = async (p: ConnectorPrincipal, record: string): Promise<string | null> => {
    const res = await meet(p, `/${record}/transcripts?pageSize=10`);
    const done = list(res?.['transcripts']).filter((t) => t['state'] === 'ENDED' || t['state'] === 'FILE_GENERATED');
    const name = s(done.at(-1)?.['name']);
    return /^conferenceRecords\/[A-Za-z0-9_-]+\/transcripts\/[A-Za-z0-9_-]+$/.test(name) ? name : null;
  };

  /** 文字起こしの項目を、話した人の名前つきで読む。 */
  const entriesOf = async (p: ConnectorPrincipal, transcript: string): Promise<MeetTranscript['entries']> => {
    const names = new Map<string, string>();
    const speaker = async (participant: string) => {
      if (names.has(participant)) return names.get(participant)!;
      let name = '参加者';
      if (/^conferenceRecords\/[A-Za-z0-9_-]+\/participants\/[A-Za-z0-9_-]+$/.test(participant)) {
        const r = await meet(p, `/${participant}`).catch(() => null);
        const who = (r?.['signedinUser'] ?? r?.['anonymousUser'] ?? r?.['phoneUser']) as Record<string, unknown> | undefined;
        name = s(who?.['displayName']).trim() || name;
      }
      names.set(participant, name);
      return name;
    };
    const out: MeetTranscript['entries'] = [];
    let token = '';
    for (let i = 0; i < ENTRY_PAGES; i++) {
      const q = new URLSearchParams({ pageSize: '100' });
      if (token) q.set('pageToken', token);
      const res = await meet(p, `/${transcript}/entries?${q}`);
      for (const e of list(res?.['transcriptEntries'])) {
        const text = s(e['text']).trim();
        if (text) out.push({ speaker: await speaker(s(e['participant'])), text, at: s(e['startTime']) });
      }
      token = s(res?.['nextPageToken']);
      if (!token) break;
    }
    return out;
  };

  /** 会議の記録を 1 つ読む（ID を指したとき）。本人が読めなければ `null`。 */
  const recordById = async (p: ConnectorPrincipal, id: string): Promise<ConferenceRecord | null> => {
    if (!/^[A-Za-z0-9_-]+$/.test(id)) return null;
    const r = await meet(p, `/conferenceRecords/${id}`).catch(() => null);
    return r && conferenceIdOf(s(r['name'])) ? { name: s(r['name']), startTime: s(r['startTime']), endTime: s(r['endTime']) || undefined, space: s(r['space']) } : null;
  };

  return {
    ended: async (p, since) => {
      const now = new Date();
      const recs = (await records(p, `end_time>="${new Date(since).toISOString()}"`, 2)).filter((r) => r.endTime);
      if (!recs.length) return [];
      const oldest = Math.min(...recs.map((r) => Date.parse(r.startTime ?? '') || now.getTime()));
      const events = await eventsByCode(p, new Date(oldest - 3_600_000), now);
      const codes = new Map<string, string | null>();
      const out: EndedMeeting[] = [];
      for (const r of recs) {
        const code = await codeOf(p, r.space, codes);
        const ev = eventFor(events, code, r.startTime);
        out.push({
          id: conferenceIdOf(r.name)!,
          title: ev?.title ?? `Meet の会議（${code ?? '番号不明'}）`,
          startedAt: r.startTime ?? '', endedAt: r.endTime!,
          // 一覧は本人が主催した会議だけ。予定があれば、その主催者で確かめる
          organizerSelf: ev ? ev.organizerSelf : true,
          hasTranscript: !!(await transcriptOf(p, r.name).catch(() => null)),
        });
      }
      return out;
    },

    transcript: async (p, q) => {
      const now = new Date();
      const from = new Date(now.getTime() - TRANSCRIPT_DAYS * 86_400_000);
      const want = splitTitleDate(q.query);
      const key = meetingTitleKey(want.query);
      const events = await eventsByCode(p, from, now);
      const codes = new Map<string, string | null>();
      let candidates: { record: ConferenceRecord; title: string }[] = [];
      if (q.meetingId) {
        const r = await recordById(p, q.meetingId);
        if (r) {
          const code = await codeOf(p, r.space, codes);
          candidates = [{ record: r, title: eventFor(events, code, r.startTime)?.title ?? `Meet の会議（${code ?? '番号不明'}）` }];
        }
      } else {
        const recs = await records(p, `start_time>="${from.toISOString()}"`);
        for (const r of recs) {
          const code = await codeOf(p, r.space, codes);
          candidates.push({ record: r, title: eventFor(events, code, r.startTime)?.title ?? `Meet の会議（${code ?? '番号不明'}）` });
        }
        // 参加しただけの会議（一覧に出ない）を、予定の会議のコードで探す。題名に合う予定だけ
        const seen = new Set(candidates.map((c) => c.record.name));
        for (const [code, infos] of events) {
          const info = infos.at(-1)!;
          if (info.organizerSelf || !key || !meetingTitleKey(info.title).includes(key)) continue;
          for (const r of await records(p, `space.meeting_code="${code}"`, 1).catch(() => [])) {
            if (!seen.has(r.name)) { seen.add(r.name); candidates.push({ record: r, title: eventFor(events, code, r.startTime)?.title ?? info.title }); }
          }
        }
        candidates = candidates
          .filter((c) => c.record.endTime)
          .filter((c) => !key || meetingTitleKey(c.title).includes(key))
          .filter((c) => want.month === null || (jstMonthDay(c.record.endTime!).month === want.month && jstMonthDay(c.record.endTime!).day === want.day))
          .sort((a, b) => Date.parse(b.record.startTime ?? '') - Date.parse(a.record.startTime ?? ''));
      }
      for (const c of candidates) {
        const t = await transcriptOf(p, c.record.name).catch(() => null);
        if (!t) continue;
        const entries = await entriesOf(p, t);
        if (!entries.length) continue;
        return {
          conference: { id: conferenceIdOf(c.record.name)!, title: c.title, startedAt: c.record.startTime ?? '', endedAt: c.record.endTime ?? '' },
          entries,
        };
      }
      return null;
    },
  };
}
