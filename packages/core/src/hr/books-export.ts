/**
 * @file 人事・給与の帳簿をまとめて書き出す（仕様書 第30.17節・ADR-0054）。解約のときに会社へ渡し、会社が法定の期間残すためのもの。
 *
 * 労働者名簿・賃金台帳（年ごと）・出勤簿（締めの期間ごと）・年次有給休暇管理簿・源泉徴収の記録（年ごと）・源泉徴収票（年と人ごとの PDF）・
 * 年末調整の申告（年ごと）・社会保険の届出の下書きの記録・労働保険の年度更新（年ごと）を、1 つの ZIP にまとめる。
 * 個々の書き出しの監査ログは残さず、まとめて書き出したことを 1 つ残す（中身の件数だけ。額は入れない）。人事区画と管理者の確かめは呼ぶ側が行う。
 */

import { randomUUID } from 'node:crypto';
import JSZip from 'jszip';
import { HR_FILING_LABELS, type AuditEvent, type HrEmployee, type YeaDeclaration } from '@m2office/shared';
import type { Repository } from '../repository/types.js';
import { renderSheet } from '../files/sheet.js';
import type { HrService } from './service.js';
import type { AttendanceService } from './attendance-service.js';
import type { PayrollService } from './payroll-service.js';
import type { YearEndService } from './yea-service.js';
import type { SocialStore } from './social-store.js';
import type { LaborInsuranceService } from './labor-service.js';
import { periodContaining, shiftDate, jstDate } from './attendance.js';

/** まとめて書き出すのに要るもの。 */
export interface BooksExportDeps {
  service: HrService;
  attendance: AttendanceService;
  payroll: PayrollService;
  yea: YearEndService;
  social: SocialStore;
  labor: LaborInsuranceService;
  repo: Repository;
  now?: () => Date;
}

/** 書き出した中身の数（画面と監査ログに出す）。 */
export interface BooksExportSummary {
  files: number;
  ledgers: number;
  attendanceBooks: number;
  withholdingSlips: number;
  years: number[];
}

