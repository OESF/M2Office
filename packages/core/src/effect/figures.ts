/**
 * @file 効果の数字の計算（仕様書 第6.7.13節）。推計の削減時間と AI の費用を、期間ごとにプログラムが計算する。
 *
 * AI には計算させない（もっともらしい誤った数字を書くため）。ここは読み出した集計から、画面とレポートの数字を組むだけの純粋な関数にする。
 */

import type { EffectAgentFigure, EffectFigures, EffectPeriod, EffectPurposeFigure } from '@m2office/shared';

/** 日本時間の今日（`YYYY-MM-DD`）。 */
export const jstDay = (d: Date) => new Date(d.getTime() + 9 * 3_600_000).toISOString().slice(0, 10);

/** 月を `n` か月ずらす（`YYYY-MM`）。 */
export function addMonths(month: string, n: number): string {
  const [y, m] = month.split('-').map(Number) as [number, number];
  const t = y * 12 + (m - 1) + n;
  return `${Math.floor(t / 12)}-${String((t % 12) + 1).padStart(2, '0')}`;
}

/** 日本時間のその日の 0 時（UTC の時刻）。 */
const jstStart = (day: string) => new Date(`${day}T00:00:00+09:00`);

/** 期間（日本時間の暦）。`until` は含まない。 */
export interface EffectRange {
  from: Date;
  until: Date;
  /** 始めの日（`YYYY-MM-DD`） */
  fromDay: string;
  /** 終わりの日（含む） */
  toDay: string;
  label: string;
}

/**
 * その月の期間。今月なら今日まで。
 *
 * @param month `YYYY-MM`
 */
export function monthRange(month: string, now: Date): EffectRange {
  const today = jstDay(now);
  const from = jstStart(`${month}-01`);
  const nextStart = jstStart(`${addMonths(month, 1)}-01`);
  const current = today.slice(0, 7) === month;
  const until = current ? now : nextStart;
  const toDay = current ? today : jstDay(new Date(nextStart.getTime() - 1));
  const [y, m] = month.split('-').map(Number);
  return { from, until, fromDay: `${month}-01`, toDay, label: `${y} 年 ${m} 月${current ? `（${Number(today.slice(8))} 日まで）` : ''}` };
}

/**
 * 欄の期間。
 *
 * @param first その会社の最初の実行か AI の利用（導入からの始め）。無ければ今日
 */
export function periodRange(period: EffectPeriod, now: Date, first: Date | null): EffectRange {
  const thisMonth = jstDay(now).slice(0, 7);
  if (period === 'thisMonth') return monthRange(thisMonth, now);
  if (period === 'lastMonth') return monthRange(addMonths(thisMonth, -1), now);
  const fromDay = jstDay(first ?? now);
  const [y, m, d] = fromDay.split('-').map(Number);
  return { from: jstStart(fromDay), until: now, fromDay, toDay: jstDay(now), label: `導入から（${y} 年 ${m} 月 ${d} 日から）` };
}

/** 業務ごとの実行の集計（期間の分）。 */
export interface EffectRunRow {
  agentId: string;
  completed: number;
  savedMinutes: number;
}

/** 用途ごとの AI の利用の集計（期間の分。用途はまとめた後）。 */
export interface EffectAiRow {
  purpose: string;
  costJpy: number;
  calls: number;
}

/** 数字を組むのに要るもの。 */
export interface EffectFigureInput {
  period: EffectPeriod;
  range: EffectRange;
  runs: EffectRunRow[];
  ai: EffectAiRow[];
  /** 前の期間（導入からなら `null`） */
  previous: { label: string; runs: EffectRunRow[]; aiCostJpy: number } | null;
  /** 会社で使える業務（期間に完了しなかったものを出すのに使う） */
  usable: { id: string; name: string }[];
  /** 名前を引く業務（使えなくなった業務の過去の実行にも名前を付ける） */
  names: (agentId: string) => string;
  /** 会社で決めた標準所要時間（業務 ID → 分） */
  minutesPerRun: Record<string, number>;
  /** 公式の既定の標準所要時間 */
  defaults: Record<string, number>;
  /** 用途の名前 */
  purposeLabel: (purpose: string) => string;
  /** 完了しなかった業務に出さない業務（秘書の調べものなど、利用者が選んで使わないもの） */
  internal: Set<string>;
}

const round1 = (n: number) => Math.round(n * 10) / 10;
const round0 = (n: number) => Math.round(n);

