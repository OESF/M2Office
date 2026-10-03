/**
 * @file 問い合わせの記録の画面（仕様書 第33.8節・第33.17節）。一覧と 1 行の欄・1 件（会話の履歴・次にやること・項目の直し）。
 *
 * 一覧の上の 1 行の欄に書いて「残す」を押すと、AI が誰から・用件・どこで知ったか・次にやることに分けて残す。
 * 前の問い合わせの続き（「田中さんに見積もりを送った」）なら同じ問い合わせに足す。どの続きか決まらなければ候補を出す。
 * 項目ごとの入力の欄は並べない。説明文は常には出さない（原則 u11）。結果の知らせは押したボタンの横に出す（原則 u12）。
 */

import { useCallback, useEffect, useState } from 'react';
import {
  INQUIRY_CHANNEL_LABELS, INQUIRY_STATUS_LABELS, INQUIRY_TEMPERATURE_LABELS,
  type Inquiry, type InquiryChannel, type InquiryDetail, type InquiryStatus, type InquiryTemperature,
} from '@m2office/shared';
import { api, describeError, type InquiryRecorded } from './api.js';

const when = (iso: string) => new Date(iso).toLocaleString('ja-JP', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });
const dayLabel = (d: string) => { const [, m, dd] = d.split('-'); return `${Number(m)}/${Number(dd)}`; };
const today = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Tokyo', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());

/** 誰からの一言。 */
const whoOf = (i: Pick<Inquiry, 'from'>) => (i.from.name ? `${i.from.name}さん${i.from.company ? `（${i.from.company}）` : ''}` : i.from.company || 'お名前なし');

const STATUS_BADGE: Record<InquiryStatus, string> = { open: 'badge warn', done: 'badge ok', dropped: 'badge' };

/** 押したボタンの横に出す知らせ。 */
type Note = { kind: 'ok' | 'error'; text: string } | null;
function NoteText({ note }: { note: Note }) {
  return note ? <span className={`inquiries-note is-${note.kind}`} role={note.kind === 'error' ? 'alert' : 'status'}>{note.text}</span> : null;
}

/** 残した結果の一言。 */
function recordedText(r: Extract<InquiryRecorded, { kind: string }>): string {
  const head = r.kind === 'created' ? `残しました（${whoOf(r.inquiry)}・${r.inquiry.category || '問い合わせ'}）` : `${whoOf(r.inquiry)}の問い合わせに足しました`;
  return [
    head,
    r.closedTask ? `「${r.closedTask.what}」を済みにしました` : '',
    r.task ? `次にやること: ${r.task.what}${r.task.due ? `（${dayLabel(r.task.due)} まで）` : ''}` : '',
    r.sensitive ? '健康などのことは記録に入れていません' : '',
    r.contactCreated ? '名刺管理に連絡先を作りました' : '',
  ].filter(Boolean).join('。');
}

/**
 * 問い合わせの記録の画面。
 *
 * @param inquiryId 開いている問い合わせ（無ければ一覧）
 * @param onOpen 問い合わせを開く・一覧に戻る（`null`）
 * @param onContact 名刺管理の連絡先を開く
 */
export function Inquiries({ inquiryId, onOpen, onContact }: {
  inquiryId: string | null;
  onOpen: (inquiryId: string | null) => void;
  onContact: (contactId: string) => void;
  userId: string;
}) {
  return inquiryId
    ? <InquiryView key={inquiryId} id={inquiryId} onBack={() => onOpen(null)} onContact={onContact} />
    : <InquiryList onOpen={(id) => onOpen(id)} />;
}

