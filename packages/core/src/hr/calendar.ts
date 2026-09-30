/**
 * @file 労務カレンダーの期限（仕様書 第30.19.1節）。会社の設定・給与の回・台帳から、決まったプログラムで期限を並べる。
 *
 * 推論に期限を決めさせない。納付と届出の期限が土曜・日曜・祝日・年末年始（12 月 29 日〜1 月 3 日）なら次の平日にする。
 * 副作用を持たない。
 */

import type { HrDeadline, HrEmployee, HrSettings, HrTask, HrTerms } from '@m2office/shared';
import { isJapaneseHoliday } from './holidays.js';
import { dayOfMonth } from './procedures.js';

/** 月ごとの給与の支払（確定した回から）。 */
export interface MonthPayment {
  /** 支払った月（YYYY-MM）。 */
  month: string;
  people: number;
  gross: number;
  tax: number;
  resident: number;
}

/** 期限を並べるのに要るもの。 */
export interface CalendarInput {
  today: string;
  /** 今日から何日先までか。 */
  days: number;
  settings: HrSettings;
  employees: HrEmployee[];
  /** 従業員ごとの今の雇用条件。 */
  terms: Map<string, HrTerms | null>;
  /** 済んでいない入退社の手続き。 */
  tasks: HrTask[];
  /** 有給の取得義務が足りない人。 */
  obligations: { employeeId: string; name: string; deadline: string; taken: number; required: number }[];
  payments: MonthPayment[];
  /** 法令の表の変わり目と更新待ち（第30.18.1節。law から作る）。 */
  law?: HrDeadline[];
}

const iso = (d: Date) => d.toISOString().slice(0, 10);
const parse = (s: string) => new Date(`${s}T00:00:00Z`);
const addDays = (s: string, n: number) => { const d = parse(s); d.setUTCDate(d.getUTCDate() + n); return iso(d); };
const ymd = (y: number, m: number, d: number) => dayOfMonth(y, m - 1, d);
const shiftYm = (ym: string, n: number) => {
  const [y, m] = ym.split('-').map(Number) as [number, number];
  const t = y * 12 + (m - 1) + n;
  return `${Math.floor(t / 12)}-${String((t % 12) + 1).padStart(2, '0')}`;
};
const md = (s: string) => `${Number(s.slice(5, 7))}/${Number(s.slice(8, 10))}`;
const yen = (n: number) => `${n.toLocaleString('ja-JP')} 円`;
const monthName = (ym: string) => `${Number(ym.slice(5, 7))} 月`;

/** 役所の休み（土日・祝日・12 月 29 日〜1 月 3 日）か。 */
export function isClosedDay(date: string): boolean {
  const w = parse(date).getUTCDay();
  const mmdd = date.slice(5);
  return w === 0 || w === 6 || isJapaneseHoliday(date) || mmdd >= '12-29' || mmdd <= '01-03';
}

/** 期限が休みの日なら次の平日にする。 */
export function nextBusinessDay(date: string): string {
  let d = date;
  while (isClosedDay(d)) d = addDays(d, 1);
  return d;
}

/**
 * 労務の期限を並べる（日付の順。過ぎて済んでいない手続きを含む）。
 */
