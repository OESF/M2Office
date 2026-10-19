/**
 * @file 在庫の見張りの計算（仕様書 第29.14節）。無くなる見込みの日・残りわずか・使用期限の近いロット・発注の案。
 *
 * 推論を使わない決まった計算にする（同じ記録からは同じ答えを出す）。需要の予測（Q-116。`demand.ts`）があれば、
 * その倍率で使う速さを、その目安で残りわずかを決める（会社が品目に目安を決めていればそれが先）。
 * 使う速さは過去 4 週の「使用」の合計から出す。調整（棚卸しの差・廃棄）は使う速さに入れない。
 */

import { discontinuedText, type InventoryDiscontinued, type InventoryItemView, type InventorySettings, type InventorySupplier } from '@m2office/shared';

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
  /** 需要の予測の理由（倍率が 1 でないとき。画面と朝のブリーフに出す。第29.14節）。 */
  forecastNote: string | null;
  /** 曜日の波の短い言い方（例: 「土日に多い」。第29.14.3節）。重みの無い品目は `null`。 */
  weekdayNote: string | null;
  /** 終売の見込み（第29.24.1節）。 */
  discontinued: InventoryDiscontinued | null;
  /** 入荷待ちの数といちばん早い届く予定の日（第29.14.4節）。 */
  onOrder?: number;
  onOrderDue?: string | null;
}

/**
 * 先の日ごとの営業日（曜日の波で、あと何日と届くまでに使う分を数えるため。第29.14.3節）。
 *
 * `open[k]`・`dows[k]` は明日から k 日目（0 が明日）が営業日か・その曜日（0 = 日曜）。`openLast28` は直近 28 日の営業日の数。
 */
export interface ForecastCalendar {
  open: boolean[];
  dows: number[];
  openLast28: number;
}

/** 曜日の重みを使う最少の条件（出庫のあった日の数と、使いはじめてからの日数。第29.14.3節）。 */
export const WEEKDAY_MIN_DAYS = 20;
export const WEEKDAY_MIN_AGE_DAYS = 56;
/** 曜日の重みを見る期間（週）。 */
export const WEEKDAY_WEEKS = 12;
/** 先の日を数える上限（日）。 */
const HORIZON_DAYS = 90;

/**
 * 品目の曜日の重みを出す（第29.14.3節）。営業日 1 日あたりの平均に対する、曜日ごとの比。営業しない曜日は 0。
 *
 * @param rows その品目の曜日ごとの使用（直近 12 週。予約の外・廃棄を除く）
 * @param openDows 営業する曜日（0 = 日曜）
 * @param today 今日（YYYY-MM-DD。使いはじめてからの日数を見る）
 * @returns 7 つの重み。記録が足りなければ `null`（平らに数える）
 */
export function weekdayWeights(rows: { dow: number; qty: number; days: number; first: string }[], openDows: number[], today: string): number[] | null {
  const open = openDows.length ? openDows : [0, 1, 2, 3, 4, 5, 6];
  const days = rows.reduce((a, r) => a + r.days, 0);
  const first = rows.map((r) => r.first).sort()[0];
  const ageDays = first ? (Date.parse(`${today}T00:00:00+09:00`) - Date.parse(first)) / 86_400_000 : 0;
  const perDow = Array.from({ length: 7 }, (_, d) => rows.filter((r) => r.dow === d).reduce((a, r) => a + r.qty, 0));
  const total = open.reduce((a, d) => a + perDow[d]!, 0);
  if (days < WEEKDAY_MIN_DAYS || ageDays < WEEKDAY_MIN_AGE_DAYS || total <= 0) return null;
  const avg = total / open.length;
  return perDow.map((q, d) => (open.includes(d) ? round2(q / avg) : 0));
}

const DOW_NAMES = ['日', '月', '火', '水', '木', '金', '土'];

/** 曜日の重みの短い言い方（重みが 1.5 以上の曜日を 2 つまで。例: 「土日に多い」「月・金曜に多い」）。目立つ曜日が無ければ空。 */
export function weekdayNote(weights: number[] | null | undefined): string {
  if (!weights || weights.length !== 7) return '';
  const top = weights.map((w, d) => ({ w, d })).filter((x) => x.w >= 1.5).sort((a, b) => b.w - a.w).slice(0, 2).map((x) => x.d).sort((a, b) => ((a + 6) % 7) - ((b + 6) % 7));
  if (top.length === 0) return '';
  if (top.length === 2 && top.includes(0) && top.includes(6)) return '土日に多い';
  return `${top.map((d) => DOW_NAMES[d]).join('・')}曜に多い`;
}

const round2 = (n: number) => Math.round(n * 100) / 100;

