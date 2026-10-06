/**
 * @file 問い合わせの記録の画面（仕様書 第33.8節・第33.17節）。一覧と 1 行の欄・1 件（会話の履歴・次にやること・項目の直し）。
 *
 * 一覧の上の 1 行の欄に書いて「残す」を押すと、AI が誰から・用件・どこで知ったか・次にやることに分けて残す。
 * 前の問い合わせの続き（「田中さんに見積もりを送った」）なら同じ問い合わせに足す。どの続きか決まらなければ候補を出す。
 * 項目ごとの入力の欄は並べない。説明文は常には出さない（原則 u11）。結果の知らせは押したボタンの横に出す（原則 u12）。
 * 秘書が問い合わせを残し終えたら読み直す（`changeKey`）。「更新」でも読み直せる（ページを読み直すと秘書との会話が切れるため）。
 * 段 2（第33.18節）: 窓口のアカウントのメールのうち問い合わせでないもの（戻せる）・月の振り返り・メールを開く・返事（下書き・承認へ進む）。
 */

import { useCallback, useEffect, useState } from 'react';
import {
  INQUIRY_CHANNEL_LABELS, INQUIRY_REPLY_STATUS_LABELS, INQUIRY_STATUS_LABELS, INQUIRY_TEMPERATURE_LABELS,
  type Inquiry, type InquiryChannel, type InquiryDetail, type InquiryMailSkipped, type InquiryReply, type InquiryStatus, type InquiryTemperature,
} from '@m2office/shared';
import { api, describeError, type InquiryRecorded } from './api.js';

const when = (iso: string) => new Date(iso).toLocaleString('ja-JP', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });
const dayLabel = (d: string) => { const [, m, dd] = d.split('-'); return `${Number(m)}/${Number(dd)}`; };
const today = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Tokyo', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());

/** 誰からの一言。 */
const whoOf = (i: Pick<Inquiry, 'from'>) => (i.from.name ? `${i.from.name}さん${i.from.company ? `（${i.from.company}）` : ''}` : i.from.company || 'お名前なし');

const STATUS_BADGE: Record<InquiryStatus, string> = { open: 'badge warn', done: 'badge ok', dropped: 'badge' };

