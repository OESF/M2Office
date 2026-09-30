/**
 * @file 社会保険の処理（仕様書 第30.12.1節）。定時決定・随時改定・資格の取得と喪失・70 歳到達の一覧と届出の下書き、加入の判定、給与の点検への知らせ。
 *
 * 額と等級は social.ts（決まったプログラム）で出す。届出の下書き（表計算）を作ると、その額を適用の月からの標準報酬月額として入れる
 * （2026-09-30 に決定）。提出は会社が行う（H-7）。人事区画の確かめは呼ぶ側（API）が行う。マイナンバー・基礎年金番号は載せない。
 */

import { randomUUID } from 'node:crypto';
import {
  HR_FILING_LABELS,
  type AuditEvent, type HrEmployee, type HrFilingKind, type HrPayrollProfile, type HrSettings, type HrStandardPay, type HrTerms, type InsuranceEligibility,
  type PayCheck, type SocialDetermination, type SocialEvent,
} from '@m2office/shared';
import type { Repository } from '../repository/types.js';
import type { HrStore } from './store.js';
import type { PayrollStore } from './payroll-store.js';
import type { SocialStore, HrFilingRecord } from './social-store.js';
import { termsOn } from './attendance-service.js';
import { jstToday } from './service.js';
import { addDays } from './procedures.js';
import { shiftMonth } from './payroll.js';
import { Law } from './law/lookup.js';
import type { LawBook } from './law/types.js';
import {
  changeCandidates, eligibility, isShortTime, over70, regularDetermination, socialEvents, standardPayAt, type PaidSlip,
} from './social.js';

/** 社会保険の処理に要るもの。 */
export interface SocialServiceDeps {
  store: SocialStore;
  payrollStore: PayrollStore;
  hrStore: HrStore;
  repo: Repository;
  law: LawBook;
}

/** 特定適用事業所の見込み。 */
export interface SpecificOffice {
  value: boolean;
  /** 会社の設定ではなく、被保険者の数から見込んだ。 */
  auto: boolean;
  /** 厚生年金の被保険者（短時間労働者を除く）の数。 */
  insured: number;
  /** 要件の人数（以上）。 */
  size: number;
}

/** 社会保険の画面に出すもの。 */
export interface SocialOverview {
  year: number;
  regular: SocialDetermination[];
  changes: SocialDetermination[];
  events: SocialEvent[];
  eligibility: InsuranceEligibility[];
  specificOffice: SpecificOffice;
  rules: { version: string; reviewed: boolean } | null;
}

/** 表計算の下書き。 */
export interface FilingSheet {
  title: string;
  columns: string[];
  rows: (string | number | null)[][];
  /** 標準報酬月額に入れた人数。 */
  applied: number;
}

/** 一覧を作るのに読み込むもの（会社ごと）。 */
interface Ctx {
  today: string;
  settings: HrSettings;
  employees: HrEmployee[];
  terms: Map<string, HrTerms[]>;
  profiles: Map<string, HrPayrollProfile>;
  standardPays: HrStandardPay[];
  filings: HrFilingRecord[];
  withDependents: Set<string>;
  fullTimeWeeklyDays: number;
}

const kilo = (n: number | null | undefined) => (n ? Math.round(n / 1000) : null);
const ymLabel = (ym: string) => `${Number(ym.slice(0, 4))} 年 ${Number(ym.slice(5, 7))} 月`;

/**
 * 社会保険の処理。
 *
 * @remarks テナント境界: 置き場が会社ごとに絞る（不変則 I-2）。監査ログには額を入れない（件数と種類だけ）
 */
export class SocialInsuranceService {
  readonly law: Law;

  constructor(readonly deps: SocialServiceDeps) {
    this.law = new Law(deps.law);
  }