/** 残りわずかの目安（会社が品目に決めた値 → 需要の予測の目安 → 会社の既定。第29.14節）。 */
export function effectiveLow(item: Pick<InventoryItemView, 'lowThreshold' | 'forecast'>, settings: Pick<InventorySettings, 'lowDefault' | 'features'>): number {
  const predicted = settings.features.forecast !== false ? item.forecast?.low ?? null : null;
  return item.lowThreshold ?? predicted ?? settings.lowDefault;
}

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
  supplier: InventorySupplier | null, settings: InventorySettings, today: string, calendar?: ForecastCalendar,
): ForecastRow {
  // 需要の予測の倍率（次の 4 週の見込み）。切っている会社と、予測の無い品目は 1
  const factor = settings.features.forecast !== false ? item.forecast?.factor ?? 1 : 1;
  const dailyUse = round2((Math.max(0, used) / USAGE_DAYS) * factor);
  const leadDays = item.leadDays ?? supplier?.leadDays ?? settings.leadDaysDefault;
  // 曜日の波（第29.14.3節）。重みのある品目は、明日から日ごとに曜日の量を引いて数える。無ければ平らに割る
  const weights = calendar && settings.features.forecast !== false && item.forecast?.weekdays?.length === 7 ? item.forecast.weekdays : null;
  const perOpen = weights && calendar ? (Math.max(0, used) / Math.max(1, calendar.openLast28)) * factor : 0;
  const useOn = (k: number) => (weights && calendar ? (calendar.open[k] ? perOpen * weights[calendar.dows[k]!]! : 0) : dailyUse);
  /** 明日から n 日に使う見込みの合計。 */
  const useWithin = (n: number) => {
    if (!weights) return dailyUse * Math.max(0, n);
    let sum = 0;
    for (let k = 0; k < Math.min(n, HORIZON_DAYS); k++) sum += useOn(k);
    return sum;
  };
  // 入荷待ちの数は使える数に足して見る（発注してから届くまで「足りなくなりそう」を出さない。第29.14.4節）
  const onOrder = Math.max(0, item.onOrder ?? 0);
  const supply = item.available + onOrder;
  let daysLeft: number | null = null;
  if (dailyUse > 0 && weights && calendar) {
    let rest = supply;
    daysLeft = rest <= 0 ? 0 : HORIZON_DAYS;
    for (let k = 0; rest > 0 && k < HORIZON_DAYS; k++) {
      rest -= useOn(k);
      if (rest < 0) { daysLeft = k; break; }
    }
  } else if (dailyUse > 0) {
    daysLeft = Math.max(0, Math.floor(supply / dailyUse));
  }
  const waveNote = weights ? weekdayNote(weights) : '';
  const disc = item.discontinued ?? null;
  const threshold = effectiveLow(item, settings);
  const runningOut = daysLeft !== null && daysLeft <= leadDays;
  const expiring = lots
    .filter((l) => l.qty > 0 && l.expiresOn)
    .map((l) => ({ lot: l.lot, expiresOn: l.expiresOn!, qty: l.qty, days: daysBetween(today, l.expiresOn!) }))
    .filter((l) => l.days <= EXPIRY_NOTICE_DAYS[0])
    .sort((a, b) => a.days - b.days);
  let proposal: OrderProposal | null = null;
  // 終売済みの品目は発注の案を出さない（仕入れられないため。第29.24.1節）
  if (settings.features.order && item.status === 'active' && (item.low || runningOut) && disc?.status !== 'ended') {
    // 届くまでに使う分（曜日の波を入れる）と、届いてから 2 週間分と、目安の数を持てるだけ。
    // 終売予定の品目は、終売の日までに使う分を上限にする（日付が分からなければ、届いてから 2 週間分を足さない）
    const target = disc
      ? (disc.date ? useWithin(daysBetween(today, disc.date)) : useWithin(leadDays) + threshold)
      : useWithin(leadDays) + dailyUse * COVER_DAYS + threshold;
    // 入荷待ちの分は差し引き、まかなえていれば案を出さない
    let qty = disc || onOrder > 0 ? Math.ceil(target - supply) : Math.max(Math.ceil(target - item.available), Math.max(1, threshold));
    let packs: number | null = null;
    if (item.packSize && item.packSize > 0) {
      packs = Math.max(1, Math.ceil(qty / item.packSize));
      qty = packs * item.packSize;
    }
    // 案を出した理由と同じことを書く（無くなる見込みなら日数、そうでなければ目安）
    const basis = (factor !== 1 && item.forecast?.note ? `見込みで 1 日 ${dailyUse} ${item.unit}（${item.forecast.note}）` : `過去 4 週で 1 日 ${dailyUse} ${item.unit}使用`)
      + (waveNote ? `。${waveNote}` : '');
    const reason = (runningOut
      ? `${basis}。あと ${daysLeft} 日で無くなる見込み（仕入れに ${leadDays} 日）`
      : `使える数が目安（${threshold} ${item.unit}）以下${dailyUse > 0 ? `。${basis}` : ''}`)
      + (disc ? `。${discontinuedText(disc)}のため、最後の発注として終売までに使う分だけ（出典: ${disc.source}）` : '');
    if (qty > 0) proposal = {
      qty, packs, supplierId: supplier?.id ?? null, supplierName: supplier?.name ?? null,
      method: supplier?.method ?? null, contact: supplier?.contact ?? null, reason,
    };
  }
  return {
    itemId: item.id, name: item.name, unit: item.unit, packUnit: item.packUnit, packSize: item.packSize,
    available: item.available, dailyUse, daysLeft, leadDays, low: item.low, runningOut, expiring, proposal,
    forecastNote: factor !== 1 && item.forecast?.note ? item.forecast.note : null,
    weekdayNote: waveNote || null, discontinued: disc,
    ...(onOrder > 0 ? { onOrder, onOrderDue: item.onOrderDue ?? null } : {}),
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