/** 1 行の欄と一覧。 */
function InquiryList({ onOpen }: { onOpen: (id: string) => void }) {
  const [items, setItems] = useState<Inquiry[] | null>(null);
  const [status, setStatus] = useState<'open' | 'all'>('open');
  const [q, setQ] = useState('');
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<Note>(null);
  const [candidates, setCandidates] = useState<Inquiry[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    api.inquiries.list({ status, ...(q.trim() ? { q: q.trim() } : {}) })
      .then((r) => { setItems(r.items); setError(null); }).catch((e) => setError(describeError(e, '読めませんでした')));
  }, [status, q]);
  useEffect(() => { const t = setTimeout(load, q ? 250 : 0); return () => clearTimeout(t); }, [load, q]);
  useEffect(() => {
    if (note?.kind !== 'ok') return;
    const t = setTimeout(() => setNote(null), 6000);
    return () => clearTimeout(t);
  }, [note]);

  const done = (r: InquiryRecorded) => {
    if ('ambiguous' in r) { setCandidates(r.candidates); setNote(null); return; }
    setText(''); setCandidates(null);
    setNote({ kind: 'ok', text: recordedText(r) });
    load();
  };
  const record = async () => {
    setBusy(true);
    try { done(await api.inquiries.record(text.trim())); } catch (e) { setNote({ kind: 'error', text: describeError(e, '残せませんでした') }); } finally { setBusy(false); }
  };
  const appendTo = async (id: string) => {
    setBusy(true);
    try { done(await api.inquiries.append(id, text.trim())); } catch (e) { setNote({ kind: 'error', text: describeError(e, '足せませんでした') }); } finally { setBusy(false); }
  };

  const t = today();
  return (
    <div className="inquiries">
      <div className="inquiries-entry">
        <input value={text} maxLength={4000} aria-label="問い合わせ"
          placeholder="いま田中さんから電話。来月の見積もりがほしい。ホームページを見たって。金曜日までに送る"
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter' && text.trim() && !busy && !e.nativeEvent.isComposing) void record(); }} />
        <button className="btn" disabled={busy || !text.trim()} onClick={() => void record()}>{busy ? '残しています…' : '残す'}</button>
        <NoteText note={note} />
      </div>
      {candidates && (
        <div className="inquiries-candidates">
          <p className="small">どの問い合わせの続きですか</p>
          {candidates.map((c) => (
            <div key={c.id} className="row">
              <span>{whoOf(c)}・{c.summary.slice(0, 40)}</span>
              <button className="btn ghost small" disabled={busy} onClick={() => void appendTo(c.id)}>この問い合わせに足す</button>
            </div>
          ))}
          <button className="btn ghost small" onClick={() => setCandidates(null)}>キャンセル</button>
        </div>
      )}
      <div className="row inquiries-filter">
        <button className={status === 'open' ? 'btn small' : 'btn ghost small'} onClick={() => setStatus('open')}>対応中</button>
        <button className={status === 'all' ? 'btn small' : 'btn ghost small'} onClick={() => setStatus('all')}>すべて</button>
        <input className="inquiries-search" value={q} placeholder="検索" aria-label="検索" onChange={(e) => setQ(e.target.value)} />
      </div>
      {error && <p className="error">{error}</p>}
      {items && items.length === 0 && <p className="muted">{q ? '見つかりません。' : status === 'open' ? '対応中の問い合わせはありません。' : 'まだ問い合わせがありません。'}</p>}
      {items && items.length > 0 && (
        <table className="table inquiries-list">
          <thead><tr><th>次にやること</th><th>誰から</th><th>経路</th><th>用件</th><th>担当</th><th>状態</th><th>最後</th></tr></thead>
          <tbody>
            {items.map((i) => {
              const due = i.nextTask?.due ?? null;
              return (
                <tr key={i.id} className="clickable" onClick={() => onOpen(i.id)}>
                  <td className={due && due < t ? 'inquiries-overdue' : ''}>
                    {i.nextTask ? <>{due && <span className="small">{dayLabel(due)} </span>}{i.nextTask.what}</> : <span className="muted">—</span>}
                  </td>
                  <td><button className="link" onClick={(e) => { e.stopPropagation(); onOpen(i.id); }}>{whoOf(i)}</button></td>
                  <td>{INQUIRY_CHANNEL_LABELS[i.channel]}</td>
                  <td className="inquiries-summary">{i.category && <span className="badge">{i.category}</span>} {i.summary}</td>
                  <td>{i.nextTask?.assigneeName || i.receivedByName}</td>
                  <td><span className={STATUS_BADGE[i.status]}>{INQUIRY_STATUS_LABELS[i.status]}</span></td>
                  <td className="small">{when(i.lastAt)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </div>
  );
}

/** 1 件の問い合わせ。 */
function InquiryView({ id, onBack, onContact }: { id: string; onBack: () => void; onContact: (contactId: string) => void }) {
  const [d, setD] = useState<InquiryDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<Note>(null);
  const [more, setMore] = useState('');
  const [taskWhat, setTaskWhat] = useState('');
  const [taskDue, setTaskDue] = useState('');
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => {
    api.inquiries.get(id).then((r) => { setD(r); setError(null); }).catch((e) => setError(describeError(e, '読めませんでした')));
  }, [id]);
  useEffect(load, [load]);
  useEffect(() => {
    if (note?.kind !== 'ok') return;
    const t = setTimeout(() => setNote(null), 5000);
    return () => clearTimeout(t);
  }, [note]);

  const act = async (fn: () => Promise<unknown>, ok: string | null, fail: string) => {
    setBusy(true);
    try {
      await fn();
      setNote(ok ? { kind: 'ok', text: ok } : null);
      load();
    } catch (e) {
      setNote({ kind: 'error', text: describeError(e, fail) });
    } finally {
      setBusy(false);
    }
  };

  if (error) return <div className="inquiries"><button className="link small" onClick={onBack}>‹ 問い合わせの一覧</button><p className="error">{error}</p></div>;
  if (!d) return <div className="inquiries"><p className="muted">読み込み中…</p></div>;
  const { inquiry: i, events, tasks } = d;
  const save = (patch: Parameters<typeof api.inquiries.update>[1]) => void act(() => api.inquiries.update(i.id, patch), '保存しました', '保存できませんでした');
  const t = today();

  return (
    <div className="inquiries">
      <div className="row">
        <button className="link small" onClick={onBack}>‹ 問い合わせの一覧</button>
        <NoteText note={note} />
      </div>
      <h2>{whoOf(i)} <span className={STATUS_BADGE[i.status]}>{INQUIRY_STATUS_LABELS[i.status]}</span></h2>

      <div className="inquiries-fields">
        <label>名前<input defaultValue={i.from.name} maxLength={80} onBlur={(e) => { if (e.target.value !== i.from.name) save({ from: { name: e.target.value } }); }} /></label>
        <label>会社<input defaultValue={i.from.company} maxLength={120} onBlur={(e) => { if (e.target.value !== i.from.company) save({ from: { company: e.target.value } }); }} /></label>
        <label>電話<input defaultValue={i.from.phone} maxLength={40} onBlur={(e) => { if (e.target.value !== i.from.phone) save({ from: { phone: e.target.value } }); }} /></label>
        <label>メール<input defaultValue={i.from.email} maxLength={200} onBlur={(e) => { if (e.target.value !== i.from.email) save({ from: { email: e.target.value } }); }} /></label>
        <label>経路
          <select value={i.channel} onChange={(e) => save({ channel: e.target.value })}>
            {(Object.keys(INQUIRY_CHANNEL_LABELS) as InquiryChannel[]).map((c) => <option key={c} value={c}>{INQUIRY_CHANNEL_LABELS[c]}</option>)}
          </select>
        </label>
        <label>分類<input defaultValue={i.category} maxLength={40} onBlur={(e) => { if (e.target.value !== i.category) save({ category: e.target.value }); }} /></label>
        <label>どこで知ったか<input defaultValue={i.source} maxLength={40} onBlur={(e) => { if (e.target.value !== i.source) save({ source: e.target.value }); }} /></label>
        <label>温度感
          <select value={i.temperature} onChange={(e) => save({ temperature: e.target.value })}>
            {(Object.keys(INQUIRY_TEMPERATURE_LABELS) as InquiryTemperature[]).map((x) => <option key={x} value={x}>{INQUIRY_TEMPERATURE_LABELS[x]}</option>)}
          </select>
        </label>
        <label>状態
          <select value={i.status} onChange={(e) => save({ status: e.target.value })}>
            {(Object.keys(INQUIRY_STATUS_LABELS) as InquiryStatus[]).map((x) => <option key={x} value={x}>{INQUIRY_STATUS_LABELS[x]}</option>)}
          </select>
        </label>
        <label className="wide">用件<textarea rows={2} defaultValue={i.summary} maxLength={400} onBlur={(e) => { if (e.target.value !== i.summary) save({ summary: e.target.value }); }} /></label>
      </div>
      <p className="small muted">
        受けた人: {i.receivedByName}・{when(i.firstAt)}
        {i.contactId && <> ・ <button className="link small" onClick={() => onContact(i.contactId!)}>名刺を開く</button></>}
      </p>

      <h3>次にやること</h3>
      {tasks.length === 0 && <p className="muted small">ありません。</p>}
      <ul className="inquiries-tasks">
        {tasks.map((task) => (
          <li key={task.id} className={task.doneAt ? 'done' : task.due && task.due < t ? 'inquiries-overdue' : ''}>
            <label className="check">
              <input type="checkbox" checked={!!task.doneAt} disabled={busy}
                onChange={(e) => void act(() => api.inquiries.updateTask(task.id, { done: e.target.checked }), e.target.checked ? '済みにしました' : '戻しました', '変えられませんでした')} />
              {task.what}
            </label>
            <input type="date" value={task.due ?? ''} disabled={busy || !!task.doneAt} aria-label="期限"
              onChange={(e) => void act(() => api.inquiries.updateTask(task.id, { due: e.target.value || null }), '期限を変えました', '変えられませんでした')} />
            <span className="small muted">{task.assigneeName}</span>
          </li>
        ))}
      </ul>
      <div className="row">
        <input value={taskWhat} maxLength={120} placeholder="見積もりを送る" aria-label="次にやること" onChange={(e) => setTaskWhat(e.target.value)} />
        <input type="date" value={taskDue} aria-label="期限" onChange={(e) => setTaskDue(e.target.value)} />
        <button className="btn ghost small" disabled={busy || !taskWhat.trim()}
          onClick={() => void act(() => api.inquiries.addTask(i.id, { what: taskWhat.trim(), due: taskDue || null }).then(() => { setTaskWhat(''); setTaskDue(''); }), '足しました', '足せませんでした')}>足す</button>
      </div>

      <h3>会話の履歴</h3>
      <ol className="inquiries-events">
        {events.map((e) => (
          <li key={e.id} className={e.direction === 'out' ? 'out' : 'in'}>
            <span className="small muted">{when(e.at)}・{INQUIRY_CHANNEL_LABELS[e.channel]}・{e.direction === 'out' ? 'こちらから' : '届いた'}・{e.createdByName}</span>
            <div>{e.summary}</div>
            {e.body && e.body !== e.summary && <details><summary className="small">書いた文</summary><p className="small">{e.body}</p></details>}
          </li>
        ))}
      </ol>
      <div className="inquiries-entry">
        <input value={more} maxLength={4000} aria-label="続き" placeholder="見積もりを送った・折り返しの電話があった など"
          onChange={(e) => setMore(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter' && more.trim() && !busy && !e.nativeEvent.isComposing) {
            void act(async () => { const r = await api.inquiries.append(i.id, more.trim()); setMore(''); return r; }, '足しました', '足せませんでした');
          } }} />
        <button className="btn ghost" disabled={busy || !more.trim()}
          onClick={() => void act(async () => { const r = await api.inquiries.append(i.id, more.trim()); setMore(''); return r; }, '足しました', '足せませんでした')}>続きを足す</button>
      </div>

      <div className="row inquiries-danger">
        <button className="btn ghost small danger" disabled={busy}
          onClick={() => { if (window.confirm('この問い合わせを削除しますか。会話の履歴と次にやることも削除します')) void act(() => api.inquiries.remove(i.id).then(onBack), null, '削除できませんでした'); }}>削除</button>
      </div>
    </div>
  );
}

/**
 * 名刺の詳細に並べる、その人の問い合わせ（第33.6.1節）。無ければ何も出さない。
 *
 * @param contactId 名刺管理の連絡先
 * @param onOpen 問い合わせを開く
 */
export function ContactInquiries({ contactId, onOpen }: { contactId: string; onOpen: (inquiryId: string) => void }) {
  const [items, setItems] = useState<Inquiry[]>([]);
  useEffect(() => {
    // 読めないとき（使えなくなった・つながらない）は出さない。名刺の詳細は止めない
    api.inquiries.list({ status: 'all', contactId }).then((r) => setItems(r.items)).catch(() => setItems([]));
  }, [contactId]);
  if (items.length === 0) return null;
  return (
    <>
      <h3>問い合わせ</h3>
      <ul className="card-exchanges">
        {items.map((i) => (
          <li key={i.id}>
            {when(i.firstAt)}　<button className="link" onClick={() => onOpen(i.id)}>{i.category || '問い合わせ'}・{i.summary.slice(0, 40)}</button>
            　<span className={STATUS_BADGE[i.status]}>{INQUIRY_STATUS_LABELS[i.status]}</span>
          </li>
        ))}
      </ul>
    </>
  );
}
