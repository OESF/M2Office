/**
 * @file 競合の分析の画面（仕様書 第36.11節・第36.18節）。自社の像と商圏・競合の一覧・1 社の事実・レポート。
 *
 * 「探す」で、AI が自社の像をまとめて近くの同業か同じような事業の会社を探し、読んでレポートを作る（数分かかる。作業の間は読み直す）。
 * 一覧の上の 1 行の欄に URL か店の名前を入れて「追加」。競合ごとに「削除」。名前を押すと、取り出した事実を出典つきで出す。
 * レポートの表の中のリンクは外す（2026-10-04 に三浦さんが指摘。名前がすべて同じ先へのリンクで見づらく、意味が無かった）。
 * 地図（Places API）で見つけたものには「Google Maps」と添える（訳さない。第36.13節）。説明文は常には出さない（原則 u11）。
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  COMPETITOR_FACT_LABELS, COMPETITOR_ORIGIN_LABELS,
  type Competitor, type CompetitorFact, type CompetitorOverview, type CompetitorReport,
} from '@m2office/shared';
import { api, describeError } from './api.js';
import { Markdown } from './help.js';
import { stripTableLinks } from './table-links.js';

/** 回の見出し（見回った日の回は「10 月 4 日」、年月の回は「2026 年 10 月」）。 */
const periodLabel = (p: string) => (p.length === 10 ? `${Number(p.slice(5, 7))} 月 ${Number(p.slice(8, 10))} 日` : `${p.slice(0, 4)} 年 ${Number(p.slice(5, 7))} 月`);
const day = (iso: string | null) => (iso ? new Date(iso).toLocaleDateString('ja-JP', { month: 'numeric', day: 'numeric' }) : '—');
const km = (m: number | null) => (m === null ? '—' : m < 1000 ? `${m} m` : `${(m / 1000).toFixed(1)} km`);

/** 押したボタンの横に出す知らせ。 */
type Note = { kind: 'ok' | 'error'; text: string } | null;
function NoteText({ note }: { note: Note }) {
  return note ? <span className={`inquiries-note is-${note.kind}`} role={note.kind === 'error' ? 'alert' : 'status'}>{note.text}</span> : null;
}

/** 1 社（か自社）の事実を、回ごとに出典つきで並べる。 */
function Facts({ id }: { id: string }) {
  const [facts, setFacts] = useState<CompetitorFact[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    api.competitors.facts(id).then((r) => setFacts(r.facts)).catch((e) => setError(describeError(e, '事実を読めませんでした')));
  }, [id]);
  if (error) return <p className="error small">{error}</p>;
  if (!facts) return <p className="muted small">読んでいます…</p>;
  if (facts.length === 0) return <p className="muted small">取り出せた事実はまだありません</p>;
  const periods = [...new Set(facts.map((f) => f.period))];
  return (
    <div className="competitors-facts">
      {periods.map((p) => (
        <div key={p}>
          <h4>{periodLabel(p)}</h4>
          <ul>
            {facts.filter((f) => f.period === p).map((f) => (
              <li key={f.id}>
                <span className="badge">{COMPETITOR_FACT_LABELS[f.kind]}</span> {f.text}{' '}
                <a href={f.sourceUrl} target="_blank" rel="noopener noreferrer nofollow" className="small">出典</a>
              </li>
            ))}
          </ul>
        </div>
      ))}
    </div>
  );
}

