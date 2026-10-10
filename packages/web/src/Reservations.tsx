/**
 * @file 予約の画面（仕様書 第37.8節）。日ごとの表（縦に時刻、横に予約できるもの。空いている所を押すか、なぞって選ぶと予約の欄が開く）・
 * 週の表・スマホでは今日と明日を縦に並べる・予約の 1 件（変える・取り消す・終わった）・自分の予約・予約できるもの（管理者）。
 *
 * 重なって断られたら、次に空いている時間と、同じ種類で空いているほかのものを出し、押せばそれで取る。説明文は常に出さない（原則 u11）。
 */

import { useCallback, useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import {
  RESERVABLE_KIND_LABELS, RESERVATION_RULE_LABELS, type ReservableItem, type ReservableKind, type Reservation, type ReservationConflict, type ReservationRule,
} from '@m2office/shared';
import { api, ApiError, describeError } from './api.js';
import { SortableList } from './Sortable.js';

const JST = 9 * 3_600_000;
const SLOT = 15;
const SLOT_PX = 12;
const pad = (n: number) => String(n).padStart(2, '0');
/** 日本時間の日付（YYYY-MM-DD）。 */
const dayOf = (iso: string | number | Date) => new Date(new Date(iso).getTime() + JST).toISOString().slice(0, 10);
/** 日本時間の時刻（HH:MM）。 */
const timeOf = (iso: string) => new Date(Date.parse(iso) + JST).toISOString().slice(11, 16);
const isoOf = (date: string, hhmm: string) => new Date(hhmm === '24:00' ? `${shift(date, 1)}T00:00:00+09:00` : `${date}T${hhmm}:00+09:00`).toISOString();
const shift = (date: string, n: number) => new Date(Date.parse(`${date}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
const minutesOf = (hhmm: string) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5));
const hhmmOf = (min: number) => `${pad(Math.floor(min / 60))}:${pad(min % 60)}`;
const WEEK = '日月火水木金土';
const dayLabel = (date: string) => `${Number(date.slice(5, 7))}/${Number(date.slice(8, 10))}（${WEEK[new Date(`${date}T00:00:00Z`).getUTCDay()]}）`;
const rangeLabel = (r: Pick<Reservation, 'startAt' | 'endAt'>) =>
  dayOf(r.startAt) === dayOf(r.endAt) || timeOf(r.endAt) === '00:00' && dayOf(r.endAt) === shift(dayOf(r.startAt), 1)
    ? `${dayLabel(dayOf(r.startAt))} ${timeOf(r.startAt)}〜${timeOf(r.endAt) === '00:00' ? '24:00' : timeOf(r.endAt)}`
    : `${dayLabel(dayOf(r.startAt))} ${timeOf(r.startAt)}〜${dayLabel(dayOf(r.endAt))} ${timeOf(r.endAt)}`;
/** 15 分刻みの時刻の選び肢。 */
const TIMES = Array.from({ length: 24 * 4 + 1 }, (_, i) => hhmmOf(i * SLOT));
const CALENDAR_NOTE = { added: 'カレンダーにも入れました。', 'not-connected': 'Google につないでいないため、カレンダーには入れていません。', failed: 'カレンダーには入れられませんでした。' } as const;

type Note = { kind: 'ok' | 'error'; text: string } | null;
function NoteText({ note }: { note: Note }) {
  return note ? <p className={`rsv-note is-${note.kind}`} role={note.kind === 'error' ? 'alert' : 'status'}>{note.text}</p> : null;
}

/** 予約の欄に入れる下書き。 */
interface Draft { id: string | null; itemId: string; date: string; start: string; end: string; purpose: string; repeat?: ReservationRule | ''; until?: string }

/** 画面の幅が狭いか（スマホ）。 */
function useNarrow(): boolean {
  const q = '(max-width: 680px)';
  const [narrow, setNarrow] = useState(() => typeof window !== 'undefined' && window.matchMedia(q).matches);
  useEffect(() => {
    const m = window.matchMedia(q);
    const on = () => setNarrow(m.matches);
    m.addEventListener('change', on);
    return () => m.removeEventListener('change', on);
  }, []);
  return narrow;
}

/** 予約の画面。 */
export function Reservations({ userId, changeKey }: {
  userId: string;
  /** 秘書が予約を扱い終えるたびに変わる値。変わったら読み直す。 */
  changeKey: string;
}) {
  const narrow = useNarrow();
  const [mode, setMode] = useState<'day' | 'week'>('day');
  const [date, setDate] = useState(() => dayOf(new Date()));
  const [kind, setKind] = useState<ReservableKind | ''>('');
  const [data, setData] = useState<{ items: ReservableItem[]; reservations: Reservation[]; admin: boolean } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [note, setNote] = useState<Note>(null);
  const [mine, setMine] = useState<Reservation[]>([]);
  const [manage, setManage] = useState(false);

  // スマホは今日と明日、週の表は月曜から 7 日、日の表はその日（前の日から続く予約も読む）
  const days = narrow ? 2 : mode === 'week' ? 7 : 1;
  const first = !narrow && mode === 'week' ? shift(date, -((new Date(`${date}T00:00:00Z`).getUTCDay() + 6) % 7)) : narrow ? dayOf(new Date()) : date;

  const load = useCallback(() => {
    api.reservations.list(isoOf(first, '00:00'), isoOf(shift(first, days), '00:00'))
      .then((r) => { setData(r); setError(null); })
      .catch((e) => setError(describeError(e, '読めませんでした')));
    api.reservations.mine().then((r) => setMine(r.reservations)).catch(() => undefined);
  }, [first, days]);
  useEffect(load, [load]);
  useEffect(() => { if (changeKey) load(); }, [changeKey]); // eslint-disable-line react-hooks/exhaustive-deps

  const items = useMemo(() => (data?.items ?? []).filter((i) => i.status === 'active' && (!kind || i.kind === kind)), [data, kind]);
  const kinds = useMemo(() => [...new Set((data?.items ?? []).filter((i) => i.status === 'active').map((i) => i.kind))], [data]);
  const byId = useMemo(() => new Map((data?.items ?? []).map((i) => [i.id, i])), [data]);
  const sel = selected ? data?.reservations.find((r) => r.id === selected) ?? mine.find((r) => r.id === selected) ?? null : null;

  const open = (d: Draft) => { setSelected(null); setNote(null); setDraft(d); };
  const done = (text: string) => { setDraft(null); setSelected(null); setNote({ kind: 'ok', text }); load(); };

  if (error) return <p className="error">{error}</p>;
  if (!data) return <p className="muted">読み込み中…</p>;
  const admin = data.admin;
  if (!data.items.length) {
    return (
      <div className="rsv">
        <p className="muted">予約できるものがまだありません。{admin ? '' : '管理者が足します。'}</p>
        {admin && <ItemManager items={data.items} onChanged={load} />}
      </div>
    );
  }

  return (
    <div className="rsv">
      {!narrow && (
        <div className="row wrap rsv-bar">
          <div className="seg" role="group" aria-label="表の形">
            <button className={mode === 'day' ? 'on' : ''} aria-pressed={mode === 'day'} onClick={() => setMode('day')}>日</button>
            <button className={mode === 'week' ? 'on' : ''} aria-pressed={mode === 'week'} onClick={() => setMode('week')}>週</button>
          </div>
          <button className="btn ghost small" aria-label="前へ" onClick={() => setDate(shift(date, mode === 'week' ? -7 : -1))}>‹</button>
          <input type="date" value={date} aria-label="日付" onChange={(e) => e.target.value && setDate(e.target.value)} />
          <button className="btn ghost small" aria-label="次へ" onClick={() => setDate(shift(date, mode === 'week' ? 7 : 1))}>›</button>
          <button className="btn ghost small" onClick={() => setDate(dayOf(new Date()))}>今日</button>
          {kinds.length > 1 && (
            <select value={kind} aria-label="種類" onChange={(e) => setKind(e.target.value as ReservableKind | '')}>
              <option value="">すべて</option>
              {kinds.map((k) => <option key={k} value={k}>{RESERVABLE_KIND_LABELS[k]}</option>)}
            </select>
          )}
          {admin && <button className={manage ? 'btn small' : 'btn ghost small'} onClick={() => setManage(!manage)}>予約できるもの</button>}
        </div>
      )}
      <NoteText note={note} />
      {manage && admin && <ItemManager items={data.items} onChanged={load} />}
      {draft && <DraftForm draft={draft} items={data.items.filter((i) => i.status === 'active' || i.id === draft.itemId)} onCancel={() => setDraft(null)} onDone={done} />}
      {sel && (
        <ReservationView r={sel} item={byId.get(sel.itemId) ?? null} canChange={sel.userId === userId || admin}
          onClose={() => setSelected(null)} onEdit={() => open({ id: sel.id, itemId: sel.itemId, date: dayOf(sel.startAt), start: timeOf(sel.startAt), end: timeOf(sel.endAt) === '00:00' ? '24:00' : timeOf(sel.endAt), purpose: sel.purpose })}
          onDone={done} onError={(text) => setNote({ kind: 'error', text })} />
      )}
      {narrow
        ? <MobileList first={first} items={items} reservations={data.reservations} onPick={setSelected} onNew={(itemId, d) => open({ id: null, itemId, date: d, start: nextQuarter(d), end: hhmmOf(Math.min(minutesOf(nextQuarter(d)) + 60, 24 * 60)), purpose: '' })} />
        : mode === 'day'
          ? <DayGrid date={first} items={items} reservations={data.reservations} userId={userId} onPick={setSelected}
            onSelect={(itemId, start, end) => open({ id: null, itemId, date: first, start, end, purpose: '' })} />
          : <WeekGrid first={first} items={items} reservations={data.reservations} userId={userId} onPick={setSelected}
            onNew={(itemId, d) => open({ id: null, itemId, date: d, start: '09:00', end: '10:00', purpose: '' })} />}
      {mine.length > 0 && (
        <section className="rsv-mine">
          <h2>自分の予約</h2>
          <ul>
            {mine.slice(0, 20).map((r) => (
              <li key={r.id}><button className="link" onClick={() => { setDraft(null); setSelected(r.id); }}>{rangeLabel(r)} {byId.get(r.itemId)?.name ?? ''}</button>{r.purpose && <span className="muted"> {r.purpose}</span>}</li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}

/** その日のいまより後の、次の 15 分の区切り（今日でなければ 9:00）。 */
function nextQuarter(date: string): string {
  if (date !== dayOf(new Date())) return '09:00';
  const now = new Date(Date.now() + JST);
  return hhmmOf(Math.min(Math.ceil((now.getUTCHours() * 60 + now.getUTCMinutes()) / SLOT) * SLOT, 23 * 60));
}

/** 日の表。縦に時刻、横に予約できるもの。空いている所を押すと 1 時間、なぞるとその幅で予約の欄を開く。 */
function DayGrid({ date, items, reservations, userId, onPick, onSelect }: {
  date: string; items: ReservableItem[]; reservations: Reservation[]; userId: string;
  onPick: (id: string) => void; onSelect: (itemId: string, start: string, end: string) => void;
}) {
  const dayStart = Date.parse(isoOf(date, '00:00'));
  const mins = (iso: string) => Math.max(0, Math.min(24 * 60, Math.round((Date.parse(iso) - dayStart) / 60_000)));
  const todays = reservations.filter((r) => Date.parse(r.endAt) > dayStart && Date.parse(r.startAt) < dayStart + 86_400_000);
  // ふだんは 7 時から 21 時。外にかかる予約があれば広げる
  const from = Math.min(7 * 60, ...todays.map((r) => Math.floor(mins(r.startAt) / 60) * 60));
  const to = Math.max(21 * 60, ...todays.map((r) => Math.ceil(mins(r.endAt) / 60) * 60));
  const height = ((to - from) / SLOT) * SLOT_PX;
  const [drag, setDrag] = useState<{ itemId: string; a: number; b: number } | null>(null);
  const dragRef = useRef(drag);
  dragRef.current = drag;
  const slotAt = (e: ReactPointerEvent<HTMLDivElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    return from + Math.max(0, Math.min(to - from - SLOT, Math.floor((e.clientY - rect.top) / SLOT_PX) * SLOT));
  };
  const finish = () => {
    const d = dragRef.current;
    setDrag(null);
    if (!d) return;
    const s = Math.min(d.a, d.b);
    const e = Math.max(d.a, d.b) + SLOT;
    onSelect(d.itemId, hhmmOf(s), hhmmOf(e - s <= SLOT ? Math.min(s + 60, 24 * 60) : e));
  };
  const hours = Array.from({ length: (to - from) / 60 }, (_, i) => from + i * 60);
  return (
    <div className="rsv-day" style={{ ['--rsv-cols' as string]: String(items.length) }}>
      <div className="rsv-day-head">
        <span />
        {items.map((i) => <span key={i.id} className="rsv-col-name" title={i.location}>{i.name}{i.capacity ? <small className="muted"> {i.capacity}名</small> : null}</span>)}
      </div>
      <div className="rsv-day-body">
        <div className="rsv-hours" style={{ height }}>
          {hours.map((h) => <span key={h} style={{ top: ((h - from) / SLOT) * SLOT_PX }}>{hhmmOf(h)}</span>)}
        </div>
        {items.map((item) => (
          <div key={item.id} className="rsv-col" style={{ height }}
            onPointerDown={(e) => { if (e.button !== 0 || (e.target as HTMLElement).closest('.rsv-block')) return; e.currentTarget.setPointerCapture(e.pointerId); const s = slotAt(e); setDrag({ itemId: item.id, a: s, b: s }); }}
            onPointerMove={(e) => { if (drag && drag.itemId === item.id) setDrag({ ...drag, b: slotAt(e) }); }}
            onPointerUp={finish}>
            {hours.map((h) => <span key={h} className="rsv-line" style={{ top: ((h - from) / SLOT) * SLOT_PX }} />)}
            {todays.filter((r) => r.itemId === item.id).map((r) => {
              const s = mins(r.startAt);
              const e = Date.parse(r.endAt) >= dayStart + 86_400_000 ? 24 * 60 : mins(r.endAt);
              return (
                <button key={r.id} className={`rsv-block${r.userId === userId ? ' is-mine' : ''}`} style={{ top: ((s - from) / SLOT) * SLOT_PX, height: Math.max(((e - s) / SLOT) * SLOT_PX - 2, 14) }}
                  onClick={() => onPick(r.id)} title={`${timeOf(r.startAt)}〜${timeOf(r.endAt)} ${r.userName}${r.purpose ? ` ${r.purpose}` : ''}`}>
                  <span>{timeOf(r.startAt)}〜{timeOf(r.endAt) === '00:00' ? '24:00' : timeOf(r.endAt)} {r.userName}</span>
                  {r.purpose && <span className="muted">{r.purpose}</span>}
                </button>
              );
            })}
            {drag && drag.itemId === item.id && (
              <span className="rsv-drag" style={{ top: ((Math.min(drag.a, drag.b) - from) / SLOT) * SLOT_PX, height: ((Math.abs(drag.b - drag.a) + SLOT) / SLOT) * SLOT_PX }} />
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

/** 週の表。縦に予約できるもの、横に 7 日。空いている所を押すと、その日の予約の欄を開く。 */
function WeekGrid({ first, items, reservations, userId, onPick, onNew }: {
  first: string; items: ReservableItem[]; reservations: Reservation[]; userId: string;
  onPick: (id: string) => void; onNew: (itemId: string, date: string) => void;
}) {
  const dates = Array.from({ length: 7 }, (_, i) => shift(first, i));
  return (
    <div className="rsv-week-wrap">
      <table className="table rsv-week">
        <thead><tr><th />{dates.map((d) => <th key={d} className={d === dayOf(new Date()) ? 'is-today' : ''}>{dayLabel(d)}</th>)}</tr></thead>
        <tbody>
          {items.map((item) => (
            <tr key={item.id}>
              <th scope="row">{item.name}</th>
              {dates.map((d) => {
                const start = Date.parse(isoOf(d, '00:00'));
                const rs = reservations.filter((r) => r.itemId === item.id && Date.parse(r.startAt) < start + 86_400_000 && Date.parse(r.endAt) > start);
                return (
                  <td key={d} className="rsv-week-cell" onClick={(e) => { if (!(e.target as HTMLElement).closest('button')) onNew(item.id, d); }}>
                    {rs.map((r) => (
                      <button key={r.id} className={`rsv-chip${r.userId === userId ? ' is-mine' : ''}`} onClick={() => onPick(r.id)}>
                        {dayOf(r.startAt) === d ? timeOf(r.startAt) : '〜'}{dayOf(r.endAt) === d || timeOf(r.endAt) === '00:00' ? `-${timeOf(r.endAt) === '00:00' ? '24:00' : timeOf(r.endAt)}` : ''} {r.userName}
                      </button>
                    ))}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** スマホ。今日と明日を縦に並べる。 */
function MobileList({ first, items, reservations, onPick, onNew }: {
  first: string; items: ReservableItem[]; reservations: Reservation[];
  onPick: (id: string) => void; onNew: (itemId: string, date: string) => void;
}) {
  return (
    <div className="rsv-mobile">
      {[first, shift(first, 1)].map((d) => {
        const start = Date.parse(isoOf(d, '00:00'));
        return (
          <section key={d}>
            <h2>{d === first ? '今日' : '明日'} {dayLabel(d)}</h2>
            {items.map((item) => {
              const rs = reservations.filter((r) => r.itemId === item.id && Date.parse(r.startAt) < start + 86_400_000 && Date.parse(r.endAt) > start);
              return (
                <div key={item.id} className="rsv-mobile-item">
                  <div className="row"><strong>{item.name}</strong><button className="btn ghost small" onClick={() => onNew(item.id, d)}>予約する</button></div>
                  {rs.length ? rs.map((r) => <button key={r.id} className="rsv-chip" onClick={() => onPick(r.id)}>{timeOf(r.startAt)}〜{timeOf(r.endAt)} {r.userName}</button>) : <span className="muted small">空き</span>}
                </div>
              );
            })}
          </section>
        );
      })}
    </div>
  );
}

/** 予約の欄（新しく取る・変える）。重なれば、次に空く時間とほかのものを出す。 */
function DraftForm({ draft, items, onCancel, onDone }: {
  draft: Draft; items: ReservableItem[]; onCancel: () => void; onDone: (text: string) => void;
}) {
  const [d, setD] = useState(draft);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [conflict, setConflict] = useState<ReservationConflict | null>(null);
  useEffect(() => { setD(draft); setError(null); setConflict(null); }, [draft]);
  const save = async (over: Partial<Draft> = {}) => {
    const v = { ...d, ...over };
    setBusy(true); setError(null); setConflict(null);
    try {
      // 繰り返し（毎週・隔週・毎月の同じ週の同じ曜日。第37.18節）
      if (!v.id && v.repeat) {
        const s = await api.reservations.createSeries({ itemId: v.itemId, rule: v.repeat, startsOn: v.date, startTime: v.start, endTime: v.end, endsOn: v.until || null, purpose: v.purpose });
        const skipped = s.skipped.map((x) => dayLabel(x)).join('、');
        onDone(`${s.item.name}を${RESERVATION_RULE_LABELS[v.repeat]}取りました（90 日先までの ${s.booked} 回）。${skipped ? `重なって取れなかった日: ${skipped}。` : ''}`);
        return;
      }
      const input = { itemId: v.itemId, startAt: isoOf(v.date, v.start), endAt: isoOf(v.date, v.end), purpose: v.purpose };
      const r = v.id ? await api.reservations.change(v.id, input) : await api.reservations.book(input);
      const name = items.find((i) => i.id === v.itemId)?.name ?? '';
      onDone(`${name}を ${rangeLabel(r.reservation)} で${v.id ? '変えました' : '取りました'}。${CALENDAR_NOTE[r.calendar]}`);
    } catch (e) {
      setD(v);
      const c = e instanceof ApiError ? (e.body['conflict'] as ReservationConflict | undefined) : undefined;
      // 重なっただけなら、使っている人と空く時間を出す（問い合わせ番号の付いた失敗の文は出さない）
      if (c) setConflict(c);
      else setError(describeError(e, '予約できませんでした'));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="rsv-form card">
      <div className="row wrap">
        <select value={d.itemId} aria-label="予約するもの" onChange={(e) => setD({ ...d, itemId: e.target.value })}>
          {items.map((i) => <option key={i.id} value={i.id}>{i.name}</option>)}
        </select>
        <input type="date" value={d.date} aria-label="日付" onChange={(e) => e.target.value && setD({ ...d, date: e.target.value })} />
        <select value={d.start} aria-label="始め" onChange={(e) => setD({ ...d, start: e.target.value, end: minutesOf(d.end) <= minutesOf(e.target.value) ? hhmmOf(Math.min(minutesOf(e.target.value) + 60, 24 * 60)) : d.end })}>
          {TIMES.slice(0, -1).map((t) => <option key={t} value={t}>{t}</option>)}
        </select>
        <span>〜</span>
        <select value={d.end} aria-label="終わり" onChange={(e) => setD({ ...d, end: e.target.value })}>
          {TIMES.filter((t) => minutesOf(t) > minutesOf(d.start)).map((t) => <option key={t} value={t}>{t}</option>)}
        </select>
        <input className="rsv-purpose" value={d.purpose} maxLength={120} placeholder="用件" aria-label="用件" onChange={(e) => setD({ ...d, purpose: e.target.value })} />
        {!d.id && (
          <select value={d.repeat ?? ''} aria-label="繰り返し" onChange={(e) => setD({ ...d, repeat: e.target.value as ReservationRule | '' })}>
            <option value="">繰り返さない</option>
            {(Object.keys(RESERVATION_RULE_LABELS) as ReservationRule[]).map((k) => <option key={k} value={k}>{RESERVATION_RULE_LABELS[k]}</option>)}
          </select>
        )}
        {!d.id && d.repeat && <input type="date" value={d.until ?? ''} min={d.date} aria-label="繰り返しの終わり" title="繰り返しの終わり（空なら続ける）" onChange={(e) => setD({ ...d, until: e.target.value })} />}
        <button className="btn" disabled={busy} onClick={() => void save()}>{d.id ? '変える' : '予約する'}</button>
        <button className="btn ghost" onClick={onCancel}>キャンセル</button>
      </div>
      {error && <p className="error">{error}</p>}
      {conflict && (
        <div className="rsv-conflict">
          <span>{conflict.taken.userName ? `${conflict.taken.userName}さんが ` : ''}{rangeLabel(conflict.taken)} に使っています。</span>
          {conflict.nextFree && (
            <button className="btn ghost small" disabled={busy}
              onClick={() => void save({ date: dayOf(conflict.nextFree!.startAt), start: timeOf(conflict.nextFree!.startAt), end: timeOf(conflict.nextFree!.endAt) === '00:00' ? '24:00' : timeOf(conflict.nextFree!.endAt) })}>
              {rangeLabel(conflict.nextFree)} で取る
            </button>
          )}
          {conflict.others.map((o) => <button key={o.id} className="btn ghost small" disabled={busy} onClick={() => void save({ itemId: o.id })}>{o.name}で取る</button>)}
        </div>
      )}
    </div>
  );
}

/** 予約の 1 件。本人と管理者には「変える」「取り消す」「終わった」。 */
function ReservationView({ r, item, canChange, onClose, onEdit, onDone, onError }: {
  r: Reservation; item: ReservableItem | null; canChange: boolean;
  onClose: () => void; onEdit: () => void; onDone: (text: string) => void; onError: (text: string) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [rule, setRule] = useState<string | null>(null);
  const ongoing = Date.parse(r.startAt) <= Date.now() && Date.parse(r.endAt) > Date.now();
  // 繰り返しの 1 回なら、決まりの文を出す
  useEffect(() => {
    setRule(null);
    if (r.seriesId) api.reservations.series(r.seriesId).then((x) => setRule(x.series.status === 'active' ? x.series.ruleText : null)).catch(() => setRule(null));
  }, [r.seriesId]);
  const act = async (f: () => Promise<unknown>, text: string) => {
    setBusy(true);
    try { await f(); onDone(text); } catch (e) { onError(describeError(e, 'できませんでした')); } finally { setBusy(false); }
  };
  return (
    <div className="rsv-detail card">
      <div className="row wrap">
        <strong>{item?.name ?? ''}</strong>
        <span>{rangeLabel(r)}</span>
        <span>{r.userName}</span>
        {r.purpose && <span className="muted">{r.purpose}</span>}
        {item?.location && <span className="muted">{item.location}</span>}
        {rule && <span className="badge">{rule}</span>}
      </div>
      <div className="row wrap">
        {canChange && <button className="btn ghost small" disabled={busy} onClick={onEdit}>変える</button>}
        {canChange && ongoing && <button className="btn ghost small" disabled={busy} onClick={() => void act(() => api.reservations.finish(r.id), '終わりをいまにしました。')}>終わった</button>}
        {canChange && <button className="btn ghost small danger" disabled={busy} onClick={() => void act(() => api.reservations.cancel(r.id), '予約を取り消しました。')}>{rule ? 'この回だけ取り消す' : '取り消す'}</button>}
        {canChange && rule && r.seriesId && <button className="btn ghost small danger" disabled={busy} onClick={() => void act(() => api.reservations.stopSeries(r.seriesId!), '繰り返しを止め、これからの回を取り消しました。')}>これから全部取り消す</button>}
        <button className="btn ghost small" onClick={onClose}>閉じる</button>
      </div>
    </div>
  );
}

/** 予約できるもの（管理者だけ）。足す・名前と種類と定員と場所を直す・並べ替え・止める。 */
function ItemManager({ items, onChanged }: { items: ReservableItem[]; onChanged: () => void }) {
  const [name, setName] = useState('');
  const [error, setError] = useState<string | null>(null);
  const run = async (f: () => Promise<unknown>) => {
    setError(null);
    try { await f(); onChanged(); } catch (e) { setError(describeError(e, '直せませんでした')); }
  };
  // 置いた並びをすぐ画面に出す（読み直しを待つ間に前の並びへ戻って見えないように）
  const [list, setList] = useState(items);
  useEffect(() => setList(items), [items]);
  const reorder = (next: ReservableItem[]) => {
    setList(next);
    void run(() => api.reservations.reorder(next.map((x) => x.id)));
  };
  return (
    <section className="rsv-items card">
      <div className="row wrap">
        <input value={name} maxLength={40} placeholder="会議室 A・プリウス・プロジェクター" aria-label="足すものの名前" onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter' && name.trim()) void run(async () => { await api.reservations.addItem({ name: name.trim() }); setName(''); }); }} />
        <button className="btn small" disabled={!name.trim()} onClick={() => void run(async () => { await api.reservations.addItem({ name: name.trim() }); setName(''); })}>足す</button>
      </div>
      {error && <p className="error">{error}</p>}
      {list.length > 0 && (
        /* 左のつまみをつかんで動かす（個人設定のメニューの並び・サイネージの流れと同じ。第37.8節）。止める・使うはスライドのスイッチ */
        <SortableList className="rsv-items-list" items={list} keyOf={(i) => i.id} nameOf={(i) => i.name} onMove={reorder}
          render={(i) => (
            <>
              <input className={`rsv-item-name${i.status === 'stopped' ? ' is-stopped' : ''}`} defaultValue={i.name} maxLength={40} aria-label="名前"
                onBlur={(e) => e.target.value.trim() !== i.name && void run(() => api.reservations.updateItem(i.id, { name: e.target.value }))} />
              <select value={i.kind} aria-label="種類" className={i.status === 'stopped' ? 'is-stopped' : ''} onChange={(e) => void run(() => api.reservations.updateItem(i.id, { kind: e.target.value }))}>
                {(Object.keys(RESERVABLE_KIND_LABELS) as ReservableKind[]).map((k) => <option key={k} value={k}>{RESERVABLE_KIND_LABELS[k]}</option>)}
              </select>
              <input className={`rsv-cap${i.status === 'stopped' ? ' is-stopped' : ''}`} type="number" min={1} max={1000} defaultValue={i.capacity ?? ''} placeholder="定員" aria-label="定員"
                onBlur={(e) => String(i.capacity ?? '') !== e.target.value && void run(() => api.reservations.updateItem(i.id, { capacity: e.target.value === '' ? null : Number(e.target.value) }))} />
              <input className={`rsv-item-place${i.status === 'stopped' ? ' is-stopped' : ''}`} defaultValue={i.location} maxLength={60} placeholder="場所" aria-label="場所"
                onBlur={(e) => e.target.value !== i.location && void run(() => api.reservations.updateItem(i.id, { location: e.target.value }))} />
              <button type="button" role="switch" aria-checked={i.status === 'active'} aria-label={`${i.name}を${i.status === 'active' ? '止める' : '使う'}`}
                title={i.status === 'active' ? '使う' : '止める'} className={i.status === 'active' ? 'switch on' : 'switch'}
                onClick={() => void run(() => api.reservations.updateItem(i.id, { status: i.status === 'active' ? 'stopped' : 'active' }))}><span /></button>
            </>
          )} />
      )}
    </section>
  );
}
