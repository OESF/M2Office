/**
 * @file 人事・給与（内蔵の拡張）の型（仕様書 第30章）。段 1（土台）の台帳・雇用条件・手続きの一覧・会社の設定。
 */

/** 人事・給与の拡張の ID（利用範囲・メニューのピン止めで使う）。 */
export const HR_EXTENSION_ID = 'hr';

/** 人事区画の名前（第30.2節）。人事・給与を入れたとき、無ければ作る。 */
export const HR_COMPARTMENT = 'hr';

/** 雇用形態。 */
export type HrEmployment = 'regular' | 'contract' | 'part' | 'arbeit' | 'officer';
export const HR_EMPLOYMENTS: { id: HrEmployment; label: string }[] = [
  { id: 'regular', label: '正社員' },
  { id: 'contract', label: '契約' },
  { id: 'part', label: 'パート' },
  { id: 'arbeit', label: 'アルバイト' },
  { id: 'officer', label: '役員' },
];

/** 人の区分（第30.5.1節）。区分で保険と税の扱いが変わる。 */
export type HrCategory = 'employee' | 'officer' | 'family' | 'owner';
export const HR_CATEGORIES: { id: HrCategory; label: string }[] = [
  { id: 'employee', label: '従業員' },
  { id: 'officer', label: '役員' },
  { id: 'family', label: '家族の従業員' },
  { id: 'owner', label: '事業主' },
];

/** 賃金の定め。 */
export type HrWageType = 'monthly' | 'daily' | 'hourly';
export const HR_WAGE_TYPES: { id: HrWageType; label: string }[] = [
  { id: 'monthly', label: '月給' },
  { id: 'daily', label: '日給' },
  { id: 'hourly', label: '時給' },
];

/** 会社の人事・給与の設定（第30.8.1節のうち段 1 で持つもの）。導入のときに会社が決める。 */
export interface HrSettings {
  /** 人事・給与を使うか（既定は切り）。 */
  enabled: boolean;
  /** 事業所。 */
  office: {
    name: string;
    address: string;
    /** 事業の形態。個人事業では事業主本人は給与の対象にならない（第30.5.1節）。 */
    form: 'corporation' | 'sole';
  };
  /** 健康保険の種類と都道府県。 */
  health: {
    kind: 'kyokai' | 'kumiai' | 'kokuho-kumiai' | 'none';
    prefecture: string;
  };
  /** 社会保険の適用の区分。 */
  socialApply: 'mandatory' | 'voluntary' | 'none';
  /** 締め日（1〜31。31 は末日）と支払日（1〜31。31 は末日）と、支払う月（締めた月か翌月か）。 */
  pay: { closingDay: number; payDay: number; payMonth: 'same' | 'next' };
  /** 社会保険と労働保険の手続きを、自社で行うか顧問の社会保険労務士に頼むか。 */
  procedures: 'self' | 'sharoushi';
  /** 労働日と休日（第30.6.1節）。曜日は 0=日曜〜6=土曜。`nationalHolidays` は祝日を休み（所定休日）にするか。 */
  work: { weekdays: number[]; legalHoliday: number; weekStart: number; nationalHolidays: boolean };
  /** 36 協定（第30.6.1節）。上限は時間。`startMonth` は対象期間の始まりの月（1〜12）。 */
  agreement: { enabled: boolean; monthly: number; yearly: number; special: boolean; startMonth: number };
  /** 休暇（第30.7.1節）。 */
  leave: { halfDay: boolean };
  /** 給与の計算（第30.10.1節）。 */
  payroll: HrPayrollSettings;
}

/** 給与の計算の会社の設定（第30.10.1節）。 */
export interface HrPayrollSettings {
  /** 社会保険料の徴収（翌月徴収: 前の月の分を当月の給与から引く）。 */
  collect: 'next' | 'current';
  /** 割増率（%）。法定の下限以上。 */
  premiums: { overtime: number; over60: number; night: number; holiday: number };
  /** 月の平均所定労働時間（月給の割増の単価に使う）。`null` なら週の所定時間 × 52 ÷ 12。 */
  avgMonthlyHours: number | null;
  /** 月給の人の欠勤・遅刻早退を引くか。 */
  deductAbsence: boolean;
  /** 健康保険組合の料率（%。組合のとき会社が入れる）。 */
  kumiai: { health: number | null; care: number | null };
  /** 手当ごとの扱い（名前で当てる。無ければ名前から決まったプログラムで見分ける）。 */
  items: HrPayItemRule[];
}

/** 手当の扱い。 */
export interface HrPayItemRule {
  name: string;
  /** 割増の単価の基礎に入れるか。 */
  premiumBase: boolean;
  /** 所得税の対象か（通勤手当の非課税の分は別に扱う）。 */
  taxable: boolean;
}

