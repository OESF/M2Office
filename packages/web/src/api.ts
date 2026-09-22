/**
 * @file 画面から API を呼ぶ唯一の入口。Cookie と CSRF トークンを扱い、ログイン切れを画面に知らせる。
 *
 * 画面は API を経由する以外にデータへ到達する手段を持たない（A-2）。
 *
 * @see 仕様書 第13.1節 公開の方針
 * @see 仕様書 第20.7節 認証の実装方針
 */

import type {
  Approval, Artifact, AuditEvent, Notification, Run, RunStep, Schedule, ScheduleRule, Tenant,
  TenantSettings, User, UserSettings,
} from '@m2office/shared';

/**
 * API の呼び出し口。
 *
 * @remarks
 * 画面は API を経由する以外にデータへ到達する手段を持たない
 * （仕様書 第13.1節 A-2）。ここが唯一の入口である。
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
 * 本来はサブドメインでテナントを解決する（仕様書 第8.5.1節）。
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

/** ダッシュボードの「いま」（仕様書 第6.7.3節）。 */
export interface DashboardLive {
  generatedAt: string;
  counts: {
    activeUsers: number; running: number; awaitingApproval: number; failedToday: number;
    todayRuns: number; todayCostJpy: number; todaySavedMinutes: number;
  };
  flows: {
    runId: string; agentName: string; status: string; requester: string; origin: string; startedAt: string;
    steps: { label: string; state: 'done' | 'current' | 'waiting' | 'failed' | 'todo' }[];
    waitingFor: { who: string; since: string; kind: 'approval' | 'confirm' } | null;
    failureReason: string | null;
  }[];
  backlog: { approvalId: string; agentName: string; what: string; requester: string; approver: string; since: string }[];
  events: { at: string; kind: 'start' | 'done' | 'fail' | 'wait'; text: string }[];
}

/** ダッシュボードの「集計」（仕様書 第6.7.8節）。 */
export interface DashboardStats {
  days: number;
  totals: {
    runs: number; completed: number; failed: number; successRate: number | null;
    avgDurationSec: number | null; savedMinutes: number; costJpy: number; tokens: number;
  };
  daily: { day: string; runs: number; completed: number; failed: number; costJpy: number; savedMinutes: number }[];
  hourly: number[];
  byAgent: {
    agentId: string; name: string; enabled: boolean; runs: number; completed: number;
    successRate: number | null; avgDurationSec: number | null; savedMinutes: number; costJpy: number; tokens: number;
  }[];
  secretary: { direct: number; route: number; chat: number };
  backlog: { pending: number; oldestSince: string | null };
  knowledge: { items: number; searches: number };
  health: { workspace: string; llm: string };
}

export interface KnowledgeItemView {
  id: string; kind: string; title: string; body: string; source: string;
  compartment: string | null; updatedAt: string;
}

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

/**
 * ファイルを取り出して保存させる。
 *
 * @remarks
 * リンクで直接開かず、API と同じ経路（Cookie・テナントの指定）で取り出してから保存させる。
 */
async function download(fileId: string, name: string): Promise<void> {
  const res = await fetch(`/v1/files/${fileId}/content`, {
    credentials: 'same-origin',
    headers: devTenant ? { 'x-tenant': devTenant } : {},
  });
  if (!res.ok) throw new ApiError('ファイルを取り出せませんでした', res.status);
  const url = URL.createObjectURL(await res.blob());
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  URL.revokeObjectURL(url);
}

export const api = {
  download,
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
  mySettings: () => call<UserSettings>('/me/settings'),
  saveMySettings: <K extends keyof UserSettings>(section: K, value: UserSettings[K]) =>
    call(`/me/settings/${section}`, { method: 'PUT', body: JSON.stringify(value) }),
  saveDisplayName: (displayName: string) =>
    call('/me/profile', { method: 'PATCH', body: JSON.stringify({ displayName }) }),
  mySessions: () => call<{ items: {
    id: string; provider: string; userAgent: string | null; createdAt: string; lastSeenAt: string; current: boolean;
  }[] }>('/me/sessions'),
  revokeSession: (id: string) => call(`/me/sessions/${id}`, { method: 'DELETE' }),
  myUsage: () => call<{
    seat: string; thisMonth: { runs: number; costJpy: number }; availableAgents: number;
    compartments: string[]; plan: null;
  }>('/me/usage'),
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
    settings: () => call<TenantSettings & {
      catalog: {
        id: string; name: string; description: string; usesWriteInternal: boolean; defaultMinutes: number;
      }[];
    }>('/admin/settings'),
    dashboardLive: () => call<DashboardLive>('/admin/dashboard/live'),
    dashboardStats: (days: 1 | 7 | 30) => call<DashboardStats>(`/admin/dashboard/stats?days=${days}`),
    saveSettings: <K extends keyof TenantSettings>(section: K, value: TenantSettings[K]) =>
      call(`/admin/settings/${section}`, { method: 'PUT', body: JSON.stringify(value) }),
    inviteUser: (email: string, displayName: string, roles: string[]) =>
      call<User>('/admin/users', { method: 'POST', body: JSON.stringify({ email, displayName, roles }) }),
    updateUser: (id: string, patch: { displayName?: string; roles?: string[]; status?: string }) =>
      call<User>(`/admin/users/${id}`, { method: 'PATCH', body: JSON.stringify(patch) }),
    knowledge: () => call<{
      items: KnowledgeItemView[]; compartments: { id: string; name: string; description: string | null }[];
    }>('/admin/knowledge'),
    saveKnowledge: (id: string | 'new', item: Omit<KnowledgeItemView, 'id' | 'updatedAt'>) =>
      call<{ id: string }>(`/admin/knowledge/${id}`, { method: 'PUT', body: JSON.stringify(item) }),
    deleteKnowledge: (id: string) => call(`/admin/knowledge/${id}`, { method: 'DELETE' }),
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
