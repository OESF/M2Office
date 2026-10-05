/**
 * @file お知らせの作成の画面（仕様書 第35.8節・第35.17節）。一覧と 1 行の欄・1 件（出し先ごとの見え方と直し・承認へ進む・出した後の結果）。
 *
 * 一覧の上の 1 行の欄に「年末年始の休業 12/28〜1/5」と書いて「作る」を押すと、AI が出し先ごとの文を作る。
 * 1 件では、出し先ごとのタブで見え方（Web の記事・LINE の吹き出し・サイネージの画面の 1 枚）を出し、その場で直せる。
 * 「承認へ進む」で管理者か承認者の承認を待ち、承認されると出す（1 回の承認。ADR-0028）。説明文は常には出さない（原則 u11）。
 */

import { useCallback, useEffect, useState } from 'react';
import {
  ANNOUNCEMENT_BAND_COLORS, ANNOUNCEMENT_CHANNELS, ANNOUNCEMENT_CHANNEL_LABELS, ANNOUNCEMENT_LINE_MAX, ANNOUNCEMENT_STATUS_LABELS,
  type Announcement, type AnnouncementChannel, type AnnouncementDetail, type AnnouncementPreview, type AnnouncementRecipient, type AnnouncementTexts,
} from '@m2office/shared';
import { api, describeError } from './api.js';
import { copyText } from './clipboard.js';
import { Markdown } from './help.js';