/** まだ設定していない会社の既定（締めは末日・支払は翌月 25 日。導入のときに会社が直す）。 */
export const DEFAULT_HR_SETTINGS: HrSettings = {
  enabled: false,
  office: { name: '', address: '', form: 'corporation' },
  health: { kind: 'kyokai', prefecture: '' },
  socialApply: 'mandatory',
  pay: { closingDay: 31, payDay: 25, payMonth: 'next' },
  procedures: 'self',
  work: { weekdays: [1, 2, 3, 4, 5], legalHoliday: 0, weekStart: 0, nationalHolidays: true },
  agreement: { enabled: true, monthly: 45, yearly: 360, special: false, startMonth: 4 },
  leave: { halfDay: true },
  payroll: {
    collect: 'next',
    premiums: { overtime: 25, over60: 50, night: 25, holiday: 35 },
    avgMonthlyHours: null,
    deductAbsence: true,
    kumiai: { health: null, care: null },
    items: [],
  },
};

/** 従業員（人事の台帳。第30.5節）。 */
export interface HrEmployee {
  id: string;
  code: string;
  name: string;
  kana: string;
  birthDate: string | null;
  gender: '' | 'male' | 'female' | 'other';
  address: string;
  phone: string;
  email: string;
  hiredOn: string | null;
  leftOn: string | null;
  leaveReason: string;
  employment: HrEmployment;
  category: HrCategory;
  department: string;
  title: string;
  /** 結び付けた M2Office の利用者（無ければ `null`）。 */
  userId: string | null;
  status: 'active' | 'left';
  note: string;
  updatedAt: string;
}

/** 手当の 1 つ（雇用条件の賃金の定め）。 */
export interface HrAllowance {
  name: string;
  amount: number;
}

/** 雇用条件（履歴。適用日つき。第30.5節）。 */
export interface HrTerms {
  id: string;
  employeeId: string;
  effectiveOn: string;
  contractStart: string | null;
  contractEnd: string | null;
  renewal: string;
  probationUntil: string | null;
  weeklyHours: number | null;
  weeklyDays: number | null;
  startTime: string;
  endTime: string;
  breakMinutes: number | null;
  wageType: HrWageType;
  wageAmount: number | null;
  allowances: HrAllowance[];
  workplace: string;
  work: string;
  /** 就業場所の変更の範囲（2024 年 4 月からの明示事項）。 */
  workplaceScope: string;
  /** 業務の変更の範囲。 */
  workScope: string;
  socialInsurance: boolean;
  employmentInsurance: boolean;
  createdAt: string;
}

/** 入退社の手続き（第30.5.2節）。 */
export interface HrTask {
  id: string;
  employeeId: string;
  employeeName?: string;
  kind: 'hire' | 'leave';
  code: string;
  title: string;
  dueOn: string | null;
  doneAt: string | null;
  doneBy: string | null;
}

/** 一覧に出す従業員（いまの雇用条件の要点と、済んでいない手続きの数つき）。 */
export interface HrEmployeeView extends HrEmployee {
  current: Pick<HrTerms, 'wageType' | 'wageAmount' | 'weeklyHours' | 'socialInsurance' | 'employmentInsurance'> | null;
  openTasks: number;
}

/** 打刻の種類（第30.6.1節）。 */
export type AttPunchKind = 'in' | 'out' | 'break_start' | 'break_end';
export const ATT_PUNCH_LABELS: Record<AttPunchKind, string> = { in: '出勤', out: '退勤', break_start: '休憩', break_end: '休憩終わり' };

/** 打刻 1 つ。 */
export interface AttPunch {
  id: string;
  employeeId: string;
  kind: AttPunchKind;
  at: string;
  source: 'screen' | 'mobile' | 'secretary' | 'fix' | 'import';
}

/** 日の区分。 */
export type AttDayType = 'workday' | 'dayoff' | 'legal-holiday';

/** 日の集計（分）。 */
export interface AttDay {
  date: string;
  type: AttDayType;
  in: string | null;
  out: string | null;
  breakMinutes: number;
  workMinutes: number;
  nightMinutes: number;
  /** 1 日 8 時間を超えた分。 */
  overtimeMinutes: number;
  /** 所定の時間を超え 8 時間までの分。 */
  extraMinutes: number;
  /** 法定休日の労働。 */
  holidayMinutes: number;
  lateMinutes: number;
  earlyMinutes: number;
  /** 有給を取った日数（0・0.5・1）。 */
  leaveDays: number;
  /** 点検の指摘（打刻漏れ・休憩の不足など）。 */
  issues: string[];
}

