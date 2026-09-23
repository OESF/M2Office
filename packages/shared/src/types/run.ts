/**
 * @file ジョブ・実行・ステップ・承認・成果物・ファイルの型。
 *
 * @see 仕様書 第9.3節 実行ライフサイクル
 */

/** 実行の状態。承認待ちで中断し、承認後に別プロセスが再開する。 */
export const RUN_STATUSES = [
  'queued',
  'running',
  'awaiting_approval',
  'completed',
  'failed',
  'cancelled',
  'expired',
] as const;

export type RunStatus = (typeof RUN_STATUSES)[number];

/** ジョブの起動経路。監査と分析に使う。 */
export type JobOrigin = 'secretary' | 'menu' | 'schedule' | 'api';

export interface Job {
  id: string;
  tenantId: string;
  agentId: string;
  agentVersion: number;
  requestedBy: string;
  origin: JobOrigin;
  input: Record<string, unknown>;
  createdAt: string;
}

export interface Run {
  id: string;
  jobId: string;
  tenantId: string;
  status: RunStatus;
  /** 次に実行するステップの位置。中断と再開の要になる。 */
  cursor: number;
  startedAt: string;
  endedAt: string | null;
  tokensUsed: number;
  costJpy: number;
  /**
   * 削減時間の推計（分）。完了した時点の標準所要時間を記録する。
   * 完了しなかった実行は 0（仕様書 第6.7.12節）。
   */
  savedMinutes: number;
  failureReason: string | null;
}

export type StepKind = 'agent' | 'approval';
/** ステップの状態。`cancelled` は、承認待ちのまま実行が止められたとき（仕様書 第9.3.1節）。 */
export type StepStatus = 'running' | 'succeeded' | 'failed' | 'awaiting' | 'rejected' | 'cancelled';

export interface RunStep {
  id: string;
  runId: string;
  seq: number;
  stepId: string;
  kind: StepKind;
  status: StepStatus;
  input: unknown;
  output: unknown;
  startedAt: string;
  endedAt: string | null;
}

export interface Approval {
  id: string;
  runStepId: string;
  tenantId: string;
  /** 承認できるロール。`approverUserId` があるときは使わない。 */
  approverRole: string[];
  /** 判断できる利用者。`approver: requester` の承認では依頼した本人。それ以外は `null`。 */
  approverUserId: string | null;
  present: string;
  /**
   * `expired` は、承認待ちのまま期限（30 日）を過ぎて止めたもの（仕様書 第14.3.2節）。
   * `cancelled` は、Google の許可がなくなったなどで業務を止めたため、判断が要らなくなったもの（第6.5.2.1節）。
   */
  decision: 'approved' | 'rejected' | 'expired' | 'cancelled' | null;
  decidedBy: string | null;
  comment: string | null;
  decidedAt: string | null;
  createdAt: string;
}

export interface Artifact {
  id: string;
  runId: string;
  tenantId: string;
  kind: string;
  title: string;
  body: string;
  /** 成果物がファイルの場合、その ID。 */
  fileId?: string | null;
  createdAt: string;
}

/** ファイルのメタデータ（仕様書 第9.4.1節）。中身はファイルの置き場にある。 */
export interface StoredFile {
  id: string;
  tenantId: string;
  ownerUserId: string;
  name: string;
  kind: 'pdf' | 'xlsx' | 'csv' | 'docx' | 'png' | 'jpeg';
  mime: string;
  size: number;
  sha256: string;
  /** `upload` は利用者が上げたもの、`generated` は業務が作ったもの。 */
  origin: 'upload' | 'generated';
  runId: string | null;
  createdAt: string;
}
