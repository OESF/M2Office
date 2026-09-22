import type {
  Approval, Artifact, AuditEvent, Notification, Run, RunStep, Schedule, ScheduleRule, Tenant, User,
} from '@m2office/shared';

/**
 * API の呼び出し口。
 *
 * @remarks
 * 画面は API を経由する以外にデータへ到達する手段を持たない
 * （仕様書 第11.1節 A-2）。ここが唯一の入口である。
 *
 * 認証は Google アカウントに一本化する（第16.1節）。ログイン状態は
 * HttpOnly の Cookie で持ち、画面の JavaScript からは読めない（第20.7節）。
 * 状態を変える要求には、`/v1/me` で受け取った CSRF トークンを添える。
 */
const params = new URLSearchParams(location.search);
/**
 * 開発用のテナント指定。
 *
 * @remarks
 * 本来はサブドメインでテナントを解決する（仕様書 第6.5.1節）。
 * `lvh.me` が使えない環境のために、`?tenant=a` での指定も受け付ける。
 * 本番では用いない。
 */
const devTenant = params.get('tenant');

/** CSRF トークン。ログイン直後と `/v1/me` の応答で更新する。 */
let csrfToken: string | null = null;

/** ログインが切れたときに呼ぶ。画面はログイン画面へ戻す。 */
let onUnauthorized: (() => void) | null = null;
export function setUnauthorizedHandler(fn: () => void): void {
  onUnauthorized = fn;
}

async function call<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`/v1${path}`, {
    ...init,
    credentials: 'same-origin',
    headers: {
      'content-type': 'application/json',
      ...(devTenant ? { 'x-tenant': devTenant } : {}),
      ...(csrfToken ? { 'x-csrf-token': csrfToken } : {}),
      ...(init?.headers ?? {}),
    },
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({ error: '通信に失敗しました' }));
    if (res.status === 401 && body.login) onUnauthorized?.();
    throw new ApiError(body.error ?? `エラー (${res.status})`, res.status, !!body.login);
  }
  return res.json() as Promise<T>;
}

/** API が返した業務上のエラー。画面では平易な文言として表示する。 */
export class ApiError extends Error {
  constructor(message: string, readonly status: number, readonly needsLogin = false) {
    super(message);
    this.name = 'ApiError';
  }
}

export interface Me {
  tenant: Tenant;
  user: User;
  auth: { method: 'session' | 'dev-header' };
  csrfToken: string | null;
  /** 予定やメールの出どころ。`mock` の間は画面にダミーであることを示す。 */
  workspaceSource: 'mock' | 'google';
}

export interface LoginProviders {
  tenant: { name: string; subdomain: string };
  google: { enabled: boolean; reason?: string };
  dev: { enabled: boolean; users: { email: string; displayName: string; roles: string[] }[] };
}

export type ScheduleView = Schedule & { label: string };

export interface AdminRun {
  id: string; status: string; startedAt: string; endedAt: string | null;
  tokensUsed: number; costJpy: number; agentId: string; agentName: string; origin: string;
  requestedBy: string;
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
  me: async () => {
    const me = await call<Me>('/me');
    csrfToken = me.csrfToken;
    return me;
  },
  providers: () => call<LoginProviders>('/auth/providers'),
  devLogin: async (email: string) => {
    const res = await call<{ csrfToken: string }>('/auth/dev-login', {
      method: 'POST', body: JSON.stringify({ email }),
    });
    csrfToken = res.csrfToken;
  },
  logout: async () => {
    await call('/auth/logout', { method: 'POST' });
    csrfToken = null;
  },
  notifications: () => call<{ items: Notification[]; unread: number }>('/notifications'),
  readNotification: (id: string) => call(`/notifications/${id}/read`, { method: 'POST' }),
  schedules: () => call<{ items: ScheduleView[] }>('/schedules'),
  createSchedule: (agentId: string, rule: ScheduleRule) =>
    call<ScheduleView>('/schedules', { method: 'POST', body: JSON.stringify({ agentId, rule }) }),
  updateSchedule: (id: string, patch: { enabled?: boolean; rule?: ScheduleRule }) =>
    call<ScheduleView>(`/schedules/${id}`, { method: 'PATCH', body: JSON.stringify(patch) }),
  triggerSchedule: (id: string) => call(`/schedules/${id}/trigger`, { method: 'POST' }),
  admin: {
    usage: () => call<{
      items: { agentId: string; name: string; runs: number; costJpy: number; tokens: number }[];
      total: { runs: number; costJpy: number }; note: string | null;
    }>('/admin/usage'),
    runs: () => call<{ items: AdminRun[] }>('/admin/runs'),
    users: () => call<{ items: User[] }>('/admin/users'),
    audit: () => call<{ items: AuditEvent[] }>('/admin/audit-events'),
    connectors: () => call<{ workspace: { source: string; label: string }; llm: { provider: string } }>(
      '/admin/connectors',
    ),
  },
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
