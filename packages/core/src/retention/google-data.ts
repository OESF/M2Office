/**
 * @file Google から取得したデータの保持。実行が終わってから決まった日数で、ステップの中身を消して目印だけを残す。
 *
 * 業務が Google から取得したメール・文書などと、そこから LLM が作った文は、実行のステップの入力と出力に入る。
 * Google の Limited Use は取得したデータから作ったものにも及ぶため、Google のツールを使った実行は、
 * ステップの中身をまとめて消す。残すのはツール名・危険度・ID・件数・日時だけ（件名と差出人は残さない）。
 *
 * @see 仕様書 第14.3.2節 Google から取得したデータの保持（Q-78）
 * @see 仕様書 第6.2.1節 実行の中身を見られる人
 */

import { randomUUID } from 'node:crypto';
import type { Approval, Run, RunStep } from '@m2office/shared';
import type { Repository } from '../repository/types.js';
import type { Logger } from '../log/logger.js';

/** 実行が終わってから中身を残す日数の上限（既定）。会社は短くできるが、長くはできない。 */
export const GOOGLE_DATA_RETENTION_DAYS = 7;
/** 承認待ちのまま放置された実行を期限切れにするまでの日数。 */
export const APPROVAL_EXPIRY_DAYS = 30;
/** 見回りで 1 度に取り出す実行の数と、1 社あたりの回数の上限（1 回の見回りで最大 2,000 件）。 */
const SWEEP_BATCH = 100;
const SWEEP_MAX_BATCHES = 20;
/** 消した後の承認の表示。 */
export const REDACTED_PRESENT = '（保存期間を過ぎたため、中身を消しました）';

/** ステップの出力に残す、ツールの呼び出しの目印。 */
export interface ToolMarker {
  name: string;
  risk?: string;
  /** 結果に含まれていたメッセージ・ファイル・予定などの ID（最大 50）。 */
  ids: string[];
  /** 結果の件数（一覧を返すツール）。 */
  count: number | null;
}

/** 中身を消したステップの出力。 */
export interface RedactedOutput {
  redacted: true;
  redactedAt: string;
  reason: 'retention' | 'disconnect' | 'expired';
  tools: ToolMarker[];
}

const ID_KEYS = new Set(['id', 'messageId', 'fileId', 'eventId', 'taskId', 'draftId', 'documentId', 'spreadsheetId', 'presentationId', 'formId', 'threadId']);

/** 結果から ID を集める（深さ 3 まで、最大 50）。本文や件名は拾わない。 */
function collectIds(v: unknown, out: string[], depth = 0): void {
  if (out.length >= 50 || depth > 3 || v === null || typeof v !== 'object') return;
  if (Array.isArray(v)) { for (const x of v) collectIds(x, out, depth + 1); return; }
  for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
    if (ID_KEYS.has(k) && typeof x === 'string' && out.length < 50) out.push(x);
    else collectIds(x, out, depth + 1);
  }
}

/** 結果の件数。最初に見つかった配列の長さ。 */
function countOf(v: unknown): number | null {
  if (Array.isArray(v)) return v.length;
  if (v && typeof v === 'object') {
    for (const x of Object.values(v as Record<string, unknown>)) if (Array.isArray(x)) return x.length;
  }
  return null;
}

/** ステップの出力にあるツールの呼び出し。 */
function toolCallsOf(step: RunStep): { name: string; risk?: string; result?: unknown }[] {
  const out = step.output as { tools?: { name: string; risk?: string; result?: unknown }[] } | null;
  return Array.isArray(out?.tools) ? out.tools : [];
}

/**
 * 実行が Google のツールを使ったかを返す。
 *
 * @param isGoogleTool ツール名から、Google のデータを扱うツールか（`Tool.google` の宣言があるか）を返す
 */
export function usesGoogleData(steps: RunStep[], isGoogleTool: (name: string) => boolean): boolean {
  return steps.some((s) => toolCallsOf(s).some((t) => isGoogleTool(t.name)));
}

/**
 * ステップの中身を消し、目印だけを残す。
 *
 * @returns 入力を空にし、出力を目印（ツール名・危険度・ID・件数）に置き換えたステップ
 */
export function redactStep(step: RunStep, reason: RedactedOutput['reason'], now: string): RunStep {
  const tools: ToolMarker[] = toolCallsOf(step).map((t) => {
    const ids: string[] = [];
    collectIds(t.result, ids);
    return { name: t.name, ...(t.risk ? { risk: t.risk } : {}), ids, count: countOf(t.result) };
  });
  const output: RedactedOutput = { redacted: true, redactedAt: now, reason, tools };
  return { ...step, input: null, output };
}

/** 会社の設定の日数を、0〜上限に収める。 */
export function retentionDays(configured: number | undefined): number {
  const n = Math.floor(Number(configured ?? GOOGLE_DATA_RETENTION_DAYS));
  return Number.isFinite(n) ? Math.min(GOOGLE_DATA_RETENTION_DAYS, Math.max(0, n)) : GOOGLE_DATA_RETENTION_DAYS;
}

export interface GoogleDataRetentionDeps {
  repo: Repository;
  isGoogleTool: (name: string) => boolean;
  logger: Logger;
}

/**
 * 保持期間の見回り役。ワーカーが一定の間隔で `sweep` を呼ぶ。
 *
 * @remarks
 * テナント境界: 会社ごとに、その会社の設定と実行だけを扱う（不変則 I-2）。
 * 実行中・承認待ちの実行の中身は消さない（判断と再開に要るため）。
 */