  private async ctx(tenantId: string, today = jstToday()): Promise<Ctx> {
    const [settings, employees, profiles, standardPays, filings] = await Promise.all([
      this.deps.repo.getTenantSettings(tenantId).then((s) => s.hr), this.deps.hrStore.listEmployees(tenantId), this.deps.payrollStore.listProfiles(tenantId),
      this.deps.payrollStore.listStandardPay(tenantId), this.deps.store.list(tenantId),
    ]);
    const terms = new Map<string, HrTerms[]>();
    const withDependents = new Set<string>();
    for (const e of employees) {
      terms.set(e.id, await this.deps.hrStore.listTerms(tenantId, e.id));
      if ((await this.deps.payrollStore.listFamily(tenantId, e.id)).some((f) => f.dependent)) withDependents.add(e.id);
    }
    return {
      today, settings, employees: employees.filter((e) => e.category !== 'owner'), terms, profiles: new Map(profiles.map((p) => [p.employeeId, p])), standardPays, filings, withDependents,
      fullTimeWeeklyDays: settings.work.weekdays.length,
    };
  }

  private termsAt(c: Ctx, employeeId: string, date: string): HrTerms | null {
    return termsOn(c.terms.get(employeeId) ?? [], date);
  }

  private shortTime(c: Ctx, t: HrTerms | null): boolean {
    return isShortTime(t, c.settings.insurance, c.fullTimeWeeklyDays);
  }

  /** 特定適用事業所か（会社の設定、`auto` なら厚生年金の被保険者（短時間労働者を除く）の数から見込む）。 */
  specificOffice(c: Ctx, date: string): SpecificOffice {
    const rules = this.law.insuranceRules(date);
    const size = rules?.shortTime.officeSize ?? 51;
    const insured = c.employees.filter((e) => (!e.hiredOn || e.hiredOn <= date) && (!e.leftOn || e.leftOn >= date)).filter((e) => {
      const t = this.termsAt(c, e.id, date);
      return !!t?.socialInsurance && !this.shortTime(c, t) && !over70(e.birthDate, date.slice(0, 7));
    }).length;
    const mode = c.settings.insurance.specificOffice;
    return { value: mode === 'auto' ? insured >= size : mode === 'yes', auto: mode === 'auto', insured, size };
  }

  private filedAt(c: Ctx, kind: HrFilingKind, employeeId: string, target: string): string | null {
    return c.filings.find((f) => f.kind === kind && f.employeeId === employeeId && f.target === target)?.createdAt ?? null;
  }

  /** 随時改定の候補（直近 6 か月の変動月）。 */
  private async changes(tenantId: string, c: Ctx): Promise<SocialDetermination[]> {
    const month = c.today.slice(0, 7);
    const since = shiftMonth(month, -6);
    const [paid, runs] = await Promise.all([this.paid(tenantId, shiftMonth(since, -2), month), this.deps.payrollStore.listRuns(tenantId)]);
    const confirmedMonths = new Set(runs.filter((r) => r.kind === 'monthly' && (r.status === 'confirmed' || r.status === 'paid')).map((r) => r.payDate.slice(0, 7)));
    const out: SocialDetermination[] = [];
    for (const e of c.employees) {
      const t = this.termsAt(c, e.id, c.today);
      if (!t?.socialInsurance) continue;
      const filed = new Map(c.filings.filter((f) => f.kind === 'change' && f.employeeId === e.id).map((f) => [f.target, f.createdAt] as const));
      for (const d of changeCandidates({
        law: this.law, rulesAt: (m) => this.law.insuranceRules(m), employee: e, shortTime: this.shortTime(c, t), paid, standardPays: c.standardPays, filed, confirmedMonths, since,
      })) {
        // 対象にならなかったものは、改定の月が近いものだけを見せる
        if (d.excluded && !/確定したら判定/.test(d.excluded) && d.applyMonth < shiftMonth(month, -1)) continue;
        out.push(d);
      }
    }
    return out.sort((a, b) => a.applyMonth.localeCompare(b.applyMonth) || a.name.localeCompare(b.name, 'ja'));
  }