/** 競合 1 行。 */
function Row({ c, open, onToggle, onRemove, busy }: { c: Competitor; open: boolean; onToggle: () => void; onRemove: () => void; busy: boolean }) {
  return (
    <>
      <tr>
        <td>
          <button className="link" onClick={onToggle} aria-expanded={open}>{c.name || '（名前を引けませんでした）'}</button>
          {c.url && <div className="small"><a href={c.url} target="_blank" rel="noopener noreferrer nofollow">{new URL(c.url).hostname}</a></div>}
        </td>
        <td>{km(c.distanceM)}</td>
        <td>{c.rating !== null ? <>{c.rating.toFixed(1)}<span className="muted small">（{c.ratingCount ?? 0}）</span></> : '—'}</td>
        <td>
          {/* 地図で見つけたものは「Google Maps」の 1 つで、出典の表記を兼ねる（訳さない。第36.13節） */}
          {c.origin === 'map' ? <span translate="no" className="gmaps">Google Maps</span> : COMPETITOR_ORIGIN_LABELS[c.origin]}
          {c.origin === 'map' && c.attributions.length > 0 && <div className="small muted">{c.attributions.join('、')}</div>}
        </td>
        <td>{day(c.lastReadAt)}{c.readNote && <div className="small muted">{c.readNote}</div>}</td>
        <td>{c.factCount}</td>
        <td><button className="btn ghost small" disabled={busy} onClick={onRemove}>削除</button></td>
      </tr>
      {open && (
        <tr className="competitors-open">
          <td colSpan={7}>
            {c.reason && <p className="small muted">{c.reason}</p>}
            <Facts id={c.id} />
          </td>
        </tr>
      )}
    </>
  );
}

/**
 * 競合の分析の画面。
 *
 * @param changeKey 秘書が競合の分析を動かしたら変わる（読み直す）
 */
