/**
 * @file 秘書の受け手（指揮者）。業務と秘書のイベントを受け、依頼した本人の秘書としてその場で動く。
 *
 * 業務の実行の終了・承認待ちと秘書との会話の保存は、データベースがイベント（`agent_events`）として必ず書く。
 * ワーカーがこの受け手の {@link SecretaryConductor.tick} を繰り返し呼び、イベントを 1 件ずつ確保して処理する。
 * いまは、その場で学ぶ（第11.5.2節）。結果を見て次の業務を起こす連携は、このイベントを土台に作る。
 *
 * @see 仕様書 第10.13節 秘書が指揮する
 * @see ADR-0039
 */

import type { AgentDefinition } from '@m2office/shared';
import type { AgentEvent, Repository } from '../repository/types.js';
import { OFFICIAL_AGENTS } from '../agents/index.js';
import { silentLogger, type Logger } from '../log/logger.js';
import type { MemoryLearning } from '../memory/learn.js';
import { learnableWork, readWorkAnswers } from '../memory/work.js';

/** 業務の答え 1 件の長さの上限（字）。 */
const WORK_ANSWER_MAX = 1500;

export interface ConductorDeps {
  repo: Repository;
  learning: Pick<MemoryLearning, 'learnNow'>;
  /**
   * その会社の業務の定義（公式と導入した拡張機能）。業務の名前と権限区画を引くのに使う。
   * 省略時は公式の業務だけ（拡張機能の業務は、区画が分からないため学ばない）。
   */
  agentsFor?(tenantId: string): Promise<AgentDefinition[]>;
  logger?: Logger;
}

/** 1 件を処理した結果。 */
export type ConductorOutcome =
  | { event: AgentEvent; action: 'learned'; learned: number; promoted: number }
  | { event: AgentEvent; action: 'skipped'; reason: string }
  | { event: null; action: 'failed'; eventId: string; error: string };

/**
 * 秘書の受け手。イベントの持ち主の秘書として動く。
 *
 * @remarks
 * テナント境界: 確保したイベントの会社の中だけを読む（不変則 I-2）。確保はデータベースの関数に閉じ込めている。
 * 個人境界: イベントの持ち主の記憶だけを書く（不変則 I-10）。
 * 失敗は処理済みにせず理由を残し、確保の期限（2 分）のあとにやり直す。5 回で諦める。
 */
export class SecretaryConductor {
  private readonly log: Logger;

  constructor(private readonly deps: ConductorDeps) {
    this.log = deps.logger ?? silentLogger;
  }

  /**
   * イベントを 1 件処理する。
   *
   * @returns 処理した結果。待っているイベントが無ければ `null`
   */
  async tick(now: Date = new Date()): Promise<ConductorOutcome | null> {
    const claimed = await this.deps.repo.claimAgentEvent();
    if (!claimed) return null;
    try {
      const outcome = await this.handle(claimed.tenantId, claimed.id, now);
      await this.deps.repo.finishAgentEvent(claimed.tenantId, claimed.id, null);
      return outcome;
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      await this.deps.repo.finishAgentEvent(claimed.tenantId, claimed.id, error).catch(() => undefined);
      this.log.error('秘書の受け手がイベントを処理できませんでした', { tenantId: claimed.tenantId, eventId: claimed.id, err });
      return { event: null, action: 'failed', eventId: claimed.id, error };
    }
  }

  /** イベントの種類ごとに振り分ける。 */
  private async handle(tenantId: string, id: string, now: Date): Promise<ConductorOutcome> {
    const event = await this.deps.repo.getAgentEvent(tenantId, id);
    if (!event) throw new Error('イベントが見つかりません');
    if (event.kind === 'conversation.turn') return this.onConversation(event, now);
    if (event.kind === 'run.finished' && event.status === 'completed') return this.onRunCompleted(event, now);
    // 失敗・中止・承認待ちは記録するだけ（第10.13節）。秘書が次の業務を起こす連携の材料にする
    return { event, action: 'skipped', reason: `記録のみ（${event.kind}・${event.status ?? ''}）` };
  }

  /** 秘書との会話を 1 往復残したとき。その往復から学ぶ。 */
  private async onConversation(event: AgentEvent, now: Date): Promise<ConductorOutcome> {
    const { repo, learning } = this.deps;
    if (!event.conversationId) return { event, action: 'skipped', reason: '会話がありません' };
    const conversation = await repo.getConversation(event.tenantId, event.conversationId);
    // 本人がすでに消していれば学ばない
    if (!conversation || conversation.userId !== event.userId) return { event, action: 'skipped', reason: '会話がありません' };
    const r = await learning.learnNow(event.tenantId, event.userId, { conversations: [conversation] }, now);
    return { event, action: 'learned', learned: r.learned, promoted: r.promoted };
  }

  /**
   * 業務が完了したとき。本人が直接使った業務なら、依頼と答えから学ぶ（ADR-0038）。
   *
   * @remarks 秘書に頼まれた業務は、結果を本人に伝えて会話に残したとき（`conversation.turn`）に学ぶ（二重にしない）
   */
  private async onRunCompleted(event: AgentEvent, now: Date): Promise<ConductorOutcome> {
    const { repo, learning } = this.deps;
    if (!event.runId) return { event, action: 'skipped', reason: '実行がありません' };
    const run = await repo.getRun(event.tenantId, event.runId);
    const job = run ? await repo.getJob(event.tenantId, run.jobId) : null;
    if (!run || !job || job.requestedBy !== event.userId) return { event, action: 'skipped', reason: '実行がありません' };
    const agents = this.deps.agentsFor ? await this.deps.agentsFor(event.tenantId) : OFFICIAL_AGENTS;
    if (!learnableWork({ run, job }, agents)) return { event, action: 'skipped', reason: '学ぶ対象ではない業務' };
    const work = await readWorkAnswers(repo, event.tenantId, [{ run, job }], agents, WORK_ANSWER_MAX);
    if (work.length === 0) return { event, action: 'skipped', reason: '答えがありません' };
    const r = await learning.learnNow(event.tenantId, event.userId, { work }, now);
    return { event, action: 'learned', learned: r.learned, promoted: r.promoted };
  }
}
