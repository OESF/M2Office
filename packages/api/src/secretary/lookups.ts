/**
 * @file 後ろへ回した調べものと、秘書が頼んだ業務（仕様書 第10.11節・第10.9.6節）の状態を引く。
 *
 * 画面（`GET /v1/secretary/lookups`）と、音声の中継の双方から使う。
 * 同じ形を 2 か所に書かないための共通の口である。
 *
 * @see 仕様書 第10.11.6節 処理中であることを見せる
 * @see 仕様書 第10.11.7節 終わったことを伝える
 */

import { LOOKUP_AGENT_ID, OFFICIAL_AGENTS } from '@m2office/core';
import type { Repository } from '@m2office/core';
import { randomUUID } from 'node:crypto';

/** 調べもの（または秘書が頼んだ業務）1 件の状態。 */
export interface LookupView {
  runId: string;
  request: string;
  /** 秘書が頼んだ業務の名前。調べものなら `null`（利用者から見れば秘書が自分で調べたもの。第10.11.7節）。 */
  agentName: string | null;
  status: string;
  /** 終わったか（完了・失敗・中止・期限切れ）。 */
  done: boolean;
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
  repo: Repository, tenantId: string, userId: string, nameOf: (agentId: string) => string | undefined = officialName,
): Promise<LookupView[]> {
  // 秘書が起こしたもの（調べもの・頼んだ業務）と、本人がメニューから起こした調べもの
  const rows = (await repo.listRunsWithJobs(tenantId, { limit: LIMIT, requestedBy: userId }))
    .filter(({ job }) => job.origin === 'secretary' || job.agentId === LOOKUP_AGENT_ID);
  const told = new Set(await repo.listToldLookups(tenantId, rows.map(({ run }) => run.id)));
  const out: LookupView[] = [];
  for (const { run, job } of rows) {
    const done = DONE.has(run.status);
    const isLookup = job.agentId === LOOKUP_AGENT_ID;
    const name = isLookup ? null : (nameOf(job.agentId) ?? '業務');
    const steps = await repo.listRunSteps(tenantId, run.id);
    const firstText = Object.values(job.input).find((v): v is string => typeof v === 'string' && v.trim() !== '');
    out.push({
      runId: run.id,
      request: String(job.input['request'] ?? firstText ?? name ?? ''),
      agentName: name,
      status: run.status,
      done,
      progress: done ? null : run.status === 'awaiting_approval' ? '承認を待っています' : isLookup ? progressOf(steps) : `「${name}」を進めています`,
      text: run.status === 'completed' ? await resultOf(repo, tenantId, run.id, steps) : null,
      failureReason: done && run.status !== 'completed' ? (run.failureReason ?? (run.status === 'cancelled' ? '中止されました' : '期限が切れました')) : run.failureReason,
      endedAt: run.endedAt,
      told: told.has(run.id),
    });
  }
  return out;
}

/** 終わった状態。 */
const DONE = new Set(['completed', 'failed', 'cancelled', 'expired']);

/** 公式の業務の名前（拡張機能の業務は呼び出し側が引く）。 */
const officialName = (agentId: string) => OFFICIAL_AGENTS.find((a) => a.id === agentId)?.name;

/**
 * 伝える結果。最後の段の文に、成果物（スライド・文書）の題名と開くリンクを添える（第10.9.6節）。
 *
 * @remarks 成果物の本文は添えない（長い。開けば見られる）
 */
async function resultOf(repo: Repository, tenantId: string, runId: string, steps: { output: unknown }[]): Promise<string> {
  const text = answerOf(steps);
  // 成果物が読めなくても、答えは伝える
  const artifacts = await Promise.resolve().then(() => repo.listArtifacts(tenantId, runId)).catch(() => []);
  const lines = artifacts.map((a) => {
    const link = /^開く: (\S+)/m.exec(a.body)?.[1];
    return `- ${a.title}${link ? ` ${link}` : ''}`;
  });
  return [text, ...(lines.length ? ['', '作ったもの:', ...lines] : [])].join('\n').trim();
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
  nameOf: (agentId: string) => string | undefined = officialName,
): Promise<LookupView[]> {
  const limit = now.getTime() - CARRY_OVER_DAYS * 86_400_000;
  const out: LookupView[] = [];
  for (const x of await listLookups(repo, tenantId, userId, nameOf)) {
    if (!x.done) continue;
    if (x.told) continue;
    // 日が経ちすぎたものは伝えない。ただし記録は取り、以降も蒸し返さない
    const fresh = x.endedAt !== null && Date.parse(x.endedAt) >= limit;
    const claimed = await repo.claimLookupDelivery(tenantId, x.runId);
    if (claimed && fresh) {
      out.push(x);
      await remember(repo, tenantId, userId, x);
    }
  }
  return out;
}

/**
 * 伝えた結果を会話ログに残す（第10.11.7節）。「さっきの行程をカレンダーに入れて」のような続きの依頼に答えるため。
 *
 * @remarks 本人が「会話を残す」を切っていれば残さない。残せなくても伝えることは止めない
 */
async function remember(repo: Repository, tenantId: string, userId: string, x: LookupView): Promise<void> {
  try {
    const prefs = await repo.getUserSettings(tenantId, userId);
    if (!prefs.memory.keepConversations) return;
    await repo.appendConversation({
      id: randomUUID(), tenantId, userId,
      message: `（${x.agentName ? `「${x.agentName}」に頼んだ` : 'お調べした'}結果）${x.request}`,
      reply: x.status === 'completed' ? (x.text ?? '') : `できませんでした。${x.failureReason ?? ''}`,
      layer: 'full', agentId: null, runId: x.runId, createdAt: new Date().toISOString(),
    });
  } catch {
    // 残せなくても伝える
  }
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
