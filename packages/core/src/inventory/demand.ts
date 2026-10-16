/**
 * @file 在庫の需要の予測（仕様書 第29.14節、Q-116、ADR-0103）。
 *
 * 週に 1 回（月曜の朝）、品目ごとに次の 4 週の使う量の見込みを出し、予測の目安と使う速さの倍率を決め直す。
 * **数は決まった計算で土台を出し**（直近 4 週と、去年の同じ時期の伸び）、AI はその土台に季節・行事を加味した倍率（0.5〜3 倍）と理由（1 行）だけを返す
 * （同じ記録から大きく違う数を出さないため）。会社が品目に目安を決めた品目（固定）の目安は変えない。発注はこれまでどおり承認の後。
 */

import type { InventoryItem, InventorySettings } from '@m2office/shared';
import type { LlmProvider } from '../llm/provider.js';
import type { InventoryStore } from './store.js';

/** 倍率の幅。 */
export const DEMAND_FACTOR_MIN = 0.5;
export const DEMAND_FACTOR_MAX = 3;
/** 見る期間（日）。 */
const WINDOW_DAYS = 28;
/** 1 回に AI に尋ねる品目の数の上限。 */
const AI_BATCH = 100;

const clamp = (n: number) => Math.min(DEMAND_FACTOR_MAX, Math.max(DEMAND_FACTOR_MIN, n));
const round2 = (n: number) => Math.round(n * 100) / 100;

/** 品目 1 つの土台（決まった計算）。 */
export interface DemandBase {
  itemId: string;
  name: string;
  category: string;
  unit: string;
  /** 直近 4 週の 1 日あたりの使用。 */
  recentDaily: number;
  /** 去年の同じ時期の伸び（去年の「次の 4 週」÷「その前の 4 週」）。去年の記録が無ければ 1。 */
  seasonal: number;
  /** 予測してよいか（4 週より前から使っている品目だけ）。 */
  enough: boolean;
}

/**
 * 土台を出す。
 *
 * @param recent 直近 4 週の使用
 * @param before その前の 4 週の使用（4 週より前から使っているかを見る）
 * @param lastYearPrev 去年の「今日までの 4 週」の使用
 * @param lastYearNext 去年の「今日からの 4 週」の使用
 */
export function demandBase(item: Pick<InventoryItem, 'id' | 'name' | 'category' | 'unit'>, recent: number, before: number, lastYearPrev: number, lastYearNext: number): DemandBase {
  const seasonal = lastYearPrev > 0 ? round2(clamp(lastYearNext / lastYearPrev)) : 1;
  return {
    itemId: item.id, name: item.name, category: item.category, unit: item.unit,
    recentDaily: round2(Math.max(0, recent) / WINDOW_DAYS), seasonal,
    enough: before > 0 || lastYearPrev > 0 || lastYearNext > 0,
  };
}

/** 推論が使えないときの倍率と理由（去年の同じ時期の伸びだけ）。 */
export function baseFactor(b: DemandBase): { factor: number; note: string } {
  return { factor: b.seasonal, note: b.seasonal !== 1 ? `去年の同じ時期は ${b.seasonal} 倍` : '' };
}

/**
 * AI に、季節と行事を加味した倍率と理由を尋ねる。答えが読めない品目は土台のまま。
 *
 * @param today 今日（YYYY-MM-DD。日本時間）
 */
export async function askDemandFactors(llm: LlmProvider | null, bases: DemandBase[], today: string): Promise<Map<string, { factor: number; note: string }>> {
  const out = new Map(bases.map((b) => [b.itemId, baseFactor(b)]));
  if (!llm || llm.name === 'stub' || llm.name === 'unconfigured' || bases.length === 0) return out;
  for (let i = 0; i < bases.length; i += AI_BATCH) {
    const batch = bases.slice(i, i + AI_BATCH);
    try {
      const res = await llm.complete({
        tier: 'fast', maxOutputTokens: 4000,
        messages: [{
          role: 'user',
          content: [
            `今日は ${today}（日本）です。日本の中小企業の在庫の品目について、次の 4 週の使う量が直近 4 週と比べて何倍になりそうかを見立ててください。`,
            '季節（暑さ寒さ）・年末年始・お盆・大型連休・年度の変わり目・行事を考えに入れ、去年の同じ時期の伸び（seasonal）も参考にしてください。分からなければ 1 にしてください。',
            `倍率は ${DEMAND_FACTOR_MIN}〜${DEMAND_FACTOR_MAX} に収め、理由は 30 字までで書いてください。`,
            'JSON の配列だけで答える: [{"id": "品目の ID", "factor": 倍率, "note": "理由"}]',
            JSON.stringify(batch.map((b) => ({ id: b.itemId, name: b.name, category: b.category, dailyUse: b.recentDaily, seasonal: b.seasonal }))),
          ].join('\n'),
        }],
      });
      const arr = JSON.parse(/\[[\s\S]*\]/.exec(res.text)?.[0] ?? '[]') as { id?: unknown; factor?: unknown; note?: unknown }[];
      for (const x of arr) {
        if (typeof x.id !== 'string' || !out.has(x.id) || typeof x.factor !== 'number' || !Number.isFinite(x.factor)) continue;
        out.set(x.id, { factor: round2(clamp(x.factor)), note: typeof x.note === 'string' ? x.note.trim().slice(0, 40) : '' });
      }
    } catch {
      // 読めなければ土台のまま
    }
  }
  return out;
}