/**
 * 期間の効果の数字を組む。
 *
 * @remarks 人ごとの数字は持たない（第6.7.10節）。削減時間をお金に換えない
 */
export function buildEffectFigures(x: EffectFigureInput): EffectFigures {
  const prevBy = new Map((x.previous?.runs ?? []).map((r) => [r.agentId, r.completed]));
  const byAgent: EffectAgentFigure[] = x.runs
    .filter((r) => r.completed > 0)
    .map((r) => ({
      agentId: r.agentId,
      name: x.names(r.agentId),
      completed: r.completed,
      savedMinutes: round1(r.savedMinutes),
      minutesPerRun: x.minutesPerRun[r.agentId] ?? x.defaults[r.agentId] ?? 0,
      customized: x.minutesPerRun[r.agentId] !== undefined,
      previousCompleted: x.previous ? (prevBy.get(r.agentId) ?? 0) : null,
    }))
    .sort((a, b) => b.savedMinutes - a.savedMinutes || b.completed - a.completed);
  const byPurpose: EffectPurposeFigure[] = x.ai
    .filter((a) => a.costJpy > 0 || a.calls > 0)
    .map((a) => ({ purpose: a.purpose, label: x.purposeLabel(a.purpose), costJpy: round0(a.costJpy), calls: a.calls }))
    .sort((a, b) => b.costJpy - a.costJpy || b.calls - a.calls);
  const savedMinutes = round1(x.runs.reduce((n, r) => n + r.savedMinutes, 0));
  const completed = x.runs.reduce((n, r) => n + r.completed, 0);
  const aiCost = x.ai.reduce((n, a) => n + a.costJpy, 0);
  const aiCalls = x.ai.reduce((n, a) => n + a.calls, 0);
  const done = new Set(byAgent.map((a) => a.agentId));
  return {
    period: x.period,
    label: x.range.label,
    from: x.range.fromDay,
    to: x.range.toDay,
    completed,
    savedMinutes,
    aiCostJpy: round0(aiCost),
    // AI の利用の記録が無い期間（記録を始める前など）は 0 円と言わず、比べられないとする
    costPerSavedHourJpy: savedMinutes > 0 && aiCalls > 0 ? round0(aiCost / (savedMinutes / 60)) : null,
    byAgent,
    byPurpose,
    previous: x.previous ? {
      label: x.previous.label,
      completed: x.previous.runs.reduce((n, r) => n + r.completed, 0),
      savedMinutes: round1(x.previous.runs.reduce((n, r) => n + r.savedMinutes, 0)),
      aiCostJpy: round0(x.previous.aiCostJpy),
    } : null,
    unusedAgents: x.usable.filter((a) => !done.has(a.id) && !x.internal.has(a.id)).map((a) => x.names(a.id)).slice(0, 8),
  };
}

/** 件数が「大きく変わった」とみなす境（前の期間との差がこの数以上で、かつ半分以上の増減）。 */
const CHANGE_MIN_RUNS = 5;
/** 標準所要時間を見直すよう勧める、期間の完了した件数の下限。 */
const REVIEW_MIN_RUNS = 10;

/**
 * レポートに渡す気づき（プログラムが選ぶ。第6.7.13節）。
 *
 * @returns 短い文の並び（AI はこれを言い直すだけ）
 */
export function effectNotices(f: EffectFigures): string[] {
  const out: string[] = [];
  for (const a of f.byAgent) {
    if (a.previousCompleted === null) continue;
    const diff = a.completed - a.previousCompleted;
    if (Math.abs(diff) >= CHANGE_MIN_RUNS && Math.abs(diff) >= Math.max(1, a.previousCompleted) / 2) {
      out.push(`「${a.name}」の完了が前の期間の ${a.previousCompleted} 件から ${a.completed} 件に${diff > 0 ? '増えました' : '減りました'}`);
    }
  }
  if (f.unusedAgents.length) out.push(`使える業務のうち、${f.unusedAgents.slice(0, 5).map((n) => `「${n}」`).join('・')}は期間に一度も完了しませんでした`);
  for (const a of f.byAgent) {
    if (a.completed >= REVIEW_MIN_RUNS && !a.customized) out.push(`「${a.name}」は ${a.completed} 件完了しましたが、標準所要時間（${a.minutesPerRun} 分）は公式の既定値のままです`);
  }
  return out.slice(0, 8);
}
