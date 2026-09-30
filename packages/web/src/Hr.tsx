/**
 * @file 人事・給与の担当者の画面（仕様書 第30.25節）。台帳・勤怠・有給・給与（計算・点検・確定・振込データ・賃金台帳・住民税の通知書・試しの計算）。
 *
 * 人事区画の人だけが開ける（API が確かめる）。一覧の上に期限の近い手続きを並べ、行を押すと 1 人の台帳を開く。
 * 説明文は常に出さない（原則 u11）。分からなければ秘書に聞く。
 */

import { Fragment, useCallback, useEffect, useRef, useState } from 'react';
import {
  HR_CATEGORIES, HR_EMPLOYMENTS, HR_WAGE_TYPES,
  type HrEmployee, type HrEmployeeView, type HrPayrollProfile, type HrSettings, type HrTask, type HrTerms, type PayCheck, type PaySlip, type PayTrialCompare,
} from '@m2office/shared';
import { api, describeError, type HrImportResult } from './api.js';

const label = <T extends string>(list: { id: T; label: string }[], id: T) => list.find((x) => x.id === id)?.label ?? id;
/** 日本時間の今日（YYYY-MM-DD）。 */
const today = () => new Date(Date.now() + 9 * 3_600_000).toISOString().slice(0, 10);
const yen = (n: number | null | undefined) => (n === null || n === undefined ? '' : `${n.toLocaleString('ja-JP')} 円`);
const wage = (t: Pick<HrTerms, 'wageType' | 'wageAmount'> | null) => (t && t.wageAmount !== null ? `${label(HR_WAGE_TYPES, t.wageType)} ${yen(t.wageAmount)}` : '');

/**
 * 人事・給与の担当者の画面。
 *
 * @param employeeId 開いている従業員（無ければ一覧）
 * @param onOpen 従業員を開く・一覧へ戻る
 */
export function Hr({ employeeId, onOpen }: { employeeId: string | null; onOpen: (id: string | null) => void }) {
  const [tab, setTab] = useState<'ledger' | 'attendance' | 'leave' | 'payroll'>('ledger');
  if (employeeId) return <EmployeeDetail id={employeeId} onBack={() => onOpen(null)} />;
  return (
    <>
      <div className="hr-tabs" role="tablist">
        {([['ledger', '台帳'], ['attendance', '勤怠'], ['leave', '有給'], ['payroll', '給与']] as const).map(([k, l]) => (
          <button key={k} role="tab" aria-selected={tab === k} className={tab === k ? 'on' : ''} onClick={() => setTab(k)}>{l}</button>
        ))}
      </div>
      {tab === 'ledger' && <EmployeeList onOpen={onOpen} />}
      {tab === 'attendance' && <AttendanceTab />}
      {tab === 'leave' && <LeaveTab />}
      {tab === 'payroll' && <PayrollTab onOpen={onOpen} />}
    </>
  );
}

const hm = (m: number) => (m ? `${Math.floor(m / 60)}:${String(m % 60).padStart(2, '0')}` : '');
/** 日本時間の時刻（HH:MM）。 */
const time = (iso: string | null) => (iso ? new Date(new Date(iso).getTime() + 9 * 3_600_000).toISOString().slice(11, 16) : '');
const WEEK = '日月火水木金土';
const mdw = (d: string) => `${Number(d.slice(5, 7))}/${Number(d.slice(8, 10))}（${WEEK[new Date(`${d}T00:00:00Z`).getUTCDay()]}）`;
const shiftMonth = (ym: string, n: number) => {
  const [y, m] = ym.split('-').map(Number) as [number, number];
  const t = y * 12 + (m - 1) + n;
  return `${Math.floor(t / 12)}-${String((t % 12) + 1).padStart(2, '0')}`;
};

/** 勤怠（期間の集計・点検・36 協定・締め・出勤簿。仕様書 第30.6.1節）。 */
function AttendanceTab() {
  const [month, setMonth] = useState<string | undefined>(undefined);
  const [data, setData] = useState<Awaited<ReturnType<typeof api.hr.attendance>> | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(() => {
    api.hr.attendance(month).then((r) => { setData(r); setError(null); }).catch((e) => setError(describeError(e, '読み込めませんでした')));
  }, [month]);
  useEffect(load, [load]);
  if (!data) return <p className="muted">{error ?? '読み込んでいます…'}</p>;
  const ym = data.period.end.slice(0, 7);
  const act = (fn: () => Promise<unknown>, fail: string) => void fn().then(load).catch((e) => setError(describeError(e, fail)));
  return (
    <div className="hr">
      <div className="row wrap hr-toolbar">
        <button className="btn ghost small" onClick={() => setMonth(shiftMonth(ym, -1))}>← 前</button>
        <strong>{data.period.label}（{mdw(data.period.start)}〜{mdw(data.period.end)}）</strong>
        <button className="btn ghost small" onClick={() => setMonth(shiftMonth(ym, 1))}>次 →</button>
        <span className="grow" />
        {data.close
          ? <button className="btn ghost small" onClick={() => act(() => api.hr.reopenAttendance(data.close!.id), '締めを戻せませんでした')}>締めを戻す</button>
          : <button className="btn small" onClick={() => act(() => api.hr.closeAttendance(ym), '締められませんでした')}>締める</button>}
        <button className="btn ghost small" onClick={() => void api.hr.attendanceBook(ym).catch((e) => setError(describeError(e, '書き出せませんでした')))}>出勤簿</button>
      </div>
      {data.close && <p className="small muted">締めました（{data.close.closedAt.slice(0, 10)}）</p>}
      {error && <p className="error">{error}</p>}
      <table className="table hr-table">
        <thead><tr><th>氏名</th><th>出勤</th><th>労働</th><th>法定外</th><th>60 時間超</th><th>深夜</th><th>休日</th><th>有給</th><th>点検</th></tr></thead>
        <tbody>
          {data.rows.map((r) => (
            <Fragment key={r.employeeId}>
              <tr>
                <td><button className="link" onClick={() => setOpen(open === r.employeeId ? null : r.employeeId)}>{r.name}</button></td>
                <td>{r.totals.workDays} 日</td><td>{hm(r.totals.workMinutes)}</td><td>{hm(r.totals.overtimeMinutes)}</td>
                <td>{hm(r.totals.over60Minutes)}</td><td>{hm(r.totals.nightMinutes)}</td><td>{hm(r.totals.holidayMinutes)}</td>
                <td>{r.totals.leaveDays || ''}</td>
                <td className="small">
                  {r.issues > 0 && <span className="badge warn">点検 {r.issues}</span>}
                  {r.alerts.map((a) => <div key={a} className="error">{a}</div>)}
                </td>
              </tr>
              {open === r.employeeId && <tr><td colSpan={9}><EmployeeAttendance employeeId={r.employeeId} month={ym} closed={!!data.close} onChanged={load} /></td></tr>}
            </Fragment>
          ))}
          {data.rows.length === 0 && <tr><td colSpan={9} className="muted">この期間に在籍した人はいません</td></tr>}
        </tbody>
      </table>
    </div>
  );
}

