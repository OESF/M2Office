/**
 * @file 年末調整の申告の入力欄（仕様書 第30.15.1節）。本人の「給与・勤怠」の画面と、人事の担当者の「年末調整」で同じものを使う。
 *
 * 本人・配偶者・扶養する親族・保険料・住宅借入金等特別控除・前の勤め先。説明文は常に出さない（原則 u11）。
 */

import type { YeaDeclaration, YeaPerson } from '@m2office/shared';

export const INSURANCE: [keyof YeaDeclaration['insurance'], string][] = [
  ['lifeNewGeneral', '一般の生命保険（新）'], ['lifeOldGeneral', '一般の生命保険（旧）'], ['lifeNewCare', '介護医療保険'],
  ['lifeNewPension', '個人年金保険（新）'], ['lifeOldPension', '個人年金保険（旧）'], ['earthquake', '地震保険'], ['oldLongTerm', '旧長期損害保険'],
  ['social', '国民年金などの社会保険料'], ['smallBusiness', '小規模企業共済・iDeCo'],
];
const DISABILITY: [YeaPerson['disability'], string][] = [['none', '障害なし'], ['general', '障害者'], ['special', '特別障害者'], ['special-cohabiting', '同居の特別障害者']];


const num = (x: string) => Math.max(0, Math.round(Number(x) || 0));
const blank = (): YeaPerson => ({ name: '', relation: '', birthDate: null, incomeEstimate: 0, disability: 'none', cohabiting: true });

/** 配偶者・親族 1 人の欄。 */
function PersonFields({ p, change, remove }: { p: YeaPerson; change: (x: YeaPerson) => void; remove?: () => void }) {
  return (
    <div className="row wrap small">
      <input className="short" placeholder="氏名" value={p.name} onChange={(e) => change({ ...p, name: e.target.value })} aria-label="氏名" />
      <input className="short" placeholder="続柄" value={p.relation} onChange={(e) => change({ ...p, relation: e.target.value })} aria-label="続柄" />
      <label>生年月日 <input type="date" value={p.birthDate ?? ''} onChange={(e) => change({ ...p, birthDate: e.target.value || null })} /></label>
      <label>所得の見積もり <input className="num-input" type="number" min={0} value={p.incomeEstimate || ''} placeholder="0" onChange={(e) => change({ ...p, incomeEstimate: num(e.target.value) })} /> 円</label>
      <select value={p.disability} onChange={(e) => change({ ...p, disability: e.target.value as YeaPerson['disability'] })} aria-label="障害">
        {DISABILITY.map(([k, l]) => <option key={k} value={k}>{l}</option>)}
      </select>
      <label className="check"><input type="checkbox" checked={p.cohabiting} onChange={(e) => change({ ...p, cohabiting: e.target.checked })} /> 同居</label>
      {remove && <button className="btn ghost small" onClick={remove}>外す</button>}
    </div>
  );
}

/**
 * 年末調整の申告の入力欄。
 *
 * @param onCertificate 控除証明書を撮る（無ければボタンを出さない）
 */
export function YeaFields({ d, set, onCertificate }: { d: YeaDeclaration; set: (p: Partial<YeaDeclaration>) => void; onCertificate?: () => void }) {
  return (
    <>
      <h4>本人</h4>
      <div className="row wrap small">
        <label>給与以外の所得の見積もり <input className="num-input" type="number" min={0} value={d.self.otherIncome || ''} placeholder="0" onChange={(e) => set({ self: { ...d.self, otherIncome: num(e.target.value) } })} /> 円</label>
        <select value={d.self.disability} onChange={(e) => set({ self: { ...d.self, disability: e.target.value as YeaDeclaration['self']['disability'] } })} aria-label="障害">
          <option value="none">障害なし</option><option value="general">障害者</option><option value="special">特別障害者</option>
        </select>
        <select value={d.self.widow} onChange={(e) => set({ self: { ...d.self, widow: e.target.value as YeaDeclaration['self']['widow'] } })} aria-label="寡婦・ひとり親">
          <option value="none">寡婦・ひとり親に当たらない</option><option value="widow">寡婦</option><option value="single-parent">ひとり親</option>
        </select>
        <label className="check"><input type="checkbox" checked={d.self.workingStudent} onChange={(e) => set({ self: { ...d.self, workingStudent: e.target.checked } })} /> 勤労学生</label>
      </div>
      <h4>配偶者 <label className="check small"><input type="checkbox" checked={!!d.spouse} onChange={(e) => set({ spouse: e.target.checked ? { ...blank(), relation: '配偶者' } : null })} /> いる</label></h4>
      {d.spouse && <PersonFields p={d.spouse} change={(x) => set({ spouse: x })} />}
      <h4>扶養する親族</h4>
      {d.dependents.map((p, i) => <PersonFields key={i} p={p} change={(x) => set({ dependents: d.dependents.map((y, j) => (j === i ? x : y)) })} remove={() => set({ dependents: d.dependents.filter((_, j) => j !== i) })} />)}
      <button className="btn ghost small" onClick={() => set({ dependents: [...d.dependents, blank()] })}>親族を追加</button>
      <h4>保険料 {onCertificate && <button className="btn ghost small" onClick={onCertificate}>控除証明書を撮って入れる</button>}</h4>
      <div className="yea-grid small">
        {INSURANCE.map(([k, l]) => (
          <label key={k}>{l} <input className="num-input" type="number" min={0} value={d.insurance[k] || ''} placeholder="0" onChange={(e) => set({ insurance: { ...d.insurance, [k]: num(e.target.value) } })} /> 円</label>
        ))}
      </div>
      <h4>住宅ローン・前の勤め先</h4>
      <div className="row wrap small">
        <label>住宅借入金等特別控除の額 <input className="num-input" type="number" min={0} value={d.housingCredit || ''} placeholder="0" onChange={(e) => set({ housingCredit: num(e.target.value) })} /> 円</label>
        <label className="check"><input type="checkbox" checked={!!d.previousJob} onChange={(e) => set({ previousJob: e.target.checked ? { pay: 0, social: 0, tax: 0 } : null })} /> 今年、前の勤め先から給与をもらった</label>
      </div>
      {d.previousJob && (
        <div className="row wrap small">
          {(['pay', 'social', 'tax'] as const).map((k) => (
            <label key={k}>{{ pay: '支払金額', social: '社会保険料等', tax: '源泉徴収税額' }[k]} <input className="num-input" type="number" min={0} value={d.previousJob![k] || ''} placeholder="0" onChange={(e) => set({ previousJob: { ...d.previousJob!, [k]: num(e.target.value) } })} /> 円</label>
          ))}
        </div>
      )}
    </>
  );
}
