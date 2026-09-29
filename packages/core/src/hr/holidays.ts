/**
 * @file 日本の国民の祝日（仕様書 第30.6.1節。会社が「祝日を休みにする」とき、勤怠の所定の労働日から外す）。
 *
 * 祝日法の決まりで計算する（2026 年以降）: 決まった日・ハッピーマンデー・春分と秋分（天文の近似式）・振替休日・国民の休日。
 * 春分と秋分の日は前の年の官報で決まるため、近似式の値と違う年があれば直す（2099 年まではこの式で合うとされる）。
 */

const pad = (n: number) => String(n).padStart(2, '0');
const ymd = (y: number, m: number, d: number) => `${y}-${pad(m)}-${pad(d)}`;
const dow = (y: number, m: number, d: number) => new Date(Date.UTC(y, m - 1, d)).getUTCDay();

/** その月の第 n 月曜日。 */
function nthMonday(y: number, m: number, n: number): number {
  const first = dow(y, m, 1);
  return 1 + ((8 - first) % 7) + 7 * (n - 1);
}

/** 春分の日・秋分の日（1980〜2099 年の近似式）。 */
export function equinoxDays(y: number): { spring: number; autumn: number } {
  const k = y - 1980;
  return {
    spring: Math.floor(20.8431 + 0.242194 * k - Math.floor(k / 4)),
    autumn: Math.floor(23.2488 + 0.242194 * k - Math.floor(k / 4)),
  };
}

const cache = new Map<number, Set<string>>();

/** その年の祝日（振替休日・国民の休日を含む。YYYY-MM-DD の集まり）。 */
export function japaneseHolidays(y: number): Set<string> {
  const hit = cache.get(y);
  if (hit) return hit;
  const { spring, autumn } = equinoxDays(y);
  const base = [
    ymd(y, 1, 1), ymd(y, 1, nthMonday(y, 1, 2)), ymd(y, 2, 11), ymd(y, 2, 23), ymd(y, 3, spring), ymd(y, 4, 29),
    ymd(y, 5, 3), ymd(y, 5, 4), ymd(y, 5, 5), ymd(y, 7, nthMonday(y, 7, 3)), ymd(y, 8, 11), ymd(y, 9, nthMonday(y, 9, 3)),
    ymd(y, 9, autumn), ymd(y, 10, nthMonday(y, 10, 2)), ymd(y, 11, 3), ymd(y, 11, 23),
  ];
  const set = new Set(base);
  const shift = (d: string, n: number) => {
    const t = new Date(`${d}T00:00:00Z`);
    t.setUTCDate(t.getUTCDate() + n);
    return t.toISOString().slice(0, 10);
  };
  // 国民の休日: 前の日と次の日が祝日の平日（日曜を除く）
  for (const d of [...set]) {
    const mid = shift(d, 1);
    if (!set.has(mid) && set.has(shift(d, 2)) && new Date(`${mid}T00:00:00Z`).getUTCDay() !== 0) set.add(mid);
  }
  // 振替休日: 祝日が日曜なら、次の祝日でない日
  for (const d of [...base].sort()) {
    if (new Date(`${d}T00:00:00Z`).getUTCDay() !== 0) continue;
    let n = shift(d, 1);
    while (set.has(n)) n = shift(n, 1);
    set.add(n);
  }
  cache.set(y, set);
  return set;
}

/** その日が祝日か。 */
export function isJapaneseHoliday(date: string): boolean {
  return japaneseHolidays(Number(date.slice(0, 4))).has(date);
}