/** 1 人の期間の日ごとの勤怠（担当者が直せる）。 */
function EmployeeAttendance({ employeeId, month, closed, onChanged }: { employeeId: string; month: string; closed: boolean; onChanged: () => void }) {
  const [data, setData] = useState<Awaited<ReturnType<typeof api.hr.attendanceOf>> | null>(null);
  const [fixing, setFixing] = useState<{ date: string; in: string; out: string; bs: string; be: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(() => {
    api.hr.attendanceOf(employeeId, month).then(setData).catch((e) => setError(describeError(e, '読み込めませんでした')));
  }, [employeeId, month]);
  useEffect(load, [load]);
  if (!data) return <p className="muted small">{error ?? '読み込んでいます…'}</p>;
  const save = () => void api.hr.fixDay(employeeId, fixing!.date, {
    in: fixing!.in, out: fixing!.out || null, breaks: fixing!.bs && fixing!.be ? [{ start: fixing!.bs, end: fixing!.be }] : [],
  }).then(() => { setFixing(null); load(); onChanged(); }).catch((e) => setError(describeError(e, '直せませんでした')));
  return (
    <div className="hr-days">
      {error && <p className="error small">{error}</p>}
      <table className="table small">
        <thead><tr><th>日付</th><th>出勤</th><th>退勤</th><th>休憩</th><th>労働</th><th>法定外</th><th>深夜</th><th>点検</th><th /></tr></thead>
        <tbody>
          {data.days.map((d) => (
            fixing?.date === d.date ? (
              <tr key={d.date}>
                <td>{mdw(d.date)}</td>
                <td><input type="time" value={fixing.in} onChange={(e) => setFixing({ ...fixing, in: e.target.value })} aria-label="出勤" /></td>
                <td><input type="time" value={fixing.out} onChange={(e) => setFixing({ ...fixing, out: e.target.value })} aria-label="退勤" /></td>
                <td colSpan={3}>
                  <input type="time" value={fixing.bs} onChange={(e) => setFixing({ ...fixing, bs: e.target.value })} aria-label="休憩の始め" />〜
                  <input type="time" value={fixing.be} onChange={(e) => setFixing({ ...fixing, be: e.target.value })} aria-label="休憩の終わり" />
                </td>
                <td colSpan={3}><button className="btn small" onClick={save}>保存</button><button className="btn ghost small" onClick={() => setFixing(null)}>やめる</button></td>
              </tr>
            ) : (
              <tr key={d.date} className={d.type !== 'workday' ? 'muted' : ''}>
                <td>{mdw(d.date)}{d.leaveDays ? ' 有給' : ''}</td><td>{time(d.in)}</td><td>{time(d.out)}</td><td>{hm(d.breakMinutes)}</td>
                <td>{hm(d.workMinutes)}</td><td>{hm(d.overtimeMinutes)}</td><td>{hm(d.nightMinutes)}</td>
                <td className={d.issues.length ? 'error' : ''}>{d.issues.join('・')}</td>
                <td>{!closed && <button className="btn ghost small" onClick={() => setFixing({ date: d.date, in: time(d.in) || '09:00', out: time(d.out) || '18:00', bs: '', be: '' })}>直す</button>}</td>
              </tr>
            )
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** 給与（支給月の計算・点検・確定・明細・振込データ。仕様書 第30.10.1節・第30.10.3節）。 */
function PayrollTab({ onOpen }: { onOpen: (id: string) => void }) {
  const thisMonth = new Date(Date.now() + 9 * 3_600_000).toISOString().slice(0, 7);
  const [month, setMonth] = useState(thisMonth);
  const [info, setInfo] = useState<Awaited<ReturnType<typeof api.hr.payroll.runs>> | null>(null);
  const [run, setRun] = useState<Awaited<ReturnType<typeof api.hr.payroll.run>> | null>(null);
  const [trial, setTrial] = useState<Awaited<ReturnType<typeof api.hr.payroll.run>> | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [problems, setProblems] = useState<string[]>([]);
  const noticeRef = useRef<HTMLInputElement>(null);
  const trialRef = useRef<HTMLInputElement>(null);
  const load = useCallback(() => {
    setRun(null);
    setTrial(null);
    api.hr.payroll.runs(month).then((r) => {
      setInfo(r);
      const mine = r.runs.filter((x) => x.payMonth === month);
      const main = mine.find((x) => x.kind === 'monthly' && x.status !== 'draft') ?? mine.find((x) => x.kind === 'monthly');
      if (main) api.hr.payroll.run(main.id).then(setRun).catch((e) => setError(describeError(e, '読み込めませんでした')));
      const t = mine.find((x) => x.kind === 'trial');
      if (t) api.hr.payroll.run(t.id).then(setTrial).catch(() => undefined);
    }).catch((e) => setError(describeError(e, '読み込めませんでした')));
  }, [month]);
  useEffect(load, [load]);
  const act = (f: () => Promise<unknown>, fail: string) => {
    setBusy(true);
    setError(null);
    setNote(null);
    setProblems([]);
    void f().catch((e) => { setError(describeError(e, fail)); setProblems((e as { problems?: string[] }).problems ?? []); }).finally(() => setBusy(false));
  };
  const calc = () => act(async () => { const r = await api.hr.payroll.calculate(month); setRun(await api.hr.payroll.run(r.run.id)); }, '計算できませんでした');
  const confirm = () => act(async () => {
    const r = await api.hr.payroll.confirm(run!.run.id);
    setNote(`確定しました。${r.published} 人に明細を届けました${r.pdf.length ? `。PDF で渡す人: ${r.pdf.join('、')}` : ''}`);
    setRun(await api.hr.payroll.run(r.run.id));
  }, '確定できませんでした');
  const request = () => act(async () => { const r = await api.hr.payroll.requestConfirm(run!.run.id); setNote(r.sent ? `管理者 ${r.sent} 人に確定を頼みました` : '知らせる管理者がいません'); }, '頼めませんでした');
  const transfer = () => act(async () => {
    const r = await api.hr.payroll.transfer(run!.run.id, month);
    setNote(`振込データ（${r.count} 件）を保存しました${r.excluded.length ? `。入っていない人: ${r.excluded.join('、')}` : ''}`);
    setRun(await api.hr.payroll.run(run!.run.id));
  }, '振込データを作れませんでした');
  const readNotice = (f: File) => act(async () => {
    const r = await api.hr.payroll.readNotice(f);
    setNote(`住民税を ${r.applied.length} 人に入れました${r.applied.length ? `（${r.applied.map((a) => a.name).join('、')}）` : ''}`);
    setProblems(r.skipped.map((x) => `${x.name}: ${x.reason}`));
  }, '通知書を読めませんでした');
  const runTrial = (f: File) => act(async () => { const r = await api.hr.payroll.trial(month, f); setTrial(await api.hr.payroll.run(r.run.id)); }, '試しの計算ができませんでした');
  const yenOf = (n: number) => n.toLocaleString('ja-JP');
  const sum = (s: PaySlip, codes: string[]) => s.lines.filter((l) => codes.includes(l.code)).reduce((a, l) => a + l.amount, 0);
  const r = run?.run;
  const confirmed = r ? r.status !== 'draft' : false;
  const stops = r?.checks.filter((c) => c.level === 'stop') ?? [];
  const checks = r?.checks.filter((c) => c.level === 'check') ?? [];
  const who = (c: PayCheck) => (c.employeeName ? `${c.employeeName}: ` : '');
  const at = (v?: string | null) => (v ? new Date(v).toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' }) : '');
  return (
    <div className="hr">
      <div className="row wrap hr-toolbar">
        <button className="btn ghost small" onClick={() => setMonth(shiftMonth(month, -1))}>← 前</button>
        <strong>{Number(month.slice(0, 4))} 年 {Number(month.slice(5))} 月支給</strong>
        <button className="btn ghost small" onClick={() => setMonth(shiftMonth(month, 1))}>次 →</button>
        {info?.schedule && <span className="small muted">支払日 {info.schedule.payDate}・勤怠 {info.schedule.period.label}</span>}
        <span className="grow" />
        {!confirmed && <button className="btn small" disabled={busy} onClick={calc}>{run ? '計算し直す' : '計算する'}</button>}
        {r && !confirmed && (run?.canConfirm
          ? <button className="btn primary small" disabled={busy || (run?.blockers.length ?? 0) > 0} onClick={confirm}>確定する</button>
          : <button className="btn small" disabled={busy} onClick={request}>{r.confirmRequestedAt ? '管理者にもう一度頼む' : '管理者に確定を頼む'}</button>)}
        {r && confirmed && run?.canConfirm && <button className="btn small" disabled={busy} onClick={transfer}>{r.transferAt ? '振込データを作り直す' : '振込データ'}</button>}
      </div>
      <div className="row wrap hr-toolbar small">
        <button className="btn ghost small" onClick={() => act(() => api.hr.payroll.ledger(Number(month.slice(0, 4)), 'xlsx'), '書き出せませんでした')}>{month.slice(0, 4)} 年の賃金台帳</button>
        <button className="btn ghost small" disabled={busy} onClick={() => noticeRef.current?.click()}>住民税の通知書を読む</button>
        <button className="btn ghost small" disabled={busy} onClick={() => trialRef.current?.click()}>今の明細と試しに比べる</button>
        <input ref={noticeRef} type="file" accept="application/pdf,image/*" hidden onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ''; if (f) readNotice(f); }} />
        <input ref={trialRef} type="file" accept=".csv,.xlsx,text/csv" hidden onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ''; if (f) runTrial(f); }} />
      </div>
      {error && <p className="error">{error}</p>}
      {problems.length > 0 && <ul className="error small">{problems.map((p) => <li key={p}>{p}</li>)}</ul>}
      {note && <p className="ok-msg small">{note}</p>}
      {r && (
        <>
          <p className="small muted">
            {confirmed ? `確定（${at(r.confirmedAt)}）` : `下書き（${at(r.calculatedAt)} に計算）`}
            {r.confirmedUnverified && <span className="badge warn">監修前の表で確定（開発）</span>}
            {r.transferAt && `・振込データ ${at(r.transferAt)}`}
            {!confirmed && r.confirmRequestedAt && `・確定を頼みました（${at(r.confirmRequestedAt)}）`}
          </p>
          {!confirmed && stops.length > 0 && (
            <div className="pay-checks stop"><strong className="small">止まっているもの</strong>
              <ul className="small">{stops.map((c, i) => <li key={i}>{who(c)}{c.text}{run?.blockers.every((b) => b.code !== c.code) && <span className="muted">（開発の環境のため確定できます）</span>}</li>)}</ul>
            </div>
          )}
          {!confirmed && checks.length > 0 && (
            <div className="pay-checks"><strong className="small">確かめること</strong>
              <ul className="small">{checks.map((c, i) => <li key={i}>{who(c)}{c.text}</li>)}</ul>
            </div>
          )}
          <div className="pay-table">
          <table className="table hr-table">
            <thead><tr><th>氏名</th><th>総支給</th><th>社会保険</th><th>雇用保険</th><th>所得税</th><th>住民税</th><th>差引支給</th><th /></tr></thead>
            <tbody>
              {run!.slips.map((s) => (
                <Fragment key={s.id}>
                  <tr>
                    <td><button className="link" onClick={() => setOpen(open === s.id ? null : s.id)}>{s.employeeName}</button></td>
                    <td>{yenOf(s.gross)}</td><td>{yenOf(sum(s, ['health', 'child', 'pension']))}</td><td>{yenOf(sum(s, ['employment']))}</td>
                    <td>{yenOf(sum(s, ['income-tax']))}</td><td>{yenOf(sum(s, ['resident-tax']))}</td><td><strong>{yenOf(s.net)}</strong></td>
                    <td className="small">{!confirmed && r.checks.some((c) => c.employeeId === s.employeeId) && <span className="badge warn">点検 {r.checks.filter((c) => c.employeeId === s.employeeId).length}</span>}</td>
                  </tr>
                  {open === s.id && (
                    <tr><td colSpan={8}>
                      <div className="pay-slip">
                        <table className="table small">
                          <tbody>
                            {s.lines.map((l) => (
                              <tr key={l.code}>
                                <td>{l.kind === 'deduct' ? '控除' : '支給'}</td>
                                <td className="pay-line">{l.label}<div className="muted">{Object.entries(l.basis).map(([k, v]) => `${k}: ${v}`).join('・')}</div></td>
                                <td className="num">{yenOf(l.amount)}</td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                        <div className="row">
                          <button className="btn ghost small" onClick={() => onOpen(s.employeeId)}>台帳と給与の情報を開く</button>
                          {confirmed && <button className="btn ghost small" onClick={() => act(() => api.hr.payroll.slipPdf(s.id, `給与明細-${month}-${s.employeeName ?? ''}.pdf`), 'PDF を出せませんでした')}>明細の PDF</button>}
                        </div>
                      </div>
                    </td></tr>
                  )}
                </Fragment>
              ))}
              {run!.slips.length === 0 && <tr><td colSpan={8} className="muted">この月に計算する人はいません</td></tr>}
            </tbody>
          </table>
          </div>
        </>
      )}
      {!run && info && <p className="muted small">まだ計算していません</p>}
      {trial?.run.compare && <TrialCompare compare={trial.run.compare} at={at(trial.run.calculatedAt)} />}
    </div>
  );
}

/** 試しの計算の比べ（差のある項目を目立たせる）。 */
function TrialCompare({ compare, at }: { compare: PayTrialCompare; at: string }) {
  const labels = [...new Set(compare.rows.flatMap((r) => r.items.map((i) => i.label)))];
  const diffs = compare.rows.reduce((n, r) => n + r.items.filter((i) => i.diff !== null && i.diff !== 0).length, 0);
  return (
    <div className="pay-trial">
      <h3>試しの計算（{at}）<span className={`badge ${diffs ? 'warn' : ''}`}>{diffs ? `差 ${diffs} か所` : '差なし'}</span></h3>
      {compare.unmatched.length > 0 && <p className="small muted">台帳に当てられなかった行: {compare.unmatched.join('、')}</p>}
      {compare.missing.length > 0 && <p className="small muted">表に無かった人: {compare.missing.join('、')}</p>}
      <div className="pay-table">
        <table className="table hr-table small">
          <thead><tr><th>氏名</th>{labels.map((l) => <th key={l}>{l}</th>)}</tr></thead>
          <tbody>
            {compare.rows.map((row) => (
              <tr key={row.employeeId ?? row.name}>
                <td>{row.name}</td>
                {labels.map((l) => {
                  const it = row.items.find((i) => i.label === l);
                  if (!it) return <td key={l} />;
                  return (
                    <td key={l} className={it.diff ? 'pay-diff' : ''}>
                      {it.ours?.toLocaleString('ja-JP')}
                      {it.diff ? <div className="small">今 {it.theirs?.toLocaleString('ja-JP')}（{it.diff > 0 ? '+' : ''}{it.diff.toLocaleString('ja-JP')}）</div> : null}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

/** 1 人の給与の情報（税の区分・扶養・住民税・通勤・口座・標準報酬月額・家族。仕様書 第30.10.1節）。 */
function PayrollProfile({ employeeId }: { employeeId: string }) {
  const [d, setD] = useState<Awaited<ReturnType<typeof api.hr.payroll.employee>> | null>(null);
  const [p, setP] = useState<HrPayrollProfile | null>(null);
  const [std, setStd] = useState({ fromMonth: new Date(Date.now() + 9 * 3_600_000).toISOString().slice(0, 7), pay: '' });
  const [fam, setFam] = useState({ name: '', relation: '', birthDate: '', dependent: true });
  const [note, setNote] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(() => {
    api.hr.payroll.employee(employeeId).then((r) => { setD(r); setP(r.profile); }).catch((e) => setError(describeError(e, '読み込めませんでした')));
  }, [employeeId]);
  useEffect(load, [load]);
  if (!d || !p) return <p className="muted small">{error ?? '読み込んでいます…'}</p>;
  const act = (fn: () => Promise<unknown>, fail: string, ok?: string) => void fn().then(() => { setError(null); setNote(ok ?? null); load(); }).catch((e) => setError(describeError(e, fail)));
  const rt = p.residentTax[0] ?? { fiscalYear: new Date().getFullYear(), municipality: '', june: 0, monthly: 0 };
  const setRt = (patch: Partial<typeof rt>) => setP({ ...p, residentTax: [{ ...rt, ...patch }, ...p.residentTax.slice(1)] });
  const num = (v: string) => (v === '' ? 0 : Number(v));
  return (
    <div className="card hr-panel">
      <strong>給与の情報</strong>
      <div className="row wrap">
        <select value={p.taxColumn} onChange={(e) => setP({ ...p, taxColumn: e.target.value as 'ko' | 'otsu' })} aria-label="税の区分">
          <option value="ko">甲欄（扶養控除等申告書あり）</option><option value="otsu">乙欄</option>
        </select>
        <label className="small">扶養親族等 <input className="num-input" type="number" min={0} max={20} value={p.dependents} onChange={(e) => setP({ ...p, dependents: num(e.target.value) })} /> 人</label>
      </div>
      <div className="row wrap">
        <span className="small">住民税</span>
        <input className="num-input" type="number" value={rt.fiscalYear} onChange={(e) => setRt({ fiscalYear: num(e.target.value) })} aria-label="年度" />
        <input className="short" placeholder="市区町村" value={rt.municipality} onChange={(e) => setRt({ municipality: e.target.value })} aria-label="市区町村" />
        <label className="small">6 月分 <input className="num-input" type="number" min={0} value={rt.june} onChange={(e) => setRt({ june: num(e.target.value) })} /></label>
        <label className="small">7 月以降 <input className="num-input" type="number" min={0} value={rt.monthly} onChange={(e) => setRt({ monthly: num(e.target.value) })} /></label>
      </div>
      <div className="row wrap">
        <span className="small">通勤</span>
        <input className="short" placeholder="手段" value={p.commute.means ?? ''} onChange={(e) => setP({ ...p, commute: { ...p.commute, means: e.target.value } })} aria-label="通勤の手段" />
        <label className="small">月額 <input className="num-input" type="number" min={0} value={p.commute.monthly ?? 0} onChange={(e) => setP({ ...p, commute: { ...p.commute, monthly: num(e.target.value) } })} /></label>
        <label className="small">うち非課税 <input className="num-input" type="number" min={0} value={p.commute.taxFree ?? 0} onChange={(e) => setP({ ...p, commute: { ...p.commute, taxFree: num(e.target.value) } })} /></label>
      </div>
      <div className="row wrap">
        <span className="small">振込先</span>
        <input className="short" placeholder="銀行" value={p.bank.bank ?? ''} onChange={(e) => setP({ ...p, bank: { ...p.bank, bank: e.target.value } })} aria-label="銀行" />
        <input className="tiny" placeholder="銀行コード" inputMode="numeric" maxLength={4} value={p.bank.bankCode ?? ''} onChange={(e) => setP({ ...p, bank: { ...p.bank, bankCode: e.target.value } })} aria-label="銀行コード" />
        <input className="short" placeholder="支店" value={p.bank.branch ?? ''} onChange={(e) => setP({ ...p, bank: { ...p.bank, branch: e.target.value } })} aria-label="支店" />
        <input className="tiny" placeholder="支店コード" inputMode="numeric" maxLength={3} value={p.bank.branchCode ?? ''} onChange={(e) => setP({ ...p, bank: { ...p.bank, branchCode: e.target.value } })} aria-label="支店コード" />
        <select value={p.bank.type ?? '普通'} onChange={(e) => setP({ ...p, bank: { ...p.bank, type: e.target.value as '普通' | '当座' } })} aria-label="種類"><option>普通</option><option>当座</option></select>
        <input className="short" placeholder="口座番号" value={p.bank.number ?? ''} onChange={(e) => setP({ ...p, bank: { ...p.bank, number: e.target.value } })} aria-label="口座番号" />
        <input className="short" placeholder="名義（カナ）" value={p.bank.holder ?? ''} onChange={(e) => setP({ ...p, bank: { ...p.bank, holder: e.target.value } })} aria-label="名義" />
      </div>
      <div className="row">
        <button className="btn small" onClick={() => act(() => api.hr.payroll.saveProfile(employeeId, {
          taxColumn: p.taxColumn, dependents: p.dependents, residentTax: rt.municipality || rt.june || rt.monthly ? [rt, ...p.residentTax.slice(1)] : p.residentTax.slice(1), commute: p.commute, bank: p.bank,
        }), '保存できませんでした', '保存しました')}>保存する</button>
        {note && <span className="small muted">{note}</span>}
      </div>
      {error && <p className="error small">{error}</p>}
      <div className="row wrap">
        <span className="small">標準報酬月額 {d.standardPays[0] ? `${d.standardPays[0].amount.toLocaleString('ja-JP')} 円（${d.standardPays[0].fromMonth} から）` : '未登録'}</span>
        <input type="month" value={std.fromMonth} onChange={(e) => setStd({ ...std, fromMonth: e.target.value })} aria-label="適用の月" />
        <input className="num-input" type="number" min={0} placeholder="報酬の額" value={std.pay} onChange={(e) => setStd({ ...std, pay: e.target.value })} aria-label="報酬の額" />
        <button className="btn ghost small" disabled={!std.pay} onClick={() => act(() => api.hr.payroll.addStandardPay(employeeId, std.fromMonth, Number(std.pay)), '足せませんでした', '等級表で標準報酬月額に直して足しました')}>足す</button>
      </div>
      <div className="small">
        家族
        <ul className="plain">
          {d.family.map((f) => (
            <li key={f.id} className="row">
              <span className="grow">{f.name}（{f.relation}）{f.birthDate ?? ''}{f.dependent ? '・扶養' : ''}</span>
              <button className="btn ghost small" onClick={() => act(() => api.hr.payroll.removeFamily(employeeId, f.id), '外せませんでした')}>外す</button>
            </li>
          ))}
        </ul>
        <div className="row wrap">
          <input className="short" placeholder="氏名" value={fam.name} onChange={(e) => setFam({ ...fam, name: e.target.value })} aria-label="家族の氏名" />
          <input className="short" placeholder="続柄" value={fam.relation} onChange={(e) => setFam({ ...fam, relation: e.target.value })} aria-label="続柄" />
          <input type="date" value={fam.birthDate} onChange={(e) => setFam({ ...fam, birthDate: e.target.value })} aria-label="生年月日" />
          <label className="check"><input type="checkbox" checked={fam.dependent} onChange={(e) => setFam({ ...fam, dependent: e.target.checked })} /> 扶養</label>
          <button className="btn ghost small" disabled={!fam.name} onClick={() => act(() => api.hr.payroll.addFamily(employeeId, { ...fam, birthDate: fam.birthDate || null }), '足せませんでした')}>足す</button>
        </div>
      </div>
    </div>
  );
}

/** 有給（残り・取得義務・出勤率・手作業の付与・管理簿。仕様書 第30.7.1節）。 */
function LeaveTab() {
  const [rows, setRows] = useState<Awaited<ReturnType<typeof api.hr.leaveOverview>>['rows'] | null>(null);
  const [grant, setGrant] = useState<{ employeeId: string; grantedOn: string; days: string; note: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(() => {
    api.hr.leaveOverview().then((r) => setRows(r.rows)).catch((e) => setError(describeError(e, '読み込めませんでした')));
  }, []);
  useEffect(load, [load]);
  if (!rows) return <p className="muted">{error ?? '読み込んでいます…'}</p>;
  return (
    <div className="hr">
      <div className="row wrap hr-toolbar">
        <span className="grow" />
        <button className="btn ghost small" onClick={() => void api.hr.leaveRegister().catch((e) => setError(describeError(e, '書き出せませんでした')))}>管理簿</button>
      </div>
      {error && <p className="error">{error}</p>}
      <table className="table hr-table">
        <thead><tr><th>氏名</th><th>残り</th><th>付与</th><th>取得義務</th><th /></tr></thead>
        <tbody>
          {rows.map((r) => (
            <Fragment key={r.employeeId}>
              <tr>
                <td>{r.name}</td>
                <td>{r.balance.remaining} 日</td>
                <td className="small">{r.balance.grants.filter((g) => g.left > 0).map((g) => `${g.grantedOn} ${g.days} 日（残り ${g.left}）`).join('・')}</td>
                <td className="small">
                  {r.balance.obligation && (r.balance.obligation.taken >= r.balance.obligation.required
                    ? '済み'
                    : <span className="badge warn">{r.balance.obligation.deadline} までにあと {r.balance.obligation.required - r.balance.obligation.taken} 日</span>)}
                  {r.lowAttendance !== null && <div className="error">出勤率 {Math.round(r.lowAttendance * 100)}%（付与を確かめる）</div>}
                </td>
                <td><button className="btn ghost small" onClick={() => setGrant(grant?.employeeId === r.employeeId ? null : { employeeId: r.employeeId, grantedOn: '', days: '', note: '導入のときの残日数' })}>付与を足す</button></td>
              </tr>
              {grant?.employeeId === r.employeeId && (
                <tr><td colSpan={5}>
                  <div className="row wrap">
                    <label className="small">付与の日 <input type="date" value={grant.grantedOn} onChange={(e) => setGrant({ ...grant, grantedOn: e.target.value })} /></label>
                    <input className="num-input" type="number" min={0} step="0.5" placeholder="日数" value={grant.days} onChange={(e) => setGrant({ ...grant, days: e.target.value })} aria-label="日数" />
                    <input className="grow" placeholder="理由" value={grant.note} onChange={(e) => setGrant({ ...grant, note: e.target.value })} aria-label="理由" />
                    <button className="btn small" disabled={!grant.grantedOn || grant.days === ''} onClick={() => void api.hr.addGrant(grant.employeeId, grant.grantedOn, Number(grant.days), grant.note)
                      .then(() => { setGrant(null); load(); }).catch((e) => setError(describeError(e, '付与を足せませんでした')))}>足す</button>
                  </div>
                </td></tr>
              )}
            </Fragment>
          ))}
          {rows.length === 0 && <tr><td colSpan={5} className="muted">在籍している人はいません</td></tr>}
        </tbody>
      </table>
    </div>
  );
}

/** 期限の近い手続き（済んだにできる）。 */
function TaskList({ tasks, onChanged, withName = false }: { tasks: HrTask[]; onChanged: () => void; withName?: boolean }) {
  const [error, setError] = useState<string | null>(null);
  const now = today();
  const toggle = (t: HrTask) => void api.hr.setTaskDone(t.id, !t.doneAt).then(onChanged).catch((e) => setError(describeError(e, '変更できませんでした')));
  return (
    <>
      <ul className="plain hr-tasks">
        {tasks.map((t) => (
          <li key={t.id} className={`row ${!t.doneAt && t.dueOn && t.dueOn < now ? 'overdue' : ''} ${t.doneAt ? 'done' : ''}`}>
            <label className="check grow">
              <input type="checkbox" checked={!!t.doneAt} onChange={() => toggle(t)} />
              <span>{withName && t.employeeName ? `${t.employeeName}: ` : ''}{t.title}</span>
            </label>
            <span className="small muted">{t.dueOn ? `${t.dueOn} まで` : ''}</span>
          </li>
        ))}
      </ul>
      {error && <p className="error small">{error}</p>}
    </>
  );
}

/** 従業員の一覧・手続き・足す・取り込む・書き出す。 */
function EmployeeList({ onOpen }: { onOpen: (id: string) => void }) {
  const [data, setData] = useState<{ employees: HrEmployeeView[]; tasks: HrTask[]; settings: HrSettings } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [q, setQ] = useState('');
  const [showLeft, setShowLeft] = useState(false);
  const [adding, setAdding] = useState(false);
  const [imported, setImported] = useState<HrImportResult | null>(null);
  const file = useRef<HTMLInputElement>(null);
  const load = useCallback(() => {
    api.hr.list().then(setData).catch((e) => setError(describeError(e, '読み込めませんでした')));
  }, []);
  useEffect(load, [load]);
  if (!data) return <p className="muted">{error ?? '読み込んでいます…'}</p>;
  const words = q.trim().toLowerCase();
  const shown = data.employees
    .filter((e) => showLeft || e.status !== 'left')
    .filter((e) => !words || [e.name, e.kana, e.code, e.department].some((v) => v.toLowerCase().includes(words)));
  const importFile = async (f: File) => {
    try {
      setImported(await api.hr.importFile(f));
      load();
    } catch (e) {
      setError(describeError(e, '取り込めませんでした'));
    }
  };
  return (
    <div className="hr">
      <div className="row wrap hr-toolbar">
        <input type="search" className="grow" placeholder="氏名・ふりがな・社員番号・所属" value={q} onChange={(e) => setQ(e.target.value)} aria-label="従業員を探す" />
        <button className={adding ? 'btn' : 'btn ghost'} onClick={() => setAdding(!adding)}>従業員を足す</button>
        <button className="btn ghost" onClick={() => file.current?.click()}>取り込む</button>
        <input ref={file} type="file" accept=".csv,.xlsx" hidden onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ''; if (f) void importFile(f); }} />
        <button className="btn ghost" onClick={() => void api.hr.roster('xlsx').catch((e) => setError(describeError(e, '書き出せませんでした')))}>労働者名簿</button>
      </div>
      {error && <p className="error">{error}</p>}
      {imported && (
        <div className="card hr-panel">
          <p>{imported.created} 人を足し、{imported.updated} 人を直しました{imported.skipped.length ? `。${imported.skipped.length} 行は取り込めませんでした` : ''}。</p>
          {imported.skipped.length > 0 && <ul className="small">{imported.skipped.slice(0, 20).map((s) => <li key={s.row}>{s.row} 行目: {s.reason}</li>)}</ul>}
          <button className="btn ghost small" onClick={() => setImported(null)}>閉じる</button>
        </div>
      )}
      {adding && <NewEmployee onSaved={(id) => { setAdding(false); onOpen(id); }} />}
      {data.tasks.length > 0 && (
        <div className="card hr-panel">
          <strong>済んでいない手続き（{data.tasks.length}）</strong>
          <TaskList tasks={data.tasks.slice(0, 12)} onChanged={load} withName />
        </div>
      )}
      <table className="table hr-table">
        <thead><tr><th>氏名</th><th>雇用形態</th><th>所属</th><th>入社日</th><th>賃金</th><th /></tr></thead>
        <tbody>
          {shown.map((e) => (
            <tr key={e.id} className={e.status === 'left' ? 'muted' : ''}>
              <td>
                <button className="link" onClick={() => onOpen(e.id)}>{e.name}</button>
                {e.code && <span className="small muted"> {e.code}</span>}
              </td>
              <td>{label(HR_EMPLOYMENTS, e.employment)}</td>
              <td>{e.department}</td>
              <td>{e.hiredOn ?? ''}</td>
              <td>{wage(e.current)}</td>
              <td className="small">
                {e.leftOn ? (e.status === 'left' ? `退職 ${e.leftOn}` : `退職予定 ${e.leftOn}`) : ''}
                {e.openTasks > 0 && <span className="badge warn">手続き {e.openTasks}</span>}
              </td>
            </tr>
          ))}
          {shown.length === 0 && <tr><td colSpan={6} className="muted">従業員はまだいません</td></tr>}
        </tbody>
      </table>
      <label className="check small"><input type="checkbox" checked={showLeft} onChange={(e) => setShowLeft(e.target.checked)} /> 退職した人も出す</label>
    </div>
  );
}

/** 雇用条件の入力欄（足すとき・変えるときに共通）。 */
function TermsFields({ t, set }: { t: Partial<HrTerms>; set: (p: Partial<HrTerms>) => void }) {
  const num = (v: string) => (v === '' ? null : Number(v));
  return (
    <div className="row wrap">
      <select value={t.wageType ?? 'monthly'} onChange={(e) => set({ wageType: e.target.value as HrTerms['wageType'] })} aria-label="賃金の定め">
        {HR_WAGE_TYPES.map((w) => <option key={w.id} value={w.id}>{w.label}</option>)}
      </select>
      <input className="num-input" type="number" min={0} placeholder="額（円）" value={t.wageAmount ?? ''} onChange={(e) => set({ wageAmount: num(e.target.value) })} aria-label="額（円）" />
      <input className="num-input" type="number" min={0} step="0.5" placeholder="週の時間" value={t.weeklyHours ?? ''} onChange={(e) => set({ weeklyHours: num(e.target.value) })} aria-label="週の所定労働時間" />
      <input className="num-input" type="number" min={0} max={7} step="0.5" placeholder="週の日数" value={t.weeklyDays ?? ''} onChange={(e) => set({ weeklyDays: num(e.target.value) })} aria-label="週の所定労働日数" />
      <input className="short" placeholder="業務" value={t.work ?? ''} onChange={(e) => set({ work: e.target.value })} aria-label="業務" />
      <input className="short" placeholder="就業場所" value={t.workplace ?? ''} onChange={(e) => set({ workplace: e.target.value })} aria-label="就業場所" />
      <label className="check"><input type="checkbox" checked={!!t.socialInsurance} onChange={(e) => set({ socialInsurance: e.target.checked })} /> 社会保険</label>
      <label className="check"><input type="checkbox" checked={!!t.employmentInsurance} onChange={(e) => set({ employmentInsurance: e.target.checked })} /> 雇用保険</label>
    </div>
  );
}

/** 従業員を足す（入社）。 */
function NewEmployee({ onSaved }: { onSaved: (id: string) => void }) {
  const [e, setE] = useState<Partial<HrEmployee>>({ employment: 'regular', category: 'employee', hiredOn: today() });
  const [t, setT] = useState<Partial<HrTerms>>({ wageType: 'monthly', socialInsurance: true, employmentInsurance: true });
  const [error, setError] = useState<string | null>(null);
  const save = () => void api.hr.create({ ...e, terms: t }).then((r) => onSaved(r.employee.id)).catch((err) => setError(describeError(err, '登録できませんでした')));
  return (
    <div className="card hr-panel">
      <div className="row wrap">
        <input className="short" placeholder="氏名" value={e.name ?? ''} onChange={(x) => setE({ ...e, name: x.target.value })} aria-label="氏名" />
        <input className="short" placeholder="ふりがな" value={e.kana ?? ''} onChange={(x) => setE({ ...e, kana: x.target.value })} aria-label="ふりがな" />
        <label className="small">入社日 <input type="date" value={e.hiredOn ?? ''} onChange={(x) => setE({ ...e, hiredOn: x.target.value })} /></label>
        <select value={e.employment} onChange={(x) => setE({ ...e, employment: x.target.value as HrEmployee['employment'], ...(x.target.value === 'officer' ? { category: 'officer' } : {}) })} aria-label="雇用形態">
          {HR_EMPLOYMENTS.map((w) => <option key={w.id} value={w.id}>{w.label}</option>)}
        </select>
        <select value={e.category} onChange={(x) => setE({ ...e, category: x.target.value as HrEmployee['category'] })} aria-label="区分">
          {HR_CATEGORIES.map((w) => <option key={w.id} value={w.id}>{w.label}</option>)}
        </select>
      </div>
      <TermsFields t={t} set={(p) => setT({ ...t, ...p })} />
      <div className="row">
        <button className="btn" disabled={!e.name?.trim()} onClick={save}>登録する</button>
      </div>
      {error && <p className="error small">{error}</p>}
    </div>
  );
}

/** 1 人の台帳（基本の項目・雇用条件の履歴・手続き・退職）。 */
function EmployeeDetail({ id, onBack }: { id: string; onBack: () => void }) {
  const [d, setD] = useState<{ employee: HrEmployee; terms: HrTerms[]; tasks: HrTask[] } | null>(null);
  const [draft, setDraft] = useState<Partial<HrEmployee>>({});
  const [newTerms, setNewTerms] = useState<Partial<HrTerms> | null>(null);
  const [leave, setLeave] = useState<{ leftOn: string; reason: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [users, setUsers] = useState<{ id: string; name: string; email: string }[]>([]);
  useEffect(() => { api.hr.users().then((r) => setUsers(r.users)).catch(() => setUsers([])); }, []);
  const load = useCallback(() => {
    api.hr.get(id).then((r) => { setD(r); setDraft(r.employee); }).catch((e) => setError(describeError(e, '読み込めませんでした')));
  }, [id]);
  useEffect(load, [load]);
  if (!d) return <p className="muted">{error ?? '読み込んでいます…'}</p>;
  const set = (p: Partial<HrEmployee>) => { setDraft({ ...draft, ...p }); setSaved(false); };
  const act = (fn: () => Promise<unknown>, fail: string, after?: () => void) => void fn().then(() => { setError(null); after?.(); load(); }).catch((e) => setError(describeError(e, fail)));
  const text = (k: keyof HrEmployee, ph: string, cls = 'short') => (
    <input className={cls} placeholder={ph} aria-label={ph} value={String(draft[k] ?? '')} onChange={(e) => set({ [k]: e.target.value } as Partial<HrEmployee>)} />
  );
  const current = d.terms[0] ?? null;
  return (
    <div className="hr">
      <div className="row"><button className="btn ghost small" onClick={onBack}>← 一覧</button></div>
      <h2>{d.employee.name}{d.employee.leftOn ? <span className="small muted">（退職 {d.employee.leftOn}）</span> : null}</h2>
      {error && <p className="error">{error}</p>}
      <div className="card hr-panel">
        <div className="row wrap">
          {text('name', '氏名')}{text('kana', 'ふりがな')}{text('code', '社員番号')}
          <label className="small">生年月日 <input type="date" value={draft.birthDate ?? ''} onChange={(e) => set({ birthDate: e.target.value || null })} /></label>
          <select value={draft.gender ?? ''} onChange={(e) => set({ gender: e.target.value as HrEmployee['gender'] })} aria-label="性別">
            <option value="">性別</option><option value="male">男</option><option value="female">女</option><option value="other">その他</option>
          </select>
        </div>
        <div className="row wrap">
          <label className="small">入社日 <input type="date" value={draft.hiredOn ?? ''} onChange={(e) => set({ hiredOn: e.target.value || null })} /></label>
          <select value={draft.employment} onChange={(e) => set({ employment: e.target.value as HrEmployee['employment'] })} aria-label="雇用形態">
            {HR_EMPLOYMENTS.map((w) => <option key={w.id} value={w.id}>{w.label}</option>)}
          </select>
          <select value={draft.category} onChange={(e) => set({ category: e.target.value as HrEmployee['category'] })} aria-label="区分">
            {HR_CATEGORIES.map((w) => <option key={w.id} value={w.id}>{w.label}</option>)}
          </select>
          {text('department', '所属')}{text('title', '役職')}
        </div>
        <div className="row wrap">{text('address', '住所', 'grow')}{text('phone', '電話')}{text('email', 'メールアドレス')}</div>
        <div className="row wrap">
          {text('note', 'メモ', 'grow')}
          <select value={draft.userId ?? ''} onChange={(e) => set({ userId: e.target.value || null })} aria-label="結び付ける利用者">
            <option value="">利用者に結び付けない</option>
            {users.map((u) => <option key={u.id} value={u.id}>{u.name}（{u.email}）</option>)}
          </select>
        </div>
        <div className="row">
          <button className="btn small" onClick={() => act(() => api.hr.update(id, {
            name: draft.name, kana: draft.kana, code: draft.code, birthDate: draft.birthDate, gender: draft.gender, hiredOn: draft.hiredOn,
            employment: draft.employment, category: draft.category, department: draft.department, title: draft.title,
            address: draft.address, phone: draft.phone, email: draft.email, note: draft.note, userId: draft.userId ?? null,
          }), '保存できませんでした', () => setSaved(true))}>保存する</button>
          {saved && <span className="small muted">保存しました</span>}
        </div>
      </div>

      <div className="card hr-panel">
        <div className="row"><strong className="grow">雇用条件</strong>
          <button className="btn ghost small" onClick={() => setNewTerms(newTerms ? null : { ...(current ?? {}), effectiveOn: today() })}>条件を変える</button>
        </div>
        {newTerms && (
          <>
            <div className="row wrap"><label className="small">適用日 <input type="date" value={newTerms.effectiveOn ?? ''} onChange={(e) => setNewTerms({ ...newTerms, effectiveOn: e.target.value })} /></label></div>
            <TermsFields t={newTerms} set={(p) => setNewTerms({ ...newTerms, ...p })} />
            <div className="row">
              <button className="btn small" onClick={() => act(() => api.hr.addTerms(id, {
                effectiveOn: newTerms.effectiveOn, wageType: newTerms.wageType, wageAmount: newTerms.wageAmount, weeklyHours: newTerms.weeklyHours,
                weeklyDays: newTerms.weeklyDays, work: newTerms.work, workplace: newTerms.workplace,
                socialInsurance: newTerms.socialInsurance, employmentInsurance: newTerms.employmentInsurance,
              }), '足せませんでした', () => setNewTerms(null))}>足す</button>
            </div>
          </>
        )}
        <table className="table">
          <thead><tr><th>適用日</th><th>賃金</th><th>週</th><th>業務・場所</th><th>保険</th></tr></thead>
          <tbody>
            {d.terms.map((t) => (
              <tr key={t.id}>
                <td>{t.effectiveOn}</td>
                <td>{wage(t)}</td>
                <td>{[t.weeklyHours !== null ? `${t.weeklyHours} 時間` : '', t.weeklyDays !== null ? `${t.weeklyDays} 日` : ''].filter(Boolean).join('・')}</td>
                <td>{[t.work, t.workplace].filter(Boolean).join('・')}</td>
                <td>{[t.socialInsurance ? '社会保険' : '', t.employmentInsurance ? '雇用保険' : ''].filter(Boolean).join('・')}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <PayrollProfile employeeId={id} />

      <div className="card hr-panel">
        <strong>手続き</strong>
        {d.tasks.length ? <TaskList tasks={d.tasks} onChanged={load} /> : <p className="muted small">手続きはありません</p>}
      </div>

      <div className="row">
        <button className="btn ghost small" onClick={() => setLeave(leave ? null : { leftOn: d.employee.leftOn ?? today(), reason: d.employee.leaveReason })}>退職を記録する</button>
      </div>
      {leave && (
        <div className="card hr-panel">
          <div className="row wrap">
            <label className="small">退職日 <input type="date" value={leave.leftOn} onChange={(e) => setLeave({ ...leave, leftOn: e.target.value })} /></label>
            <input className="grow" placeholder="退職の理由" value={leave.reason} onChange={(e) => setLeave({ ...leave, reason: e.target.value })} aria-label="退職の理由" />
            <button className="btn small" onClick={() => act(() => api.hr.leave(id, leave.leftOn, leave.reason), '記録できませんでした', () => setLeave(null))}>記録する</button>
          </div>
        </div>
      )}
    </div>
  );
}
