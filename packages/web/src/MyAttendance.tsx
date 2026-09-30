/**
 * @file 本人の「給与・勤怠」の画面（仕様書 第30.25節）。打刻・シフトと休みの希望・期間の勤怠と直し・有給の残りと申請・給与明細（同意して受け取る）・年末調整の申告。
 *
 * 本人の分だけを扱う（API が確かめる）。スマホでも押しやすいよう、打刻のボタンを大きく上に置く。
 * 説明文は常に出さない（原則 u11）。分からなければ秘書に聞く（「有給あと何日？」「出勤」も秘書に言える）。
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import type { AttDay, AttPunchKind, YeaDeclaration } from '@m2office/shared';
import { YeaFields, INSURANCE } from './YearEndForm.js';
import { api, describeError, type MyHrView, type MySlipSummary, type YeaSelfView } from './api.js';

const WEEK = '日月火水木金土';
const hm = (m: number) => (m ? `${Math.floor(m / 60)}:${String(m % 60).padStart(2, '0')}` : '');
/** 日本時間の時刻（HH:MM）。 */
const time = (iso: string | null) => (iso ? new Date(new Date(iso).getTime() + 9 * 3_600_000).toISOString().slice(11, 16) : '');
const md = (d: string) => `${Number(d.slice(5, 7))}/${Number(d.slice(8, 10))}（${WEEK[new Date(`${d}T00:00:00Z`).getUTCDay()]}）`;
/** 締め日の月を 1 つずらす。 */
const shiftMonth = (ym: string, n: number) => {
  const [y, m] = ym.split('-').map(Number) as [number, number];
  const t = y * 12 + (m - 1) + n;
  return `${Math.floor(t / 12)}-${String((t % 12) + 1).padStart(2, '0')}`;
};

