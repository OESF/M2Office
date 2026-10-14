/**
 * @file ダッシュボードの「集計」の「効果」の欄と、効果のレポート（仕様書 第6.7.13節）。
 *
 * 推計の削減時間と、すべての AI の費用を並べて見る。数字はサーバーが計算したものをそのまま出す。レポートは AI が文を書き、
 * 毎月 1 日に先月の分が届く。管理者はいつでも今月か先月の分を作り直せ、コピーと Google ドキュメントへの書き出しができる。
 * 人ごとの数字と、削減時間をお金に換えた値は出さない。
 */

import { useCallback, useEffect, useState } from 'react';
import type { EffectFigures, EffectPeriod, EffectReport, EffectReportBrief } from '@m2office/shared';
import { api, describeError } from './api.js';
import { copyText } from './clipboard.js';
import { Busy } from './components.js';
import { Markdown } from './help.js';

const PERIODS: [EffectPeriod, string][] = [['thisMonth', '今月'], ['lastMonth', '先月'], ['all', '導入から']];

/** 分を時間にする（小数 1 桁）。 */
const hours = (minutes: number) => Math.round((minutes / 60) * 10) / 10;

/** 前の期間との差（「+1.5」「−200」）。 */
function delta(now: number, before: number, unit: string): string | null {
  const d = Math.round((now - before) * 10) / 10;
  if (d === 0) return null;
  return `${d > 0 ? '+' : '−'}${Math.abs(d).toLocaleString()} ${unit}`;
}