export function Competitors({ changeKey = '', onColumn, onAnnouncement }: {
  changeKey?: string;
  /** コラムの話題でコラムを書き始める（コラムの作成を使える人だけに渡す） */
  onColumn?: (theme: string) => Promise<void>;
  /** お知らせの案でお知らせの下書きを作る（お知らせの作成を使える人だけに渡す。第36.21節） */
  onAnnouncement?: (text: string) => Promise<void>;
}) {
  const [o, setO] = useState<CompetitorOverview | null>(null);
  const [reports, setReports] = useState<CompetitorReport[]>([]);
  const [openId, setOpenId] = useState<string | null>(null);
  const [openReport, setOpenReport] = useState<string | null>(null);
  const [text, setText] = useState('');
  const [note, setNote] = useState<Note>(null);
  const [topNote, setTopNote] = useState<Note>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    api.competitors.overview().then((r) => { setO(r); setError(null); }).catch((e) => setError(describeError(e, '読めませんでした')));
    api.competitors.reports().then((r) => setReports(r.reports)).catch(() => undefined);
  }, []);
  useEffect(() => { load(); }, [load, changeKey]);
  // 探している・見回っている間は読み直す
  const working = !!o?.job;
  const wasWorking = useRef(false);
  useEffect(() => {
    // 作業が終わったら「探し始めました」などの知らせを消す（結果は一覧とレポートに出る）
    if (wasWorking.current && !working) setTopNote(null);
    wasWorking.current = working;
    if (!working) return undefined;
    const t = setInterval(load, 3000);
    return () => clearInterval(t);
  }, [working, load]);

  const run = (fn: () => Promise<unknown>, ok: string, set: (n: Note) => void) => {
    setBusy(true);
    fn().then(() => { set({ kind: 'ok', text: ok }); load(); })
      .catch((e) => set({ kind: 'error', text: describeError(e, 'できませんでした') }))
      .finally(() => setBusy(false));
  };

  if (error) return <p className="error">{error}</p>;
  if (!o) return <p className="muted">読んでいます…</p>;
  const p = o.profile;
  const latest = reports[0];
  const shownReport = openReport ?? latest?.id ?? null;

  return (
    <div className="competitors">
      <div className="card competitors-self">
        <div className="row wrap">
          <div className="competitors-self-text">
            {p ? (
              <>
                <strong>{p.business || '自社の像'}</strong>
                <span className="muted">　{p.area.local ? `半径 ${km(p.area.radiusM)}` : '全国'}{p.website ? `・${new URL(p.website).hostname}` : ''}{o.selfRating ? `・Google の評価 ${o.selfRating.rating.toFixed(1)}（${o.selfRating.count}）` : ''}</span>
                {p.area.reason && <div className="small muted">{p.area.reason}</div>}
              </>
            ) : <span className="muted">まだ探していません</span>}
          </div>
          <button className="btn small" disabled={busy || working} onClick={() => run(() => api.competitors.discover({}), '探し始めました', setTopNote)}>{p ? '探し直す' : '探す'}</button>
          <button className="btn ghost small" disabled={busy || working || o.competitors.length === 0} onClick={() => run(() => api.competitors.check(), 'チェックを始めました', setTopNote)}>今すぐチェック</button>
          {p && <button className="link small" onClick={() => setOpenId(openId === 'self' ? null : 'self')}>{openId === 'self' ? '自社のデータを閉じる' : '自社のデータ'}</button>}
        </div>
        {o.job && <p className="small competitors-working" role="status">{o.job.message || (o.job.kind === 'discover' ? '競合を探しています' : 'チェックしています')}…</p>}
        {!o.job && o.lastJob?.status === 'failed' && <p className="error small">{o.lastJob.message}</p>}
        {o.nextWatchAt && !o.job && <p className="small muted">次の見回り: {day(o.nextWatchAt)}</p>}
        {o.mapNote && <p className="small muted">{o.mapNote}</p>}
        <NoteText note={topNote} />
        {openId === 'self' && <Facts id="self" />}
      </div>

      <div className="row wrap competitors-add">
        <input value={text} maxLength={300} placeholder="URL か店の名前" aria-label="競合の URL か店の名前" onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter' && text.trim() && !busy) run(() => api.competitors.add(text.trim()).then(() => setText('')), '追加しました。サイトを読んでいます', setNote); }} />
        <button className="btn small" disabled={busy || !text.trim()} onClick={() => run(() => api.competitors.add(text.trim()).then(() => setText('')), '追加しました。サイトを読んでいます', setNote)}>追加</button>
        <NoteText note={note} />
      </div>

      {o.competitors.length > 0 ? (
        <table className="table competitors-table">
          <thead><tr><th>競合</th><th>距離</th><th><span translate="no">Google</span> の評価</th><th>取得方法</th><th>取得日</th><th>データ数</th><th /></tr></thead>
          <tbody>
            {o.competitors.map((c) => (
              <Row key={c.id} c={c} open={openId === c.id} busy={busy} onToggle={() => setOpenId(openId === c.id ? null : c.id)}
                onRemove={() => { if (window.confirm(`${c.name || 'この競合'}を削除しますか。次に自動で探しても入れません`)) run(() => api.competitors.remove(c.id), '削除しました', setNote); }} />
            ))}
          </tbody>
        </table>
      ) : p && !o.job && <p className="muted">覚えている競合はありません</p>}

      <div className="card competitors-reports">
        <div className="row wrap">
          <h3>レポート</h3>
          <button className="btn ghost small" disabled={busy || working || o.competitors.length === 0} onClick={() => run(() => api.competitors.makeReport(), 'レポートを作成しました', setTopNote)}>レポートの作成</button>
        </div>
        {reports.length === 0 && <p className="muted small">まだありません</p>}
        {reports.map((r) => (
          <div key={r.id} className="competitors-report">
            <button className="link" onClick={() => setOpenReport(shownReport === r.id ? '' : r.id)} aria-expanded={shownReport === r.id}>
              {new Date(r.createdAt).toLocaleString('ja-JP', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })}
              {r.changes ? `（前の回から ${r.changes} 件の動き）` : ''}
            </button>
            {shownReport === r.id && <div className="competitors-report-body"><Markdown text={stripTableLinks(r.text)} lineBreaks /></div>}
            {shownReport === r.id && r.themes.length > 0 && (
              <div className="competitors-themes">
                <h4>コラムの話題</h4>
                <ul>
                  {r.themes.map((t) => (
                    <li key={t}>{t}{onColumn && <button className="btn ghost small" disabled={busy} onClick={() => run(() => onColumn(t), 'コラムを書き始めました', setTopNote)}>コラムにする</button>}</li>
                  ))}
                </ul>
              </div>
            )}
            {shownReport === r.id && (r.announcementIdeas ?? []).length > 0 && (
              <div className="competitors-themes">
                <h4>お知らせの案</h4>
                <ul>
                  {r.announcementIdeas!.map((x) => (
                    <li key={x.text}>{x.text} <span className="muted small">{x.why}</span>
                      {onAnnouncement && <button className="btn ghost small" disabled={busy} onClick={() => run(() => onAnnouncement(x.text), 'お知らせの下書きを作りました', setTopNote)}>お知らせにする</button>}</li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
