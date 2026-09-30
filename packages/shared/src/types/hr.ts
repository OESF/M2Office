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
  /** 振込データの振込元（第30.10.3節）。 */
  transfer: HrTransferSettings;
  /** 労務カレンダーに使う会社の決まり（第30.19.1節）。 */
  duties: HrDutySettings;
  /** 労働条件通知書の会社の定め（第30.5.3節）。担当者が書いた文を次からの既定にする。 */
  notice: HrNoticeSettings;
}

/** 労務カレンダーに使う会社の決まり。 */
export interface HrDutySettings {
  /** 源泉所得税の納期の特例の承認を受けているか。 */
  withholdingSpecial: boolean;
  /** 住民税の納期の特例の承認を受けているか。 */
  residentSpecial: boolean;
  /** 定期健康診断の月（1〜12。決めていなければ `null`）。 */
  healthCheckMonth: number | null;
}

/** 労働条件通知書の会社の定め（文のまま載せる）。 */
export interface HrNoticeSettings {
  raise: string;
  bonus: string;
  severance: string;
  /** 退職に関する事項（解雇の事由を含む）。 */
  retirement: string;
  /** 相談の窓口（パート・有期の人に明示する）。 */
  consultation: string;
  other: string;
}

/** 労務カレンダーの期限 1 つ（第30.19.1節）。 */
export interface HrDeadline {
  /** 期限の日（YYYY-MM-DD）。 */
  date: string;
  /** 期間の始まり（年度更新のように期間があるもの）。 */
  from?: string;
  kind: 'withholding' | 'resident' | 'resident-switch' | 'labor-insurance' | 'santei' | 'yea' | 'annual-report' | 'agreement' | 'health-check' | 'hire-check' | 'contract-end' | 'task' | 'leave-obligation' | 'law-change' | 'law-stale' | 'bonus-report';
  title: string;
  detail: string;
  employeeId?: string;
  /** 過ぎていて済んでいない（手続き）。 */
  overdue?: boolean;
}

/** 振込データ（全銀協の形式）の振込元。名前は半角のカナにして使う。 */
export interface HrTransferSettings {
  /** 総合振込（種別 21）か給与振込（種別 11）か。 */
  format: 'sogo' | 'kyuyo';
  /** 委託者コード（銀行が決める 10 桁）。 */
  clientCode: string;
  /** 委託者名（カナ）。 */
  clientName: string;
  bankCode: string;
  bankName: string;
  branchCode: string;
  branchName: string;
  accountType: '普通' | '当座';
  accountNumber: string;
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
  transfer: { format: 'sogo', clientCode: '', clientName: '', bankCode: '', bankName: '', branchCode: '', branchName: '', accountType: '普通', accountNumber: '' },
  duties: { withholdingSpecial: false, residentSpecial: false, healthCheckMonth: null },
  notice: { raise: '', bonus: '', severance: '', retirement: '', consultation: '', other: '' },
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
  /** 更新の上限（通算の期間か回数。無ければ空）。 */
  renewalLimit: string;
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
  /** 年税額（通知書から読んだとき）。 */
  annual?: number;
  /** 決定通知書から読み取った額か（第30.10.3節）。 */
  source?: 'notice' | 'manual';
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
  /** 給与の振込先（振込データに使う）。銀行コードは 4 桁、支店コードは 3 桁。名義はカナ（空なら台帳のふりがな）。 */
  bank: { bank?: string; bankCode?: string; branch?: string; branchCode?: string; type?: '普通' | '当座'; number?: string; holder?: string };
  /** 明細を画面で受け取ることに本人が同意した日時（無ければ `null`。第30.10.3節）。 */
  payslipConsentAt?: string | null;
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
  /** 勤怠の期間の集計（賃金台帳に使う）。 */
  attendance?: Partial<AttTotals>;
  /** 計算の控え（社会保険料等を引いた後の額・標準賞与額・課税の支給額・社会保険料等・所得税。賞与と年末調整に使う）。 */
  meta?: { taxable?: number; stdBonusHealth?: number; stdBonusPension?: number; taxablePay?: number; social?: number; tax?: number; yea?: YeaResult };
}

/** 障害者の区分（年末調整。第30.15.1節）。 */
export type YeaDisability = 'none' | 'general' | 'special' | 'special-cohabiting';

/** 年末調整の申告の、配偶者・扶養親族の 1 人。 */
export interface YeaPerson {
  name: string;
  relation: string;
  birthDate: string | null;
  /** その年の合計所得金額の見積もり（円）。 */
  incomeEstimate: number;
  disability: YeaDisability;
  /** 同居しているか（同居老親等・同居特別障害者の判定）。 */
  cohabiting: boolean;
}

