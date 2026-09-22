import type { ScheduleRule } from '@m2office/shared';

/**
 * 定時実行の次回時刻を求める。
 *
 * @param rule 毎日／毎週の規則
 * @param timezone 規則を解釈する基準（例: `Asia/Tokyo`）
 * @param after この時刻より後で最も近い回を探す
 * @returns 次回の実行時刻（ISO 形式、UTC）
 * @throws {RangeError} 規則の値が範囲外の場合
 *
 * @remarks
 * 時刻は利用者の暮らす地域の壁時計で解釈する。「毎週月曜 8 時」は
 * サーバーの時刻ではなく、利用者にとっての月曜 8 時である（仕様書 第6.5.1節）。
 * 夏時間の切り替わる瞬間の扱いは近似である。日本では問題にならない。
 */
export function nextRunAt(rule: ScheduleRule, timezone: string, after: Date): string {
  validateRule(rule);
  for (let d = 0; d <= 8; d++) {
    const day = localDate(new Date(after.getTime() + d * 86_400_000), timezone);
    if (rule.kind === 'weekly' && day.weekday !== rule.weekday) continue;
    const at = wallTimeToUtc(day.y, day.m, day.d, rule.hour, rule.minute, timezone);
    if (at.getTime() > after.getTime()) return at.toISOString();
  }
  // 規則が正しければ 8 日以内に必ず見つかる
  throw new RangeError('次回の実行時刻を求められませんでした');
}

/**
 * 規則の値を検証する。
 *
 * @throws {RangeError} 時・分・曜日が範囲外の場合
 */
export function validateRule(rule: ScheduleRule): void {
  if (!Number.isInteger(rule.hour) || rule.hour < 0 || rule.hour > 23) {
    throw new RangeError('時は 0〜23 で指定してください');
  }
  if (!Number.isInteger(rule.minute) || rule.minute < 0 || rule.minute > 59) {
    throw new RangeError('分は 0〜59 で指定してください');
  }
  if (rule.kind === 'weekly' && (!Number.isInteger(rule.weekday) || rule.weekday < 0 || rule.weekday > 6)) {
    throw new RangeError('曜日は 0（日）〜6（土）で指定してください');
  }
  if (rule.kind !== 'daily' && rule.kind !== 'weekly') {
    throw new RangeError('規則は daily か weekly で指定してください');
  }
}

/** 規則を利用者向けの言葉にする。 */
export function describeRule(rule: ScheduleRule): string {
  const time = `${rule.hour}:${String(rule.minute).padStart(2, '0')}`;
  if (rule.kind === 'daily') return `毎日 ${time}`;
  return `毎週${'日月火水木金土'[rule.weekday]}曜 ${time}`;
}

function localDate(at: Date, timezone: string): { y: number; m: number; d: number; weekday: number } {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone, year: 'numeric', month: 'numeric', day: 'numeric', weekday: 'short',
  }).formatToParts(at);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '';
  const weekday = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(get('weekday'));
  return { y: Number(get('year')), m: Number(get('month')), d: Number(get('day')), weekday };
}

/** ある地域の壁時計の時刻を UTC に直す。 */
function wallTimeToUtc(y: number, m: number, d: number, h: number, mi: number, timezone: string): Date {
  const guess = Date.UTC(y, m - 1, d, h, mi);
  const offset = offsetMs(new Date(guess), timezone);
  return new Date(guess - offset);
}

/** その時点での、地域の時刻と UTC の差（ミリ秒）。 */
function offsetMs(at: Date, timezone: string): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone, hourCycle: 'h23',
    year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric',
  }).formatToParts(at);
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value ?? 0);
  const asUtc = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour'), get('minute'));
  return asUtc - Math.floor(at.getTime() / 60_000) * 60_000;
}
