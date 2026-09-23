/**
 * @file 後ろへ回した調べもの（仕様書 第10.11節）の状態を引く。
 *
 * 画面（`GET /v1/secretary/lookups`）と、音声の中継の双方から使う。
 * 同じ形を 2 か所に書かないための共通の口である。
 *
 * @see 仕様書 第10.11.6節 処理中であることを見せる
 * @see 仕様書 第10.11.7節 終わったことを伝える
 */

import { LOOKUP_AGENT_ID } from '@m2office/core';
import type { Repository } from '@m2office/core';

/** 調べもの 1 件の状態。 */
export interface LookupView {
  runId: string;
  request: string;
  status: string;
  /** 何をしているか。終わっていれば `null`。**いつ終わるかの見込みは作らない**（第10.11.5節）。 */
  progress: string | null;
  /** 答え。終わるまでは `null`。 */
  text: string | null;
  failureReason: string | null;
  /** 終わった時刻。まだ終わっていなければ `null`。 */
  endedAt: string | null;
}

/** 一度に見る件数。画面にも中継にも、これだけあれば足りる。 */
const LIMIT = 20;

/**
 * その人の調べものの状態を、新しい順に返す。
 *
 * @remarks
 * テナント境界: その会社の、その人が依頼したものだけを返す（不変則 I-2・I-9）。
 */
export async function listLookups(
  repo: Repository, tenantId: string, userId: string,
): Promise<LookupView[]> {
  const rows = await repo.listRunsWithJobs(tenantId, { limit: LIMIT, requestedBy: userId });
  const out: LookupView[] = [];
  for (const { run, job } of rows) {
    if (job.agentId !== LOOKUP_AGENT_ID) continue;
    const done = run.status === 'completed' || run.status === 'failed';
    const steps = await repo.listRunSteps(tenantId, run.id);
    out.push({
      runId: run.id,
      request: String(job.input['request'] ?? ''),
      status: run.status,
      progress: done ? null : progressOf(steps),
      text: run.status === 'completed' ? answerOf(steps) : null,
      failureReason: run.failureReason,
      endedAt: run.endedAt,
    });
  }
  return out;
}

/** 何をしているか。段の ID から作る。見込みの時間は出さない。 */
function progressOf(steps: { stepId: string; status: string }[]): string {
  const current = [...steps].reverse().find((s) => s.status === 'running') ?? steps.at(-1);
  return current?.stepId === 'answer' ? 'まとめています' : 'お調べしています';
}

/**
 * 調べものの答え。
 *
 * @remarks
 * **最後の段の文**を使う。途中の段の文には道具の呼び出しが混じることがあり、
 * それを利用者に見せない。
 */
function answerOf(steps: { output: unknown }[]): string {
  const last = steps.at(-1);
  return (last?.output as { text?: string } | null)?.text ?? '';
}
