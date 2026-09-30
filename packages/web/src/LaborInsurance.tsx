/**
 * @file 人事の担当者の「年度更新」（仕様書 第30.13.1節）。前年度の月ごとの賃金の集計・足りない月の合計・申告済の概算保険料と、
 * 確定保険料・概算保険料・延納の期別の額・申告書の下書き。説明文は常に出さない（原則 u11）。
 */

import { useCallback, useEffect, useState } from 'react';
import type { LaborInsuranceView, LaborLine, LaborSupplement } from '@m2office/shared';
import { api, describeError } from './api.js';

const yen = (n: number | null | undefined) => (n === null || n === undefined ? '' : n.toLocaleString('ja-JP'));
const monthName = (key: string) => (key.length === 7 ? `${Number(key.slice(0, 4))}/${Number(key.slice(5, 7))}` : `賞与 ${Number(key.slice(5, 7))}/${Number(key.slice(8, 10))}`);
const num = (v: string) => (v === '' ? 0 : Math.max(0, Math.round(Number(v) || 0)));
const EMPTY: LaborSupplement = { workers: 0, wages: 0, insured: 0, insuredWages: 0 };
const LABEL: Record<keyof LaborSupplement, string> = { workers: '労災保険の人数', wages: '労災保険の賃金', insured: '雇用保険の人数', insuredWages: '雇用保険の賃金' };

/** 保険料の 1 行（算定基礎額 × 率 = 額）。 */
function Line({ label, l }: { label: string; l: LaborLine }) {
  return <tr><td>{label}</td><td className="num">{yen(l.base / 1000)} 千円</td><td className="num">{l.rate}/1000</td><td className="num">{yen(l.amount)}</td></tr>;
}

/**
 * 年度更新の担当者の画面。
 */
