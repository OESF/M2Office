import type { Approval, Run, RunStep, Artifact, Tenant, User } from '@m2office/shared';

/**
 * API の呼び出し口。
 *
 * @remarks
 * 画面は API を経由する以外にデータへ到達する手段を持たない
 * （仕様書 第11.1節 A-2）。ここが唯一の入口である。
 *
 * 認証は Google アカウントに一本化する（第16.1節）。プロトタイプでは
 * 開発用に利用者を `x-user` で指定する。
 */
const params = new URLSearchParams(location.search);
const devUser = params.get('user');
/**
 * 開発用のテナント指定。
 *
 * @remarks
 * 本来はサブドメインでテナントを解決する（仕様書 第6.5.1節）。
 * `lvh.me` が使えない環境のために、`?tenant=a` での指定も受け付ける。
 * 本番では用いない。
 */
const devTenant = params.get('tenant');

async function call<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`/v1${path}`, {
    ...init,
    headers: {
      'content-type': 'application/json',
      ...(devTenant ? { 'x-tenant': devTenant } : {}),
      ...(devUser ? { 'x-user': devUser } : {}),
      ...(init?.headers ?? {}),
    },
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({ error: '通信に失敗しました' }));
    throw new ApiError(body.error ?? `エラー (${res.status})`, res.status);
  }
  return res.json() as Promise<T>;
}

/** API が返した業務上のエラー。画面では平易な文言として表示する。 */
export class ApiError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
    this.name = 'ApiError';
  }
}

export interface AgentSummary {
  id: string;
  version: number;
  name: string;
  category: string;
  description: string;
  inputs: { required?: string[]; properties?: Record<string, JsonSchemaField> };
  hasApproval: boolean;
  stepCount: number;
}

export interface JsonSchemaField {
  type: string;
  title?: string;
  format?: string;
}

export interface RunDetail {
  run: Run;
  job: { agentId: string; input: Record<string, unknown> } | null;
  steps: RunStep[];
  artifacts: Artifact[];
}

export interface SecretaryReply {
  layer: 'direct' | 'light' | 'full';
  text: string;
  evidence: { label: string; value: string }[];
  suggestedAgent?: { id: string; version: number; name: string };
  tokensUsed: number;
  elapsedMs: number;
}

export const api = {
  me: () => call<{ tenant: Tenant; user: User }>('/me'),
  agents: () => call<{ agents: AgentSummary[] }>('/agents'),
  createJob: (agentId: string, input: Record<string, unknown>, origin = 'menu') =>
    call<{ jobId: string; runId: string }>('/jobs', {
      method: 'POST',
      body: JSON.stringify({ agentId, input, origin }),
    }),
  jobs: () => call<{ items: { run: Run; job: { agentId: string } | null }[] }>('/jobs'),
  run: (id: string) => call<RunDetail>(`/runs/${id}`),
  approvals: () => call<{ items: Approval[] }>('/approvals'),
  decide: (id: string, decision: 'approved' | 'rejected', comment?: string) =>
    call<{ runId: string }>(`/approvals/${id}`, {
      method: 'POST',
      body: JSON.stringify({ decision, comment: comment ?? null }),
    }),
  ask: (message: string) =>
    call<SecretaryReply>('/secretary', {
      method: 'POST',
      body: JSON.stringify({ message }),
    }),
};
