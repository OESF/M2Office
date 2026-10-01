/**
 * @file 本人が直接使った業務の答えを、秘書の記憶の材料にする。
 *
 * メニュー・API・定時実行から本人が使った業務の「依頼と答え」を取り出す。秘書が答えるとき（今日の分）と、
 * 1 日 1 回の学習（前日の分）で使う。秘書に頼んだ業務の結果はすでに会話ログにあるため除き、
 * 権限区画の業務は記憶に入れないため除く。
 *
 * @see 仕様書 第10.7.3節・第11.5.2節、ADR-0038
 */

import type { AgentDefinition, Job, Run, RunStep } from '@m2office/shared';
import type { Repository } from '../repository/types.js';
import { LOOKUP_AGENT_ID, MORNING_BRIEF } from '../agents/index.js';

/** 秘書の記憶の材料にする、業務 1 件の依頼と答え。 */
export interface WorkAnswer {
  runId: string;
  agentName: string;
  /** 何の件かが分かる短い言葉（入力の題名・質問など）。無ければ空。 */
  label: string;
  /** 最後の段の答えの文（切り詰め済み）。 */
  answer: string;
  endedAt: string;
}

/**
 * 秘書が本人に伝える業務か（秘書が起こしたもの・秘書の調べもの・朝のブリーフ）。
 *
 * @remarks これらの結果は、伝えたときに会話ログに残る（第10.11.7節）。記憶の材料として二重にしない。
 */
export function deliveredBySecretary(job: Pick<Job, 'origin' | 'agentId'>): boolean {
  return job.origin === 'secretary' || job.agentId === LOOKUP_AGENT_ID || job.agentId === MORNING_BRIEF.id;
}

/** 業務の入力のうち、何の件かが分かる短い言葉（題名・件名など）。 */
export function jobLabel(input: Record<string, unknown>, max = 60): string {
  for (const k of ['title', 'subject', 'question', 'request', 'topic', 'name']) {
    const v = input[k];
    if (typeof v === 'string' && v.trim()) {
      const t = v.trim();
      return t.length > max ? `${t.slice(0, max)}…` : t;
    }
  }
  return '';
}

/**
 * 秘書の記憶の材料にしてよい業務か。
 *
 * @remarks
 * 完了したもの、秘書が伝えるものでないもの、権限区画に属さない業務、学ばない業務でないもの（第12.12.3節）だけを通す（第16.3節）。
 * 定義が見つからない業務（外した拡張機能など）は、区画が分からないため通さない。
 */
export function learnableWork(item: { run: Run; job: Job }, agents: AgentDefinition[]): boolean {
  if (item.run.status !== 'completed' || !item.run.endedAt) return false;
  if (deliveredBySecretary(item.job)) return false;
  const def = agents.find((a) => a.id === item.job.agentId);
  return !!def && def.compartment === null && def.private !== true;
}

/**
 * 業務の答え。最後の段の文を使う。
 *
 * @remarks 途中の段の文にはツールの呼び出しの結果が混じるため使わない。成果物の本文も使わない。
 */
export function answerOfSteps(steps: Pick<RunStep, 'output'>[]): string {
  const last = steps.at(-1);
  const text = (last?.output as { text?: unknown } | null)?.text;
  return typeof text === 'string' ? text.trim() : '';
}

/**
 * 業務の依頼と答えを読む。
 *
 * @param items 材料にしてよいもの（{@link learnableWork} を通したもの）
 * @param maxChars 1 件の答えの長さの上限（字）
 * @returns 答えの文が取れたものだけ。読めなかったものは飛ばす（記憶が欠けても、秘書が使えなくなるよりよい）
 */
export async function readWorkAnswers(
  repo: Repository, tenantId: string, items: { run: Run; job: Job }[], agents: AgentDefinition[], maxChars: number,
): Promise<WorkAnswer[]> {
  const read = await Promise.all(items.map(async ({ run, job }) => {
    const steps = await Promise.resolve().then(() => repo.listRunSteps(tenantId, run.id)).catch(() => []);
    const answer = answerOfSteps(steps);
    if (!answer) return null;
    return {
      runId: run.id,
      agentName: agents.find((a) => a.id === job.agentId)?.name ?? '業務',
      label: jobLabel(job.input ?? {}),
      answer: answer.length > maxChars ? `${answer.slice(0, maxChars)}…` : answer,
      endedAt: run.endedAt ?? run.startedAt,
    } satisfies WorkAnswer;
  }));
  return read.filter((x): x is WorkAnswer => x !== null);
}