  private async paid(tenantId: string, from: string, to: string): Promise<PaidSlip[]> {
    return (await this.deps.payrollStore.listPaidSlips(tenantId, from, to)).map((s) => ({ slip: s, run: s.run }));
  }

  /** 定時決定（その年）。 */
  private async regular(tenantId: string, c: Ctx, year: number, changes: SocialDetermination[]): Promise<SocialDetermination[]> {
    const rules = this.law.insuranceRules(`${year}-07-01`);
    if (!rules) return [];
    const paid = await this.paid(tenantId, `${year}-04`, `${year}-06`);
    const summer = [`${year}-07`, `${year}-08`, `${year}-09`];
    const out: SocialDetermination[] = [];
    for (const e of c.employees) {
      if (e.hiredOn && e.hiredOn > `${year}-07-01`) continue;
      if (e.leftOn && e.leftOn < `${year}-04-01`) continue;
      const t = this.termsAt(c, e.id, `${year}-07-01`);
      if (!t?.socialInsurance) continue;
      const changeInJulyToSep = c.filings.some((f) => f.kind === 'change' && f.employeeId === e.id && summer.includes(f.target))
        || changes.some((d) => d.employeeId === e.id && summer.includes(d.applyMonth) && !d.excluded);
      const d = regularDetermination({ law: this.law, rules, year, employee: e, terms: t, shortTime: this.shortTime(c, t), paid, standardPays: c.standardPays, changeInJulyToSep });
      out.push({ ...d, filedAt: this.filedAt(c, 'regular', e.id, `${year}-09`) });
    }
    return out.sort((a, b) => Number(!!a.excluded) - Number(!!b.excluded) || a.name.localeCompare(b.name, 'ja'));
  }

  private events(c: Ctx): SocialEvent[] {
    const filed = new Map(c.filings.map((f) => [`${f.kind}|${f.employeeId}|${f.target}`, f.createdAt] as const));
    return socialEvents({
      law: this.law, from: addDays(c.today, -60), to: addDays(c.today, 60), employees: c.employees, termsAt: (id, d) => this.termsAt(c, id, d),
      profiles: c.profiles, standardPays: c.standardPays, withDependents: c.withDependents, shortTime: (t) => this.shortTime(c, t), filed,
    });
  }

  private eligibilityList(c: Ctx): InsuranceEligibility[] {
    const rules = this.law.insuranceRules(c.today);
    if (!rules) return [];
    const specific = this.specificOffice(c, c.today).value;
    return c.employees.filter((e) => !e.leftOn || e.leftOn >= c.today).map((e) => eligibility({
      rules, date: c.today, employee: e, terms: this.termsAt(c, e.id, c.today), profile: c.profiles.get(e.id) ?? null, specificOffice: specific,
      settings: { socialApply: c.settings.socialApply, officeForm: c.settings.office.form, insurance: c.settings.insurance, fullTimeWeeklyDays: c.fullTimeWeeklyDays },
    }));
  }

  /**
   * 社会保険の画面（定時決定・随時改定・資格の取得と喪失・加入の判定）。
   *
   * @param year 定時決定の年
   */
  async overview(tenantId: string, year: number): Promise<SocialOverview> {
    const c = await this.ctx(tenantId);
    const changes = await this.changes(tenantId, c);
    const rules = this.law.insuranceRules(c.today);
    return {
      year, regular: await this.regular(tenantId, c, year, changes), changes, events: this.events(c), eligibility: this.eligibilityList(c),
      specificOffice: this.specificOffice(c, c.today), rules: rules ? { version: rules.version, reviewed: rules.review.status === 'verified' } : null,
    };
  }