/** 期間（締めの期間）の集計（分）。 */
export interface AttTotals {
  workDays: number;
  workMinutes: number;
  overtimeMinutes: number;
  /** 週 40 時間を超えた分（overtimeMinutes に含む）。 */
  weeklyOvertimeMinutes: number;
  extraMinutes: number;
  nightMinutes: number;
  holidayMinutes: number;
  /** 月 60 時間を超えた法定外。 */
  over60Minutes: number;
  lateMinutes: number;
  earlyMinutes: number;
  leaveDays: number;
  /** 打刻の無い所定の労働日。 */
  missingDays: number;
}

/** 締めの期間。 */
export interface AttPeriod {
  start: string;
  end: string;
  /** 「2026 年 9 月分」のような呼び名（締め日の月）。 */
  label: string;
}

/** 締めの記録。 */
export interface AttClose {
  id: string;
  periodStart: string;
  periodEnd: string;
  status: 'closed' | 'reopened';
  closedBy: string | null;
  closedAt: string;
}

/** 有給の付与。 */
export interface LeaveGrant {
  id: string;
  employeeId: string;
  grantedOn: string;
  days: number;
  expiresOn: string;
  basis: 'auto' | 'manual';
  note: string;
}

/** 有給の取得。 */
export interface LeaveTake {
  id: string;
  employeeId: string;
  date: string;
  days: number;
  status: 'taken' | 'cancelled';
  source: 'screen' | 'secretary' | 'staff';
}

/** 有給の残りと取得義務。 */
export interface LeaveBalance {
  /** 使える日数（時効の来ていない付与から、取った分を古い順に引いたもの）。 */
  remaining: number;
  /** 付与ごとの残り（古い順）。 */
  grants: (LeaveGrant & { used: number; left: number })[];
  /** 取得義務（10 日以上の付与の、付与の日から 1 年）。無ければ `null`。 */
  obligation: { grantedOn: string; deadline: string; taken: number; required: number } | null;
}

/** 住民税の年度の額（6 月から翌年 5 月。第30.14節）。 */
export interface HrResidentTax {
  /** 年度（6 月の年。2026 なら 2026 年 6 月〜2027 年 5 月）。 */
  fiscalYear: number;
  municipality: string;
  /** 6 月分。 */
  june: number;
  /** 7 月以降の月額。 */
  monthly: number;
}

/** 従業員ごとの給与の情報（第30.5節・第30.10.1節）。 */
export interface HrPayrollProfile {
  employeeId: string;
  /** 甲欄（扶養控除等申告書を出している）か乙欄か。 */
  taxColumn: 'ko' | 'otsu';
  /** 源泉控除の扶養親族等の数。 */
  dependents: number;
  residentTax: HrResidentTax[];
  /** 通勤手当の月額と、そのうち非課税の額。 */
  commute: { means?: string; monthly?: number; taxFree?: number };
  /** 給与の振込先（段 4 の振込データに使う）。 */
  bank: { bank?: string; branch?: string; type?: '普通' | '当座'; number?: string; holder?: string };
}

/** 標準報酬月額の履歴。 */
export interface HrStandardPay {
  id: string;
  employeeId: string;
  /** 適用の月（YYYY-MM）。 */
  fromMonth: string;
  amount: number;
  kind: 'acquire' | 'regular' | 'change' | 'manual';
}

/** 家族。 */
export interface HrFamilyMember {
  id: string;
  employeeId: string;
  name: string;
  relation: string;
  birthDate: string | null;
  cohabiting: boolean;
  incomeEstimate: number | null;
  dependent: boolean;
}

/** 明細の 1 行。根拠は表の版・等級・料率・集計・端数処理（H-4）。 */
export interface PayLine {
  code: string;
  label: string;
  amount: number;
  kind: 'pay' | 'deduct';
  basis: Record<string, string | number>;
}

/** 明細（1 人・1 回）。 */
export interface PaySlip {
  id: string;
  runId: string;
  employeeId: string;
  employeeName?: string;
  gross: number;
  deductions: number;
  net: number;
  lines: PayLine[];
  warnings: string[];
}

/** 給与の回。 */
export interface PayRun {
  id: string;
  kind: 'monthly' | 'bonus' | 'yea' | 'correction';
  payMonth: string;
  payDate: string;
  periodStart: string;
  periodEnd: string;
  status: 'draft' | 'checked' | 'confirmed' | 'paid';
  /** 使った法令の表の版と監修の状態。 */
  law: Record<string, { version: string; source: string; reviewed: boolean }>;
  warnings: string[];
  calculatedAt: string;
}