type Rows = (string | number | null)[][];
const safe = (s: string) => s.replace(/[\\/:*?"<>|]/g, '＿').trim() || '名前なし';
const ymLabel = (ym: string) => `${Number(ym.slice(0, 4))}年${Number(ym.slice(5, 7))}月`;

/**
 * 人事・給与の帳簿をまとめて書き出す。
 *
 * @remarks テナント境界: 使う処理と置き場が会社ごとに絞る（不変則 I-2）
 */
export class HrBooksExport {
  constructor(readonly deps: BooksExportDeps) {}

  private today(): string {
    return jstDate(this.deps.now ? this.deps.now() : new Date());
  }

  /**
   * ZIP を作る。
   *
   * @returns ZIP のバイト列と、中身の数
   */
  async build(tenantId: string, userId: string): Promise<{ bytes: Uint8Array; filename: string; summary: BooksExportSummary }> {
    const { service, attendance, payroll, yea, social, labor, repo } = this.deps;
    const zip = new JSZip();
    const today = this.today();
    const settings = (await repo.getTenantSettings(tenantId)).hr;
    const tenant = await repo.findTenantById(tenantId);
    const company = settings.office.name || tenant?.name || '';
    const add = async (path: string, title: string, sheet: { columns: string[]; rows: Rows }) => {
      if (sheet.rows.length === 0) return false;
      zip.file(path, await renderSheet(title, sheet.columns, sheet.rows, 'xlsx'));
      return true;
    };
    const summary: BooksExportSummary = { files: 0, ledgers: 0, attendanceBooks: 0, withholdingSlips: 0, years: [] };
    const count = (ok: boolean) => { if (ok) summary.files++; return ok; };

    // 労働者名簿（退職した人を含む）
    count(await add('01_労働者名簿.xlsx', '労働者名簿', await service.rosterRows(tenantId, userId, false)));

    // 給与を確定した年（賃金台帳・源泉徴収の記録・源泉徴収票・年末調整の申告）
    const runs = (await payroll.deps.store.listRuns(tenantId)).filter((r) => r.kind !== 'trial' && (r.status === 'confirmed' || r.status === 'paid'));
    const years = [...new Set(runs.map((r) => Number(r.payDate.slice(0, 4))))].sort();
    summary.years = years;
    const employees = (await service.deps.store.listEmployees(tenantId)).filter((e) => e.category !== 'owner');
    for (const y of years) {
      if (count(await add(`02_賃金台帳/賃金台帳_${y}年.xlsx`, `賃金台帳 ${y}`, await payroll.ledger(tenantId, userId, y, false)))) summary.ledgers++;
      count(await add(`05_源泉徴収の記録/源泉徴収票・給与支払報告書の表_${y}年分.xlsx`, `源泉徴収 ${y}`, await yea.report(tenantId, userId, y, false)));
      for (const e of employees) {
        const pdf = await yea.withholdingPdf(tenantId, userId, e, y, false);
        if (!pdf) continue;
        zip.file(`06_源泉徴収票/${y}年分/${safe(e.code ? `${e.code}_${e.name}` : e.name)}.pdf`, pdf);
        summary.files++;
        summary.withholdingSlips++;
      }
      count(await add(`07_年末調整の申告/年末調整の申告_${y}年分.xlsx`, `年末調整の申告 ${y}`, await this.declarations(tenantId, y, employees)));
    }

    // 出勤簿（最初の打刻の期間から今日の期間まで、締めの期間ごと）
    const first = [...(await attendance.deps.store.firstPunchDates(tenantId)).values()].sort()[0];
    if (first) {
      for (let p = periodContaining(first, settings.pay.closingDay); p.start <= today; p = periodContaining(shiftDate(p.end, 1), settings.pay.closingDay)) {
        const ym = p.end.slice(0, 7);
        if (count(await add(`03_出勤簿/出勤簿_${ymLabel(ym)}分.xlsx`, `出勤簿 ${ym}`, await attendance.attendanceBook(tenantId, userId, p, false)))) summary.attendanceBooks++;
      }
    }

    // 年次有給休暇管理簿
    count(await add('04_年次有給休暇管理簿.xlsx', '年次有給休暇管理簿', await attendance.leaveRegister(tenantId, userId, false)));

    // 社会保険の届出の下書きを作った記録
    const names = new Map(employees.map((e) => [e.id, e]));
    const filings = await social.list(tenantId);
    count(await add('08_社会保険の届出の下書き.xlsx', '社会保険の届出の下書き', {
      columns: ['届出', '社員番号', '氏名', '対象（適用の月・事実のあった日）', '下書きを作った日時', '標準報酬月額', '原因・備考'],
      rows: filings.map((f) => {
        const d = f.data as { after?: { amount?: number } | null; grade?: { amount?: number } | null; cause?: string; notes?: string[] };
        const e = names.get(f.employeeId);
        return [HR_FILING_LABELS[f.kind], e?.code ?? '', e?.name ?? '', f.target, f.createdAt, d.after?.amount ?? d.grade?.amount ?? null, [d.cause, ...(d.notes ?? [])].filter(Boolean).join('・')];
      }),
    }));

    // 労働保険の年度更新（計算できた年）
    const laborYears = [...new Set([...years, ...years.map((y) => y + 1)])].sort();
    for (const y of laborYears) {
      const sheet = await labor.bookSheet(tenantId, y);
      if (sheet) count(await add(`09_労働保険の年度更新/年度更新_${y}年.xlsx`, sheet.title, sheet));
    }

    zip.file('はじめにお読みください.txt', [
      `人事・給与の帳簿（${company}）`,
      `書き出した日: ${today}`,
      '',
      'M2Office の人事・給与に残っている帳簿をまとめたものです。',
      '賃金台帳・出勤簿・労働者名簿・年次有給休暇管理簿は労働基準法で、扶養控除等申告書などは所得税法で、会社に保存の義務があります。',
      '解約の後は M2Office から消えるため、このファイルを会社で保存してください（M2Office では 7 年残す決まりにしています）。',
      '',
      '01 労働者名簿（退職した人を含む）',
      '02 賃金台帳（年ごと）',
      '03 出勤簿（締めの期間ごと）',
      '04 年次有給休暇管理簿',
      '05 源泉徴収の記録（源泉徴収票・給与支払報告書の表。年ごと）',
      '06 源泉徴収票（年と人ごとの PDF）',
      '07 年末調整の申告（年ごと）',
      '08 社会保険の届出の下書きを作った記録',
      '09 労働保険の年度更新（年ごと）',
      '（記録の無い帳簿は入っていません）',
      '',
      '個人番号（マイナンバー）は M2Office が持たないため、入っていません。',
    ].join('\r\n'));
    summary.files++;
    const bytes = await zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE' });
    const ev: AuditEvent = {
      id: randomUUID(), tenantId, actorType: 'user', actorId: userId, action: 'hr.books.export', targetType: 'hr', targetId: today,
      detail: { files: summary.files, ledgers: summary.ledgers, attendanceBooks: summary.attendanceBooks, withholdingSlips: summary.withholdingSlips }, occurredAt: new Date().toISOString(),
    };
    await repo.appendAudit(ev);
    return { bytes, filename: `hr-books-${today}.zip`, summary };
  }

  /** 年末調整の申告の表（1 人 1 行。扶養する親族と保険料をまとめる）。 */
  private async declarations(tenantId: string, year: number, employees: HrEmployee[]): Promise<{ columns: string[]; rows: Rows }> {
    const list = await this.deps.yea.deps.store.list(tenantId, year);
    const byId = new Map(employees.map((e) => [e.id, e]));
    const person = (p: { name: string; relation: string; birthDate: string | null; incomeEstimate: number }) => `${p.name}（${p.relation}・${p.birthDate ?? '生年月日なし'}・所得の見積もり ${p.incomeEstimate.toLocaleString('ja-JP')} 円）`;
    const rows: Rows = list.map((v) => {
      const d = v.data as YeaDeclaration;
      const e = byId.get(v.employeeId);
      const ins = d.insurance;
      return [
        e?.code ?? '', v.employeeName, v.submittedAt ?? '', v.checkedAt ?? '', d.self.otherIncome, d.self.disability, d.self.widow, d.self.workingStudent ? '該当' : '',
        d.spouse ? person(d.spouse) : '', d.dependents.map(person).join('／'),
        ins.lifeNewGeneral, ins.lifeOldGeneral, ins.lifeNewCare, ins.lifeNewPension, ins.lifeOldPension, ins.earthquake, ins.oldLongTerm, ins.social, ins.smallBusiness,
        d.housingCredit, d.previousJob?.pay ?? null, d.previousJob?.social ?? null, d.previousJob?.tax ?? null,
      ].map((x) => x ?? null);
    });
    return {
      columns: ['社員番号', '氏名', '出した日時', '担当者が確かめた日時', '給与以外の所得の見積もり', '障害', '寡婦・ひとり親', '勤労学生', '配偶者', '扶養する親族',
        '一般の生命保険料（新）', '一般の生命保険料（旧）', '介護医療保険料', '個人年金保険料（新）', '個人年金保険料（旧）', '地震保険料', '旧長期損害保険料', '社会保険料（本人が払った分）', '小規模企業共済等掛金',
        '住宅借入金等特別控除の額', '前の勤め先の支払金額', '前の勤め先の社会保険料等', '前の勤め先の源泉徴収税額'],
      rows,
    };
  }
}