const when = (iso: string | null) => (iso ? new Date(iso).toLocaleString('ja-JP', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '');
const md = (d: string | null) => (d ? `${Number(d.slice(5, 7))}/${Number(d.slice(8, 10))}` : '');
const period = (a: Pick<Announcement, 'startDate' | 'endDate'>) => (a.startDate || a.endDate ? `${md(a.startDate)}${a.endDate && a.endDate !== a.startDate ? `〜${md(a.endDate)}` : ''}` : '');
/** ISO を datetime-local の値に（日本時間）。 */
const toLocal = (iso: string | null) => (iso ? new Date(new Date(iso).getTime() + 9 * 3_600_000).toISOString().slice(0, 16) : '');
const fromLocal = (v: string) => (v ? new Date(`${v}:00+09:00`).toISOString() : null);

type Note = { kind: 'ok' | 'error'; text: string } | null;
function NoteText({ note }: { note: Note }) {
  return note ? <span className={`inquiries-note is-${note.kind}`} role={note.kind === 'error' ? 'alert' : 'status'}>{note.text}</span> : null;
}

const STATUS_BADGE: Record<Announcement['status'], string> = {
  draft: 'badge', awaiting: 'badge warn', scheduled: 'badge warn', published: 'badge ok', ended: 'badge', cancelled: 'badge',
};

/** 一覧と 1 行の欄。 */
function List({ onOpen, changeKey }: { onOpen: (id: string) => void; changeKey: string }) {
  const [items, setItems] = useState<Announcement[] | null>(null);
  const [line, setLine] = useState<{ followers: number | null; remaining: number | null } | null>(null);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<Note>(null);
  const load = useCallback(() => {
    api.announcements.list().then((r) => setItems(r.items)).catch((e) => setNote({ kind: 'error', text: describeError(e, '読めませんでした') }));
    api.announcements.lineStatus().then((r) => setLine(r.line)).catch(() => setLine(null));
  }, []);
  useEffect(() => { load(); }, [load, changeKey]);
  const make = () => {
    if (!text.trim()) return;
    setBusy(true);
    api.announcements.draft(text.trim()).then((r) => { setText(''); onOpen(r.announcement.id); })
      .catch((e) => setNote({ kind: 'error', text: describeError(e, '作れませんでした') })).finally(() => setBusy(false));
  };
  return (
    <div className="announcements">
      <div className="row wrap inquiries-entry">
        <input value={text} maxLength={2000} placeholder="例: 年末年始の休業 12/28〜1/5" aria-label="お知らせの頼み" onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter' && !busy) make(); }} />
        <button className="btn" disabled={busy || !text.trim()} onClick={make}>{busy ? '作っています…' : '作る'}</button>
        <NoteText note={note} />
      </div>
      {line && <p className="small muted">LINE の友だち {line.followers ?? '—'} 人・今月の残り {line.remaining ?? '上限なし'}{line.remaining !== null ? ' 通' : ''}</p>}
      {items && items.length === 0 && <p className="muted">まだありません</p>}
      {items && items.length > 0 && (
        <table className="table">
          <thead><tr><th>題名</th><th>期間</th><th>出し先</th><th>状態</th><th>出す日時</th></tr></thead>
          <tbody>
            {items.map((a) => (
              <tr key={a.id}>
                <td><button className="link" onClick={() => onOpen(a.id)}>{a.title || '（題名なし）'}</button></td>
                <td>{period(a)}</td>
                <td>{a.channels.map((c) => ANNOUNCEMENT_CHANNEL_LABELS[c]).join('・')}</td>
                <td><span className={STATUS_BADGE[a.status]}>{ANNOUNCEMENT_STATUS_LABELS[a.status]}</span></td>
                <td>{a.publishAt ? when(a.publishAt) : a.publishedAt ? when(a.publishedAt) : '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

/** 1 件。 */
function Detail({ id, onBack, onApprovals, changeKey }: { id: string; onBack: () => void; onApprovals: () => void; changeKey: string }) {
  const [d, setD] = useState<AnnouncementDetail | null>(null);
  const [p, setP] = useState<AnnouncementPreview | null>(null);
  const [edit, setEdit] = useState<{ title: string; startDate: string; endDate: string; publishAt: string; channels: AnnouncementChannel[]; texts: AnnouncementTexts; mailContactIds: string[] } | null>(null);
  const [recipients, setRecipients] = useState<AnnouncementRecipient[]>([]);
  const [tab, setTab] = useState<AnnouncementChannel>('web');
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<Note>(null);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(() => {
    api.announcements.get(id).then((r) => {
      setD(r);
      const a = r.announcement;
      setEdit({ title: a.title, startDate: a.startDate ?? '', endDate: a.endDate ?? '', publishAt: toLocal(a.publishAt), channels: a.channels, texts: a.texts, mailContactIds: a.mailContactIds });
      if (a.mailContactIds.length) api.announcements.recipients(id).then((x) => setRecipients(x.recipients)).catch(() => setRecipients([]));
      if (a.channels.length && !a.channels.includes(tab)) setTab(a.channels[0]!);
      if (a.status === 'draft') api.announcements.preview(id).then(setP).catch(() => setP(null));
      else setP(null);
    }).catch((e) => setError(describeError(e, '読めませんでした')));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);
  useEffect(() => { load(); }, [load, changeKey]);
  // サイネージの画面の見本は、打つのが止まってから保存する前の文で組み直す
  const signageTexts = edit?.texts.signage;
  const [screenTexts, setScreenTexts] = useState<AnnouncementTexts['signage'] | null>(null);
  useEffect(() => {
    if (!signageTexts) return;
    const t = window.setTimeout(() => setScreenTexts(signageTexts), 400);
    return () => window.clearTimeout(t);
  }, [signageTexts]);
  if (error) return <p className="error">{error}</p>;
  if (!d || !edit) return <p className="muted">読んでいます…</p>;
  const a = d.announcement;
  const editable = a.status === 'draft';
  const save = async () => {
    await api.announcements.update(id, {
      title: edit.title, startDate: edit.startDate || null, endDate: edit.endDate || null, publishAt: fromLocal(edit.publishAt), channels: edit.channels, texts: edit.texts, mailContactIds: edit.mailContactIds,
    });
  };
  const run = (fn: () => Promise<unknown>, ok: string) => {
    setBusy(true);
    fn().then(() => { setNote({ kind: 'ok', text: ok }); load(); }).catch((e) => setNote({ kind: 'error', text: describeError(e, 'できませんでした') })).finally(() => setBusy(false));
  };
  const setTexts = (t: Partial<AnnouncementTexts>) => setEdit({ ...edit, texts: { ...edit.texts, ...t } });
  const outputs = new Map(d.outputs.map((o) => [o.channel, o]));
  return (
    <div className="announcements">
      <div className="row wrap">
        <button className="link small" onClick={onBack}>一覧に戻る</button>
        <span className={STATUS_BADGE[a.status]}>{ANNOUNCEMENT_STATUS_LABELS[a.status]}</span>
      </div>
      <div className="card announcements-head">
        <label>題名<input value={edit.title} maxLength={80} disabled={!editable} onChange={(e) => setEdit({ ...edit, title: e.target.value })} /></label>
        <div className="row wrap announcements-dates">
          <div className="announcements-field">
            <span id="announcement-period">期間</span>
            <div className="announcements-range" role="group" aria-labelledby="announcement-period">
              <input type="date" aria-label="期間の始まり" value={edit.startDate} disabled={!editable} onChange={(e) => setEdit({ ...edit, startDate: e.target.value })} />
              <span>〜</span>
              <input type="date" aria-label="期間の終わり" value={edit.endDate} disabled={!editable} onChange={(e) => setEdit({ ...edit, endDate: e.target.value })} />
            </div>
          </div>
          <div className="announcements-field">
            <span id="announcement-publish-at">出す日時</span>
            <div className="announcements-range">
              <input type="datetime-local" aria-labelledby="announcement-publish-at" value={edit.publishAt} disabled={!editable} onChange={(e) => setEdit({ ...edit, publishAt: e.target.value })} />
              {!edit.publishAt && <span className="small muted">承認したとき</span>}
            </div>
          </div>
        </div>
        <div className="row wrap">
          {ANNOUNCEMENT_CHANNELS.map((c) => (
            <label key={c} className="check">
              <input type="checkbox" checked={edit.channels.includes(c)} disabled={!editable || (!d.available[c] && !edit.channels.includes(c))}
                onChange={(e) => setEdit({ ...edit, channels: e.target.checked ? [...edit.channels, c] : edit.channels.filter((x) => x !== c) })} />
              {ANNOUNCEMENT_CHANNEL_LABELS[c]}{!d.available[c] && <span className="small muted">（つないでいません）</span>}
            </label>
          ))}
        </div>
      </div>

      <div className="announcements-tabs" role="tablist">
        {ANNOUNCEMENT_CHANNELS.filter((c) => edit.channels.includes(c)).map((c) => (
          <button key={c} role="tab" aria-selected={tab === c} className={tab === c ? 'on' : ''} onClick={() => setTab(c)}>{ANNOUNCEMENT_CHANNEL_LABELS[c]}</button>
        ))}
      </div>
      {tab === 'web' && edit.channels.includes('web') && (
        <div className="card announcements-channel">
          <label>記事の題名<input value={edit.texts.web.title} maxLength={80} disabled={!editable} onChange={(e) => setTexts({ web: { ...edit.texts.web, title: e.target.value } })} /></label>
          <label>本文<textarea rows={8} value={edit.texts.web.body} disabled={!editable} onChange={(e) => setTexts({ web: { ...edit.texts.web, body: e.target.value } })} /></label>
          <div className="announcements-web-preview"><h3>{edit.texts.web.title}</h3><Markdown text={edit.texts.web.body} lineBreaks /></div>
          {!d.wordpress && (
            <div className="row wrap">
              <button className="btn ghost small" onClick={() => void api.announcements.copy(id).then((r) => copyText(r.html)).then(() => setNote({ kind: 'ok', text: 'HTML をコピーしました' }))}>HTML をコピー</button>
              <button className="btn ghost small" onClick={() => void api.announcements.copy(id).then((r) => copyText(r.text)).then(() => setNote({ kind: 'ok', text: 'テキストをコピーしました' }))}>テキストをコピー</button>
            </div>
          )}
        </div>
      )}
      {tab === 'line' && edit.channels.includes('line') && (
        <div className="card announcements-channel">
          <label>LINE の文<textarea rows={6} maxLength={ANNOUNCEMENT_LINE_MAX} value={edit.texts.line} disabled={!editable} onChange={(e) => setTexts({ line: e.target.value })} /></label>
          <span className="small muted">{edit.texts.line.length} / {ANNOUNCEMENT_LINE_MAX} 字</span>
          <div className="announcements-line-bubble">{edit.texts.line}</div>
        </div>
      )}
      {tab === 'mail' && edit.channels.includes('mail') && (
        <div className="card announcements-channel">
          <label>件名<input value={edit.texts.mail.subject} maxLength={200} disabled={!editable} onChange={(e) => setTexts({ mail: { ...edit.texts.mail, subject: e.target.value } })} /></label>
          <label>本文<textarea rows={8} value={edit.texts.mail.body} disabled={!editable} onChange={(e) => setTexts({ mail: { ...edit.texts.mail, body: e.target.value } })} /></label>
          <MailRecipients id={id} editable={editable} ids={edit.mailContactIds} people={recipients}
            onChange={(ids, people) => {
              if (people) setRecipients((old) => [...new Map([...old, ...people].map((r) => [r.contactId, r])).values()]);
              setEdit({ ...edit, mailContactIds: ids });
            }} />
        </div>
      )}
      {tab === 'signage' && edit.channels.includes('signage') && (
        <div className="card announcements-channel">
          <div className="row wrap">
            <label>見出し<input value={edit.texts.signage.headline} maxLength={30} disabled={!editable} onChange={(e) => setTexts({ signage: { ...edit.texts.signage, headline: e.target.value } })} /></label>
            <label>期間の書き方<input value={edit.texts.signage.period} maxLength={60} disabled={!editable} onChange={(e) => setTexts({ signage: { ...edit.texts.signage, period: e.target.value } })} /></label>
            <label>一言<input value={edit.texts.signage.note} maxLength={40} disabled={!editable} onChange={(e) => setTexts({ signage: { ...edit.texts.signage, note: e.target.value } })} /></label>
          </div>
          <label>説明<input value={edit.texts.signage.detail ?? ''} maxLength={60} disabled={!editable} onChange={(e) => setTexts({ signage: { ...edit.texts.signage, detail: e.target.value } })} /></label>
          <div className="announcements-colors" role="radiogroup" aria-label="帯の色">
            <span>帯の色</span>
            {[{ id: '', label: '店の色', color: d.storeColor }, ...ANNOUNCEMENT_BAND_COLORS].map((c) => (
              <button key={c.id || 'store'} type="button" role="radio" aria-checked={(edit.texts.signage.color ?? '') === c.id} disabled={!editable}
                className={`announcements-color${(edit.texts.signage.color ?? '') === c.id ? ' on' : ''}`} title={c.label}
                onClick={() => setTexts({ signage: { ...edit.texts.signage, color: c.id } })}>
                <span className="announcements-color-chip" style={{ background: c.color }} />{c.label}
              </button>
            ))}
          </div>
          <img className="announcements-screen" src={api.announcements.screenUrl(id, a.updatedAt, editable && screenTexts ? screenTexts : undefined)} alt="サイネージの画面の 1 枚" />
        </div>
      )}

      {d.outputs.length > 0 && (
        <div className="card">
          <h3>出し先ごとの結果</h3>
          <ul>
            {ANNOUNCEMENT_CHANNELS.filter((c) => outputs.has(c)).map((c) => {
              const o = outputs.get(c)!;
              return (
                <li key={c}>
                  {ANNOUNCEMENT_CHANNEL_LABELS[c]}: {o.status === 'done' ? '出しました' : o.status === 'waiting' ? '予約' : o.status === 'ended' ? '期間が終わりました' : '出せませんでした'}
                  {o.result.link && <> <a href={o.result.link} target="_blank" rel="noopener noreferrer">記事を開く</a></>}
                  {o.result.sent !== undefined && `（${o.result.sent} 人に送りました）`}
                  {o.result.queued !== undefined && `（${o.result.queued} 人に 1 通ずつ送っています）`}
                  {o.result.screens?.length ? `（${o.result.screens.join('・')}）` : ''}
                  {o.reason && <span className="small muted">　{o.reason}</span>}
                </li>
              );
            })}
          </ul>
        </div>
      )}

      {p && p.problems.length > 0 && <ul className="error small">{p.problems.map((x) => <li key={x}>{x}</li>)}</ul>}
      <div className="row wrap">
        {editable && <button className="btn ghost" disabled={busy} onClick={() => run(save, '保存しました')}>保存</button>}
        {editable && <button className="btn" disabled={busy || edit.channels.length === 0} onClick={() => run(async () => { await save(); await api.announcements.submit(id); onApprovals(); }, '承認へ進めました')}>承認へ進む</button>}
        {a.status === 'scheduled' && <button className="btn ghost" disabled={busy} onClick={() => { if (window.confirm('予約を取り消しますか。Web の予約公開の記事は、WordPress の側で消してください')) run(() => api.announcements.cancel(id), '取り消しました'); }}>予約を取り消す</button>}
        {(a.status === 'draft' || a.status === 'cancelled' || a.status === 'ended') && (
          <button className="btn ghost" disabled={busy} onClick={() => { if (window.confirm('このお知らせを削除しますか')) run(async () => { await api.announcements.remove(id); onBack(); }, '削除しました'); }}>削除</button>
        )}
        <NoteText note={note} />
      </div>
    </div>
  );
}

/**
 * お知らせの作成の画面。
 *
 * @param announcementId 開いているお知らせ（無ければ一覧）
 * @param changeKey 秘書がお知らせを作り終えたら変わる（読み直す）
 */
export function Announcements({ announcementId, onOpen, onApprovals, changeKey = '' }: {
  announcementId: string | null;
  onOpen: (id: string | null) => void;
  onApprovals: () => void;
  changeKey?: string;
}) {
  return announcementId
    ? <Detail id={announcementId} onBack={() => onOpen(null)} onApprovals={onApprovals} changeKey={changeKey} />
    : <List onOpen={(id) => onOpen(id)} changeKey={changeKey} />;
}

/** 宛先の 1 行の、選ばれた理由（名刺を交換した日・問い合わせのあった日）。 */
function recipientReason(r: AnnouncementRecipient): string {
  const parts: string[] = [];
  if (r.exchangedOn) parts.push(`名刺 ${r.exchangedOn}`);
  if (r.inquiredOn) parts.push(`問い合わせ ${r.inquiredOn}`);
  return parts.join('・');
}

/**
 * メールの宛先（第35.19節）。言葉で頼んで作り直す欄・検索の欄・表示中の人をまとめて外す／だけ残す・1 人ずつ削除。
 * 直した宛先は、ほかの欄と同じく「保存」か「承認へ進む」で残す。
 */
function MailRecipients({ id, editable, ids, people, onChange }: {
  id: string;
  editable: boolean;
  ids: string[];
  people: AnnouncementRecipient[];
  onChange: (ids: string[], people?: AnnouncementRecipient[]) => void;
}) {
  const [request, setRequest] = useState('');
  const [q, setQ] = useState('');
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<Note>(null);
  const byId = new Map(people.map((r) => [r.contactId, r]));
  const rows = ids.flatMap((x) => (byId.has(x) ? [byId.get(x)!] : []));
  const words = q.normalize('NFKC').toLowerCase().split(/[\s　]+/).filter(Boolean);
  const shown = words.length
    ? rows.filter((r) => { const hay = `${r.name} ${r.company} ${r.department ?? ''} ${r.email}`.normalize('NFKC').toLowerCase(); return words.every((w) => hay.includes(w)); })
    : rows;
  const shownIds = new Set(shown.map((r) => r.contactId));
  const refine = () => {
    if (!request.trim() || busy) return;
    setBusy(true);
    setNote(null);
    api.announcements.refineRecipients(id, request.trim(), ids)
      .then((r) => {
        if (r.changed) onChange(r.recipients.map((x) => x.contactId), r.recipients);
        setNote({ kind: r.changed ? 'ok' : 'error', text: r.text });
        if (r.changed) setRequest('');
      })
      .catch((e) => setNote({ kind: 'error', text: describeError(e, '作り直せませんでした') }))
      .finally(() => setBusy(false));
  };
  return (
    <div className="announcements-mail-to">
      <h4>宛先（{ids.length} 人）</h4>
      {editable && (
        <div className="row wrap inquiries-entry">
          <input value={request} maxLength={300} placeholder="例: 名刺を交換した取引先だけにして、〇〇社は外して" aria-label="宛先の頼み"
            onChange={(e) => setRequest(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter' && !e.nativeEvent.isComposing) refine(); }} />
          <button className="btn ghost" disabled={busy || !request.trim()} onClick={refine}>{busy ? '作り直しています…' : '作り直す'}</button>
          <NoteText note={note} />
        </div>
      )}
      {rows.length > 0 && (
        <div className="row wrap announcements-mail-filter">
          <input type="search" value={q} placeholder="会社・名前・アドレスで探す" aria-label="宛先を探す" onChange={(e) => setQ(e.target.value)} />
          {editable && words.length > 0 && shown.length > 0 && (
            <>
              <span className="small muted">表示中の {shown.length} 人を</span>
              <button className="btn ghost small" onClick={() => { onChange(ids.filter((x) => !shownIds.has(x))); setQ(''); }}>外す</button>
              <button className="btn ghost small" onClick={() => { onChange(ids.filter((x) => shownIds.has(x))); setQ(''); }}>だけ残す</button>
            </>
          )}
        </div>
      )}
      <ul className="announcements-recipients">
        {shown.map((r) => (
          <li key={r.contactId}>
            <span className="grow">{r.name}{r.company ? `（${r.company}）` : ''} <span className="small muted">{r.email}</span></span>
            <span className="small muted">{recipientReason(r)}</span>
            {editable && <button className="link small" onClick={() => onChange(ids.filter((x) => x !== r.contactId))}>削除</button>}
          </li>
        ))}
      </ul>
      {words.length > 0 && shown.length === 0 && <p className="small muted">当たる人はいません</p>}
    </div>
  );
}