export class GoogleDataRetention {
  constructor(private readonly deps: GoogleDataRetentionDeps) {}

  /**
   * 全社を見回る。承認待ちの放置を期限切れにし、保持期間を過ぎた実行の中身を消す。
   *
   * @returns 期限切れにした実行と、中身を消した実行の数
   */
  async sweep(now: Date): Promise<{ expired: number; redacted: number }> {
    let expired = 0;
    let redacted = 0;
    for (const tenantId of await this.deps.repo.listTenantIds()) {
      try {
        expired += await this.expireStaleApprovals(tenantId, now);
        const { privacy } = await this.deps.repo.getTenantSettings(tenantId);
        const cutoff = new Date(now.getTime() - retentionDays(privacy.googleDataRetentionDays) * 86_400_000);
        // 1 回の見回りで、たまった分を片付ける。ただし 1 社あたり上限を置き、ほかの会社を待たせすぎない
        for (let batch = 0; batch < SWEEP_MAX_BATCHES; batch++) {
          const runs = await this.deps.repo.listRunsForRetention(tenantId, cutoff.toISOString(), SWEEP_BATCH);
          for (const run of runs) if (await this.process(run, 'retention', now)) redacted++;
          if (runs.length < SWEEP_BATCH) break;
        }
      } catch (err) {
        // 1 社の失敗で、ほかの会社の見回りを止めない
        this.deps.logger.error('保持期間の見回りで例外が発生しました', { tenantId, err });
      }
    }
    return { expired, redacted };
  }

  /**
   * 利用者が Google の連携を解除したとき、その人の実行から Google 由来の中身を消す（期間を待たない）。
   *
   * @remarks 実行中・承認待ちの実行は対象外（Q-54 で扱いを決める）。
   * @returns 中身を消した実行の数
   */
  async purgeUser(tenantId: string, userId: string, now: Date): Promise<number> {
    let n = 0;
    for (const run of await this.deps.repo.listUserRunsForPurge(tenantId, userId)) {
      if (await this.process(run, 'disconnect', now)) n++;
    }
    return n;
  }

  /**
   * 1 つの実行の中身を、期間を待たずに消す（止めた実行の後から書き込まれた中身を含めて消すため）。
   *
   * @returns Google のツールを使っていて、中身を消したら `true`
   */
  async purgeRun(run: Run, reason: RedactedOutput['reason'], now: Date): Promise<boolean> {
    return this.process(run, reason, now);
  }

  /** 1 つの実行を処理する。Google のツールを使っていれば中身を消す。 */
  private async process(run: Run, reason: RedactedOutput['reason'], now: Date): Promise<boolean> {
    const steps = await this.deps.repo.listRunSteps(run.tenantId, run.id);
    const redact = usesGoogleData(steps, this.deps.isGoogleTool);
    const at = now.toISOString();
    await this.deps.repo.markRunRetention(
      run.tenantId, run.id, redact ? steps.map((s) => redactStep(s, reason, at)) : null, REDACTED_PRESENT, at,
    );
    return redact;
  }

  /** 承認待ちのまま 30 日たった実行を期限切れにして止め、依頼者に知らせる。中身もすぐに消す。 */
  private async expireStaleApprovals(tenantId: string, now: Date): Promise<number> {
    const { repo } = this.deps;
    const before = new Date(now.getTime() - APPROVAL_EXPIRY_DAYS * 86_400_000).toISOString();
    const stale = await repo.listStaleApprovals(tenantId, before);
    let n = 0;
    const at = now.toISOString();
    for (const a of stale) {
      const step = await repo.getRunStepById(tenantId, a.runStepId);
      const run = step ? await repo.getRun(tenantId, step.runId) : null;
      if (!step || !run || run.status !== 'awaiting_approval') continue;
      const job = await repo.getJob(tenantId, run.jobId);
      const expiredApproval: Approval = { ...a, decision: 'expired', decidedAt: at, comment: `承認待ちのまま ${APPROVAL_EXPIRY_DAYS} 日たったため期限切れ` };
      await repo.updateApproval(expiredApproval);
      await repo.updateRunStep(tenantId, { ...step, status: 'failed', endedAt: at });
      const stopped: Run = {
        ...run, status: 'expired', endedAt: at,
        failureReason: `承認待ちのまま ${APPROVAL_EXPIRY_DAYS} 日たったため、期限切れにしました`,
      };
      await repo.updateRun(stopped);
      await repo.appendAudit({
        id: randomUUID(), tenantId, actorType: 'system', actorId: 'retention', action: 'run.expire',
        targetType: 'run', targetId: run.id, detail: { approvalId: a.id, days: APPROVAL_EXPIRY_DAYS }, occurredAt: at,
      });
      if (job) {
        await repo.createNotification({
          id: randomUUID(), tenantId, userId: job.requestedBy, kind: 'failure',
          title: '承認待ちの業務を期限切れにしました',
          body: `承認されないまま ${APPROVAL_EXPIRY_DAYS} 日たったため、業務を止めました。必要なら、もう一度依頼してください。`,
          runId: run.id, readAt: null, createdAt: at,
        });
      }
      await this.process(stopped, 'expired', now);
      n++;
    }
    return n;
  }
}
