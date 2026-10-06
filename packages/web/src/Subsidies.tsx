/**
 * @file 補助金・助成金の案内の画面（仕様書 第39.9節）。調べるのに使った会社のこと（管理者は直せる）・いま調べる・
 * 候補（締め切りの近い順。見立て・合う理由・確かめたい条件・上限額と補助率・締め切り・出典）・気になる／見送り・過ぎたもの・見送ったもの。
 *
 * 金額と日付は出典どおりで、無ければ「不明」と出す（推測で埋めない）。申請書は作らない。説明文は常に出さない（原則 u11）。
 */

import { useCallback, useEffect, useState } from 'react';
import {
  SUBSIDY_FIT_LABELS, SUBSIDY_KIND_LABELS, type Subsidy, type SubsidyProfile, type SubsidyStatus,
} from '@m2office/shared';
import { api, describeError } from './api.js';

type View = 'active' | 'past' | 'skipped';
type Data = Awaited<ReturnType<typeof api.subsidies.list>>;

const dayLabel = (d: string | null) => (d ? d.replace(/-/g, '/') : '不明');
const timeLabel = (iso: string) => new Intl.DateTimeFormat('ja-JP', { timeZone: 'Asia/Tokyo', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }).format(new Date(iso));

/** 締め切りまでの日数の印（14 日以内は目立たせる）。 */
function LeftBadge({ deadline, today }: { deadline: string | null; today: string }) {
  if (!deadline) return null;
  const left = Math.round((Date.parse(`${deadline}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) / 86_400_000);
  if (left < 0) return <span className="badge">過ぎた</span>;
  return <span className={left <= 14 ? 'badge warn' : 'badge'}>あと {left} 日</span>;
}

/** 補助金・助成金の案内の画面。 */
export function Subsidies({ changeKey }: {
  /** 秘書が調べ終えた・状態を変えたたびに変わる値。変わったら読み直す。 */
  changeKey: string;
}) {
  const [data, setData] = useState<Data | null>(null);
  const [view, setView] = useState<View>('active');
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);

  const load = useCallback(() => {
    api.subsidies.list().then((r) => { setData(r); setError(null); }).catch((e) => setError(describeError(e, '読めませんでした')));
  }, []);
  useEffect(load, [load]);
  useEffect(() => { if (changeKey) load(); }, [changeKey]); // eslint-disable-line react-hooks/exhaustive-deps
  // 調べている間は読み直す
  useEffect(() => {
    if (!data?.searching) return;
    const t = setInterval(load, 4000);
    return () => clearInterval(t);
  }, [data?.searching, load]);

  const search = () => {
    setNote(null);
    api.subsidies.search().then(load).catch((e) => setNote(describeError(e, '調べられませんでした')));
  };
  const mark = (id: string, status: SubsidyStatus) => {
    api.subsidies.mark(id, status).then(load).catch((e) => setNote(describeError(e, '変えられませんでした')));
  };

  if (error) return <p className="error">{error}</p>;
  if (!data) return <p className="muted">読み込み中…</p>;
  const { today } = data;
  const searchedToday = !!data.searchedAt && new Date(Date.parse(data.searchedAt) + 9 * 3_600_000).toISOString().slice(0, 10) === today;
  const shown = data.items.filter((c) => (view === 'skipped' ? c.status === 'skipped'
    : view === 'past' ? c.status !== 'skipped' && !!c.deadline && c.deadline < today
      : c.status !== 'skipped' && (!c.deadline || c.deadline >= today)));

  return (
    <div className="sbs">
      <div className="sbs-profile">
        {editing && data.admin
          ? <ProfileForm industry={data.industry || data.profile?.industry || ''} interest={data.interest} onDone={() => { setEditing(false); load(); }} onCancel={() => setEditing(false)} />
          : (
            <p className="small">
              <ProfileLine profile={data.profile} interest={data.interest} />
              {data.admin && <> <button className="link small" onClick={() => setEditing(true)}>直す</button></>}
            </p>
          )}
      </div>
      <div className="row wrap sbs-bar">
        {/* 調べるのは 1 日 1 回まで（第39.4節） */}
        <button className="btn small" disabled={data.searching || searchedToday} onClick={search}>{data.searching ? '調べています…' : searchedToday ? '今日は調べました' : 'いま調べる'}</button>
        {data.searchedAt && <span className="small muted">最後に調べた日時: {timeLabel(data.searchedAt)}</span>}
        <div className="seg" role="group" aria-label="表示">
          {([['active', '候補'], ['past', '過ぎたもの'], ['skipped', '見送ったもの']] as const).map(([v, label]) => (
            <button key={v} className={view === v ? 'on' : ''} aria-pressed={view === v} onClick={() => setView(v)}>{label}</button>
          ))}
        </div>
      </div>
      {note && <p className="error">{note}</p>}
      {shown.length > 0 && view === 'active' && <p className="small muted">公募の中身は変わることがあります。申請の前に出典で確かめてください。</p>}
      {shown.length === 0 && (
        <p className="muted">{view === 'active' ? (data.searchedAt ? 'いまは合いそうな制度が見つかっていません。' : 'まだ調べていません。') : 'ありません。'}</p>
      )}
      <ul className="sbs-list">
        {shown.map((c) => <SubsidyCard key={c.id} c={c} today={today} onMark={mark} />)}
      </ul>
    </div>
  );
}

/** 調べるのに使った会社のこと（1 行）。 */
function ProfileLine({ profile, interest }: { profile: SubsidyProfile | null; interest: string }) {
  const parts = [
    `業種: ${profile?.industry || '不明'}`, `所在地: ${profile?.region || '不明'}`, `従業員: ${profile?.employees || '不明'}`, `関心: ${interest || 'なし'}`,
  ];
  return <span className="muted">{parts.join('／')}</span>;
}

/** 業種と関心を直す（管理者だけ）。 */
function ProfileForm({ industry, interest, onDone, onCancel }: { industry: string; interest: string; onDone: () => void; onCancel: () => void }) {
  const [v, setV] = useState({ industry, interest });
  const [error, setError] = useState<string | null>(null);
  const save = () => api.subsidies.saveSettings(v).then(onDone).catch((e) => setError(describeError(e, '直せませんでした')));
  return (
    <div className="row wrap">
      <input value={v.industry} maxLength={60} placeholder="業種" aria-label="業種" onChange={(e) => setV({ ...v, industry: e.target.value })} />
      <input className="sbs-interest" value={v.interest} maxLength={100} placeholder="関心（IT の導入・人の採用など）" aria-label="関心" onChange={(e) => setV({ ...v, interest: e.target.value })} />
      <button className="btn small" onClick={() => void save()}>保存</button>
      <button className="btn ghost small" onClick={onCancel}>キャンセル</button>
      {error && <span className="error">{error}</span>}
    </div>
  );
}

/** 候補の 1 件。 */
function SubsidyCard({ c, today, onMark }: { c: Subsidy; today: string; onMark: (id: string, s: SubsidyStatus) => void }) {
  return (
    <li className={`sbs-card card${c.status === 'interested' ? ' is-interested' : ''}`}>
      <div className="row wrap sbs-head">
        <a href={c.sourceUrl} target="_blank" rel="noopener noreferrer" className="sbs-name">{c.name}</a>
        <span className="badge">{SUBSIDY_KIND_LABELS[c.kind]}</span>
        <span className={c.fit === 'likely' ? 'badge ok' : 'badge'}>{SUBSIDY_FIT_LABELS[c.fit]}</span>
        {c.status === 'interested' && <span className="badge warn">気になる</span>}
      </div>
      <p className="small muted">{c.provider || '実施する所: 不明'}</p>
      {c.reason && <p className="small">{c.reason}</p>}
      {c.conditions && <p className="small muted">確かめたい条件: {c.conditions}</p>}
      <p className="small">
        上限額: {c.amount || '不明'}　補助率: {c.rate || '不明'}　締め切り: {dayLabel(c.deadline)} <LeftBadge deadline={c.deadline} today={today} />
      </p>
      <div className="row wrap sbs-actions">
        <span className="small muted">出典: <a href={c.sourceUrl} target="_blank" rel="noopener noreferrer">{c.sourceTitle || c.sourceUrl}</a></span>
        {c.status !== 'interested' && c.status !== 'skipped' && <button className="btn ghost small" onClick={() => onMark(c.id, 'interested')}>気になる</button>}
        {c.status !== 'skipped' && <button className="btn ghost small" onClick={() => onMark(c.id, 'skipped')}>見送り</button>}
        {c.status !== 'new' && <button className="btn ghost small" onClick={() => onMark(c.id, 'new')}>戻す</button>}
      </div>
    </li>
  );
}