export function LaborTab() {
  const [year, setYear] = useState(new Date(Date.now() + 9 * 3_600_000).getUTCFullYear());
  const [data, setData] = useState<LaborInsuranceView | null>(null);
  const [edit, setEdit] = useState<Record<string, LaborSupplement>>({});
  const [declared, setDeclared] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const apply = (v: LaborInsuranceView) => { setData(v); setEdit(v.data.supplements); setDeclared(v.data.declaredEstimate === null ? '' : String(v.data.declaredEstimate)); };
  const load = useCallback(() => { api.hr.payroll.labor(year).then(apply).catch((e) => setError(describeError(e, '読み込めませんでした'))); }, [year]);
  useEffect(load, [load]);
  if (!data) return <p className="muted">{error ?? '読み込んでいます…'}</p>;
  const act = (f: () => Promise<unknown>, fail: string, ok?: string) => {
    setBusy(true); setError(null); setNote(null);
    void f().then(() => ok && setNote(ok)).catch((e) => setError(describeError(e, fail))).finally(() => setBusy(false));
  };
  const save = () => act(async () => apply(await api.hr.payroll.laborSave(year, { supplements: edit, declaredEstimate: declared === '' ? null : num(declared) })), '保存できませんでした', '保存しました');
  const r = data.result;
  const manualKeys = data.months.filter((m) => m.source !== 'm2office').map((m) => m.key);
  const cell = (key: string, k: keyof LaborSupplement) => (
    <input className="num-input" type="number" min={0} value={edit[key]?.[k] ?? ''} aria-label={`${monthName(key)} ${LABEL[k]}`}
      onChange={(e) => setEdit({ ...edit, [key]: { ...(edit[key] ?? EMPTY), [k]: num(e.target.value) } })} />
  );
  return (
    <div className="hr">
      <div className="row wrap hr-toolbar">
        <button className="btn ghost small" onClick={() => setYear(year - 1)}>← 前</button>
        <strong>{year} 年度の年度更新</strong>
        <button className="btn ghost small" onClick={() => setYear(year + 1)}>次 →</button>
        <span className="small muted">確定 {data.period.from} 〜 {data.period.to}</span>
        <span className="grow" />
        {r && <button className="btn small" disabled={busy} onClick={() => act(async () => { await api.hr.payroll.laborReport(year); load(); }, '下書きを作れませんでした', '年度更新の下書きを作りました')}>申告書の下書き</button>}
        {data.filedAt && <span className="small muted">下書き済み {data.filedAt.slice(5, 10).replace('-', '/')}</span>}
      </div>
      {error && <p className="error">{error}</p>}
      {note && <p className="ok-msg small">{note}</p>}
      {data.error && <p className="small"><span className="badge warn">まだ</span> {data.error}</p>}
      {data.tables.some((t) => !t.reviewed) && <p className="small muted">{data.tables.map((t) => t.version).join('・')}（監修前）</p>}

      <div className="pay-table">
        <table className="table hr-table social-table">
          <thead><tr><th>月</th><th>労災 人数</th><th>労災 賃金</th><th>雇用 人数</th><th>雇用 賃金</th><th /></tr></thead>
          <tbody>
            {data.months.map((m) => (
              <tr key={m.key} className={m.source === 'missing' ? 'hr-overdue' : ''}>
                <td>{monthName(m.key)}</td>
                {m.source === 'm2office' ? (
                  <>
                    <td className="num">{m.kind === 'bonus' ? '' : m.workers}</td><td className="num">{yen(m.wages)}</td>
                    <td className="num">{m.kind === 'bonus' ? '' : m.insured}</td><td className="num">{yen(m.insuredWages)}</td><td />
                  </>
                ) : (
                  <>
                    <td>{cell(m.key, 'workers')}</td><td>{cell(m.key, 'wages')}</td><td>{cell(m.key, 'insured')}</td><td>{cell(m.key, 'insuredWages')}</td>
                    <td className="small muted">{m.source === 'manual' ? '入れた額' : ''}</td>
                  </>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="row wrap hr-toolbar">
        <label className="small">前の年に申告した概算保険料 <input className="num-input" type="number" min={0} value={declared} onChange={(e) => setDeclared(e.target.value)} /> 円</label>
        {(manualKeys.length > 0 || String(data.data.declaredEstimate ?? '') !== declared) && <button className="btn small" disabled={busy} onClick={save}>保存する</button>}
      </div>

      {r && (
        <div className="pay-table">
          <table className="table hr-table">
            <thead><tr><th /><th>算定基礎額</th><th>率</th><th>額</th></tr></thead>
            <tbody>
              <Line label="確定 労災保険分" l={r.confirmed.workersComp} />
              <Line label="確定 雇用保険分" l={r.confirmed.employment} />
              <tr><td><strong>確定保険料</strong></td><td /><td /><td className="num"><strong>{yen(r.confirmed.total)}</strong></td></tr>
              <Line label="一般拠出金" l={r.generalContribution} />
              <Line label="概算 労災保険分" l={r.estimate.workersComp} />
              <Line label="概算 雇用保険分" l={r.estimate.employment} />
              <tr><td><strong>概算保険料</strong></td><td /><td /><td className="num"><strong>{yen(r.estimate.total)}</strong></td></tr>
              {r.declaredEstimate !== null && (
                <tr><td>{r.shortage > 0 ? '不足額' : '充当額'}（申告済 {yen(r.declaredEstimate)}）</td><td /><td /><td className="num">{yen(r.shortage > 0 ? r.shortage : r.surplus)}</td></tr>
              )}
              {r.installments.map((p, i) => (
                <tr key={p.due}><td>{r.installments.length > 1 ? `第 ${i + 1} 期` : '納付'}（{p.due}）</td><td /><td /><td className="num">{yen(p.amount)}</td></tr>
              ))}
              {r.refund > 0 && <tr><td>還付</td><td /><td /><td className="num">{yen(r.refund)}</td></tr>}
            </tbody>
          </table>
          <p className="small muted">{r.industry.code} {r.industry.name}・常時使用労働者数 {r.workers} 人・雇用保険被保険者数 {r.insured} 人</p>
        </div>
      )}
      {data.notes.length > 0 && <ul className="small muted">{data.notes.map((n) => <li key={n}>{n}</li>)}</ul>}
    </div>
  );
}
