/**
 * @file 人事の担当者の「社会保険」（仕様書 第30.12.1節）。随時改定の候補・資格の取得と喪失と 70 歳到達・定時決定・加入の判定と、各届出の下書き。
 *
 * 下書きを作ると、その額を適用の月からの標準報酬月額として入れる（2026-09-30 に決定）。説明文は常に出さない（原則 u11）。
 */

import { useCallback, useEffect, useState } from 'react';
import { HR_FILING_LABELS, type SocialDetermination, type SocialEvent } from '@m2office/shared';
import { api, describeError } from './api.js';

type Overview = Awaited<ReturnType<typeof api.hr.payroll.social>>;

const yen = (n: number | null | undefined) => (n === null || n === undefined ? '' : n.toLocaleString('ja-JP'));
const ym = (s: string) => `${Number(s.slice(0, 4))}/${Number(s.slice(5, 7))}`;
const md = (s: string) => `${Number(s.slice(5, 7))}/${Number(s.slice(8, 10))}`;

/** 定時決定の年（7 月からはその年、6 月までは前の年）。 */
const defaultYear = () => {
  const now = new Date(Date.now() + 9 * 3_600_000);
  return now.getUTCMonth() + 1 >= 7 ? now.getUTCFullYear() : now.getUTCFullYear() - 1;
};

/** 従前 → 決定の等級。 */
function Grades({ d }: { d: SocialDetermination }) {
  if (!d.after) return <span className="muted">{d.before ? `${yen(d.before.amount)}（${d.before.grade}）` : ''}</span>;
  return <span>{d.before ? `${yen(d.before.amount)}（${d.before.grade}）→ ` : ''}<strong>{yen(d.after.amount)}（{d.after.grade}）</strong></span>;
}

/** 3 か月の報酬と支払基礎日数（平均に入れない月は薄く）。 */
function Months({ d }: { d: SocialDetermination }) {
  return (
    <span className="social-months">
      {d.months.map((m) => (
        <span key={m.month} className={m.counted ? '' : 'muted'}>{Number(m.month.slice(5, 7))} 月 {m.baseDays === null && !m.pay && !m.retro ? '—' : `${yen(m.pay + m.retro)}（${m.baseDays ?? '?'} 日）`}</span>
      ))}
    </span>
  );
}

/**
 * 社会保険の担当者の画面。
 */
