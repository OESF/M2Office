/**
 * @file 会員とポイントの画面（仕様書 第40.9節）。会員の一覧（探す・作る）／1 人（ポイントの記録・取り消し・調整・呼び名と電話・会員証の QR と紙のカード・
 * まとめる・削除）／特典（管理者が作る・直す・止める）。店員がポイントを付けるのはスマホのページ（`/m/members`）。
 *
 * ポイントはお金ではない。購入の金額は残さない。説明文は常に出さない（原則 u11）。
 */

import { useCallback, useEffect, useState } from 'react';
import { MEMBER_POINT_KIND_LABELS, type Member, type MemberPoint, type MemberReward } from '@m2office/shared';
import { api, describeError } from './api.js';

const dayLabel = (iso: string | null) => (iso ? new Intl.DateTimeFormat('ja-JP', { timeZone: 'Asia/Tokyo', year: 'numeric', month: 'numeric', day: 'numeric' }).format(new Date(iso)) : '—');
const timeLabel = (iso: string) => new Intl.DateTimeFormat('ja-JP', { timeZone: 'Asia/Tokyo', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }).format(new Date(iso));

type Note = { kind: 'ok' | 'error'; text: string } | null;
function NoteText({ note }: { note: Note }) {
  return note ? <p className={`mbr-note is-${note.kind}`} role={note.kind === 'error' ? 'alert' : 'status'}>{note.text}</p> : null;
}

/** 会員とポイントの画面（一覧か 1 人）。 */
export function Members({ memberId, onOpen, changeKey }: {
  memberId: string | null;
  onOpen: (memberId: string | null) => void;
  /** 秘書が会員を直し終えるたびに変わる値。変わったら読み直す。 */
  changeKey: string;
}) {
  return memberId
    ? <MemberView key={memberId} id={memberId} onBack={() => onOpen(null)} onOpen={onOpen} changeKey={changeKey} />
    : <MemberList onOpen={(id) => onOpen(id)} changeKey={changeKey} />;
}

