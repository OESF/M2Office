/**
 * @file マスター管理画面（仕様書 第23.8.15節）が呼ぶ運営の API（`/v1/ops`）。顧客の API（`api.ts`）とは別の口と別のログイン状態を使う。
 */

/** 運営の API の失敗。 */
export class OpsApiError extends Error {
  constructor(message: string, readonly status: number, readonly needsLogin = false) {
    super(message);
    this.name = 'OpsApiError';
  }
}

let csrf: string | null = null;

/** 運営の API を呼ぶ。書き換える要求には CSRF の値を付ける。 */
async function call<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`/v1/ops${path}`, {
    ...init,
    credentials: 'same-origin',
    headers: { 'content-type': 'application/json', ...(csrf ? { 'x-csrf-token': csrf } : {}), ...(init?.headers ?? {}) },
  });
  const body = await res.json().catch(() => ({})) as Record<string, unknown>;
  if (!res.ok) throw new OpsApiError(typeof body['error'] === 'string' ? body['error'] : '通信に失敗しました', res.status, body['needsLogin'] === true);
  return body as T;
}

const send = (method: string, body?: unknown): RequestInit => ({ method, body: JSON.stringify(body ?? {}) });

export type OperatorRole = 'admin' | 'support' | 'monitor';

export interface OperatorView {
  id: string;
  email: string;
  displayName: string;
  role: OperatorRole;
  status: 'active' | 'disabled';
  createdAt: string;
  lastLoginAt: string | null;
}

export interface OpsMe {
  operator: OperatorView;
  csrfToken: string;
  can: Record<'tenant.create' | 'tenant.status' | 'tenant.suspend' | 'tenant.lock' | 'machine.manage' | 'operator.manage' | 'settings.manage', boolean>;
}

export interface TenantRow {
  id: string;
  subdomain: string;
  name: string;
  workspaceDomain: string | null;
  status: 'trial' | 'active' | 'suspended' | 'locked' | 'cancelled';
  createdAt: string;
  usersActive: number;
  usersInvited: number;
  users30d: number;
  lastUsedAt: string | null;
  runsToday: number;
  runs30d: number;
  runsFailed30d: number;
  conversations30d: number;
  aiCostMonth: number;
  filesBytes: number;
  extensions: number;
  googleConnections: number;
}

export interface MachineRow {
  id: string;
  name: string;
  createdAt: string;
  lastAt: string | null;
  flags: string[];
  report: {
    version: string;
    parts: { database: boolean; worker: boolean; entrance: boolean; localAi: boolean | null };
    backup: { configured: boolean; lastAt: string | null; lastOk: boolean | null; restoreOk: boolean | null; offsite?: { configured: boolean; lastOk: boolean | null; checkOk: boolean | null } };
    disk: { dataFree: number | null; dataTotal: number | null; backupFree: number | null };
    cert: { daysLeft: number | null };
    update: { lastResult: string | null; version: string | null };
  } | null;
}

export interface OpsAuditRow {
  id: string;
  operatorEmail: string | null;
  operatorId: string;
  action: string;
  targetType: string;
  targetId: string;
  detail: Record<string, unknown>;
  occurredAt: string;
}

export interface TenantDetailView {
  tenant: { id: string; subdomain: string; name: string; workspaceDomain: string | null; status: TenantRow['status']; createdAt: string };
  seats: { displayName: string; roles: string[]; status: string; email: string | null; lastUsedAt: string | null }[];
  months: { month: string; runs: number; failed: number; conversations: number; aiCost: number; usersMax: number }[];
  currentMonth: { month: string; runs: number; failed: number; conversations: number; aiCost: number };
  health: {
    runs30d: number; failed30d: number; approvalsPending: number; approvalsOldest: string | null; googleConnections: number;
    targets: { target: string; ok: number; fail: number; avgMs: number | null; lastError: string | null }[];
    failedAgents: { agentId: string; count: number }[];
  };
  history: { action: string; actorId: string; detail: Record<string, unknown>; occurredAt: string }[];
}

export interface ServerStatusView {
  queue: { queued: number; oldestQueuedAt: string | null; running: number; awaitingApproval: number };
  runs: { hour: number; hourFailed: number; today: number; todayFailed: number };
  workers: { id: string; at: string; version: string | null }[];
  schedulesLate: number;
  targets: { group: string; ok: number; fail: number; avgMs: number | null }[];
  database: { bytes: number; connections: number };
  filesBytes: number;
  ai: { today: number; month: number; lastMonthSamePeriod: number };
}

export interface OperatorProfileView { nameJa: string; nameEn: string; address: string; web: string; contact: string }

/** 停止・緊急停止・再開の申請（第23.8.6節）。 */
export interface StatusRequestRow {
  id: string;
  tenantId: string;
  tenantName: string | null;
  kind: 'suspend' | 'lock' | 'resume';
  reasonCode: string;
  reason: string;
  state: 'pending' | 'scheduled' | 'done' | 'rejected' | 'withdrawn';
  fromStatus: string | null;
  requestedBy: string;
  requestedAt: string;
  decidedBy: string | null;
  decidedAt: string | null;
  effectiveAt: string | null;
  doneAt: string | null;
  confirmedBy: string | null;
  confirmedAt: string | null;
}