  /** 標準報酬月額を入れる（同じ月・同じ額が既にあれば入れない）。 */
  private async applyStandard(tenantId: string, userId: string, c: Ctx, employeeId: string, fromMonth: string, amount: number, kind: HrStandardPay['kind']): Promise<boolean> {
    if (c.standardPays.some((s) => s.employeeId === employeeId && s.fromMonth === fromMonth && s.amount === amount)) return false;
    const s: HrStandardPay = { id: randomUUID(), employeeId, fromMonth, amount, kind };
    await this.deps.payrollStore.addStandardPay(tenantId, { ...s, createdBy: userId });
    c.standardPays.push(s);
    return true;
  }

  private head(c: Ctx, e: HrEmployee | undefined): (string | number | null)[] {
    return [c.settings.insurance.officeSymbol, c.settings.insurance.officeNumber, c.profiles.get(e?.id ?? '')?.insurance?.number ?? '', e?.name ?? '', e?.kana ?? '', e?.birthDate ?? ''];
  }

  private static readonly HEAD = ['事業所整理記号', '事業所番号', '被保険者整理番号', '氏名', 'ふりがな', '生年月日'];

  /** 算定基礎届・月額変更届の行。 */
  private determinationRow(c: Ctx, d: SocialDetermination, planned = false): (string | number | null)[] {
    const e = c.employees.find((x) => x.id === d.employeeId);
    const beforeStd = standardPayAt(c.standardPays.filter((s) => s.fromMonth < d.applyMonth), d.employeeId, shiftMonth(d.applyMonth, -1));
    const months = [0, 1, 2].flatMap((i) => {
      const m = d.months[i];
      if (!m || planned) return [m ? ymLabel(m.month) : '', null, null, null, null];
      return [ymLabel(m.month), m.baseDays, m.pay + m.retro, 0, m.pay + m.retro];
    });
    const counted = d.months.filter((m) => m.counted);
    const retro = d.months.filter((m) => m.retro).map((m) => `${Number(m.month.slice(5, 7))} 月 ${m.retro.toLocaleString('ja-JP')} 円`).join('・');
    const change = d.kind === 'change' ? `${ymLabel(d.months[0]?.month ?? '')} ${d.direction === 'down' ? '降給' : '昇給'}` : '';
    return [
      ...this.head(c, e), ymLabel(d.applyMonth), kilo(d.before?.amount), kilo(d.before?.pensionAmount), beforeStd ? ymLabel(beforeStd.fromMonth) : '', change, retro,
      ...months,
      planned ? null : counted.reduce((s, m) => s + m.pay + m.retro, 0), planned ? null : d.average, planned ? null : d.adjustedAverage,
      planned ? null : d.after?.amount ?? null, planned ? null : d.after?.grade ?? null, planned ? null : d.after?.pensionAmount ?? null, planned ? null : d.after?.pensionGrade ?? null,
      '', [...(planned ? ['月額変更予定'] : []), ...d.notes].join('・'),
    ];
  }

  private static readonly DET_COLUMNS = [
    ...SocialInsuranceService.HEAD, '適用年月（改定年月）', '従前の標準報酬月額（健康保険・千円）', '従前の標準報酬月額（厚生年金・千円）', '従前改定月', '昇（降）給', '遡及支払額',
    ...[1, 2, 3].flatMap((i) => [`${i} か月目 支給月`, `${i} か月目 基礎日数`, `${i} か月目 通貨`, `${i} か月目 現物`, `${i} か月目 合計`]),
    '総計', '平均額', '修正平均額', '決定の標準報酬月額（健康保険）', '健康保険の等級', '決定の標準報酬月額（厚生年金）', '厚生年金の等級', '個人番号（基礎年金番号）', '備考',
  ];

