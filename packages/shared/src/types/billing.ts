/**
 * @file クラウド版の料金と支払いの型（仕様書 第23.4.5節、ADR-0123・ADR-0124）。画面と API とワーカーで同じ形を使う。
 */

/** 請求の区分。`none` は請求しない会社（運営者が作った会社・体験版・ローカルの形）。 */
export type BillingCategory = 'starter' | 'card' | 'transfer' | 'none';

/** 請求書の発行者（発行した時点の写し）。 */
export interface InvoiceIssuer {
  name: string;
  postalCode: string;
  address: string;
  contact: string;
  /** 適格請求書の登録番号。 */
  registrationNo: string;
  /** 振込先（振込の請求だけ）。 */
  bankAccount: string;
}

/** クラス（第23.4.5節「クラス」）。 */
export type BillingClass = 'starter' | 'small_business' | 'business' | 'enterprise';

/** 契約の形。 */
export type ContractTerm = 'monthly' | 'annual';

/** スモールビジネスの上限（有料 20 人＋無料の 1 人）。データベースの `ops.billing_user_limit` と同じ値。 */
export const SMALL_BUSINESS_MAX_USERS = 21;
/** ビジネスの上限。データベースの `ops.billing_user_limit` と同じ値。 */
export const BUSINESS_MAX_USERS = 50;

/** 請求の種類。`monthly` は月間、`annual` は年間の 12 か月、`annual_add` は増えた席、`fixed` は定額の年額。 */
export type InvoiceKind = 'monthly' | 'annual' | 'annual_add' | 'fixed';

/** 1 通の請求。 */
export interface InvoiceView {
  id: string;
  number: string;
  tenantId: string;
  /** 月間は請求の対象の月、それ以外は発行の月（YYYY-MM）。 */
  month: string;
  kind: InvoiceKind;
  /** 有料の人数（定額は上限。上限なしは 0）。 */
  seats: number;
  /** 何か月分か。 */
  months: number;
  termStart: string | null;
  termEnd: string | null;
  /** 1 人 1 か月の単価（定額は年額）。 */
  unitPriceJpy: number;
  subtotalJpy: number;
  taxPercent: number;
  taxJpy: number;
  totalJpy: number;
  method: 'card' | 'transfer';
  status: 'open' | 'paid' | 'void';
  chargeState: 'pending' | 'failed' | 'done' | null;
  chargeError: string | null;
  dueDate: string;
  issuedAt: string;
  paidAt: string | null;
  dunningStage: number;
  issuer: InvoiceIssuer;
  recipient: { name: string };
}

/** 会社の管理者が見る、ご利用料金。 */
export interface BillingView {
  category: BillingCategory;
  billingClass: BillingClass;
  /** クラスの人数の上限（招待中の人も数える）。null は上限なし。 */
  seatLimit: number | null;
  /** 招待してまだログインしていない人の数。 */
  invited: number;
  /** 契約の形。null は未選択。 */
  contractTerm: ContractTerm | null;
  /** 年間契約の期間（1 人の間は null）。 */
  termStart: string | null;
  termEnd: string | null;
  /** 年間契約の席（同時に使った有料の人数の最大）。 */
  paidSeats: number;
  /** この年間契約の単価。 */
  annualUnitJpy: number | null;
  /** 月間から年間へ移る日。 */
  annualStartOn: string | null;
  /** 更新のときに移る形。 */
  nextTerm: 'monthly' | null;
  /** 定額の年額（ビジネスとエンタープライズ）。 */
  fixedAnnualJpy: number | null;
  /** 今日（日本時間。YYYY-MM-DD）。 */
  today: string;
  /** 問い合わせの窓口（運営主体の設定）。 */
  contact: string;
  billingName: string;
  /** 解約の申し出があるとき、使える最後の日。 */
  cancelOn: string | null;
  month: string;
  /** いまの人数。 */
  seats: number;
  /** 今月の人数の最大（月間契約の請求のもと）。 */
  peak: number;
  monthlyPriceJpy: number;
  annualPriceJpy: number;
  taxPercent: number;
  /** 銀行振込を選べるか（振込先と登録番号を運営が設定している）。 */
  transferReady: boolean;
  /** カードを選べるか（支払いの口が設定されている）。 */
  cardReady: boolean;
  invoices: InvoiceView[];
}

/** 料金の計算の結果。 */
export interface BillingAmount {
  subtotalJpy: number;
  taxJpy: number;
  totalJpy: number;
}

