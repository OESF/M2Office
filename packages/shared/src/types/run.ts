/**
 * ジョブと実行の型（仕様書 第7.3節 実行ライフサイクル）。
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
  failureReason: string | null;
}

export type StepKind = 'agent' | 'approval';
export type StepStatus = 'running' | 'succeeded' | 'failed' | 'awaiting' | 'rejected';

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
  decision: 'approved' | 'rejected' | null;
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
  createdAt: string;
}