/** 押したボタンの横に出す知らせ。`open` があれば、その問い合わせを開くリンクを添える。 */
type Note = { kind: 'ok' | 'error'; text: string; open?: () => void } | null;
function NoteText({ note }: { note: Note }) {
  return note
    ? <span className={`inquiries-note is-${note.kind}`} role={note.kind === 'error' ? 'alert' : 'status'}>
      {note.text}{note.open && <> <button className="link small" onClick={note.open}>開く</button></>}
    </span>
    : null;
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
export function Inquiries({ inquiryId, onOpen, onContact, changeKey = '', onColumn, admin = false, members = false, onMember }: {
  inquiryId: string | null;
  /** 会員とポイントを使えるか（同じ人の会員とポイントを出す。第40.8節）。 */
  members?: boolean;
  /** 会員を開く。 */
  onMember?: (memberId: string) => void;
  /** 会社の管理者か（本人から求められたときのまとめての削除を出す。第33.21節）。 */
  admin?: boolean;
  onOpen: (inquiryId: string | null) => void;
  onContact: (contactId: string) => void;
  userId: string;
  /** よくある質問の話題でコラムを書き始める（コラムの作成を使える人だけに渡す）。 */
  onColumn?: (theme: string) => Promise<void>;
  /** 秘書が問い合わせを残し終えるたびに変わる値。変わったら読み直す。 */
  changeKey?: string;
}) {
  return inquiryId
    ? <InquiryView key={inquiryId} id={inquiryId} onBack={() => onOpen(null)} onContact={onContact} onOpen={(id) => onOpen(id)} changeKey={changeKey} admin={admin} members={members} {...(onMember ? { onMember } : {})} />
    : <InquiryList onOpen={(id) => onOpen(id)} changeKey={changeKey} {...(onColumn ? { onColumn } : {})} />;
}

/** 1 行の欄と一覧。 */
function InquiryList({ onOpen, changeKey, onColumn }: { onOpen: (id: string) => void; changeKey: string; onColumn?: (theme: string) => Promise<void> }) {
  const [items, setItems] = useState<Inquiry[] | null>(null);
  const [status, setStatus] = useState<'open' | 'all'>('open');
  const [q, setQ] = useState('');
  // 経路・分類・担当の絞り込み（第33.21節。空はすべて）
  const [channel, setChannel] = useState('');
  const [category, setCategory] = useState('');
  const [assignee, setAssignee] = useState('');
  const [facets, setFacets] = useState<{ categories: string[]; assignees: { id: string; name: string }[] }>({ categories: [], assignees: [] });
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<Note>(null);
  const [candidates, setCandidates] = useState<Inquiry[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [panel, setPanel] = useState<'skipped' | 'review' | null>(null);

  const load = useCallback(() => {
    api.inquiries.list({ status, ...(q.trim() ? { q: q.trim() } : {}), ...(channel ? { channel } : {}), ...(category ? { category } : {}), ...(assignee ? { assignee } : {}) })
      .then((r) => { setItems(r.items); setFacets(r.facets); setError(null); }).catch((e) => setError(describeError(e, '読めませんでした')));
  }, [status, q, channel, category, assignee]);
  useEffect(() => { const t = setTimeout(load, q ? 250 : 0); return () => clearTimeout(t); }, [load, q]);
  // 秘書が問い合わせを残したら読み直す（はじめの 1 回は上で読む）
  useEffect(() => { if (changeKey) load(); }, [changeKey]); // eslint-disable-line react-hooks/exhaustive-deps
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
        <select value={channel} aria-label="経路" onChange={(e) => setChannel(e.target.value)}>
          <option value="">経路: すべて</option>
          {(Object.keys(INQUIRY_CHANNEL_LABELS) as InquiryChannel[]).map((c) => <option key={c} value={c}>{INQUIRY_CHANNEL_LABELS[c]}</option>)}
        </select>
        <select value={category} aria-label="分類" onChange={(e) => setCategory(e.target.value)}>
          <option value="">分類: すべて</option>
          {[...new Set([...facets.categories, ...(category ? [category] : [])])].map((c) => <option key={c} value={c}>{c}</option>)}
        </select>
        <select value={assignee} aria-label="担当" onChange={(e) => setAssignee(e.target.value)}>
          <option value="">担当: すべて</option>
          <option value="me">自分</option>
          {facets.assignees.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
        </select>
        <input className="inquiries-search" value={q} placeholder="検索" aria-label="検索" onChange={(e) => setQ(e.target.value)} />
        <button className="btn ghost small" onClick={() => { void api.inquiries.checkMail().catch(() => undefined).finally(load); }}>更新</button>
        <button className={panel === 'skipped' ? 'btn small' : 'btn ghost small'} onClick={() => setPanel(panel === 'skipped' ? null : 'skipped')}>問い合わせでないもの</button>
        <button className={panel === 'review' ? 'btn small' : 'btn ghost small'} onClick={() => setPanel(panel === 'review' ? null : 'review')}>振り返り</button>
      </div>
      {panel === 'skipped' && <SkippedMails onOpen={onOpen} onChanged={load} />}
      {panel === 'review' && <MonthReview {...(onColumn ? { onColumn } : {})} />}
      {error && <p className="error">{error}</p>}
      {items && items.length === 0 && <p className="muted">{q || channel || category || assignee ? '見つかりません。' : status === 'open' ? '対応中の問い合わせはありません。' : 'まだ問い合わせがありません。'}</p>}
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
function InquiryView({ id, onBack, onContact, onOpen, changeKey, admin, members, onMember }: {
  id: string; onBack: () => void; onContact: (contactId: string) => void; onOpen: (id: string) => void; changeKey: string; admin: boolean;
  members: boolean; onMember?: (memberId: string) => void;
}) {
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
  // 秘書が問い合わせを残したら読み直す（はじめの 1 回は上で読む）
  useEffect(() => { if (changeKey) load(); }, [changeKey]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (note?.kind !== 'ok' || note.open) return;
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
        <button className="btn ghost small" onClick={load}>更新</button>
        <NoteText note={note} />
      </div>
      <h2>{whoOf(i)} <span className={STATUS_BADGE[i.status]}>{INQUIRY_STATUS_LABELS[i.status]}</span>{members && <MemberBadge inquiryId={i.id} phone={i.from.phone} {...(onMember ? { onOpen: onMember } : {})} />}</h2>

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
        {events.map((e, n) => (
          <li key={e.id} className={e.direction === 'out' ? 'out' : 'in'}>
            <span className="small muted">{when(e.at)}・{INQUIRY_CHANNEL_LABELS[e.channel]}・{e.direction === 'out' ? 'こちらから' : '届いた'}・{e.createdByName}</span>
            {/* 続きとして入ったのが別の用件なら、別の問い合わせに分ける（最初の履歴は分けない） */}
            {n > 0 && (
              <button className="link small inquiries-split" disabled={busy}
                onClick={() => void (async () => {
                  setBusy(true);
                  try {
                    const r = await api.inquiries.split(e.id);
                    setNote({ kind: 'ok', text: '別の問い合わせに分けました', open: () => onOpen(r.id) });
                    load();
                  } catch (err) {
                    setNote({ kind: 'error', text: describeError(err, '分けられませんでした') });
                  } finally {
                    setBusy(false);
                  }
                })()}>別の問い合わせに分ける</button>
            )}
            <div>{e.summary}</div>
            {e.body && e.body !== e.summary && <details><summary className="small">書いた文</summary><p className="small">{e.body}</p></details>}
            {e.mail && <MailBody eventId={e.id} />}
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

      <Replies inquiryId={i.id} replies={d.replies} onChanged={load} />

      <div className="row inquiries-danger">
        <button className="btn ghost small danger" disabled={busy}
          onClick={() => { if (window.confirm('この問い合わせを削除しますか。会話の履歴と次にやることも削除します')) void act(() => api.inquiries.remove(i.id).then(onBack), null, '削除できませんでした'); }}>削除</button>
        {admin && <ErasePerson inquiryId={i.id} onDone={onBack} />}
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

/** 会話の履歴のメールの中身を、開いたときだけ窓口のアカウントから読む（本文は M2Office に写していない）。 */
function MailBody({ eventId }: { eventId: string }) {
  const [mail, setMail] = useState<{ from: string; subject: string; date: string; body: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const toggle = () => {
    if (open) { setOpen(false); return; }
    setOpen(true);
    if (!mail) api.inquiries.mail(eventId).then((m) => { setMail(m); setError(null); }).catch((e) => setError(describeError(e, 'メールを読めませんでした')));
  };
  return (
    <div className="inquiries-mail">
      <button className="link small" onClick={toggle}>{open ? 'メールを閉じる' : 'メールを開く'}</button>
      {open && error && <p className="error small">{error}</p>}
      {open && mail && (
        <div className="inquiries-mail-body small">
          <div className="muted">{mail.from}・{when(mail.date)}</div>
          <div><strong>{mail.subject}</strong></div>
          <pre>{mail.body}</pre>
        </div>
      )}
    </div>
  );
}

/** 返事（第33.18節）。下書きを書いてもらい、直して「承認へ進む」。承認の後に窓口のアカウントから送る。 */
function Replies({ inquiryId, replies, onChanged }: { inquiryId: string; replies: InquiryReply[]; onChanged: () => void }) {
  const draft = replies.find((r) => r.status === 'draft') ?? null;
  const [edit, setEdit] = useState<{ to: string; subject: string; body: string } | null>(draft ? { to: draft.to, subject: draft.subject, body: draft.body } : null);
  const [instruction, setInstruction] = useState('');
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<Note>(null);
  useEffect(() => { setEdit(draft ? { to: draft.to, subject: draft.subject, body: draft.body } : null); }, [draft?.id, draft?.body, draft?.subject, draft?.to]); // eslint-disable-line react-hooks/exhaustive-deps
  const run = async (fn: () => Promise<unknown>, ok: string | null, fail: string) => {
    setBusy(true);
    try { await fn(); setNote(ok ? { kind: 'ok', text: ok } : null); onChanged(); } catch (e) { setNote({ kind: 'error', text: describeError(e, fail) }); } finally { setBusy(false); }
  };
  const dirty = !!draft && !!edit && (edit.to !== draft.to || edit.subject !== draft.subject || edit.body !== draft.body);
  return (
    <div className="inquiries-replies">
      <h3>返事</h3>
      <div className="row">
        <input value={instruction} maxLength={200} aria-label="書き方の頼み" placeholder="書き方の頼み（もっと丁寧に・来週伺えると伝える など）" onChange={(e) => setInstruction(e.target.value)} />
        <button className="btn ghost small" disabled={busy} onClick={() => void run(() => api.inquiries.draftReply(inquiryId, instruction.trim()).then(() => setInstruction('')), draft ? '書き直しました' : '下書きを書きました', '下書きを書けませんでした')}>
          {busy ? '書いています…' : draft ? '下書きを書き直す' : '返事の下書き'}
        </button>
        <NoteText note={note} />
      </div>
      {draft && edit && (
        <div className="inquiries-reply-edit">
          {draft.channel === 'line'
            ? <label>宛先<input value="この問い合わせの LINE の相手" disabled /></label>
            : <label>宛先<input value={edit.to} maxLength={200} onChange={(e) => setEdit({ ...edit, to: e.target.value })} /></label>}
          <label>差出人<input value={draft.channel === 'line' ? `LINE 公式アカウント「${draft.from}」` : draft.from} disabled /></label>
          {draft.channel === 'mail' && <label>件名<input value={edit.subject} maxLength={200} onChange={(e) => setEdit({ ...edit, subject: e.target.value })} /></label>}
          <label>本文<textarea rows={10} value={edit.body} onChange={(e) => setEdit({ ...edit, body: e.target.value })} /></label>
          <div className="row">
            <button className="btn ghost small" disabled={busy || !dirty} onClick={() => void run(() => api.inquiries.updateReply(draft.id, edit), '保存しました', '保存できませんでした')}>保存</button>
            <button className="btn small" disabled={busy}
              onClick={() => void run(async () => { if (dirty) await api.inquiries.updateReply(draft.id, edit); await api.inquiries.submitReply(draft.id); }, '承認へ進めました。承認されると送ります', '承認へ進められませんでした')}>承認へ進む</button>
            <button className="btn ghost small danger" disabled={busy} onClick={() => void run(() => api.inquiries.deleteReply(draft.id), '下書きを削除しました', '削除できませんでした')}>削除</button>
          </div>
        </div>
      )}
      {replies.filter((r) => r.status !== 'draft').map((r) => (
        <details key={r.id} className="inquiries-reply-sent">
          <summary className="small">
            <span className={r.status === 'sent' ? 'badge ok' : 'badge warn'}>{INQUIRY_REPLY_STATUS_LABELS[r.status]}</span>
            {' '}{r.channel === 'line' ? 'LINE' : `${r.subject}・${r.to}`}{r.sentAt ? `・${when(r.sentAt)}` : ''}
          </summary>
          <pre className="small">{r.body}</pre>
        </details>
      ))}
    </div>
  );
}

/** 窓口のアカウントのメールのうち、問い合わせでないと見分けたもの。「問い合わせにする」で戻せる。 */
function SkippedMails({ onOpen, onChanged }: { onOpen: (id: string) => void; onChanged: () => void }) {
  const [items, setItems] = useState<InquiryMailSkipped[] | null>(null);
  const [note, setNote] = useState<Note>(null);
  const [busy, setBusy] = useState(false);
  const load = useCallback(() => {
    api.inquiries.skipped().then((r) => setItems(r.items)).catch((e) => setNote({ kind: 'error', text: describeError(e, '読めませんでした') }));
  }, []);
  useEffect(load, [load]);
  const promote = async (messageId: string) => {
    setBusy(true);
    try {
      const r = await api.inquiries.promote(messageId);
      setNote({ kind: 'ok', text: '問い合わせにしました', open: () => onOpen(r.id) });
      load(); onChanged();
    } catch (e) {
      setNote({ kind: 'error', text: describeError(e, '問い合わせにできませんでした') });
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="inquiries-panel">
      <NoteText note={note} />
      {items && items.length === 0 && <p className="muted small">ありません。</p>}
      {items && items.length > 0 && (
        <table className="table small">
          <thead><tr><th>届いた</th><th>差出人</th><th>件名</th><th>見分けた理由</th><th /></tr></thead>
          <tbody>
            {items.map((m) => (
              <tr key={m.messageId}>
                <td>{when(m.receivedAt)}</td><td>{m.from}</td><td>{m.subject}</td><td className="muted">{m.reason}</td>
                <td><button className="btn ghost small" disabled={busy} onClick={() => void promote(m.messageId)}>問い合わせにする</button></td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

/** 月の振り返り（数はプログラムが数える。第33.9節）と、よくある質問の話題（第33.19節）。 */
function MonthReview({ onColumn }: { onColumn?: (theme: string) => Promise<void> }) {
  const [which, setWhich] = useState<'prev' | 'this'>('prev');
  const [text, setText] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    // 今月は日本時間の今日の月。先月はサーバーが決める（月の指定なし）
    const month = which === 'this' ? today().slice(0, 7) : undefined;
    api.inquiries.review(month).then((r) => { setText(r.text); setError(null); }).catch((e) => setError(describeError(e, '読めませんでした')));
  }, [which]);
  return (
    <div className="inquiries-panel">
      <div className="row">
        <button className={which === 'prev' ? 'btn small' : 'btn ghost small'} onClick={() => setWhich('prev')}>先月</button>
        <button className={which === 'this' ? 'btn small' : 'btn ghost small'} onClick={() => setWhich('this')}>今月</button>
      </div>
      {error && <p className="error small">{error}</p>}
      {text && <p className="inquiries-review">{text}</p>}
      <FaqTopics onColumn={onColumn} />
    </div>
  );
}

/** よくある質問の話題。コラムの作成を使える人には「コラムにする」を出す（話題だけを渡す。誰が聞いたかは渡さない）。 */
function FaqTopics({ onColumn }: { onColumn?: (theme: string) => Promise<void> }) {
  const [topics, setTopics] = useState<{ topic: string; count: number }[] | null>(null);
  const [note, setNote] = useState<Note>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => { api.inquiries.faq().then((r) => setTopics(r.topics)).catch(() => setTopics([])); }, []);
  if (!topics || topics.length === 0) return null;
  return (
    <div className="inquiries-faq">
      <h4>よくある質問（最近 90 日）</h4>
      <ul>
        {topics.map((t) => (
          <li key={t.topic}>
            {t.topic}（{t.count} 件）
            {onColumn && (
              <button className="btn ghost small" disabled={busy}
                onClick={() => void (async () => {
                  setBusy(true);
                  try { await onColumn(t.topic); } catch (e) { setNote({ kind: 'error', text: describeError(e, 'コラムを書き始められませんでした') }); } finally { setBusy(false); }
                })()}>コラムにする</button>
            )}
          </li>
        ))}
      </ul>
      <NoteText note={note} />
    </div>
  );
}

/**
 * 本人から求められたときに、その人の問い合わせと、問い合わせから作った連絡先をまとめて削除する（管理者だけ。第33.21節）。
 * 押すと当たった問い合わせを並べ、「削除」で削除する（取り消せないため、ここだけ確かめを挟む）。
 */
function ErasePerson({ inquiryId, onDone }: { inquiryId: string; onDone: () => void }) {
  const [target, setTarget] = useState<{ inquiries: Inquiry[]; contacts: number } | null>(null);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<Note>(null);
  const [done, setDone] = useState<string | null>(null);
  const open = () => {
    setBusy(true);
    api.inquiries.person(inquiryId).then(setTarget).catch((e) => setNote({ kind: 'error', text: describeError(e, '読めませんでした') })).finally(() => setBusy(false));
  };
  const erase = () => {
    setBusy(true);
    api.inquiries.erasePerson(inquiryId)
      .then((r) => setDone(`問い合わせ ${r.inquiries} 件と、問い合わせから作った連絡先 ${r.contacts} 件を削除しました。${r.keptContacts ? `名刺から作った連絡先 ${r.keptContacts} 件は残しています（名刺管理で削除してください）。` : ''}`))
      .catch((e) => setNote({ kind: 'error', text: describeError(e, '削除できませんでした') }))
      .finally(() => setBusy(false));
  };
  if (done) {
    return (
      <div className="card inquiries-erase">
        <p role="status">{done}</p>
        <button className="btn ghost small" onClick={onDone}>‹ 問い合わせの一覧</button>
      </div>
    );
  }
  if (!target) {
    return (
      <>
        <button className="btn ghost small danger" disabled={busy} onClick={open}>この人の問い合わせをまとめて削除</button>
        <NoteText note={note} />
      </>
    );
  }
  return (
    <div className="card inquiries-erase">
      <p>次の問い合わせ {target.inquiries.length} 件と、会話の履歴・次にやること・返事を削除します。問い合わせから作った連絡先も削除します（{target.contacts} 件まで）。元に戻せません。</p>
      <ul>
        {target.inquiries.map((x) => (
          <li key={x.id}>{new Date(x.lastAt).toLocaleDateString('ja-JP')}　{whoOf(x)}　{INQUIRY_CHANNEL_LABELS[x.channel]}　<span className="muted">{x.summary}</span></li>
        ))}
      </ul>
      <div className="row">
        <button className="btn danger small" disabled={busy} onClick={erase}>削除</button>
        <button className="btn ghost small" disabled={busy} onClick={() => setTarget(null)}>キャンセル</button>
        <NoteText note={note} />
      </div>
    </div>
  );
}

/** 同じ人の会員とポイント（LINE のお客様か電話で見分ける。第40.8節）。会員でなければ何も出さない。 */
function MemberBadge({ inquiryId, phone, onOpen }: { inquiryId: string; phone: string; onOpen?: (memberId: string) => void }) {
  const [m, setM] = useState<{ id: string; number: number; balance: number } | null>(null);
  useEffect(() => {
    api.members.lookup({ inquiryId, phone }).then((r) => setM(r.member)).catch(() => setM(null));
  }, [inquiryId, phone]);
  if (!m) return null;
  return <>{' '}<button className="badge ok" onClick={() => onOpen?.(m.id)}>会員 No. {m.number}・{m.balance} ポイント</button></>;
}