/** 代理アクセスの申請（第23.6.1節）。 */
export interface ProxyGrantRow {
  id: string; tenantId: string; tenantName: string; operatorId: string; operatorLabel: string; scope: 'admin' | 'runs'; reason: string;
  state: 'requested' | 'approved' | 'denied' | 'revoked' | 'withdrawn' | 'expired';
  requestedAt: string; decidedAt: string | null; hours: number | null; expiresAt: string | null; endedAt: string | null; views: number;
}

/** 会社一覧の CSV の書き出しの URL（ログイン状態の Cookie で開く）。 */
export const TENANTS_CSV_URL = '/v1/ops/tenants.csv';

export const opsApi = {
  providers: () => call<{ google: { enabled: boolean }; dev: { enabled: boolean; operators: { email: string; displayName: string; role: OperatorRole }[] } }>('/auth/providers'),
  googleLoginUrl: () => call<{ url: string }>('/auth/google/start'),
  devLogin: async (email: string) => { csrf = (await call<{ csrfToken: string }>('/auth/dev-login', send('POST', { email }))).csrfToken; },
  exchange: async (ticket: string) => { csrf = (await call<{ csrfToken: string }>('/auth/exchange', send('POST', { ticket }))).csrfToken; },
  me: async () => { const me = await call<OpsMe>('/me'); csrf = me.csrfToken; return me; },
  logout: () => call<{ ok: true }>('/auth/logout', send('POST')),
  tenants: () => call<{ tenants: TenantRow[] }>('/tenants'),
  createTenant: (b: { subdomain: string; name: string; domain: string; admin: string; status: 'trial' | 'active' }) =>
    call<{ id: string; loginUrl: string; welcome: string }>('/tenants', send('POST', b)),
  setTenantStatus: (id: string, status: 'trial' | 'active') => call<{ ok: true }>(`/tenants/${encodeURIComponent(id)}/status`, send('PUT', { status })),
  tenantDetail: (id: string) => call<{ detail: TenantDetailView; opsHistory: OpsAuditRow[] }>(`/tenants/${encodeURIComponent(id)}`),
  server: () => call<{ status: ServerStatusView }>('/server'),
  operatorProfile: () => call<{ profile: OperatorProfileView }>('/settings/operator'),
  setOperatorProfile: (p: OperatorProfileView) => call<{ profile: OperatorProfileView }>('/settings/operator', send('PUT', p)),
  statusRequests: (tenantId?: string) => call<{ requests: StatusRequestRow[] }>(`/status-requests${tenantId ? `?tenant=${encodeURIComponent(tenantId)}` : ''}`),
  requestStatus: (tenantId: string, b: { kind: StatusRequestRow['kind']; reasonCode: string; reason: string }) =>
    call<{ id: string; notice: string | null }>(`/tenants/${encodeURIComponent(tenantId)}/requests`, send('POST', b)),
  decideStatus: (id: string, approve: boolean) => call<{ state: string; notice: string | null }>(`/status-requests/${encodeURIComponent(id)}/decide`, send('POST', { approve })),
  withdrawStatus: (id: string) => call<{ ok: true }>(`/status-requests/${encodeURIComponent(id)}/withdraw`, send('POST')),
  confirmLock: (id: string) => call<{ ok: true }>(`/status-requests/${encodeURIComponent(id)}/confirm`, send('POST')),
  proxyGrants: (tenantId?: string) => call<{ grants: ProxyGrantRow[] }>(`/proxy${tenantId ? `?tenant=${encodeURIComponent(tenantId)}` : ''}`),
  requestProxy: (tenantId: string, scope: 'admin' | 'runs', reason: string) => call<{ id: string }>(`/tenants/${encodeURIComponent(tenantId)}/proxy`, send('POST', { scope, reason })),
  openProxy: (id: string) => call<{ url: string }>(`/proxy/${encodeURIComponent(id)}/open`, send('POST')),
  endProxy: (id: string) => call<{ ok: true }>(`/proxy/${encodeURIComponent(id)}/end`, send('POST')),
  machines: () => call<{ machines: MachineRow[] }>('/machines'),
  addMachine: (name: string) => call<{ machine: MachineRow; token: string }>('/machines', send('POST', { name })),
  removeMachine: (id: string) => call<{ ok: true }>(`/machines/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  operators: () => call<{ operators: OperatorView[] }>('/operators'),
  addOperator: (b: { email: string; displayName: string; role: OperatorRole }) => call<{ operator: OperatorView }>('/operators', send('POST', b)),
  updateOperator: (id: string, b: { role?: OperatorRole; status?: 'active' | 'disabled' }) => call<{ operator: OperatorView }>(`/operators/${encodeURIComponent(id)}`, send('PUT', b)),
  audit: () => call<{ entries: OpsAuditRow[] }>('/audit'),
};
