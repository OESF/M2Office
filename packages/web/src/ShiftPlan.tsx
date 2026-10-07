/**
 * @file 人事の担当者の「シフト」（仕様書 第30.6.2節）。勤務の型と日ごとに要る人数・締めの期間のシフトの案・直す・公開と、点検の指摘。
 *
 * 説明文は常に出さない（原則 u11）。分からなければ秘書に聞く。
 */

import { useCallback, useEffect, useState } from 'react';
import type { HrShiftPattern, HrShiftSettings, ShiftView } from '@m2office/shared';
import { api, describeError, type WorkSystemsView } from './api.js';

const WEEK = ['日', '月', '火', '水', '木', '金', '土', '祝'];
const wd = (d: string) => new Date(`${d}T00:00:00Z`).getUTCDay();
const hours = (m: number) => Math.round((m / 60) * 10) / 10;
const shiftMonth = (ym: string, n: number) => {
  const [y, m] = ym.split('-').map(Number) as [number, number];
  const t = y * 12 + (m - 1) + n;
  return `${Math.floor(t / 12)}-${String((t % 12) + 1).padStart(2, '0')}`;
};

/** 勤務の型と要る人数と変形労働時間制の設定。 */
function ShiftSettingsForm({ settings, onSaved }: { settings: HrShiftSettings; onSaved: () => void }) {
  const [s, setS] = useState(settings);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => setS(settings), [settings]);
  const setP = (i: number, patch: Partial<HrShiftPattern>) => setS({ ...s, patterns: s.patterns.map((p, k) => (k === i ? { ...p, ...patch } : p)) });
  const count = (day: number, patternId: string) => s.needs.find((n) => n.day === day && n.patternId === patternId)?.count ?? 0;
  const setCount = (day: number, patternId: string, v: number) => setS({ ...s, needs: [...s.needs.filter((n) => !(n.day === day && n.patternId === patternId)), { day, patternId, count: v }] });
  return (
    <details className="card hr-panel">
      <summary>勤務の型と要る人数</summary>
      {s.patterns.map((p, i) => (
        <div key={p.id} className="row wrap small">
          <input className="short" value={p.name} onChange={(e) => setP(i, { name: e.target.value })} aria-label="型の名前" />
          <input type="time" value={p.start} onChange={(e) => setP(i, { start: e.target.value })} aria-label="始業" />
          <input type="time" value={p.end} onChange={(e) => setP(i, { end: e.target.value })} aria-label="終業" />
          <label>休憩 <input className="num-input" type="number" min={0} value={p.breakMinutes} onChange={(e) => setP(i, { breakMinutes: Number(e.target.value) })} /> 分</label>
          <button className="btn ghost small" onClick={() => setS({ ...s, patterns: s.patterns.filter((_, k) => k !== i) })}>外す</button>
        </div>
      ))}
      <button className="btn ghost small" onClick={() => setS({ ...s, patterns: [...s.patterns, { id: `p${Date.now().toString(36)}`, name: '', start: '09:00', end: '18:00', breakMinutes: 60 }] })}>型を追加</button>
      {s.patterns.length > 0 && (
        <div className="pay-table">
          <table className="table hr-table small">
            <thead><tr><th />{WEEK.map((w) => <th key={w}>{w}</th>)}</tr></thead>
            <tbody>
              {s.patterns.map((p) => (
                <tr key={p.id}>
                  <td>{p.name || '（名前）'}</td>
                  {WEEK.map((w, day) => <td key={w}><input className="tiny" type="number" min={0} value={count(day, p.id) || ''} onChange={(e) => setCount(day, p.id, Number(e.target.value) || 0)} aria-label={`${p.name}の${w}の人数`} /></td>)}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <div className="row wrap small">
        <label className="check"><input type="checkbox" checked={s.variable} onChange={(e) => setS({ ...s, variable: e.target.checked })} /> 1 か月単位の変形労働時間制</label>
        {s.variable && <label className="check"><input type="checkbox" checked={s.special44} onChange={(e) => setS({ ...s, special44: e.target.checked })} /> 週 44 時間の特例</label>}
        <button className="btn small" onClick={() => void api.hr.payroll.shiftSettings(s).then(() => { setError(null); onSaved(); }).catch((e) => setError(describeError(e, '保存できませんでした')))}>保存する</button>
      </div>
      {error && <p className="error small">{error}</p>}
    </details>
  );
}

/**
 * 1 年単位の変形労働時間制・フレックスタイム制・共有の端末（仕様書 第30.6.3節）。労使協定と届出は会社が行い、ここには決まりを写すだけ。
 */
function WorkSystemsForm() {
  const [v, setV] = useState<WorkSystemsView | null>(null);
  const [code, setCode] = useState('');
  const [name, setName] = useState('');
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const load = useCallback(() => { api.hr.payroll.workSystems().then(setV).catch((e) => setMsg({ ok: false, text: describeError(e, '読み込めませんでした') })); }, []);
  useEffect(load, [load]);
  if (!v) return null;
  const save = () => void api.hr.payroll.saveWorkSystems({ annual: v.annual, flex: v.flex, terminal: v.terminal })
    .then(() => { setMsg({ ok: true, text: '保存しました' }); load(); }).catch((e) => setMsg({ ok: false, text: describeError(e, '保存できませんでした') }));
  const a = v.annual;
  const f = v.flex;
  return (
    <details className="card hr-panel">
      <summary>1 年単位の変形労働時間制・フレックスタイム制・打刻の端末</summary>
      <div className="row wrap small">
        <label className="check"><input type="checkbox" checked={a.enabled} onChange={(e) => setV({ ...v, annual: { ...a, enabled: e.target.checked } })} /> 1 年単位の変形労働時間制</label>
        {a.enabled && (
          <>
            <label>起算日 <input type="date" value={a.start} onChange={(e) => setV({ ...v, annual: { ...a, start: e.target.value } })} /></label>
            <label>対象期間 <input className="num-input" type="number" min={2} max={12} value={a.months} onChange={(e) => setV({ ...v, annual: { ...a, months: Number(e.target.value) } })} /> か月</label>
            <label>特定期間 <input className="short" placeholder="12-01〜12-31" value={a.busy.map((b) => `${b.from}〜${b.to}`).join(', ')}
              onChange={(e) => setV({ ...v, annual: { ...a, busy: e.target.value.split(/[,、]/).map((x) => x.trim()).filter(Boolean).map((x) => { const [from = '', to = ''] = x.split(/[〜~-]{1}(?=\d{2}-\d{2}$)/); return { from, to }; }) } })} /></label>
          </>
        )}
      </div>
      <div className="row wrap small">
        <label className="check"><input type="checkbox" checked={f.enabled} onChange={(e) => setV({ ...v, flex: { ...f, enabled: e.target.checked } })} /> フレックスタイム制</label>
        {f.enabled && (
          <>
            <label>清算期間 <select value={f.months} onChange={(e) => setV({ ...v, flex: { ...f, months: Number(e.target.value) } })}>{[1, 2, 3].map((n) => <option key={n} value={n}>{n} か月</option>)}</select></label>
            {f.months > 1 && <label>起算の月 <input type="month" value={f.startMonth} onChange={(e) => setV({ ...v, flex: { ...f, startMonth: e.target.value } })} /></label>}
            <label className="check"><input type="checkbox" checked={!!f.core} onChange={(e) => setV({ ...v, flex: { ...f, core: e.target.checked ? { start: '10:00', end: '15:00' } : null } })} /> コアタイム</label>
            {f.core && (
              <>
                <input type="time" value={f.core.start} onChange={(e) => setV({ ...v, flex: { ...f, core: { ...f.core!, start: e.target.value } } })} aria-label="コアタイムの始め" />
                <input type="time" value={f.core.end} onChange={(e) => setV({ ...v, flex: { ...f, core: { ...f.core!, end: e.target.value } } })} aria-label="コアタイムの終わり" />
              </>
            )}
            <label>足りない時間 <select value={f.shortfall} onChange={(e) => setV({ ...v, flex: { ...f, shortfall: e.target.value as 'carry' | 'deduct' } })}>
              <option value="carry">次の清算期間に繰り越す</option><option value="deduct">給与から差し引く</option>
            </select></label>
          </>
        )}
      </div>
      <div className="row wrap small">
        <label className="check"><input type="checkbox" checked={v.terminal.pinAllowed} onChange={(e) => setV({ ...v, terminal: { pinAllowed: e.target.checked } })} /> 打刻の端末で、名前と番号でも打てる</label>
        <button className="btn small" onClick={save}>保存する</button>
      </div>
      <ul className="small">
        {v.terminals.map((t) => (
          <li key={t.id}>{t.name} <span className="muted">{t.lastSeenAt ? `最後に見えた ${new Date(t.lastSeenAt).toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' })}` : ''}</span>
            {' '}<button className="link small" onClick={() => void api.hr.payroll.removeTerminal(t.id).then(load).catch((e) => setMsg({ ok: false, text: describeError(e) }))}>外す</button></li>
        ))}
      </ul>
      <div className="row wrap small">
        <input className="short" inputMode="numeric" placeholder="端末の番号" value={code} onChange={(e) => setCode(e.target.value)} aria-label="端末に出ている番号" />
        <input className="short" placeholder="名前（受付など）" value={name} onChange={(e) => setName(e.target.value)} aria-label="端末の名前" />
        <button className="btn ghost small" disabled={!code.trim()} onClick={() => void api.hr.payroll.claimTerminal(code, name)
          .then(() => { setCode(''); setName(''); setMsg({ ok: true, text: '端末を登録しました' }); load(); }).catch((e) => setMsg({ ok: false, text: describeError(e, '登録できませんでした') }))}>端末を登録</button>
      </div>
      {msg && <p className={msg.ok ? 'ok-msg small' : 'error small'}>{msg.text}</p>}
    </details>
  );
}

/**
 * シフトの担当者の画面。
 */
export function ShiftTab() {
  const [month, setMonth] = useState<string | undefined>(undefined);
  const [data, setData] = useState<ShiftView | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(() => { api.hr.payroll.shifts(month).then(setData).catch((e) => setError(describeError(e, '読み込めませんでした'))); }, [month]);
  useEffect(load, [load]);
  if (!data) return <p className="muted">{error ?? '読み込んでいます…'}</p>;
  const ym = data.period.end.slice(0, 7);
  const act = (f: () => Promise<ShiftView>, fail: string) => {
    setBusy(true); setError(null);
    void f().then(setData).catch((e) => setError(describeError(e, fail))).finally(() => setBusy(false));
  };
  const days: string[] = [];
  for (let d = data.period.start; d <= data.period.end; d = new Date(Date.parse(`${d}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10)) days.push(d);
  const cell = (employeeId: string, d: string) => data.shifts.find((s) => s.employeeId === employeeId && s.date === d && s.patternId);
  const wished = new Set(data.requests.map((r) => `${r.employeeId}|${r.date}`));
  const pattern = new Map(data.settings.patterns.map((p) => [p.id, p]));
  const published = data.plan.status === 'published';
  return (
    <div className="hr">
      <div className="row wrap hr-toolbar">
        <button className="btn ghost small" onClick={() => setMonth(shiftMonth(ym, -1))}>← 前</button>
        <strong>{data.period.label}</strong>
        <button className="btn ghost small" onClick={() => setMonth(shiftMonth(ym, 1))}>次 →</button>
        <span className="small muted">{data.period.start} 〜 {data.period.end}</span>
        <span className="grow" />
        {published ? <span className="small muted">公開 {data.plan.publishedAt?.slice(5, 10).replace('-', '/')}</span> : (
          <>
            <button className="btn ghost small" disabled={busy} onClick={() => act(() => api.hr.payroll.shiftGenerate(ym), '案を作れませんでした')}>{data.plan.status === 'none' ? '案を作る' : '案を作り直す'}</button>
            {data.plan.status === 'draft' && <button className="btn small" disabled={busy} onClick={() => act(() => api.hr.payroll.shiftPublish(ym), '公開できませんでした')}>公開する</button>}
          </>
        )}
      </div>
      <ShiftSettingsForm settings={data.settings} onSaved={load} />
      <WorkSystemsForm />
      {error && <p className="error">{error}</p>}
      {data.issues.length > 0 && (
        <ul className="small shift-issues">
          {data.issues.map((x, i) => <li key={i} className={x.level === 'stop' ? 'error' : ''}>{x.text}</li>)}
        </ul>
      )}
      {data.members.length === 0 ? <p className="muted small">シフトの人はいません</p> : (
        <div className="pay-table">
          <table className="table hr-table shift-grid">
            <thead>
              <tr>
                <th>氏名</th>
                {days.map((d) => <th key={d} className={wd(d) === 0 ? 'sun' : wd(d) === 6 ? 'sat' : ''}>{Number(d.slice(8))}<br />{WEEK[wd(d)]}</th>)}
                <th>所定</th>
              </tr>
            </thead>
            <tbody>
              {data.members.map((m) => (
                <tr key={m.employeeId}>
                  <td className="nowrap">{m.name}</td>
                  {days.map((d) => {
                    const s = cell(m.employeeId, d);
                    return (
                      <td key={d} className={wished.has(`${m.employeeId}|${d}`) ? 'wish' : ''} title={wished.has(`${m.employeeId}|${d}`) ? '休みの希望' : ''}>
                        <select value={s?.patternId ?? ''} disabled={busy} onChange={(e) => act(() => api.hr.payroll.shiftCell(ym, m.employeeId, d, e.target.value || null), '直せませんでした')} aria-label={`${m.name} ${d}`}>
                          <option value="">休</option>
                          {data.settings.patterns.map((p) => <option key={p.id} value={p.id}>{p.name.slice(0, 2)}</option>)}
                        </select>
                      </td>
                    );
                  })}
                  <td className="nowrap small">{hours(m.scheduledMinutes)}{m.capMinutes !== null && ` / ${Math.floor(hours(m.capMinutes) * 10) / 10}`} 時間</td>
                </tr>
              ))}
              {data.settings.patterns.map((p) => (
                <tr key={p.id} className="small muted">
                  <td className="nowrap">{p.name}</td>
                  {days.map((d) => {
                    const have = data.shifts.filter((s) => s.date === d && s.patternId === p.id).length;
                    return <td key={d} className="num">{have || ''}</td>;
                  })}
                  <td />
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {pattern.size > 0 && <p className="small muted">{[...pattern.values()].map((p) => `${p.name} ${p.start}〜${p.end}`).join('・')}</p>}
    </div>
  );
}