  /**
   * 算定基礎届の下書き。対象の人の決定の額を 9 月からの標準報酬月額として入れ、下書きを作った記録を残す。
   * 7〜9 月に随時改定がある人は、報酬を空けて備考に「月額変更予定」と書く。
   */
  async regularReport(tenantId: string, userId: string, year: number): Promise<FilingSheet | { error: string }> {
    const c = await this.ctx(tenantId);
    const changes = await this.changes(tenantId, c);
    const list = await this.regular(tenantId, c, year, changes);
    const rows: (string | number | null)[][] = [];
    let applied = 0;
    for (const d of list) {
      if (d.excluded?.startsWith('7〜9 月に随時改定')) { rows.push(this.determinationRow(c, d, true)); continue; }
      if (d.excluded || !d.after) continue;
      rows.push(this.determinationRow(c, d));
      await this.deps.store.save(tenantId, { id: randomUUID(), employeeId: d.employeeId, kind: 'regular', target: d.applyMonth, data: { ...d } }, userId);
      if (await this.applyStandard(tenantId, userId, c, d.employeeId, d.applyMonth, d.after.amount, 'regular')) applied++;
    }
    if (rows.length === 0) return { error: `${year} 年の算定基礎届に載せる人がいません（4〜6 月に支払った確定した給与が要ります）` };
    await this.audit(tenantId, userId, 'hr.social.regular', String(year), { rows: rows.length, applied });
    return { title: `算定基礎届（下書き）${year}`, columns: SocialInsuranceService.DET_COLUMNS, rows, applied };
  }

  /**
   * 月額変更届の下書き。随時改定に当たる人（下書きをまだ作っていない人。`employeeIds` を渡せばその人）の額を改定の月から入れる。
   */
  async changeReport(tenantId: string, userId: string, employeeIds?: string[]): Promise<FilingSheet | { error: string }> {
    const c = await this.ctx(tenantId);
    const list = (await this.changes(tenantId, c)).filter((d) => !d.excluded && d.after && (employeeIds?.length ? employeeIds.includes(d.employeeId) : !d.filedAt));
    if (list.length === 0) return { error: '随時改定に当たる人がいません' };
    const rows: (string | number | null)[][] = [];
    let applied = 0;
    for (const d of list) {
      rows.push(this.determinationRow(c, d));
      await this.deps.store.save(tenantId, { id: randomUUID(), employeeId: d.employeeId, kind: 'change', target: d.applyMonth, data: { ...d } }, userId);
      if (await this.applyStandard(tenantId, userId, c, d.employeeId, d.applyMonth, d.after!.amount, 'change')) applied++;
    }
    await this.audit(tenantId, userId, 'hr.social.change', 'change', { rows: rows.length, applied });
    return { title: '月額変更届（下書き）', columns: SocialInsuranceService.DET_COLUMNS, rows, applied };
  }