/** 年末調整の申告（年ごと・人ごと。第30.15.1節）。 */
export interface YeaDeclaration {
  year: number;
  self: {
    /** 給与以外の所得の見積もり（合計所得金額に足す）。 */
    otherIncome: number;
    disability: 'none' | 'general' | 'special';
    widow: 'none' | 'widow' | 'single-parent';
    workingStudent: boolean;
  };
  spouse: YeaPerson | null;
  dependents: YeaPerson[];
  /** 保険料控除申告書の支払った保険料（円）。 */
  insurance: {
    lifeNewGeneral: number; lifeOldGeneral: number; lifeNewCare: number; lifeNewPension: number; lifeOldPension: number;
    earthquake: number; oldLongTerm: number; social: number; smallBusiness: number;
  };
  /** 住宅借入金等特別控除申告書の控除額（年末調整で引く税額）。 */
  housingCredit: number;
  /** 年の途中で入社した人の、前の勤め先の源泉徴収票の額。 */
  previousJob: { pay: number; social: number; tax: number } | null;
}

/** 年末調整の申告の状態。 */
export interface YeaDeclarationView {
  employeeId: string;
  employeeName?: string;
  year: number;
  data: YeaDeclaration;
  submittedAt: string | null;
  checkedAt: string | null;
}

/** 年末調整の計算の結果（源泉徴収票に使う）。 */
export interface YeaResult {
  year: number;
  /** 支払金額（この会社の分 ＋ 前の勤め先の分）。 */
  pay: number;
  payHere: number;
  payPrevious: number;
  /** 給与所得控除後の給与等の金額（所得金額調整控除の後）。 */
  afterDeduction: number;
  incomeAdjustment: number;
  /** 所得控除の内訳（円）。 */
  deductions: {
    social: number; smallBusiness: number; life: number; earthquake: number; spouse: number; spouseSpecial: number;
    dependents: number; specificRelative: number; basic: number; disability: number; widow: number; student: number;
  };
  deductionTotal: number;
  /** 課税給与所得金額（1,000 円未満切り捨て）。 */
  taxable: number;
  calculatedTax: number;
  housingCredit: number;
  /** 年調年税額（復興特別所得税を含む。100 円未満切り捨て）。 */
  annualTax: number;
  /** 源泉徴収した額（この会社の分 ＋ 前の勤め先の分）。 */
  withheld: number;
  /** 過不足（プラスは還付、マイナスは不足）。 */
  difference: number;
  /** 扶養の数（源泉徴収票の記載事項）。 */
  counts: { spouse: 'none' | 'general' | 'elderly' | 'special'; specific: number; elderly: number; elderlyCohabiting: number; general: number; under16: number; disabilityGeneral: number; disabilitySpecial: number; disabilitySpecialCohabiting: number; specificRelative: number };
  /** 根拠（計算の順）。 */
  basis: [string, string][];
}

/** 回ごと・人ごとの調整の行（第30.10.4節）。一回だけの支給か控除。 */
export interface PayAdjustment {
  id: string;
  employeeId: string;
  employeeName?: string;
  kind: 'monthly' | 'bonus';
  payMonth: string;
  label: string;
  direction: 'pay' | 'deduct';
  amount: number;
  /** 所得税の対象か。 */
  taxable: boolean;
  /** 雇用保険の賃金に入れるか。 */
  insurable: boolean;
  reason: string;
  source: 'manual' | 'correction' | 'yea';
}

/** 賞与の回の入力（第30.11.1節）。 */
export interface BonusPlan {
  payMonth: string;
  payDate: string;
  /** 賞与の計算期間が 6 か月を超えるか。 */
  longPeriod: boolean;
  /** 人ごとの賞与の額（従業員の ID → 円）。 */
  amounts: Record<string, number>;
}

/** 回の点検の 1 つ（第30.10.3節）。`stop` が残っていれば確定できない。 */
export interface PayCheck {
  level: 'stop' | 'check';
  code: string;
  text: string;
  employeeId?: string;
  employeeName?: string;
}

/** 試しの計算の比べ（1 人）。 */
export interface PayTrialRow {
  employeeId: string | null;
  name: string;
  items: { label: string; ours: number | null; theirs: number | null; diff: number | null }[];
}

/** 試しの計算の比べ。 */
export interface PayTrialCompare {
  /** 今の方法の表の列と、当てた項目。 */
  columns: { header: string; item: string | null }[];
  rows: PayTrialRow[];
  /** 表にあって台帳に当てられなかった名前。 */
  unmatched: string[];
  /** 表に無く、M2Office だけで計算した人。 */
  missing: string[];
}

/** 給与の回。 */
export interface PayRun {
  id: string;
  kind: 'monthly' | 'bonus' | 'yea' | 'correction' | 'trial';
  payMonth: string;
  payDate: string;
  periodStart: string;
  periodEnd: string;
  status: 'draft' | 'checked' | 'confirmed' | 'paid';
  /** 使った法令の表の版と監修の状態。 */
  law: Record<string, { version: string; source: string; reviewed: boolean }>;
  warnings: string[];
  calculatedAt: string;
  /** 点検（第30.10.3節）。 */
  checks: PayCheck[];
  confirmedAt?: string | null;
  confirmedBy?: string | null;
  /** 監修前の表で確定した（開発の環境だけ）。 */
  confirmedUnverified?: boolean;
  confirmRequestedAt?: string | null;
  transferAt?: string | null;
  /** 試しの計算の比べ。 */
  compare?: PayTrialCompare | null;
  /** 訂正の回の元の回。 */
  sourceRunId?: string | null;
}
