/**
 * @file 在庫の見張りの計算（仕様書 第29.14節）。無くなる見込みの日・残りわずか・使用期限の近いロット・発注の案。
 *
 * 推論を使わない決まった計算にする（同じ記録からは同じ答えを出す）。需要の予測（季節・流行）は Phase 2（Q-116）。
 * 使う速さは過去 4 週の「使用」の合計から出す。調整（棚卸しの差・廃棄）は使う速さに入れない。
 */

import type { InventoryItemView, InventorySettings, InventorySupplier } from '@m2office/shared';

/** 使う速さを出す期間（日）。 */
export const USAGE_DAYS = 28;
/** 届いてから、何日分を持っておくか（発注の数の目安）。 */
export const COVER_DAYS = 14;
/** 使用期限を知らせる日数（30 日前と 7 日前）。 */
export const EXPIRY_NOTICE_DAYS = [30, 7] as const;

/** 使用期限の近いロット。 */
export interface ExpiringLot {
  lot: string | null;
  expiresOn: string;
  qty: number;
  /** 期限までの日数（切れていれば負）。 */
  days: number;
}

/** 発注の案。 */
export interface OrderProposal {
  /** 発注する数（使う単位）。 */
  qty: number;
  /** 仕入れの単位での数（入り数があるとき）。 */
  packs: number | null;
  supplierId: string | null;
  supplierName: string | null;
  method: InventorySupplier['method'] | null;
  /** 仕入先の連絡先（メールの宛先・発注の画面の URL・電話番号）。 */
  contact: string | null;
  /** 理由（1 行）。 */
  reason: string;
}

/** 品目 1 つの見張りの結果。 */
export interface ForecastRow {
  itemId: string;
  name: string;
  unit: string;
  packUnit: string;
  packSize: number | null;
  available: number;
  /** 1 日に使う数（過去 4 週の平均）。 */
  dailyUse: number;
  /** あと何日で無くなるか。使っていなければ `null`。 */
  daysLeft: number | null;
  /** 仕入れにかかる日数（品目・仕入先・会社の既定の順）。 */
  leadDays: number;
  low: boolean;
  /** 仕入れにかかる日数より早く無くなる見込み。 */
  runningOut: boolean;
  expiring: ExpiringLot[];
  /** 発注の案（発注の案の機能を入れていて、残りわずか・無くなる見込みのとき）。 */
  proposal: OrderProposal | null;
}

const round2 = (n: number) => Math.round(n * 100) / 100;

/** 2 つの日付（YYYY-MM-DD）の間の日数。 */
export function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);
}

/**
 * 品目 1 つの見張りの結果を出す。
 *
 * @param used 過去 4 週に使った数（使う単位。使用の取り消しを差し引いたもの）
 * @param lots 残っているロット（数が正のもの）
 * @param today 今日（YYYY-MM-DD）
 */
export function forecastItem(
  item: InventoryItemView, used: number, lots: { lot: string | null; expiresOn: string | null; qty: number }[],
  supplier: InventorySupplier | null, settings: InventorySettings, today: string,
): ForecastRow {
  const dailyUse = round2(Math.max(0, used) / USAGE_DAYS);
  const daysLeft = dailyUse > 0 ? Math.max(0, Math.floor(item.available / dailyUse)) : null;
  const leadDays = item.leadDays ?? supplier?.leadDays ?? settings.leadDaysDefault;
  const threshold = item.lowThreshold ?? settings.lowDefault;
  const runningOut = daysLeft !== null && daysLeft <= leadDays;
  const expiring = lots
    .filter((l) => l.qty > 0 && l.expiresOn)
    .map((l) => ({ lot: l.lot, expiresOn: l.expiresOn!, qty: l.qty, days: daysBetween(today, l.expiresOn!) }))
    .filter((l) => l.days <= EXPIRY_NOTICE_DAYS[0])
    .sort((a, b) => a.days - b.days);
  let proposal: OrderProposal | null = null;
  if (settings.features.order && item.status === 'active' && (item.low || runningOut)) {
    // 届くまでに使う分と、届いてから 2 週間分と、目安の数を持てるだけ
    const target = dailyUse * (leadDays + COVER_DAYS) + threshold;
    let qty = Math.max(Math.ceil(target - item.available), Math.max(1, threshold));
    let packs: number | null = null;
    if (item.packSize && item.packSize > 0) {
      packs = Math.max(1, Math.ceil(qty / item.packSize));
      qty = packs * item.packSize;
    }
    // 案を出した理由と同じことを書く（無くなる見込みなら日数、そうでなければ目安）
    const reason = runningOut
      ? `過去 4 週で 1 日 ${dailyUse} ${item.unit}使用。あと ${daysLeft} 日で無くなる見込み（仕入れに ${leadDays} 日）`
      : `使える数が目安（${threshold} ${item.unit}）以下${dailyUse > 0 ? `。過去 4 週で 1 日 ${dailyUse} ${item.unit}使用` : ''}`;
    proposal = {
      qty, packs, supplierId: supplier?.id ?? null, supplierName: supplier?.name ?? null,
      method: supplier?.method ?? null, contact: supplier?.contact ?? null, reason,
    };
  }
  return {
    itemId: item.id, name: item.name, unit: item.unit, packUnit: item.packUnit, packSize: item.packSize,
    available: item.available, dailyUse, daysLeft, leadDays, low: item.low, runningOut, expiring, proposal,
  };
}

/** 見張りの結果を、急ぐ順（無くなる見込みの早い順・残りわずか・期限の近い順）に並べる。 */
export function sortForecast(rows: ForecastRow[]): ForecastRow[] {
  const rank = (r: ForecastRow) => (r.runningOut ? 0 : r.low ? 1 : r.expiring.length ? 2 : 3);
  return [...rows].sort((a, b) => rank(a) - rank(b)
    || (a.daysLeft ?? Infinity) - (b.daysLeft ?? Infinity)
    || (a.expiring[0]?.days ?? Infinity) - (b.expiring[0]?.days ?? Infinity)
    || a.name.localeCompare(b.name));
}