/** 一覧・会員を作る・特典。 */
function MemberList({ onOpen, changeKey }: { onOpen: (id: string) => void; changeKey: string }) {
  const [data, setData] = useState<Awaited<ReturnType<typeof api.members.list>> | null>(null);
  const [q, setQ] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [rewardsOpen, setRewardsOpen] = useState(false);

  const load = useCallback(() => {
    api.members.list(q.trim()).then((r) => { setData(r); setError(null); }).catch((e) => setError(describeError(e, '読めませんでした')));
  }, [q]);
  useEffect(() => { const t = setTimeout(load, q ? 250 : 0); return () => clearTimeout(t); }, [load, q]);
  useEffect(() => { if (changeKey) load(); }, [changeKey]); // eslint-disable-line react-hooks/exhaustive-deps

  if (error) return <p className="error">{error}</p>;
  if (!data) return <p className="muted">読み込み中…</p>;
  return (
    <div className="mbr">
      <div className="row wrap">
        <button className={adding ? 'btn small' : 'btn ghost small'} onClick={() => setAdding(!adding)}>会員を作る</button>
        <button className={rewardsOpen ? 'btn small' : 'btn ghost small'} onClick={() => setRewardsOpen(!rewardsOpen)}>特典</button>
        <a className="btn ghost small" href="/m/members">スマホのページ</a>
        <span className="small muted">来店 {data.settings.visitPoints} ポイント／{data.settings.yenPerPoint} 円で 1 ポイント／有効期限 {data.settings.expiryDays} 日</span>
        <input className="mbr-search" type="search" value={q} placeholder="呼び名・会員番号・電話で探す" aria-label="探す" onChange={(e) => setQ(e.target.value)} />
      </div>
      {adding && <CreateForm onDone={(id) => { setAdding(false); onOpen(id); }} />}
      {rewardsOpen && <RewardManager admin={data.admin} />}
      {data.items.length === 0
        ? <p className="muted">{q ? '当たる会員はいません。' : 'まだ会員がいません。'}</p>
        : (
          <div className="mbr-table-wrap">
            <table className="table">
              <thead><tr><th>会員番号</th><th>呼び名</th><th>ポイント</th><th>来店</th><th>最後の来店</th><th /></tr></thead>
              <tbody>
                {data.items.map((m) => (
                  <tr key={m.id}>
                    <td>{m.number}</td>
                    <td><button className="link" onClick={() => onOpen(m.id)}>{m.nickname}</button></td>
                    <td>{m.balance}</td>
                    <td>{m.visits}</td>
                    <td>{dayLabel(m.lastVisitAt)}</td>
                    <td>{m.line && <span className="badge">LINE</span>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
    </div>
  );
}

/** 店頭で会員を作る欄。 */
function CreateForm({ onDone }: { onDone: (id: string) => void }) {
  const [v, setV] = useState({ nickname: '', phone: '' });
  const [error, setError] = useState<string | null>(null);
  const save = () => api.members.create(v).then((r) => onDone(r.member.id)).catch((e) => setError(describeError(e, '作れませんでした')));
  return (
    <div className="row wrap card mbr-form">
      <input value={v.nickname} maxLength={30} placeholder="呼び名（ニックネームでよい）" aria-label="呼び名" onChange={(e) => setV({ ...v, nickname: e.target.value })} />
      <input value={v.phone} maxLength={20} placeholder="電話（任意）" aria-label="電話" onChange={(e) => setV({ ...v, phone: e.target.value })} />
      <button className="btn small" disabled={!v.nickname.trim()} onClick={() => void save()}>作る</button>
      {error && <span className="error">{error}</span>}
    </div>
  );
}

/** 特典（管理者は作る・直す・止める）。 */
function RewardManager({ admin }: { admin: boolean }) {
  const [items, setItems] = useState<MemberReward[] | null>(null);
  const [v, setV] = useState({ name: '', points: '' });
  const [error, setError] = useState<string | null>(null);
  const load = () => api.members.rewards().then((r) => setItems(r.items)).catch((e) => setError(describeError(e, '読めませんでした')));
  useEffect(() => { void load(); }, []);
  const run = (f: () => Promise<unknown>) => f().then(load).then(() => setError(null)).catch((e) => setError(describeError(e, '直せませんでした')));
  return (
    <section className="card mbr-rewards">
      {admin && (
        <div className="row wrap">
          <input value={v.name} maxLength={40} placeholder="特典（ドリンク 1 杯など）" aria-label="特典の名前" onChange={(e) => setV({ ...v, name: e.target.value })} />
          <input className="mbr-num" type="number" min={1} value={v.points} placeholder="ポイント" aria-label="必要なポイント" onChange={(e) => setV({ ...v, points: e.target.value })} />
          <button className="btn small" disabled={!v.name.trim() || !v.points} onClick={() => void run(async () => { await api.members.createReward({ name: v.name.trim(), points: Number(v.points) }); setV({ name: '', points: '' }); })}>足す</button>
        </div>
      )}
      {error && <p className="error">{error}</p>}
      {items && items.length === 0 && <p className="muted small">特典はまだありません。</p>}
      {items && items.length > 0 && (
        <ul className="mbr-reward-list">
          {items.map((r) => (
            <li key={r.id} className={r.status === 'stopped' ? 'is-stopped' : ''}>
              <span>{r.name}</span><span>{r.points} ポイント</span>
              {admin && <button className="btn ghost small" onClick={() => void run(() => api.members.updateReward(r.id, { status: r.status === 'active' ? 'stopped' : 'active' }))}>{r.status === 'active' ? '止める' : '使う'}</button>}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/** 1 人。 */
function MemberView({ id, onBack, onOpen, changeKey }: { id: string; onBack: () => void; onOpen: (id: string | null) => void; changeKey: string }) {
  const [d, setD] = useState<Awaited<ReturnType<typeof api.members.get>> | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<Note>(null);
  const [adj, setAdj] = useState({ points: '', note: '' });
  const load = useCallback(() => {
    api.members.get(id).then((r) => { setD(r); setError(null); }).catch((e) => setError(describeError(e, '読めませんでした')));
  }, [id]);
  useEffect(load, [load]);
  useEffect(() => { if (changeKey) load(); }, [changeKey]); // eslint-disable-line react-hooks/exhaustive-deps
  const act = (f: () => Promise<unknown>, ok: string) => f().then(() => { setNote({ kind: 'ok', text: ok }); load(); }).catch((e) => setNote({ kind: 'error', text: describeError(e, 'できませんでした') }));

  if (error) return <div className="mbr"><button className="link small" onClick={onBack}>‹ 会員の一覧</button><p className="error">{error}</p></div>;
  if (!d) return <p className="muted">読み込み中…</p>;
  const m: Member = d.member;
  return (
    <div className="mbr">
      <div className="row wrap"><button className="link small" onClick={onBack}>‹ 会員の一覧</button><NoteText note={note} /></div>
      <div className="mbr-head">
        <div>
          <h2>No. {m.number} {m.nickname} {m.line && <span className="badge">LINE</span>}</h2>
          <p className="mbr-balance">{m.balance} <small>ポイント</small></p>
          <p className="small muted">来店 {m.visits} 回・最後の来店 {dayLabel(m.lastVisitAt)}・作った日 {dayLabel(m.createdAt)}</p>
          <div className="row wrap mbr-fields">
            <label>呼び名 <input defaultValue={m.nickname} maxLength={30} onBlur={(e) => e.target.value.trim() !== m.nickname && void act(() => api.members.update(m.id, { nickname: e.target.value }), '直しました')} /></label>
            <label>電話 <input defaultValue={m.phone} maxLength={20} onBlur={(e) => e.target.value.trim() !== m.phone && void act(() => api.members.update(m.id, { phone: e.target.value }), '直しました')} /></label>
          </div>
        </div>
        <div className="mbr-qr">
          <img src={api.members.qrUrl(m.id)} alt="会員証の QR" width={140} height={140} />
          <a className="btn ghost small" href={api.members.cardPdfUrl(m.id)}>紙の会員証（PDF）</a>
          {d.cardUrl && <a className="small" href={d.cardUrl} target="_blank" rel="noopener noreferrer">会員証のページ</a>}
        </div>
      </div>
      <div className="row wrap">
        <input className="mbr-num" type="number" value={adj.points} placeholder="±ポイント" aria-label="足すポイント" onChange={(e) => setAdj({ ...adj, points: e.target.value })} />
        <input value={adj.note} maxLength={100} placeholder="理由" aria-label="理由" onChange={(e) => setAdj({ ...adj, note: e.target.value })} />
        <button className="btn ghost small" disabled={!adj.points || !adj.note.trim()} onClick={() => void act(async () => { await api.members.adjust(m.id, Number(adj.points), adj.note); setAdj({ points: '', note: '' }); }, '調整しました')}>調整する</button>
      </div>
      {d.candidates.length > 0 && (
        <div className="row wrap small">
          <span className="muted">同じ人かもしれない会員:</span>
          {d.candidates.map((c) => (
            <span key={c.id}>
              <button className="link small" onClick={() => onOpen(c.id)}>No. {c.number} {c.nickname}</button>
              {' '}<button className="btn ghost small" onClick={() => void act(() => api.members.merge(c.id, m.id), `No. ${c.number} をまとめました`)}>この会員にまとめる</button>
            </span>
          ))}
        </div>
      )}
      <h3>ポイントの記録</h3>
      {d.points.length === 0 ? <p className="muted small">まだ記録はありません。</p> : (
        <table className="table mbr-points">
          <tbody>
            {d.points.map((p: MemberPoint) => (
              <tr key={p.id} className={p.reversed ? 'is-reversed' : ''}>
                <td className="nowrap">{timeLabel(p.createdAt)}</td>
                <td>{MEMBER_POINT_KIND_LABELS[p.kind]}{p.rewardName && `（${p.rewardName}）`}{p.note && <span className="muted"> {p.note}</span>}</td>
                <td className="mbr-pt">{p.points > 0 ? `+${p.points}` : p.points}</td>
                <td className="small muted">{p.createdByName}</td>
                <td>{!p.reversed && p.kind !== 'undo' && p.kind !== 'expire' && <button className="btn ghost small" onClick={() => void act(() => api.members.undo(p.id), '取り消しました')}>取り消す</button>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <div className="row wrap"><button className="btn ghost small danger" onClick={() => void act(async () => { await api.members.remove(m.id); onBack(); }, '削除しました')}>削除（退会）</button></div>
    </div>
  );
}