/** 「効果」の欄。 */
export function EffectPanel() {
  const [period, setPeriod] = useState<EffectPeriod>('thisMonth');
  const [f, setF] = useState<EffectFigures | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    setF(null);
    setError(null);
    api.admin.effect(period).then((r) => setF(r.figures)).catch((e) => setError(describeError(e, '読み込めませんでした')));
  }, [period]);
  const p = f?.previous ?? null;
  return (
    <section className="card effect">
      <div className="row wrap effect-head">
        <h3 className="grow">効果</h3>
        <div className="seg small-seg">
          {PERIODS.map(([id, label]) => <button key={id} className={period === id ? 'on' : ''} onClick={() => setPeriod(id)}>{label}</button>)}
        </div>
      </div>
      {error && <p className="error">{error}</p>}
      {!f ? (!error && <p className="muted">読み込み中…</p>) : (
        <>
          <p className="muted small">{f.label}</p>
          <div className="tiles">
            <EffectTile label="推計の削減時間" value={hours(f.savedMinutes)} unit="時間" diff={p ? delta(hours(f.savedMinutes), hours(p.savedMinutes), '時間') : null} />
            <EffectTile label="完了した業務" value={f.completed} unit="件" diff={p ? delta(f.completed, p.completed, '件') : null} />
            <EffectTile label="AI の費用" value={f.aiCostJpy} unit="円" diff={p ? delta(f.aiCostJpy, p.aiCostJpy, '円') : null}
              title="業務・秘書・音声・画像・動画・自動の処理など、すべての AI の利用の合計です（目安の単価で数えた概算）" />
            <EffectTile label="削減 1 時間あたりの AI の費用" value={f.costPerSavedHourJpy ?? '—'} unit={f.costPerSavedHourJpy === null ? '' : '円'} diff={null} />
            <EffectTile label="会社の知識（秘書が学んだこと）" value={f.knowledge.learned} unit="件" diff={null}
              note={`期間に +${f.knowledge.added} 件・使われた ${f.knowledge.used} 件`} />
          </div>
          {p && <p className="muted small">比べている期間: {p.label}</p>}
          <div className="dash-grid">
            <div>
              <h4>よく効いた業務</h4>
              {f.byAgent.length ? (
                <table className="table small">
                  <thead><tr><th>業務</th><th className="num">完了</th><th className="num">推計の削減時間</th><th className="num">1 件の標準所要時間</th></tr></thead>
                  <tbody>
                    {f.byAgent.slice(0, 6).map((a) => (
                      <tr key={a.agentId}>
                        <td>{a.name}</td>
                        <td className="num">{a.completed} 件</td>
                        <td className="num">{hours(a.savedMinutes)} 時間</td>
                        <td className="num">{a.minutesPerRun} 分{a.customized ? '' : <span className="muted">（既定）</span>}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              ) : <p className="muted small">期間に完了した業務はありません</p>}
            </div>
            <div>
              <h4>AI の費用の使い道</h4>
              {f.byPurpose.length ? (
                <table className="table small">
                  <thead><tr><th>使い道</th><th className="num">費用</th><th className="num">回数</th></tr></thead>
                  <tbody>
                    {f.byPurpose.slice(0, 6).map((x) => (
                      <tr key={x.purpose}><td>{x.label}</td><td className="num">{x.costJpy.toLocaleString()} 円</td><td className="num">{x.calls.toLocaleString()} 回</td></tr>
                    ))}
                  </tbody>
                </table>
              ) : <p className="muted small">期間に AI の利用はありません</p>}
            </div>
          </div>
        </>
      )}
      <EffectReports />
    </section>
  );
}

function EffectTile({ label, value, unit, diff, title, note }: { label: string; value: number | string; unit: string; diff: string | null; title?: string; note?: string }) {
  return (
    <div className="tile" title={title}>
      <span>{label}</span>
      <strong>{typeof value === 'number' ? value.toLocaleString() : value}<small> {unit}</small></strong>
      {diff && <small className="muted effect-diff">前の期間より {diff}</small>}
      {note && <small className="muted effect-diff">{note}</small>}
    </div>
  );
}

/** 効果のレポートの一覧と、作る・開く・コピー・Google ドキュメントへの書き出し。 */
function EffectReports() {
  const [reports, setReports] = useState<EffectReportBrief[] | null>(null);
  const [open, setOpen] = useState<{ report: EffectReport; markdown: string } | null>(null);
  const [which, setWhich] = useState<'this' | 'last'>('last');
  const [busy, setBusy] = useState<'create' | 'doc' | null>(null);
  const [note, setNote] = useState<{ text: string; url?: string | null; warn?: boolean } | null>(null);
  const load = useCallback(() => { api.admin.effectReports().then((r) => setReports(r.reports)).catch(() => setReports([])); }, []);
  useEffect(load, [load]);
  const show = (id: string) => {
    setNote(null);
    api.admin.effectReport(id).then(setOpen).catch((e) => setNote({ text: describeError(e, '開けませんでした'), warn: true }));
  };
  const create = () => {
    setBusy('create');
    setNote(null);
    api.admin.createEffectReport(which).then((r) => { load(); show(r.report.id); })
      .catch((e) => setNote({ text: describeError(e, '作れませんでした'), warn: true })).finally(() => setBusy(null));
  };
  const toDoc = () => {
    if (!open) return;
    setBusy('doc');
    setNote(null);
    api.admin.effectReportDoc(open.report.id).then((r) => setNote({ text: `Google ドキュメント「${r.name}」に書き出しました`, url: r.url }))
      .catch((e) => setNote({ text: describeError(e, '書き出せませんでした'), warn: true })).finally(() => setBusy(null));
  };
  const monthLabel = (m: string) => `${Number(m.slice(0, 4))} 年 ${Number(m.slice(5))} 月`;
  return (
    <div className="effect-reports">
      <div className="row wrap">
        <h4 className="grow">効果のレポート</h4>
        <select value={which} disabled={!!busy} aria-label="レポートを作る月" onChange={(e) => setWhich(e.target.value === 'this' ? 'this' : 'last')}>
          <option value="last">先月</option>
          <option value="this">今月（ここまで）</option>
        </select>
        <button className="btn small" disabled={!!busy} onClick={create}>{busy === 'create' ? <Busy>作っています…</Busy> : 'いま作る'}</button>
      </div>
      {reports && reports.length > 0 && (
        <ul className="effect-report-list">
          {reports.map((r) => (
            <li key={r.id}>
              <button className={`link${open?.report.id === r.id ? ' on' : ''}`} onClick={() => (open?.report.id === r.id ? setOpen(null) : show(r.id))}>{monthLabel(r.month)}</button>
              <span className="muted small"> {r.headline}</span>
            </li>
          ))}
        </ul>
      )}
      {reports && reports.length === 0 && <p className="muted small">まだありません。毎月 1 日に先月の分が届きます</p>}
      {note && <p className={`small${note.warn ? ' error' : ''}`} role="status">{note.text}{note.url && <> <a href={note.url} target="_blank" rel="noreferrer">開く</a></>}</p>}
      {open && (
        <div className="card effect-report">
          <div className="row wrap">
            <span className="grow" />
            <button className="btn ghost small" onClick={() => void copyText(open.markdown).then((ok) => setNote({ text: ok ? 'コピーしました' : 'コピーできませんでした', warn: !ok }))}>コピー</button>
            <button className="btn ghost small" disabled={!!busy} onClick={toDoc}>{busy === 'doc' ? <Busy>書き出しています…</Busy> : 'Google ドキュメントに書き出す'}</button>
            <button className="btn ghost small" onClick={() => setOpen(null)}>閉じる</button>
          </div>
          <Markdown text={open.markdown} />
        </div>
      )}
    </div>
  );
}
