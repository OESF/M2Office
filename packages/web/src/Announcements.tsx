/**
 * @file お知らせの作成の画面（仕様書 第35.8節・第35.17節）。一覧と 1 行の欄・1 件（出し先ごとの見え方と直し・承認へ進む・出した後の結果）。
 *
 * 一覧の上の 1 行の欄に「年末年始の休業 12/28〜1/5」と書いて「作る」を押すと、AI が出し先ごとの文を作る。
 * 1 件では、出し先ごとのタブで見え方（Web の記事・LINE の吹き出し・店頭の画面の 1 枚）を出し、その場で直せる。
 * 「承認へ進む」で管理者か承認者の承認を待ち、承認されると出す（1 回の承認。ADR-0028）。説明文は常には出さない（原則 u11）。
 */

import { useCallback, useEffect, useState } from 'react';
import {
  ANNOUNCEMENT_CHANNELS, ANNOUNCEMENT_CHANNEL_LABELS, ANNOUNCEMENT_LINE_MAX, ANNOUNCEMENT_STATUS_LABELS,
  type Announcement, type AnnouncementChannel, type AnnouncementDetail, type AnnouncementPreview, type AnnouncementTexts,
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
  const [edit, setEdit] = useState<{ title: string; startDate: string; endDate: string; publishAt: string; channels: AnnouncementChannel[]; texts: AnnouncementTexts } | null>(null);
  const [tab, setTab] = useState<AnnouncementChannel>('web');
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<Note>(null);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(() => {
    api.announcements.get(id).then((r) => {
      setD(r);
      const a = r.announcement;
      setEdit({ title: a.title, startDate: a.startDate ?? '', endDate: a.endDate ?? '', publishAt: toLocal(a.publishAt), channels: a.channels, texts: a.texts });
      if (a.channels.length && !a.channels.includes(tab)) setTab(a.channels[0]!);
      if (a.status === 'draft') api.announcements.preview(id).then(setP).catch(() => setP(null));
      else setP(null);
    }).catch((e) => setError(describeError(e, '読めませんでした')));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);
  useEffect(() => { load(); }, [load, changeKey]);
  if (error) return <p className="error">{error}</p>;
  if (!d || !edit) return <p className="muted">読んでいます…</p>;
  const a = d.announcement;
  const editable = a.status === 'draft';
  const save = async () => {
    await api.announcements.update(id, {
      title: edit.title, startDate: edit.startDate || null, endDate: edit.endDate || null, publishAt: fromLocal(edit.publishAt), channels: edit.channels, texts: edit.texts,
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
        <div className="row wrap">
          <label>期間<input type="date" value={edit.startDate} disabled={!editable} onChange={(e) => setEdit({ ...edit, startDate: e.target.value })} /></label>
          <span>〜</span>
          <input type="date" aria-label="期間の終わり" value={edit.endDate} disabled={!editable} onChange={(e) => setEdit({ ...edit, endDate: e.target.value })} />
          <label>出す日時<input type="datetime-local" value={edit.publishAt} disabled={!editable} onChange={(e) => setEdit({ ...edit, publishAt: e.target.value })} /></label>
          {!edit.publishAt && <span className="small muted">承認したとき</span>}
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

      <div className="tabs" role="tablist">
        {ANNOUNCEMENT_CHANNELS.filter((c) => edit.channels.includes(c)).map((c) => (
          <button key={c} role="tab" aria-selected={tab === c} className={`tab${tab === c ? ' is-active' : ''}`} onClick={() => setTab(c)}>{ANNOUNCEMENT_CHANNEL_LABELS[c]}</button>
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
      {tab === 'signage' && edit.channels.includes('signage') && (
        <div className="card announcements-channel">
          <div className="row wrap">
            <label>見出し<input value={edit.texts.signage.headline} maxLength={30} disabled={!editable} onChange={(e) => setTexts({ signage: { ...edit.texts.signage, headline: e.target.value } })} /></label>
            <label>期間の書き方<input value={edit.texts.signage.period} maxLength={60} disabled={!editable} onChange={(e) => setTexts({ signage: { ...edit.texts.signage, period: e.target.value } })} /></label>
            <label>一言<input value={edit.texts.signage.note} maxLength={40} disabled={!editable} onChange={(e) => setTexts({ signage: { ...edit.texts.signage, note: e.target.value } })} /></label>
          </div>
          <img className="announcements-screen" src={api.announcements.screenUrl(id, a.updatedAt)} alt="店頭の画面の 1 枚" />
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
