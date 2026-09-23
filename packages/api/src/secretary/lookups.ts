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
  /** 結果を利用者に伝えたか（仕様書 第10.11.7節「持ち越し」）。 */
  told: boolean;
}

/** 一度に見る件数。画面にも中継にも、これだけあれば足りる。 */
const LIMIT = 20;

/**
 * 持ち越しの期限（日）。
 *
 * @remarks
 * これを過ぎたものは伝えない（仕様書 第10.11.7節）。
 * 日が経ってから急に答えを言い出すことを防ぐ。画面内のお知らせには残る。
 */
export const CARRY_OVER_DAYS = 7;

/**
 * その人の調べものの状態を、新しい順に返す。
 *
 * @remarks
 * テナント境界: その会社の、その人が依頼したものだけを返す（不変則 I-2・I-9）。
 */
export async function listLookups(
  repo: Repository, tenantId: string, userId: string,
): Promise<LookupView[]> {
  const rows = (await repo.listRunsWithJobs(tenantId, { limit: LIMIT, requestedBy: userId }))
    .filter(({ job }) => job.agentId === LOOKUP_AGENT_ID);
  const told = new Set(await repo.listToldLookups(tenantId, rows.map(({ run }) => run.id)));
  const out: LookupView[] = [];
  for (const { run, job } of rows) {
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
      told: told.has(run.id),
    });
  }
  return out;
}

/**
 * まだ伝えていない調べものを取り出し、**伝えたことを先に記録する**（仕様書 第10.11.7節）。
 *
 * @param now 現在時刻。持ち越しの期限を測るのに使う
 * @returns 伝えるべきもの。記録できたものだけが入る
 *
 * @remarks
 * 画面と音声の双方から呼ばれる。記録を先に取り、取れた側だけが伝えるため、
 * 両方を開いていても、伝えるのは一方だけになる。
 *
 * 終わってから {@link CARRY_OVER_DAYS} 日を過ぎたものは伝えない。
 */
export async function claimUntold(
  repo: Repository, tenantId: string, userId: string, now: Date = new Date(),
): Promise<LookupView[]> {
  const limit = now.getTime() - CARRY_OVER_DAYS * 86_400_000;
  const out: LookupView[] = [];
  for (const x of await listLookups(repo, tenantId, userId)) {
    if (x.status !== 'completed' && x.status !== 'failed') continue;
    if (x.told) continue;
    // 日が経ちすぎたものは伝えない。ただし記録は取り、以降も蒸し返さない
    const fresh = x.endedAt !== null && Date.parse(x.endedAt) >= limit;
    const claimed = await repo.claimLookupDelivery(tenantId, x.runId);
    if (claimed && fresh) out.push(x);
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