/**
 * 1 社の品目の需要の予測を決め直す。
 *
 * @returns 予測を書いた品目の数
 * @remarks 予測の目安は「仕入れにかかる日数の間に使う見込みの数」（1 以上）。使っていない品目は目安を出さない（倍率だけ）
 */
export async function forecastDemand(
  deps: { store: InventoryStore; llm: LlmProvider | null; leadDaysOf(item: InventoryItem): number },
  tenantId: string, settings: InventorySettings, now: Date,
): Promise<number> {
  if (!settings.enabled || settings.features.forecast === false) return 0;
  const today = new Date(now.getTime() + 9 * 3_600_000).toISOString().slice(0, 10);
  const day = (offset: number) => new Date(Date.parse(`${today}T00:00:00+09:00`) + offset * 86_400_000).toISOString();
  const [items, recent, before, lyPrev, lyNext] = await Promise.all([
    deps.store.listItems(tenantId),
    deps.store.usageByItem(tenantId, day(-WINDOW_DAYS), day(0)),
    deps.store.usageByItem(tenantId, day(-2 * WINDOW_DAYS), day(-WINDOW_DAYS)),
    deps.store.usageByItem(tenantId, day(-365 - WINDOW_DAYS), day(-365)),
    deps.store.usageByItem(tenantId, day(-365), day(-365 + WINDOW_DAYS)),
  ]);
  const bases = items.map((i) => demandBase(i, recent.get(i.id) ?? 0, before.get(i.id) ?? 0, lyPrev.get(i.id) ?? 0, lyNext.get(i.id) ?? 0)).filter((b) => b.enough);
  const factors = await askDemandFactors(deps.llm, bases, today);
  const at = now.toISOString();
  let written = 0;
  for (const b of bases) {
    const item = items.find((i) => i.id === b.itemId)!;
    const f = factors.get(b.itemId) ?? baseFactor(b);
    const daily = b.recentDaily * f.factor;
    const low = daily > 0 ? Math.max(1, Math.ceil(daily * deps.leadDaysOf(item))) : null;
    await deps.store.setForecast(tenantId, b.itemId, { low, factor: f.factor, note: f.note, at });
    written++;
  }
  return written;
}

/** 予測を回す時か（月曜の朝 6 時から。前の予測から 5 日たっていれば）。 */
export function demandDue(now: Date, lastAt: string | null): boolean {
  const jst = new Date(now.getTime() + 9 * 3_600_000);
  if (jst.getUTCDay() !== 1 || jst.getUTCHours() < 6) return false;
  return !lastAt || now.getTime() - Date.parse(lastAt) > 5 * 86_400_000;
}

/**
 * 全社の需要の予測を、回す時の会社だけ回す（ワーカーが 1 時間ごとに呼ぶ）。
 *
 * @returns 予測を書いた品目の数
 * @remarks テナント境界: 会社ごとに、その会社の品目と記録だけを読む（不変則 I-2）。1 社の失敗はほかの会社を止めない
 */
export async function runDemandForecasts(
  deps: { listTenantIds(): Promise<string[]>; settingsOf(tenantId: string): Promise<InventorySettings>; store: InventoryStore; llmFor(tenantId: string): Promise<LlmProvider | null> },
  now: Date = new Date(),
): Promise<number> {
  let written = 0;
  for (const tenantId of await deps.listTenantIds()) {
    try {
      const settings = await deps.settingsOf(tenantId);
      if (!settings.enabled || settings.features.forecast === false) continue;
      const items = await deps.store.listItems(tenantId);
      const last = items.map((i) => i.forecast?.at ?? '').sort().at(-1) || null;
      if (!demandDue(now, last)) continue;
      const suppliers = new Map((await deps.store.listSuppliers(tenantId)).map((s) => [s.id, s]));
      written += await forecastDemand({
        store: deps.store, llm: await deps.llmFor(tenantId).catch(() => null),
        leadDaysOf: (i) => i.leadDays ?? (i.supplierId ? suppliers.get(i.supplierId)?.leadDays ?? null : null) ?? settings.leadDaysDefault,
      }, tenantId, settings, now);
    } catch {
      // 次の見回りで試す
    }
  }
  return written;
}

