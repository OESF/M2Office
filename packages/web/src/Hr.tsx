/**
 * @file 人事・給与の担当者の画面（仕様書 第30.25節。段 1: 台帳・雇用条件の履歴・入退社の手続き・取り込み・労働者名簿）。
 *
 * 人事区画の人だけが開ける（API が確かめる）。一覧の上に期限の近い手続きを並べ、行を押すと 1 人の台帳を開く。
 * 説明文は常に出さない（原則 u11）。分からなければ秘書に聞く。
 */

import { Fragment, useCallback, useEffect, useRef, useState } from 'react';
import {
  HR_CATEGORIES, HR_EMPLOYMENTS, HR_WAGE_TYPES,
  type HrEmployee, type HrEmployeeView, type HrSettings, type HrTask, type HrTerms,
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
  const [tab, setTab] = useState<'ledger' | 'attendance' | 'leave'>('ledger');
  if (employeeId) return <EmployeeDetail id={employeeId} onBack={() => onOpen(null)} />;
  return (
    <>
      <div className="hr-tabs" role="tablist">
        {([['ledger', '台帳'], ['attendance', '勤怠'], ['leave', '有給']] as const).map(([k, l]) => (
          <button key={k} role="tab" aria-selected={tab === k} className={tab === k ? 'on' : ''} onClick={() => setTab(k)}>{l}</button>
        ))}
      </div>
      {tab === 'ledger' && <EmployeeList onOpen={onOpen} />}
      {tab === 'attendance' && <AttendanceTab />}
      {tab === 'leave' && <LeaveTab />}
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