export function SocialTab() {
  const [year, setYear] = useState(defaultYear());
  const [data, setData] = useState<Overview | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const load = useCallback(() => { api.hr.payroll.social(year).then(setData).catch((e) => setError(describeError(e, '読み込めませんでした'))); }, [year]);
  useEffect(load, [load]);
  if (!data) return <p className="muted">{error ?? '読み込んでいます…'}</p>;
  const report = (kind: 'regular' | 'change' | 'acquire' | 'lose' | 'age70', name: string) => {
    setBusy(true); setError(null); setNote(null);
    void api.hr.payroll.socialReport(kind, name, year)
      .then((applied) => { setNote(applied > 0 ? `${name}の下書きを作り、${applied} 人の標準報酬月額を入れました` : `${name}の下書きを作りました`); load(); })
      .catch((e) => setError(describeError(e, '下書きを作れませんでした'))).finally(() => setBusy(false));
  };
  const changesToFile = data.changes.filter((d) => !d.excluded && d.after && !d.filedAt);
  const eventKinds = (['acquire', 'lose', 'age70'] as const).filter((k) => data.events.some((x) => x.kind === k && x.required && !x.filedAt));
  const mismatches = data.eligibility.filter((x) => x.social.should !== x.current.social || x.employment.should !== x.current.employment);
  const status = (x: { filedAt: string | null; required?: boolean }) => (x.filedAt ? <span className="muted">下書き済み {md(x.filedAt.slice(0, 10))}</span> : x.required === false ? <span className="muted">届出は要らない</span> : <span className="badge warn">まだ</span>);
  return (
    <div className="hr">
      {error && <p className="error">{error}</p>}
      {note && <p className="ok-msg small">{note}</p>}
      {data.rules && !data.rules.reviewed && <p className="small muted">{data.rules.version}（監修前）</p>}

      <div className="row wrap hr-toolbar">
        <h3 className="pay-sub grow">随時改定</h3>
        {changesToFile.length > 0 && <button className="btn small" disabled={busy} onClick={() => report('change', '月額変更届')}>月額変更届の下書き（{changesToFile.length} 人）</button>}
      </div>
      {data.changes.length === 0 ? <p className="muted small">候補はありません</p> : (
        <div className="pay-table"><table className="table hr-table social-table">
          <thead><tr><th>氏名</th><th>改定</th><th>3 か月</th><th>修正平均</th><th>標準報酬月額（等級）</th><th /></tr></thead>
          <tbody>
            {data.changes.map((d) => (
              <tr key={`${d.employeeId}-${d.applyMonth}`}>
                <td>{d.name}{d.direction && <span className="small muted">（{d.direction === 'up' ? '昇給' : '降給'}）</span>}</td>
                <td className="nowrap">{ym(d.applyMonth)}</td>
                <td className="small"><Months d={d} /></td>
                <td className="small">{yen(d.adjustedAverage)}</td>
                <td className="small"><Grades d={d} />{d.notes.length > 0 && <div className="muted">{d.notes.join('・')}</div>}</td>
                <td className="small">{d.excluded ? <span className="muted">{d.excluded}</span> : status(d)}</td>
              </tr>
            ))}
          </tbody>
        </table></div>
      )}

      <div className="row wrap hr-toolbar">
        <h3 className="pay-sub grow">資格の取得・喪失</h3>
        {eventKinds.map((k) => <button key={k} className="btn small" disabled={busy} onClick={() => report(k, HR_FILING_LABELS[k])}>{HR_FILING_LABELS[k]}の下書き</button>)}
      </div>
      {data.events.length === 0 ? <p className="muted small">前後 60 日の届出はありません</p> : (
        <div className="pay-table"><table className="table hr-table social-table">
          <thead><tr><th>氏名</th><th>届出</th><th>日</th><th>期限</th><th>標準報酬月額</th><th /></tr></thead>
          <tbody>
            {data.events.map((x: SocialEvent) => (
              <tr key={`${x.kind}-${x.employeeId}-${x.date}`}>
                <td>{x.name}</td>
                <td className="small">{HR_FILING_LABELS[x.kind]}<div className="muted">{x.cause}</div></td>
                <td className="nowrap">{md(x.date)}</td>
                <td className="nowrap">{md(x.dueOn)}</td>
                <td className="small" title={x.notes.find((n) => n.startsWith('報酬月額の見込み')) ?? ''}>
                  {x.grade ? `${yen(x.kind === 'age70' ? x.grade.pensionAmount : x.grade.amount)}（報酬 ${yen(x.pay)}）` : ''}
                  {x.notes.some((n) => !n.startsWith('報酬月額の見込み')) && <div className="muted">{x.notes.filter((n) => !n.startsWith('報酬月額の見込み')).join('・')}</div>}
                </td>
                <td className="small">{status(x)}</td>
              </tr>
            ))}
          </tbody>
        </table></div>
      )}

      <div className="row wrap hr-toolbar">
        <h3 className="pay-sub">定時決定</h3>
        <button className="btn ghost small" onClick={() => setYear(year - 1)}>← 前</button>
        <strong>{year} 年</strong>
        <button className="btn ghost small" onClick={() => setYear(year + 1)}>次 →</button>
        <span className="grow" />
        {data.regular.some((d) => !d.excluded && d.after) && <button className="btn small" disabled={busy} onClick={() => report('regular', `算定基礎届 ${year}`)}>算定基礎届の下書き</button>}
      </div>
      {data.regular.length === 0 ? <p className="muted small">対象の人はいません</p> : (
        <div className="pay-table"><table className="table hr-table social-table">
          <thead><tr><th>氏名</th><th>4〜6 月</th><th>修正平均</th><th>9 月からの標準報酬月額（等級）</th><th /></tr></thead>
          <tbody>
            {data.regular.map((d) => (
              <tr key={d.employeeId}>
                <td>{d.name}</td>
                <td className="small">{d.excluded ? <span className="muted">{d.excluded}</span> : <Months d={d} />}</td>
                <td className="small">{yen(d.adjustedAverage)}</td>
                <td className="small">{!d.excluded && <Grades d={d} />}{d.notes.length > 0 && <div className="muted">{d.notes.join('・')}</div>}</td>
                <td className="small">{!d.excluded && status(d)}</td>
              </tr>
            ))}
          </tbody>
        </table></div>
      )}

      <div className="row wrap hr-toolbar">
        <h3 className="pay-sub grow">加入の判定</h3>
        <span className="small muted">特定適用事業所: {data.specificOffice.value ? '該当' : '該当しない'}{data.specificOffice.auto ? `（被保険者 ${data.specificOffice.insured} 人・${data.specificOffice.size} 人以上で該当）` : ''}</span>
      </div>
      {mismatches.length === 0 ? <p className="muted small">雇用条件の加入は判定と合っています</p> : (
        <div className="pay-table"><table className="table hr-table social-table">
          <thead><tr><th>氏名</th><th>社会保険</th><th>雇用保険</th></tr></thead>
          <tbody>
            {mismatches.map((x) => (
              <tr key={x.employeeId}>
                <td>{x.name}</td>
                {(['social', 'employment'] as const).map((k) => (
                  <td key={k} className="small">
                    {x[k].should !== x.current[k] ? <span className="badge warn">{x[k].should ? '加入' : '対象外'}</span> : <span className="muted">{x[k].should ? '加入' : '対象外'}</span>}
                    <div className="muted">{x[k].reason}</div>
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table></div>
      )}
    </div>
  );
}
