/**
 * @file 契約の管理の画面（仕様書 第38.9節）。一覧（期限の近い順・絞り込み）・契約書を入れる・手で入れる／1 件の項目のその場の直し・
 * 解約を申し出た・契約書を開く・削除。秘書が台帳を直したら読み直す。
 *
 * 読めなかった項目には「確かめてください」の印を付ける（推測で埋めない）。金額は扱わない。
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  CONTRACT_KIND_LABELS, CONTRACT_STATUS_LABELS, CONTRACT_UNKNOWN_LABELS,
  type Contract, type ContractKind, type ContractStatus,
} from '@m2office/shared';
import { api, describeError } from './api.js';

const today = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Tokyo', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
const dayLabel = (d: string | null) => (d ? d.replace(/-/g, '/') : '');
const STATUS_BADGE: Record<ContractStatus, string> = { active: 'badge ok', cancel_requested: 'badge warn', ended: 'badge' };

/** 次の期限（解約の申し出の期限か終わりの早いほう）と、その名前。 */
function nextDue(c: Contract): { day: string; label: string } | null {
  if (c.status === 'ended') return null;
  const list: { day: string; label: string }[] = [];
  if (c.status === 'active' && c.autoRenew && c.noticeDeadline) list.push({ day: c.noticeDeadline, label: '解約の申し出' });
  if (c.endOn) list.push({ day: c.endOn, label: '終わり' });
  return list.sort((a, b) => a.day.localeCompare(b.day))[0] ?? null;
}

/** 期限までの日数の印（30 日以内は目立たせる）。 */
function DueBadge({ day }: { day: string }) {
  const left = Math.round((Date.parse(`${day}T00:00:00Z`) - Date.parse(`${today()}T00:00:00Z`)) / 86_400_000);
  if (left < 0) return <span className="badge">過ぎた</span>;
  return <span className={left <= 30 ? 'badge warn' : 'badge'}>あと {left} 日</span>;
}

type Note = { kind: 'ok' | 'error'; text: string } | null;
function NoteText({ note }: { note: Note }) {
  return note ? <span className={`contracts-note is-${note.kind}`} role={note.kind === 'error' ? 'alert' : 'status'}>{note.text}</span> : null;
}

/** 契約の管理の画面（一覧か 1 件）。 */
export function Contracts({ contractId, onOpen, changeKey, userId }: {
  contractId: string | null;
  onOpen: (contractId: string | null) => void;
  /** 秘書が台帳を操作し終えるたびに変わる値。変わったら読み直す。 */
  changeKey: string;
  userId: string;
}) {
  return contractId
    ? <ContractView key={contractId} id={contractId} onBack={() => onOpen(null)} onOpen={onOpen} changeKey={changeKey} userId={userId} />
    : <ContractList onOpen={(id) => onOpen(id)} changeKey={changeKey} />;
}