export function buildDeadlines(input: CalendarInput): HrDeadline[] {
  const { today, settings: s } = input;
  const end = addDays(today, input.days);
  const out: HrDeadline[] = [];
  const within = (date: string) => date >= today && date <= end;
  const push = (d: HrDeadline) => { if (within(d.date)) out.push(d); };
  const years = [Number(today.slice(0, 4)), Number(today.slice(0, 4)) + 1];
  const pay = new Map(input.payments.map((p) => [p.month, p]));
  const sum = (months: string[], key: 'tax' | 'resident' | 'gross' | 'people') => months.reduce((a, m) => a + (pay.get(m)?.[key] ?? 0), 0);
  const range = (from: string, to: string) => { const list: string[] = []; for (let m = from; m <= to; m = shiftYm(m, 1)) list.push(m); return list; };
  const active = input.employees.filter((e) => e.category !== 'owner' && (!e.leftOn || e.leftOn >= today));

  // 源泉所得税と住民税の納付
  const startYm = shiftYm(today.slice(0, 7), -2);
  if (s.duties.withholdingSpecial) {
    for (const y of years) {
      push({ date: nextBusinessDay(ymd(y, 7, 10)), kind: 'withholding', title: `源泉所得税の納付（${y} 年 1〜6 月分・納期の特例）`, detail: taxDetail(range(`${y}-01`, `${y}-06`)) });
      push({ date: nextBusinessDay(ymd(y, 1, 20)), kind: 'withholding', title: `源泉所得税の納付（${y - 1} 年 7〜12 月分・納期の特例）`, detail: taxDetail(range(`${y - 1}-07`, `${y - 1}-12`)) });
    }
  } else {
    for (const m of range(startYm, shiftYm(end.slice(0, 7), 0))) {
      const next = shiftYm(m, 1);
      push({ date: nextBusinessDay(`${next}-10`), kind: 'withholding', title: `源泉所得税の納付（${monthName(m)}支払分）`, detail: taxDetail([m]) });
    }
  }
  if (s.duties.residentSpecial) {
    for (const y of years) {
      push({ date: nextBusinessDay(ymd(y, 12, 10)), kind: 'resident', title: `住民税の納付（${y} 年 6〜11 月分・納期の特例）`, detail: residentDetail(range(`${y}-06`, `${y}-11`)) });
      push({ date: nextBusinessDay(ymd(y, 6, 10)), kind: 'resident', title: `住民税の納付（${y - 1} 年 12 月〜${y} 年 5 月分・納期の特例）`, detail: residentDetail(range(`${y - 1}-12`, `${y}-05`)) });
    }
  } else {
    for (const m of range(startYm, shiftYm(end.slice(0, 7), 0))) {
      push({ date: nextBusinessDay(`${shiftYm(m, 1)}-10`), kind: 'resident', title: `住民税の納付（${monthName(m)}に引いた分）`, detail: residentDetail([m]) });
    }
  }
  function taxDetail(months: string[]): string {
    const n = Math.max(...months.map((m) => pay.get(m)?.people ?? 0), 0);
    if (!months.some((m) => pay.has(m))) return '確定した給与がまだありません。所得税徴収高計算書は確定の後に集計します';
    return `所得税徴収高計算書: 人員 ${n} 人・支給額 ${yen(sum(months, 'gross'))}・税額 ${yen(sum(months, 'tax'))}（確定した給与から）`;
  }
  function residentDetail(months: string[]): string {
    if (!months.some((m) => pay.has(m))) return '確定した給与がまだありません';
    return `引いた住民税 ${yen(sum(months, 'resident'))}（確定した給与から。市区町村ごとの納付書で納める）`;
  }

  const insured = active.some((e) => input.terms.get(e.id)?.socialInsurance);
  for (const y of years) {
    push({ date: ymd(y, 5, 31), from: ymd(y, 5, 1), kind: 'resident-switch', title: '住民税の決定通知書（6 月の給与から切り替え）', detail: '市区町村から届いたら「住民税の通知書を読む」で入れる' });
    push({ date: nextBusinessDay(ymd(y, 7, 10)), from: ymd(y, 6, 1), kind: 'labor-insurance', title: '労働保険の年度更新', detail: '前の年度の賃金の総額から、確定保険料と概算保険料を申告して納める（6 月 1 日から）' });
    if (insured) push({ date: nextBusinessDay(ymd(y, 7, 10)), from: ymd(y, 7, 1), kind: 'santei', title: '算定基礎届', detail: '4〜6 月の報酬から、9 月からの標準報酬月額を届け出る（7 月 1 日から）' });
    push({ date: dayOfMonth(y, 11, s.pay.payDay), from: ymd(y, 11, 1), kind: 'yea', title: '年末調整', detail: '11 月から扶養控除等申告書・保険料控除申告書などを集め、12 月の給与で精算する' });
    push({ date: nextBusinessDay(ymd(y, 1, 31)), kind: 'annual-report', title: '給与支払報告書・法定調書合計表', detail: '前の年の源泉徴収票の内容を、市区町村と税務署に出す' });
    if (s.agreement.enabled) {
      const start = ymd(y, s.agreement.startMonth, 1);
      push({ date: addDays(start, -1), kind: 'agreement', title: `36 協定の届出（${s.agreement.startMonth} 月からの分）`, detail: '対象期間が始まる前に、労働基準監督署に届け出る' });
    }
    if (s.duties.healthCheckMonth) push({ date: ymd(y, s.duties.healthCheckMonth, 1), kind: 'health-check', title: '定期健康診断', detail: '1 年に 1 回、常時使用する人に受けさせる' });
  }

  for (const e of active) {
    if (e.hiredOn && within(e.hiredOn)) push({ date: e.hiredOn, kind: 'hire-check', title: `雇入れ時の健康診断（${e.name}さん）`, detail: '雇い入れるときに受けさせる（3 か月以内に受けた診断の結果を出してもらえば省ける）', employeeId: e.id });
    const t = input.terms.get(e.id);
    if (t?.contractEnd) {
      push({ date: t.contractEnd, kind: 'contract-end', title: `契約期間の満了（${e.name}さん）`, detail: t.renewal ? `更新: ${t.renewal}` : '更新するかを決めて本人に伝える', employeeId: e.id });
      push({ date: addDays(t.contractEnd, -30), kind: 'contract-end', title: `更新しないなら予告（${e.name}さん）`, detail: `${md(t.contractEnd)} で契約が終わる。更新しないなら 30 日前までに予告する`, employeeId: e.id });
    }
  }
  for (const k of input.tasks) {
    if (!k.dueOn || k.doneAt || k.dueOn > end) continue;
    out.push({ date: k.dueOn, kind: 'task', title: `${k.title}（${k.employeeName ?? ''}さん）`, detail: k.kind === 'hire' ? '入社の手続き' : '退職の手続き', employeeId: k.employeeId, overdue: k.dueOn < today });
  }
  for (const d of input.law ?? []) push(d);
  for (const o of input.obligations) {
    if (o.deadline > end) continue;
    push({ date: o.deadline, kind: 'leave-obligation', title: `有給の取得義務（${o.name}さん）`, detail: `あと ${o.required - o.taken} 日取る必要がある`, employeeId: o.employeeId });
  }
  return out.sort((a, b) => (!!a.overdue === !!b.overdue ? a.date.localeCompare(b.date) : a.overdue ? -1 : 1));
}
