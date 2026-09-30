/**
 * @file 人事の担当者の「年末調整」（仕様書 第30.15.1節）。対象と申告の状態・不備・申告の確かめと直し・申告を頼む・計算・
 * 年末調整の回（点検・確定・還付の振込データ）・源泉徴収票と提出用の下書き。
 *
 * 説明文は常に出さない（原則 u11）。分からなければ秘書に聞く。
 */

import { Fragment, useCallback, useEffect, useState, type ComponentType } from 'react';
import type { YeaDeclaration } from '@m2office/shared';
import { api, describeError } from './api.js';
import { YeaFields } from './YearEndForm.js';

type Overview = Awaited<ReturnType<typeof api.hr.payroll.yea>>;

/** 年末調整の年（10 月からはその年、1 月までは前の年）。 */
const defaultYear = () => {
  const now = new Date(Date.now() + 9 * 3_600_000);
  return now.getUTCMonth() + 1 >= 10 ? now.getUTCFullYear() : now.getUTCFullYear() - 1;
};

/**
 * 年末調整の担当者の画面。
 *
 * @param RunView 年末調整の回を月の給与と同じ形で見せる部品（Hr.tsx の RunPanel）
 */
export function YearEndTab({ RunView }: { RunView: ComponentType<{ runId: string; onChanged: () => void }> }) {
  const [year, setYear] = useState(defaultYear());
  const [data, setData] = useState<Overview | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [decl, setDecl] = useState<YeaDeclaration | null>(null);
  const [payDate, setPayDate] = useState(`${defaultYear()}-12-25`);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const load = useCallback(() => { api.hr.payroll.yea(year).then(setData).catch((e) => setError(describeError(e, '読み込めませんでした'))); }, [year]);
  useEffect(load, [load]);
  // 還付を払う日は、その年の回があればその日、無ければその年の 12 月 25 日
  const runPayDate = data?.runs[0]?.payDate;
  useEffect(() => { setPayDate(runPayDate ?? `${year}-12-25`); }, [year, runPayDate]);
  const changeYear = (y: number) => { setYear(y); setOpen(null); setNote(null); };
  const act = (f: () => Promise<unknown>, fail: string) => { setBusy(true); setError(null); setNote(null); void f().catch((e) => setError(describeError(e, fail))).finally(() => setBusy(false)); };
  const openRow = (id: string) => {
    if (open === id) { setOpen(null); return; }
    setOpen(id);
    setDecl(null);
    void api.hr.payroll.yeaDeclaration(id, year).then((r) => setDecl(r.declaration.data)).catch((e) => setError(describeError(e, '読み込めませんでした')));
  };
  if (!data) return <p className="muted">{error ?? '読み込んでいます…'}</p>;
  const targets = data.rows.filter((r) => r.target);
  const run = data.runs.find((r) => r.status !== 'draft') ?? data.runs[0];
  return (
    <div className="hr">
      <div className="row wrap hr-toolbar">
        <button className="btn ghost small" onClick={() => changeYear(year - 1)}>← 前</button>
        <strong>{year} 年分</strong>
        <button className="btn ghost small" onClick={() => changeYear(year + 1)}>次 →</button>
        <span className="small muted">対象 {targets.length} 人・出した {targets.filter((r) => r.submittedAt).length} 人・確かめた {targets.filter((r) => r.checkedAt).length} 人</span>
        <span className="grow" />
        <button className="btn ghost small" disabled={busy} onClick={() => act(async () => { const r = await api.hr.payroll.yeaRequest(year); setNote(`${r.sent} 人に申告を頼みました`); }, '頼めませんでした')}>申告を頼む</button>
        <label className="small">還付を払う日 <input type="date" value={payDate} onChange={(e) => setPayDate(e.target.value)} /></label>
        <button className="btn small" disabled={busy || (run && run.status !== 'draft')} onClick={() => act(async () => { await api.hr.payroll.yeaCalculate(year, payDate); load(); }, '計算できませんでした')}>{run ? '計算し直す' : '計算する'}</button>
      </div>
      <div className="row wrap hr-toolbar small">
        <button className="btn ghost small" onClick={() => act(() => api.hr.payroll.yeaReport(year), '書き出せませんでした')}>源泉徴収票・給与支払報告書（下書き）</button>
        {!data.decemberConfirmed && <span className="muted">12 月の給与が確定すると、年末調整を確定できます</span>}
      </div>
      {error && <p className="error">{error}</p>}
      {note && <p className="ok-msg small">{note}</p>}
      <table className="table hr-table">
        <thead><tr><th>氏名</th><th>対象</th><th>申告</th><th>不備</th><th /></tr></thead>
        <tbody>
          {data.rows.map((r) => (
            <Fragment key={r.employeeId}>
              <tr>
                <td><button className="link" onClick={() => openRow(r.employeeId)}>{r.name}</button></td>
                <td className="small">{r.target ? '対象' : <span className="muted">{r.reason}</span>}</td>
                <td className="small">{r.checkedAt ? '確かめた' : r.submittedAt ? <span className="badge warn">確かめ待ち</span> : r.target ? <span className="muted">まだ</span> : ''}</td>
                <td className="small">{r.problems.length > 0 && <span className="badge warn">{r.problems.length}</span>}</td>
                <td><button className="btn ghost small" onClick={() => act(() => api.hr.payroll.yeaWithholding(r.employeeId, year, r.name), '源泉徴収票を出せませんでした')}>源泉徴収票</button></td>
              </tr>
              {open === r.employeeId && (
                <tr><td colSpan={5}>
                  {r.problems.length > 0 && <ul className="error small">{r.problems.map((p) => <li key={p}>{p}</li>)}</ul>}
                  {decl ? (
                    <div className="yea-form">
                      <YeaFields d={decl} set={(p) => setDecl({ ...decl, ...p })} />
                      <div className="row">
                        <button className="btn ghost small" disabled={busy} onClick={() => act(async () => { await api.hr.payroll.yeaSave(r.employeeId, year, decl); setNote('申告を直しました（確かめた印は外れます）'); load(); }, '直せませんでした')}>申告を直す</button>
                        {r.target && (r.checkedAt
                          ? <button className="btn ghost small" disabled={busy} onClick={() => act(async () => { await api.hr.payroll.yeaCheck(r.employeeId, year, false); load(); }, '外せませんでした')}>確かめた印を外す</button>
                          : <button className="btn small" disabled={busy || !r.submittedAt} onClick={() => act(async () => { await api.hr.payroll.yeaCheck(r.employeeId, year, true); load(); }, '確かめられませんでした')}>確かめた</button>)}
                      </div>
                    </div>
                  ) : <p className="muted small">読み込んでいます…</p>}
                </td></tr>
              )}
            </Fragment>
          ))}
        </tbody>
      </table>
      {run && <><h3 className="pay-sub">年末調整の回</h3><RunView runId={run.id} onChanged={load} /></>}
    </div>
  );
}
