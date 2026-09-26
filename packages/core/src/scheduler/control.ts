/**
 * @file 定時実行を画面と秘書から操作するときの共通の決まり。登録できる業務、入力の確かめ、停止・再開・今すぐ実行。
 *
 * @see 仕様書 第6.1.7節 定時実行の画面
 * @see 仕様書 第10.9.8節 定時実行の確認と制御
 */

import type { AgentDefinition, Schedule } from '@m2office/shared';
import { LOOKUP_AGENT_ID } from '../agents/index.js';
import { nextRunAt } from './rule.js';

/**
 * 定時実行に登録できる業務か。
 *
 * @remarks
 * ファイルを受け取る業務（入力に `fileId` を持つ。仕様書 第10.10.3節）と秘書の調べものは、
 * 毎回違うものを渡すため登録できない（第6.1.7節）。利用範囲と無効にした業務は、呼ぶ側で確かめる。
 */
export function isSchedulable(def: AgentDefinition): boolean {
  if (def.id === LOOKUP_AGENT_ID) return false;
  return !Object.keys((def.inputs as { properties?: object }).properties ?? {}).includes('fileId');
}

/**
 * 必須の入力のうち空のものの名前（欄の題名）を返す。空でなければ空の配列。
 *
 * @remarks 定時実行は本人が居ないときに動くため、保存の前に確かめる（第6.1.7節）。
 */
export function missingInputs(def: AgentDefinition, input: Record<string, unknown>): string[] {
  // 入力は JSON Schema の形（properties・required）で持つ
  const schema = def.inputs as { properties?: Record<string, { title?: string }>; required?: string[] };
  const props = schema.properties ?? {};
  return (schema.required ?? [])
    .filter((key) => {
      const v = input[key];
      return v === undefined || v === null || (typeof v === 'string' && v.trim() === '');
    })
    .map((key) => props[key]?.title ?? key);
}

/**
 * 停止・再開した定時実行を返す（保存はしない）。
 *
 * @remarks
 * 再開するときは次回の時刻を今から求め直す。止めていた間の回は起動しない（第6.1.7節）。
 * 状態が変わらなければ元のままを返す。
 */
export function withEnabled(s: Schedule, enabled: boolean, now: Date = new Date()): Schedule {
  if (s.enabled === enabled) return s;
  return enabled ? { ...s, enabled, nextRunAt: nextRunAt(s.rule, s.timezone, now) } : { ...s, enabled };
}

/**
 * 次の回を今にした定時実行を返す（保存はしない）。ワーカーの次の見回りで起動し、そのあとは元の繰り返しに戻る。
 *
 * @remarks 止めていたものも、今すぐ実行すると有効に戻す（それまでの画面の「今すぐ実行」と同じ）。
 */
export function triggeredNow(s: Schedule, now: Date = new Date()): Schedule {
  return { ...s, enabled: true, nextRunAt: now.toISOString() };
}
