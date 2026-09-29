/**
 * @file 人事・給与の担当者の画面（仕様書 第30.25節。段 1: 台帳・雇用条件の履歴・入退社の手続き・取り込み・労働者名簿）。
 *
 * 人事区画の人だけが開ける（API が確かめる）。一覧の上に期限の近い手続きを並べ、行を押すと 1 人の台帳を開く。
 * 説明文は常に出さない（原則 u11）。分からなければ秘書に聞く。
 */

import { useCallback, useEffect, useRef, useState } from 'react';
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
  return employeeId ? <EmployeeDetail id={employeeId} onBack={() => onOpen(null)} /> : <EmployeeList onOpen={onOpen} />;
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
        <div className="row wrap">{text('note', 'メモ', 'grow')}</div>
        <div className="row">
          <button className="btn small" onClick={() => act(() => api.hr.update(id, {
            name: draft.name, kana: draft.kana, code: draft.code, birthDate: draft.birthDate, gender: draft.gender, hiredOn: draft.hiredOn,
            employment: draft.employment, category: draft.category, department: draft.department, title: draft.title,
            address: draft.address, phone: draft.phone, email: draft.email, note: draft.note,
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