/**
 * 利用者の数から、有料の人数を求める。
 *
 * @param users 利用者の数
 * @returns 最初の 1 人はずっと無料なので、1 を引いた人数（第23.4.5節、Q-300）
 */
export function paidSeatCount(users: number): number {
  return Math.max(users - 1, 0);
}

/**
 * スモールビジネスの料金を計算する（第23.4.5節「スモールビジネスの料金」）。
 *
 * @param paidSeats 有料の人数（{@link paidSeatCount}）
 * @param unitPriceJpy 1 人 1 か月の単価（税別）
 * @param taxPercent 消費税の率（%）
 * @param months 何か月分か
 * @returns 税別・消費税・税込
 *
 * @remarks 消費税は請求書ごとに 1 回計算し、1 円未満を切り捨てる。データベースの締め（`ops.billing_make_invoice`）と同じ計算にする
 */
export function billingAmount(paidSeats: number, unitPriceJpy: number, taxPercent: number, months = 1): BillingAmount {
  if (paidSeats <= 0) return { subtotalJpy: 0, taxJpy: 0, totalJpy: 0 };
  const subtotalJpy = paidSeats * unitPriceJpy * months;
  const taxJpy = Math.floor((subtotalJpy * taxPercent) / 100);
  return { subtotalJpy, taxJpy, totalJpy: subtotalJpy + taxJpy };
}

/**
 * 契約の終わりまでの月数を求める。1 か月に満たない分は切り上げる。
 *
 * @param from 席を増やした日（YYYY-MM-DD）
 * @param termEnd 契約の終わりの日（YYYY-MM-DD）
 * @returns 月数。契約が終わっていれば 0
 *
 * @example `remainingMonths('2027-03-10', '2027-11-19')` は 9（8 か月と 10 日の切り上げ）
 *
 * @remarks データベースの `ops.billing_term_months` と同じ結果にする
 */
export function remainingMonths(from: string, termEnd: string): number {
  const end = new Date(`${termEnd}T00:00:00Z`);
  end.setUTCDate(end.getUTCDate() + 1);
  const start = new Date(`${from}T00:00:00Z`);
  if (end <= start) return 0;
  const months = (end.getUTCFullYear() - start.getUTCFullYear()) * 12 + end.getUTCMonth() - start.getUTCMonth();
  return end.getUTCDate() > start.getUTCDate() ? months + 1 : months;
}

/** {@link inviteEffect} の結果。 */
export type InviteEffect =
  /** 招けない。支払いの方法の登録が先。 */
  | { kind: 'payment_required' }
  /** クラスの上限に達していて招けない。 */
  | { kind: 'class_limit'; limit: number }
  /** 料金は増えない。 */
  | { kind: 'free' }
  /** 月間契約: 今月の料金がこの額になる。 */
  | { kind: 'monthly'; paidSeats: number; totalJpy: number }
  /** 年間契約: 席が増え、この額を翌月 1 日に請求する。 */
  | { kind: 'annual_add'; months: number; totalJpy: number }
  /** 年間契約: 2 人目で期間が始まる。 */
  | { kind: 'annual_start'; totalJpy: number };

/**
 * 招待したら料金がどう変わるかを求める（第23.4.5節「招待の確かめ」）。
 *
 * @param view いまのご利用料金
 * @returns 増えないなら `free`。入れ替えの範囲では何も聞かないために使う
 */
export function inviteEffect(view: BillingView): InviteEffect {
  if (view.category === 'none') return { kind: 'free' };
  const users = view.seats + view.invited + 1;
  if (view.seatLimit !== null && users > view.seatLimit) {
    return view.category === 'starter' ? { kind: 'payment_required' } : { kind: 'class_limit', limit: view.seatLimit };
  }
  if (view.billingClass !== 'small_business') return { kind: 'free' };
  const paid = paidSeatCount(users);
  if (view.contractTerm === 'annual') {
    if (paid <= view.paidSeats) return { kind: 'free' };
    const unit = view.annualUnitJpy ?? view.annualPriceJpy;
    if (!view.termStart || !view.termEnd) return { kind: 'annual_start', totalJpy: billingAmount(paid, unit, view.taxPercent, 12).totalJpy };
    const months = remainingMonths(view.today, view.termEnd);
    return { kind: 'annual_add', months, totalJpy: billingAmount(paid - view.paidSeats, unit, view.taxPercent, months).totalJpy };
  }
  if (users <= view.peak) return { kind: 'free' };
  return { kind: 'monthly', paidSeats: paid, totalJpy: billingAmount(paid, view.monthlyPriceJpy, view.taxPercent).totalJpy };
}
