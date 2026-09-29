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
}

/** まだ設定していない会社の既定（締めは末日・支払は翌月 25 日。導入のときに会社が直す）。 */
export const DEFAULT_HR_SETTINGS: HrSettings = {
  enabled: false,
  office: { name: '', address: '', form: 'corporation' },
  health: { kind: 'kyokai', prefecture: '' },
  socialApply: 'mandatory',
  pay: { closingDay: 31, payDay: 25, payMonth: 'next' },
  procedures: 'self',
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