/** 一覧と、契約書を入れる・手で入れる。 */
function ContractList({ onOpen, changeKey }: { onOpen: (id: string) => void; changeKey: string }) {
  const [items, setItems] = useState<Contract[] | null>(null);
  const [storage, setStorage] = useState<{ folderName: string } | null>(null);
  const [status, setStatus] = useState<'live' | ContractStatus | 'all'>('live');
  const [kind, setKind] = useState('');
  const [q, setQ] = useState('');
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<Note>(null);
  const [error, setError] = useState<string | null>(null);
  const [manual, setManual] = useState(false);
  const [progress, setProgress] = useState<string | null>(null);
  const file = useRef<HTMLInputElement>(null);

  const load = useCallback(() => {
    api.contracts.list({ status: 'all', ...(kind ? { kind } : {}), ...(q.trim() ? { q: q.trim() } : {}) })
      .then((r) => { setItems(r.items); setStorage(r.storage); setError(null); })
      .catch((e) => setError(describeError(e, '読めませんでした')));
  }, [kind, q]);
  useEffect(() => { const t = setTimeout(load, q ? 250 : 0); return () => clearTimeout(t); }, [load, q]);
  useEffect(() => { if (changeKey) load(); }, [changeKey]); // eslint-disable-line react-hooks/exhaustive-deps

  /** 契約書を入れる（いくつも選べば、1 つずつ順に読んで入れる。今ある契約書をまとめて台帳にする。第38.18節）。 */
  const importFiles = async (files: File[]) => {
    setBusy(true);
    setNote(null);
    const done: string[] = [];
    const failed: string[] = [];
    let last = '';
    for (const [i, f] of files.entries()) {
      if (files.length > 1) setProgress(`${i + 1} / ${files.length} 件目を読んでいます…`);
      try {
        const up = await api.uploadFile(f);
        const r = await api.contracts.importFrom({ fileId: up.id });
        const unknown = r.contract.unknown.map((u) => CONTRACT_UNKNOWN_LABELS[u]);
        last = `${r.contract.party || '相手不明'}の${CONTRACT_KIND_LABELS[r.contract.kind]}を入れました。${unknown.length ? `${unknown.join('・')}を読めなかったので確かめてください。` : ''}${r.fileNote ?? ''}`;
        done.push(f.name);
      } catch (e) {
        failed.push(`${f.name}（${describeError(e, '入れられませんでした')}）`);
      }
      load();
    }
    setProgress(null);
    setBusy(false);
    if (files.length === 1) setNote(failed.length ? { kind: 'error', text: failed[0]! } : { kind: 'ok', text: last });
    else setNote({ kind: failed.length ? 'error' : 'ok', text: `${done.length} 件を入れました。${failed.length ? `入れられなかったもの: ${failed.join('、')}` : '読めなかった項目は「確かめて」の印で出ます。'}` });
  };

  const shown = (items ?? []).filter((c) => (status === 'all' ? true : status === 'live' ? c.status !== 'ended' : c.status === status));
  return (
    <div className="contracts">
      <div className="row wrap contracts-entry">
        <button className="btn" disabled={busy} onClick={() => file.current?.click()}>{busy ? progress ?? '読んでいます…' : '契約書を入れる'}</button>
        <input ref={file} type="file" hidden multiple accept="application/pdf,image/png,image/jpeg,.docx"
          onChange={(e) => { const fs = Array.from(e.target.files ?? []).slice(0, 30); e.target.value = ''; if (fs.length) void importFiles(fs); }} />
        <button className={manual ? 'btn small' : 'btn ghost small'} onClick={() => setManual(!manual)}>手で入れる</button>
        <NoteText note={note} />
      </div>
      {items && !storage && <p className="small muted">契約書の置き場（Google ドライブ）がつながっていないため、契約書はドライブに置きません。管理者が拡張機能の設定でつなぎます。</p>}
      {manual && <ManualForm onDone={(id) => { setManual(false); load(); onOpen(id); }} />}
      <div className="row wrap contracts-filter">
        <select value={status} aria-label="状態" onChange={(e) => setStatus(e.target.value as typeof status)}>
          <option value="live">有効と申し出中</option>
          {(Object.keys(CONTRACT_STATUS_LABELS) as ContractStatus[]).map((s) => <option key={s} value={s}>{CONTRACT_STATUS_LABELS[s]}</option>)}
          <option value="all">すべて</option>
        </select>
        <select value={kind} aria-label="種類" onChange={(e) => setKind(e.target.value)}>
          <option value="">種類: すべて</option>
          {(Object.keys(CONTRACT_KIND_LABELS) as ContractKind[]).map((k) => <option key={k} value={k}>{CONTRACT_KIND_LABELS[k]}</option>)}
        </select>
        <input className="contracts-search" type="search" value={q} placeholder="相手・件名で探す" aria-label="探す" onChange={(e) => setQ(e.target.value)} />
      </div>
      {error && <p className="error">{error}</p>}
      {items && shown.length === 0 && <p className="muted">{items.length === 0 ? 'まだ契約がありません。' : '当たる契約はありません。'}</p>}
      {shown.length > 0 && (
        <div className="contracts-table-wrap">
        <table className="table contracts-table">
          <thead><tr><th>相手</th><th>契約</th><th>期間</th><th>次の期限</th><th>状態</th><th>担当</th></tr></thead>
          <tbody>
            {shown.map((c) => {
              const due = nextDue(c);
              return (
                <tr key={c.id}>
                  <td className="contracts-party"><button className="link" onClick={() => onOpen(c.id)}>{c.party || '相手不明'}</button>{c.unknown.length > 0 && <> <span className="badge warn" title={c.unknown.map((u) => CONTRACT_UNKNOWN_LABELS[u]).join('・')}>確かめて</span></>}</td>
                  <td>{CONTRACT_KIND_LABELS[c.kind]}{c.title && <div className="small muted">{c.title}</div>}</td>
                  <td className="nowrap">{c.startOn || c.endOn ? <>{dayLabel(c.startOn)}〜<br />{dayLabel(c.endOn)}</> : '—'}{c.autoRenew && <div className="small muted">自動更新</div>}</td>
                  <td>{due && <><div className="small muted">{due.label}</div><span className="nowrap">{dayLabel(due.day)}</span> <DueBadge day={due.day} /></>}</td>
                  <td><span className={STATUS_BADGE[c.status]}>{CONTRACT_STATUS_LABELS[c.status]}</span></td>
                  <td>{c.ownerName}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
        </div>
      )}
    </div>
  );
}

/** 手で入れる欄（紙だけの古い契約など）。 */
function ManualForm({ onDone }: { onDone: (id: string) => void }) {
  const [v, setV] = useState({ party: '', kind: 'other', title: '', startOn: '', endOn: '', autoRenew: false, noticeDays: '' });
  const [note, setNote] = useState<Note>(null);
  const save = () => {
    api.contracts.create({ ...v, startOn: v.startOn || null, endOn: v.endOn || null, noticeDays: v.noticeDays === '' ? null : Number(v.noticeDays) })
      .then((r) => onDone(r.contract.id)).catch((e) => setNote({ kind: 'error', text: describeError(e, '入れられませんでした') }));
  };
  return (
    <div className="card contracts-manual">
      <div className="row wrap">
        <label>相手<input value={v.party} maxLength={100} onChange={(e) => setV({ ...v, party: e.target.value })} /></label>
        <label>種類<select value={v.kind} onChange={(e) => setV({ ...v, kind: e.target.value })}>
          {(Object.keys(CONTRACT_KIND_LABELS) as ContractKind[]).map((k) => <option key={k} value={k}>{CONTRACT_KIND_LABELS[k]}</option>)}
        </select></label>
        <label className="grow">件名<input value={v.title} maxLength={120} onChange={(e) => setV({ ...v, title: e.target.value })} /></label>
      </div>
      <div className="row wrap">
        <label>始め<input type="date" value={v.startOn} onChange={(e) => setV({ ...v, startOn: e.target.value })} /></label>
        <label>終わり<input type="date" value={v.endOn} onChange={(e) => setV({ ...v, endOn: e.target.value })} /></label>
        <label className="check"><input type="checkbox" checked={v.autoRenew} onChange={(e) => setV({ ...v, autoRenew: e.target.checked })} />自動更新</label>
        {v.autoRenew && <label>終わりの何日前までに申し出るか<input type="number" min={0} max={730} className="num-input" value={v.noticeDays} onChange={(e) => setV({ ...v, noticeDays: e.target.value })} /></label>}
      </div>
      <div className="row">
        <button className="btn small" disabled={!v.party.trim()} onClick={save}>入れる</button>
        <NoteText note={note} />
      </div>
    </div>
  );
}

/** 1 件。項目はその場で直す（欄を離れると保存）。 */
function ContractView({ id, onBack, onOpen, changeKey, userId }: { id: string; onBack: () => void; onOpen: (id: string) => void; changeKey: string; userId: string }) {
  const [c, setC] = useState<Contract | null>(null);
  const [reviewRun, setReviewRun] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<Note>(null);
  const load = useCallback(() => {
    api.contracts.get(id).then((r) => { setC(r.contract); setError(null); }).catch((e) => setError(describeError(e, '読めませんでした')));
  }, [id]);
  useEffect(load, [load, changeKey]);
  if (error) return <div className="contracts"><button className="link small" onClick={onBack}>‹ 契約の一覧</button><p className="error">{error}</p></div>;
  if (!c) return <div className="contracts"><p className="muted">読み込み中…</p></div>;

  const save = (patch: Record<string, unknown>, ok = '保存しました') => {
    api.contracts.update(id, patch).then((r) => { setC(r.contract); setNote({ kind: 'ok', text: ok }); }).catch((e) => setNote({ kind: 'error', text: describeError(e, '保存できませんでした') }));
  };
  const field = (key: keyof Contract, label: string, type: 'text' | 'date' | 'number' = 'text', max = 120) => (
    <label>{label}{c.unknown.includes(key as never) && <span className="badge warn">確かめて</span>}
      <input type={type} defaultValue={(c[key] as string | number | null) ?? ''} key={`${key}-${String(c[key])}`} maxLength={max} className={type === 'number' ? 'num-input' : undefined}
        onBlur={(e) => {
          const raw = e.target.value;
          const value = type === 'number' ? (raw === '' ? null : Number(raw)) : type === 'date' ? (raw || null) : raw;
          if (value !== (c[key] ?? (type === 'text' ? '' : null))) save({ [key]: value });
        }} />
    </label>
  );
  const due = nextDue(c);
  return (
    <div className="contracts">
      <div className="row">
        <button className="link small" onClick={onBack}>‹ 契約の一覧</button>
        <button className="btn ghost small" onClick={load}>更新</button>
        <NoteText note={note} />
      </div>
      <h2>{c.party || '相手不明'} <span className={STATUS_BADGE[c.status]}>{CONTRACT_STATUS_LABELS[c.status]}</span></h2>
      {due && <p>{due.label}: {dayLabel(due.day)} <DueBadge day={due.day} /></p>}
      <div className="card contracts-detail">
        <div className="row wrap">
          {field('party', '相手', 'text', 100)}
          <label>種類{c.unknown.includes('kind') && <span className="badge warn">確かめて</span>}
            <select value={c.kind} onChange={(e) => save({ kind: e.target.value })}>
              {(Object.keys(CONTRACT_KIND_LABELS) as ContractKind[]).map((k) => <option key={k} value={k}>{CONTRACT_KIND_LABELS[k]}</option>)}
            </select>
          </label>
          {field('title', '件名')}
        </div>
        <div className="row wrap">
          {field('signedOn', '締結日', 'date')}
          {field('startOn', '始め', 'date')}
          {field('endOn', '終わり', 'date')}
        </div>
        <div className="row wrap">
          <label className="check"><input type="checkbox" checked={c.autoRenew} onChange={(e) => save({ autoRenew: e.target.checked })} />自動更新{c.unknown.includes('autoRenew') && <span className="badge warn">確かめて</span>}</label>
          {c.autoRenew && field('renewMonths', '更新の期間（月）', 'number')}
          {c.autoRenew && field('noticeDays', '終わりの何日前までに申し出るか', 'number')}
          {c.autoRenew && <span>解約の申し出の期限: {c.noticeDeadline ? dayLabel(c.noticeDeadline) : <span className="badge warn">不明</span>}</span>}
        </div>
        {c.noticeRule && <blockquote className="contracts-rule">{c.noticeRule}</blockquote>}
        <label>メモ<textarea rows={2} defaultValue={c.note} key={`note-${c.note}`} maxLength={1000} onBlur={(e) => { if (e.target.value !== c.note) save({ note: e.target.value }); }} /></label>
        <p className="small muted">担当: {c.ownerName || '不明'}{c.ownerId !== userId && <> <button className="link small" onClick={() => save({ ownerId: userId }, '担当を自分にしました')}>自分を担当にする</button></>}{c.renewedCount > 0 ? `　自動で更新した回数: ${c.renewedCount}` : ''}</p>
      </div>
      <div className="row wrap">
        {c.driveFileId
          ? <a className="btn ghost small" href={api.contracts.fileUrl(c.id)} target="_blank" rel="noopener noreferrer">契約書を開く</a>
          : <span className="small muted">契約書はドライブに置いていません</span>}
        {c.reviewRunId && <a className="link small" href={`/runs/${encodeURIComponent(c.reviewRunId)}`}>契約書チェックの結果</a>}
        {/* 更新の前に見直す（ドライブの契約書で契約書チェックを始める。第38.18節） */}
        {c.driveFileId && c.status !== 'ended' && (
          reviewRun
            ? <a className="link small" href={`/runs/${encodeURIComponent(reviewRun)}`}>見直しを始めました（結果を開く）</a>
            : <button className="btn ghost small" onClick={() => api.contracts.review(c.id).then((r) => setReviewRun(r.runId)).catch((e) => setNote({ kind: 'error', text: describeError(e, '契約書チェックを始められませんでした') }))}>契約書チェックで見直す</button>
        )}
        {c.previousId && <button className="link small" onClick={() => onOpen(c.previousId!)}>前の版</button>}
        {c.status === 'active' && c.autoRenew && <button className="btn ghost small" onClick={() => save({ status: 'cancel_requested' }, '解約を申し出た、にしました。期限の知らせは止まります')}>解約を申し出た</button>}
        {c.status === 'cancel_requested' && <button className="btn ghost small" onClick={() => save({ status: 'active' }, '有効に戻しました')}>有効に戻す</button>}
        <button className="btn ghost small danger" onClick={() => {
          if (window.confirm('この契約を台帳から削除しますか。ドライブの契約書は残ります')) {
            api.contracts.remove(c.id).then(onBack).catch((e) => setNote({ kind: 'error', text: describeError(e, '削除できませんでした') }));
          }
        }}>削除</button>
      </div>
    </div>
  );
}

/** 契約書チェック（公式の拡張機能。第28章）の業務の ID。 */
export const CONTRACT_REVIEW_AGENT_ID = 'jp.m2office.legal.contract-review:contract-review';

/**
 * 契約書チェックの実行の詳細に出す「結んだので台帳に入れる」（第38.5節 ①）。チェックを頼んだ本人だけに出す。
 * 結んだ版が違えば、契約の画面の「契約書を入れる」で結んだ版を入れる。
 */
export function ContractFromReview({ runId, onOpen }: { runId: string; onOpen: (contractId: string) => void }) {
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<Note>(null);
  const [done, setDone] = useState<string | null>(null);
  const run = () => {
    setBusy(true);
    api.contracts.importFrom({ runId })
      .then((r) => { setDone(r.contract.id); setNote({ kind: 'ok', text: `${r.contract.party || '相手不明'}の${CONTRACT_KIND_LABELS[r.contract.kind]}を台帳に入れました。${r.fileNote ?? ''}` }); })
      .catch((e) => setNote({ kind: 'error', text: describeError(e, '台帳に入れられませんでした') }))
      .finally(() => setBusy(false));
  };
  return (
    <div className="row wrap contracts-from-review">
      {done
        ? <button className="btn ghost small" onClick={() => onOpen(done)}>台帳の契約を開く</button>
        : <button className="btn small" disabled={busy} onClick={run} title="チェックした版のまま結んだとき。修正して結んだら、契約の画面で結んだ版を入れてください">{busy ? '入れています…' : '結んだので台帳に入れる'}</button>}
      <NoteText note={note} />
    </div>
  );
}