/** 本人の「給与・勤怠」の画面。 */
export function MyAttendance() {
  const [month, setMonth] = useState<string | undefined>(undefined);
  const [v, setV] = useState<MyHrView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [fixing, setFixing] = useState<{ date: string; in: string; out: string; bs: string; be: string } | null>(null);
  const [leaveDate, setLeaveDate] = useState('');
  const [leaveDays, setLeaveDays] = useState(1);
  const load = useCallback(() => {
    api.myHr.get(month).then((r) => { setV(r); setError(null); }).catch((e) => setError(describeError(e, '読み込めませんでした')));
  }, [month]);
  useEffect(load, [load]);
  if (!v) return <p className="muted">{error ?? '読み込んでいます…'}</p>;
  const act = (fn: () => Promise<unknown>, fail: string, after?: () => void) =>
    void fn().then(() => { after?.(); load(); }).catch((e) => setError(describeError(e, fail)));
  const punch = (k: AttPunchKind) => act(() => api.myHr.punch(k, window.matchMedia('(max-width: 680px)').matches ? 'mobile' : 'screen'), '打刻できませんでした');
  const ym = v.period.end.slice(0, 7);
  const t = v.totals;
  const openFix = (d: AttDay) => setFixing({ date: d.date, in: time(d.in) || '09:00', out: time(d.out) || '18:00', bs: '', be: '' });
  return (
    <div className="myhr">
      <div className="card myhr-punch">
        <div className="myhr-state">
          {v.state.state === 'working' ? `出勤中（${time(v.state.since)} から）` : v.state.state === 'break' ? `休憩中（${time(v.state.since)} から）` : '退勤しています'}
        </div>
        <div className="row wrap">
          {v.state.state === 'off' && <button className="btn big" onClick={() => punch('in')}>出勤</button>}
          {v.state.state === 'working' && <button className="btn ghost big" onClick={() => punch('break_start')}>休憩</button>}
          {v.state.state === 'working' && <button className="btn big" onClick={() => punch('out')}>退勤</button>}
          {v.state.state === 'break' && <button className="btn big" onClick={() => punch('break_end')}>休憩終わり</button>}
        </div>
      </div>
      {error && <p className="error">{error}</p>}

      <MyShifts />
      <MyPayslips />
      <MyYearEnd />

      <div className="card myhr-leave">
        <div className="row wrap">
          <strong className="grow">有給の残り {v.leave.remaining} 日</strong>
          {v.leave.obligation && v.leave.obligation.taken < v.leave.obligation.required && (
            <span className="badge warn">{v.leave.obligation.deadline} までにあと {v.leave.obligation.required - v.leave.obligation.taken} 日</span>
          )}
        </div>
        <div className="row wrap">
          <input type="date" value={leaveDate} onChange={(e) => setLeaveDate(e.target.value)} aria-label="休む日" />
          {v.halfDay && (
            <select value={leaveDays} onChange={(e) => setLeaveDays(Number(e.target.value))} aria-label="日数">
              <option value={1}>1 日</option><option value={0.5}>半日</option>
            </select>
          )}
          <button className="btn small" disabled={!leaveDate} onClick={() => act(() => api.myHr.leave(leaveDate, leaveDays), '有給を入れられませんでした', () => setLeaveDate(''))}>有給を取る</button>
        </div>
        {v.leave.takes.filter((x) => x.date >= v.today).length > 0 && (
          <ul className="plain small">
            {v.leave.takes.filter((x) => x.date >= v.today).map((x) => (
              <li key={x.id} className="row">
                <span className="grow">{md(x.date)} {x.days === 0.5 ? '半日' : '1 日'}</span>
                <button className="btn ghost small" onClick={() => act(() => api.myHr.cancelLeave(x.id), '取り消せませんでした')}>取り消し</button>
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className="row wrap myhr-nav">
        <button className="btn ghost small" onClick={() => setMonth(shiftMonth(ym, -1))}>← 前</button>
        <strong>{v.period.label}（{md(v.period.start)}〜{md(v.period.end)}）{v.closed ? ' 締め済み' : ''}</strong>
        <button className="btn ghost small" onClick={() => setMonth(shiftMonth(ym, 1))}>次 →</button>
      </div>
      <div className="myhr-totals small">
        <span>労働 {hm(t.workMinutes) || '0:00'}</span><span>法定外 {hm(t.overtimeMinutes) || '0:00'}</span>
        <span>深夜 {hm(t.nightMinutes) || '0:00'}</span><span>休日 {hm(t.holidayMinutes) || '0:00'}</span>
        <span>出勤 {t.workDays} 日</span><span>有給 {t.leaveDays} 日</span>
      </div>
      <table className="table myhr-days">
        <thead><tr><th>日付</th><th>出勤</th><th>退勤</th><th>休憩</th><th>労働</th><th>法定外</th><th /></tr></thead>
        <tbody>
          {v.days.filter((d) => d.date <= v.today).reverse().map((d) => (
            fixing?.date === d.date ? (
              <tr key={d.date}>
                <td>{md(d.date)}</td>
                <td><input type="time" value={fixing.in} onChange={(e) => setFixing({ ...fixing, in: e.target.value })} aria-label="出勤" /></td>
                <td><input type="time" value={fixing.out} onChange={(e) => setFixing({ ...fixing, out: e.target.value })} aria-label="退勤" /></td>
                <td colSpan={2}>
                  <input type="time" value={fixing.bs} onChange={(e) => setFixing({ ...fixing, bs: e.target.value })} aria-label="休憩の始め" />〜
                  <input type="time" value={fixing.be} onChange={(e) => setFixing({ ...fixing, be: e.target.value })} aria-label="休憩の終わり" />
                </td>
                <td colSpan={2}>
                  <button className="btn small" onClick={() => act(() => api.myHr.fixDay(d.date, {
                    in: fixing.in, out: fixing.out || null, breaks: fixing.bs && fixing.be ? [{ start: fixing.bs, end: fixing.be }] : [],
                  }), '直せませんでした', () => setFixing(null))}>保存</button>
                  <button className="btn ghost small" onClick={() => setFixing(null)}>やめる</button>
                </td>
              </tr>
            ) : (
              <tr key={d.date} className={`${d.type !== 'workday' ? 'muted' : ''} ${d.issues.length ? 'warn' : ''}`}>
                <td>{md(d.date)}{d.leaveDays ? <span className="small"> 有給{d.leaveDays === 0.5 ? '（半日）' : ''}</span> : null}</td>
                <td>{time(d.in)}</td><td>{time(d.out)}</td><td>{hm(d.breakMinutes)}</td><td>{hm(d.workMinutes)}</td><td>{hm(d.overtimeMinutes)}</td>
                <td className="small">
                  {d.issues.join('・')}
                  {!v.closed && <button className="btn ghost small" onClick={() => openFix(d)}>直す</button>}
                </td>
              </tr>
            )
          ))}
        </tbody>
      </table>
    </div>
  );
}

/**
 * 本人の給与明細（仕様書 第30.10.3節）。画面で受け取るには本人の同意が要る（所得税法）。同意はいつでも取り消せる。
 */
function MyPayslips() {
  const [data, setData] = useState<{ consentAt: string | null; slips: MySlipSummary[] } | null>(null);
  const [open, setOpen] = useState<Awaited<ReturnType<typeof api.myHr.payslip>> | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(() => {
    api.myHr.payslips().then(setData).catch((e) => setError(describeError(e, '読み込めませんでした')));
  }, []);
  useEffect(load, [load]);
  if (!data) return error ? <p className="error">{error}</p> : null;
  const consent = (v: boolean) => void api.myHr.consent(v).then(() => { setOpen(null); load(); }).catch((e) => setError(describeError(e, '変えられませんでした')));
  const label = (ym: string, kind = 'monthly') => `${Number(ym.slice(0, 4))} 年 ${Number(ym.slice(5, 7))} 月支給${kind === 'bonus' ? 'の賞与' : kind === 'correction' ? 'の訂正' : ''}`;
  const yen = (n: number) => `${n.toLocaleString('ja-JP')} 円`;
  if (!data.consentAt) {
    return (
      <div className="card row wrap">
        <strong className="grow">給与明細を画面で受け取りますか</strong>
        <button className="btn small" onClick={() => consent(true)}>同意して受け取る</button>
      </div>
    );
  }
  return (
    <div className="card myhr-slips">
      <div className="row wrap">
        <strong className="grow">給与明細</strong>
        <button className="btn ghost small" onClick={() => consent(false)}>画面での受け取りをやめる</button>
      </div>
      {error && <p className="error">{error}</p>}
      {data.slips.length === 0 && <p className="muted small">まだありません</p>}
      <ul className="plain small">
        {data.slips.map((x) => (
          <li key={x.id}>
            <button className="link grow" onClick={() => (open?.slip.id === x.id ? setOpen(null) : void api.myHr.payslip(x.id).then(setOpen).catch((e) => setError(describeError(e, '読み込めませんでした'))))}>{label(x.payMonth, x.kind)}</button>
            <span>差引支給 <strong>{yen(x.net)}</strong></span>
          </li>
        ))}
      </ul>
      {open && (
        <div className="pay-slip">
          {open.diff && open.previousNet !== null && <p className="small">前の回より {open.slip.net - open.previousNet >= 0 ? '+' : '−'}{Math.abs(open.slip.net - open.previousNet).toLocaleString('ja-JP')} 円（{open.diff}）</p>}
          <table className="table small">
            <tbody>
              {open.slip.lines.map((l) => (
                <tr key={l.code}><td>{l.kind === 'deduct' ? '控除' : '支給'}</td><td>{l.label}</td><td className="num">{l.amount.toLocaleString('ja-JP')}</td></tr>
              ))}
              <tr><td /><td><strong>総支給</strong></td><td className="num">{open.slip.gross.toLocaleString('ja-JP')}</td></tr>
              <tr><td /><td><strong>控除の計</strong></td><td className="num">{open.slip.deductions.toLocaleString('ja-JP')}</td></tr>
              <tr><td /><td><strong>差引支給</strong></td><td className="num"><strong>{open.slip.net.toLocaleString('ja-JP')}</strong></td></tr>
            </tbody>
          </table>
          <button className="btn ghost small" onClick={() => void api.myHr.payslipPdf(open.slip.id, open.slip.run.payMonth).catch((e) => setError(describeError(e, 'PDF を出せませんでした')))}>PDF</button>
        </div>
      )}
    </div>
  );
}

/**
 * 本人の年末調整の申告（仕様書 第30.15.1節）。10 月から翌年 1 月まで出す。控除証明書は写真か PDF を渡すと AI が読む。
 */
/** 自分のシフト（公開した期間）と、次の期間の休みの希望。シフトの人でなければ出さない。 */
function MyShifts() {
  const [v, setV] = useState<Awaited<ReturnType<typeof api.myHr.shifts>> | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(() => { api.myHr.shifts().then(setV).catch(() => setV(null)); }, []);
  useEffect(load, [load]);
  if (!v || v.periods.length === 0) return null;
  const name = new Map(v.patterns.map((p) => [p.id, p]));
  const days = (p: { start: string; end: string }) => {
    const out: string[] = [];
    for (let d = p.start; d <= p.end; d = new Date(Date.parse(`${d}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10)) out.push(d);
    return out;
  };
  const toggle = (date: string, on: boolean) => void api.myHr.shiftRequest(date, on).then(() => { setError(null); load(); }).catch((e) => setError(describeError(e, '休みの希望を出せませんでした')));
  return (
    <div className="card myhr-shifts">
      {v.periods.filter((p) => p.published || p.canRequest).map((p) => (
        <div key={p.period.start}>
          <strong>シフト {p.period.label}</strong>
          <div className="myhr-shift-days">
            {days(p.period).map((d) => {
              const s = p.shifts.find((x) => x.date === d && x.patternId);
              const wish = p.requests.includes(d);
              return p.published ? (
                <span key={d} className={s ? 'on' : 'off'}>{md(d)} {s ? `${name.get(s.patternId!)?.name ?? ''} ${s.start}〜${s.end}` : '休み'}</span>
              ) : (
                <label key={d} className={`check ${wish ? 'wish' : ''}`}><input type="checkbox" checked={wish} onChange={(e) => toggle(d, e.target.checked)} aria-label={`${md(d)} 休みの希望`} />{md(d)}</label>
              );
            })}
          </div>
        </div>
      ))}
      {error && <p className="error small">{error}</p>}
    </div>
  );
}

function MyYearEnd() {
  const now = new Date(Date.now() + 9 * 3_600_000);
  const m = now.getUTCMonth() + 1;
  const year = m >= 10 ? now.getUTCFullYear() : m <= 1 ? now.getUTCFullYear() - 1 : null;
  const [v, setV] = useState<YeaSelfView | null>(null);
  const [d, setD] = useState<YeaDeclaration | null>(null);
  const [open, setOpen] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const cert = useRef<HTMLInputElement>(null);
  const load = useCallback(() => {
    if (year === null) return;
    api.myHr.yea(year).then((r) => { setV(r); setD(r.declaration.data); }).catch(() => setV(null));
  }, [year]);
  useEffect(load, [load]);
  if (year === null || !v || !d) return null;
  const set = (p: Partial<YeaDeclaration>) => setD({ ...d, ...p });
  const save = (submit: boolean) => void api.myHr.saveYea(year, d, submit).then(() => { setMsg(submit ? '出しました。担当者が確かめます' : '保存しました'); load(); }).catch((e) => setError(describeError(e, '保存できませんでした')));
  const read = (f: File) => void api.myHr.readCertificate(f).then((r) => {
    if (r.status === 'insurance') {
      const ins = { ...d.insurance };
      for (const it of r.items) ins[it.kind] += it.amount;
      set({ insurance: ins });
      setMsg(`${r.items.map((it) => `${INSURANCE.find(([k]) => k === it.kind)?.[1]} ${it.amount.toLocaleString('ja-JP')} 円`).join('・')} を足しました。額を確かめてください`);
    } else if (r.status === 'previous-job') {
      set({ previousJob: { pay: r.pay, social: r.social, tax: r.tax } });
      setMsg('前の勤め先の額を入れました。源泉徴収票と見比べてください');
    } else setError(r.reason);
  }).catch((e) => setError(describeError(e, '読めませんでした')));
  const state = v.declaration.checkedAt ? '担当者が確かめました' : v.declaration.submittedAt ? '出しました（担当者の確かめ待ち）' : 'まだ出していません';
  return (
    <div className="card myhr-yea">
      <div className="row wrap">
        <strong className="grow">{year} 年の年末調整</strong>
        <span className="small muted">{v.target ? state : v.reason}</span>
        {v.result && <button className="btn ghost small" onClick={() => void api.myHr.withholdingPdf(year).catch((e) => setError(describeError(e, '出せませんでした')))}>源泉徴収票</button>}
        {v.target && <button className="btn ghost small" onClick={() => setOpen(!open)}>{open ? '閉じる' : v.canEdit ? '申告する' : '申告を見る'}</button>}
      </div>
      {v.result && <p className="small">年末調整で{v.result.difference >= 0 ? ` ${v.result.difference.toLocaleString('ja-JP')} 円が戻ります` : ` ${(-v.result.difference).toLocaleString('ja-JP')} 円が不足し、1 月の給与で差し引きます`}（年税額 {v.result.annualTax.toLocaleString('ja-JP')} 円）。</p>}
      {error && <p className="error">{error}</p>}
      {msg && <p className="ok-msg small">{msg}</p>}
      {open && v.target && (
        <fieldset disabled={!v.canEdit} className="yea-form">
          {v.problems.length > 0 && <ul className="error small">{v.problems.map((p) => <li key={p}>{p}</li>)}</ul>}
          <YeaFields d={d} set={set} onCertificate={() => cert.current?.click()} />
          <input ref={cert} type="file" accept="image/*,application/pdf" capture="environment" hidden onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ''; if (f) read(f); }} />
          {v.canEdit && (
            <div className="row">
              <button className="btn ghost small" onClick={() => save(false)}>保存する</button>
              <button className="btn small" onClick={() => save(true)}>出す</button>
            </div>
          )}
        </fieldset>
      )}
    </div>
  );
}
