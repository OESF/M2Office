/**
 * @file マスター管理画面（仕様書 第23.8.15節）が呼ぶ運営の API（`/v1/ops`）。顧客の API（`api.ts`）とは別の口と別のログイン状態を使う。
 */

import type { RuntimeEnvironment, RuntimeSampleDays, RuntimeSamplePoint } from '@m2office/shared';
import { logQuery, type EvidenceView, type SystemLogDigestView, type SystemLogPage, type SystemLogQuery } from './api.js';

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
  passkeyCount?: number;
}

export interface OpsMe {
  operator: OperatorView;
  csrfToken: string;
  /** パスキーで確かめたか（第23.8.15節）。確かめるまでは、ほかの操作ができない。 */
  verified: boolean;
  passkeyCount: number;
  can: Record<'tenant.create' | 'tenant.status' | 'tenant.suspend' | 'tenant.lock' | 'machine.manage' | 'operator.manage' | 'settings.manage' | 'evidence.create' | 'evidence.delete', boolean>;
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
  /** この 24 時間の不正の兆しの数と、そのうち重いもの（中身と人は返さない）。古い API では無い。 */
  securitySignals24h?: number;
  securityHigh24h?: number;
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

/** 障害・計画停止（第16.11.3節 G-9）。 */
export interface IncidentRow {
  id: string;
  title: string;
  impact: 'down' | 'degraded' | 'maintenance';
  /** 対象の会社。`null` ならすべての会社。 */
  tenantIds: string[] | null;
  body: string;
  updates: { at: string; body: string; ended: boolean }[];
  startedAt: string;
  endedAt: string | null;
  createdLabel: string;
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

/** 運営の AI の設定（鍵の値は持たない）。 */
export interface OpsAiSettingsView {
  /** いま効いている鍵: 画面で入れたもの・配備の設定のもの・無し。`tail` は末尾 4 文字。 */
  key: { source: 'screen' | 'env' | 'none'; tail: string | null; setAt: string | null; setBy: string | null };
  /** 会社ごとの上限の既定（円）。画面で決めていなければ `null`（配備の設定の `envTenantCapJpy` が効く）。 */
  tenantCapJpy: number | null;
  /** 運営の鍵の全体の月の上限（円）。 */
  platformCapJpy: number | null;
  envTenantCapJpy: number | null;
  /** 運営の鍵での全社の今月の推定費用。 */
  month: { month: string; usedJpy: number };
}

export interface OperatorProfileView { nameJa: string; nameEn: string; address: string; web: string; contact: string }

/** 運営の税率の表の 1 行（仕様書 第15.1.1.1節）。 */
export interface TaxRateRow {
  id: string;
  category: 'standard' | 'food' | 'news' | 'exempt';
  rate: number;
  from: string;
  to?: string;
  planned?: boolean;
  note?: string;
  sourceUrl: string;
  checkedOn: string | null;
  updatedBy: string;
  updatedAt: string;
}

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
  state: 'requested' | 'approved' | 'denied' | 'revoked' | 'ended' | 'withdrawn' | 'expired';
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
  // 運営者のパスキー（第23.8.15節）。options は @simplewebauthn/browser にそのまま渡す
  passkeyRegisterOptions: (code?: string) => call<{ options: unknown }>('/passkey/register-options', send('POST', { code })),
  passkeyRegister: (response: unknown, name: string, code?: string) => call<{ ok: true }>('/passkey/register', send('POST', { response, name, code })),
  passkeyOptions: () => call<{ options: unknown }>('/passkey/options', send('POST')),
  passkeyVerify: (response: unknown) => call<{ ok: true }>('/passkey/verify', send('POST', { response })),
  myPasskeys: () => call<{ passkeys: { id: string; name: string; createdAt: string; lastUsedAt: string | null }[] }>('/me/passkeys'),
  deleteMyPasskey: (id: string) => call<{ ok: true }>(`/me/passkeys/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  issueEnrollCode: (operatorId: string) => call<{ code: string; expiresAt: string }>(`/operators/${encodeURIComponent(operatorId)}/enroll-code`, send('POST')),
  resetPasskeys: (operatorId: string) => call<{ ok: true }>(`/operators/${encodeURIComponent(operatorId)}/passkeys`, { method: 'DELETE' }),
  logout: () => call<{ ok: true }>('/auth/logout', send('POST')),
  tenants: () => call<{ tenants: TenantRow[] }>('/tenants'),
  createTenant: (b: { subdomain: string; name: string; domain: string; admin: string; status: 'trial' | 'active' }) =>
    call<{ id: string; loginUrl: string; welcome: string }>('/tenants', send('POST', b)),
  setTenantStatus: (id: string, status: 'trial' | 'active') => call<{ ok: true }>(`/tenants/${encodeURIComponent(id)}/status`, send('PUT', { status })),
  tenantDetail: (id: string) => call<{ detail: TenantDetailView; opsHistory: OpsAuditRow[] }>(`/tenants/${encodeURIComponent(id)}`),
  server: () => call<{ status: ServerStatusView }>('/server'),
  /** 動いている環境（仕様書 第8.6.7.1節。クラウドの形では運営だけが見る）。 */
  runtime: () => call<RuntimeEnvironment>('/runtime'),
  /** 運営者のヘルプの章の一覧（仕様書 第23.8.16節）。`q` で題と本文を絞り込む。 */
  help: (q = '') => call<{ chapters: { id: string; title: string }[] }>(`/help${q.trim() ? `?q=${encodeURIComponent(q.trim())}` : ''}`),
  /** 運営者のヘルプの 1 章（本文は Markdown）。 */
  helpChapter: (id: string) => call<{ chapter: { id: string; title: string; body: string } }>(`/help/${encodeURIComponent(id)}`),
  /** 機械の資源の推移（仕様書 第23.8.7節「機械の資源の図」）。 */
  runtimeSamples: (days: RuntimeSampleDays) => call<{ samples: RuntimeSamplePoint[] }>(`/runtime/samples?days=${days}`),
  /** 障害・計画停止の知らせ（仕様書 第16.11.3節 G-9）。 */
  incidents: () => call<{ incidents: IncidentRow[] }>('/incidents'),
  openIncident: (b: { title: string; impact: IncidentRow['impact']; body: string; tenants: string[] | null; startedAt: string | null }) =>
    call<{ id: string; notified: number }>('/incidents', send('POST', b)),
  updateIncident: (id: string, body: string) => call<{ notified: number }>(`/incidents/${encodeURIComponent(id)}/update`, send('POST', { body })),
  closeIncident: (id: string, body: string, endedAt: string | null) => call<{ notified: number }>(`/incidents/${encodeURIComponent(id)}/close`, send('POST', { body, endedAt })),
  /** 消費税の税率の表（法令の表の 1 つ。第15.1.1.1節）。`bundled` は運営がまだ直していないこと。`drafts` は全社の書類の下書きの数。 */
  taxRates: () => call<{ rows: TaxRateRow[]; bundled: boolean; drafts: number }>('/tax-rates'),
  saveTaxRates: (rows: Partial<TaxRateRow>[]) => call<{ rows: TaxRateRow[]; bundled: boolean; notified: number }>('/tax-rates', send('PUT', { rows })),
  /** 運営の AI の設定（仕様書 第23.8.14節「マスター管理画面の設定を広げる」）。鍵の値は返らない。 */
  aiSettings: () => call<OpsAiSettingsView>('/settings/ai'),
  setAiKey: (apiKey: string) => call<{ ok: true; ms: number }>('/settings/ai/key', send('PUT', { apiKey })),
  deleteAiKey: () => call<{ ok: true }>('/settings/ai/key', send('DELETE')),
  testAiKey: () => call<{ ok: boolean; ms: number; error?: string; source?: 'screen' | 'env' }>('/settings/ai/test', send('POST', {})),
  setAiLimits: (b: { tenantCapJpy: number | null; platformCapJpy: number | null }) => call<{ ok: true }>('/settings/ai/limits', send('PUT', b)),
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
  /** すべての会社のシステムログ（仕様書 第16.10.4節）。 */
  logs: (q: SystemLogQuery) => call<SystemLogPage>(`/logs?${logQuery(q)}`),
  logDigests: (q: SystemLogQuery) => call<{ items: SystemLogDigestView[] }>(`/logs/digests?${logQuery(q)}`),
  /** ダウンロードの URL（運営のログイン状態の Cookie で開く）。 */
  logExportUrl: (q: SystemLogQuery, format: 'jsonl' | 'csv') => `/v1/ops/logs/export?${logQuery(q)}&format=${format}`,
  /** 証拠保全（第16.10.5節）。 */
  evidence: () => call<{ items: EvidenceView[] }>('/evidence'),
  createEvidence: (tenantId: string | null, reason: string, days: number) => call<{ id: string }>('/evidence', send('POST', { tenantId, reason, days })),
  evidenceUrl: (id: string) => `/v1/ops/evidence/${encodeURIComponent(id)}/download`,
  deleteEvidence: (id: string, reason: string) => call<{ ok: true }>(`/evidence/${encodeURIComponent(id)}`, send('DELETE', { reason })),
};