  /**
   * 資格取得届・資格喪失届・70 歳到達届の下書き（前後 60 日の、届出が要る人）。資格取得は、見込みの報酬月額の等級を取得の月から入れる。
   */
  async eventReport(tenantId: string, userId: string, kind: 'acquire' | 'lose' | 'age70', employeeIds?: string[]): Promise<FilingSheet | { error: string }> {
    const c = await this.ctx(tenantId);
    const list = this.events(c).filter((x) => x.kind === kind && x.required && (employeeIds?.length ? employeeIds.includes(x.employeeId) : !x.filedAt));
    if (list.length === 0) return { error: `${HR_FILING_LABELS[kind]}が要る人がいません` };
    const rows: (string | number | null)[][] = [];
    let applied = 0;
    for (const x of list) {
      const e = c.employees.find((y) => y.id === x.employeeId);
      const head = this.head(c, e);
      const gender = e?.gender === 'male' ? '1 男' : e?.gender === 'female' ? '2 女' : '';
      if (kind === 'acquire') {
        const area = x.notes.find((n) => n.startsWith('取得の区分')) ?? x.notes[0] ?? '';
        rows.push([...head, gender, area.replace('取得の区分: ', ''), '', x.date, c.withDependents.has(x.employeeId) ? '1 有' : '0 無', x.pay, 0, x.pay, x.grade?.amount ?? null,
          x.notes.filter((n) => !n.startsWith('取得の区分') && !n.startsWith('報酬月額の見込み')).join('・'), e?.address ?? '', '']);
        if (x.grade && await this.applyStandard(tenantId, userId, c, x.employeeId, x.date.slice(0, 7), x.grade.amount, 'acquire')) applied++;
      } else if (kind === 'lose') {
        rows.push([...head, '', x.date, x.cause, x.notes.find((n) => n.startsWith('70 歳以上被用者不該当')) ?? '', '', x.notes.filter((n) => !n.startsWith('70 歳以上')).join('・')]);
      } else {
        rows.push([...head, '', x.date, x.pay, 0, x.pay, x.grade?.pensionAmount ?? null, x.notes.filter((n) => !n.startsWith('報酬月額の見込み')).join('・')]);
      }
      await this.deps.store.save(tenantId, { id: randomUUID(), employeeId: x.employeeId, kind, target: x.date, data: { ...x } }, userId);
    }
    const columns = kind === 'acquire'
      ? [...SocialInsuranceService.HEAD, '種別', '取得区分', '個人番号又は基礎年金番号', '取得年月日', '被扶養者', '報酬月額（通貨）', '報酬月額（現物）', '報酬月額（合計）', '標準報酬月額（見込み）', '備考', '住所', '資格確認書の発行']
      : kind === 'lose'
        ? [...SocialInsuranceService.HEAD, '個人番号又は基礎年金番号', '喪失年月日', '喪失の原因', '70 歳以上被用者不該当', '資格確認書の回収（枚数）', '備考']
        : [...SocialInsuranceService.HEAD, '個人番号又は基礎年金番号', '70 歳到達日', '報酬月額（通貨）', '報酬月額（現物）', '報酬月額（合計）', '標準報酬月額相当額', '備考'];
    await this.audit(tenantId, userId, `hr.social.${kind}`, kind, { rows: rows.length, applied });
    return { title: `${HR_FILING_LABELS[kind]}（下書き）`, columns, rows, applied };
  }

  /**
   * 月の給与の点検に足す知らせ（随時改定に当たる人・判定を待つ人・加入の判定と雇用条件が違う人）。
   */
  async hints(tenantId: string): Promise<PayCheck[]> {
    const c = await this.ctx(tenantId);
    const out: PayCheck[] = [];
    for (const d of await this.changes(tenantId, c)) {
      const who = { employeeId: d.employeeId, employeeName: d.name };
      if (!d.excluded && d.after && !d.filedAt) {
        out.push({ level: 'check', code: 'social-change', text: `随時改定に当たります（${ymLabel(d.applyMonth)}から標準報酬月額 ${d.after.amount.toLocaleString('ja-JP')} 円）。「社会保険」で月額変更届の下書きを作ると反映します`, ...who });
      } else if (d.excluded && /確定したら判定/.test(d.excluded)) {
        out.push({ level: 'check', code: 'fixed-wage', text: `固定的賃金が変わりました（${ymLabel(d.months[0]?.month ?? d.applyMonth)}支払分から）。${d.excluded}`, ...who });
      }
    }
    for (const x of this.eligibilityList(c)) {
      const diff = [x.social.should !== x.current.social ? `社会保険は${x.social.should ? '加入' : '対象外'}（${x.social.reason}）` : '', x.employment.should !== x.current.employment ? `雇用保険は${x.employment.should ? '加入' : '対象外'}（${x.employment.reason}）` : ''].filter(Boolean);
      if (diff.length) out.push({ level: 'check', code: 'insurance-eligibility', text: `加入の判定と雇用条件が違います: ${diff.join('・')}`, employeeId: x.employeeId, employeeName: x.name });
    }
    return out;
  }

  private async audit(tenantId: string, userId: string, action: string, targetId: string, detail: Record<string, unknown>): Promise<void> {
    const ev: AuditEvent = { id: randomUUID(), tenantId, actorType: 'user', actorId: userId, action, targetType: 'hr', targetId, detail, occurredAt: new Date().toISOString() };
    await this.deps.repo.appendAudit(ev);
  }
}
