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
    throw new ApiError(
      body.error ?? `エラー (${res.status})`, res.status, !!body.login,
      body.requestId ?? res.headers.get('x-request-id'),
      Array.isArray(body.problems) ? body.problems : [],
    );
  }
  return res.json() as Promise<T>;
}

/** API が返した業務上のエラー。画面では平易な文言として表示する。 */
export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly needsLogin = false,
    /** 要求の ID。問い合わせのときにログと突き合わせる（開発規約 第7.4節）。 */
    readonly requestId: string | null = null,
    /** 検証で見つかった問題の一覧（拡張機能の取り込みなど）。 */
    readonly problems: string[] = [],
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

/**
 * エラーを画面に出す文にする。要求の ID があれば問い合わせ番号として添える。
 *
 * @remarks 利用者が管理者へ問い合わせるときに、この番号で何が起きたかを調べられる（仕様書 第6.10.4節）。
 */
export function describeError(err: unknown, fallback = 'うまくいきませんでした'): string {
  if (err instanceof ApiError) {
    return err.requestId ? `${err.message}（問い合わせ番号: ${err.requestId.slice(0, 8)}）` : err.message;
  }
  return err instanceof Error ? err.message : fallback;
}

/** ヘルプの記事の一覧の 1 件。 */
export interface HelpArticleMeta {
  id: string; title: string; audience: string; category: string; related: string[]; source: 'official' | 'agent';
}

/** 業務の説明（仕様書 第6.10.5節）。 */
export interface AgentHelpView {
  agentId: string; name: string; summary: string;
  inputs: { key: string; title: string; required: boolean }[];
  flow: string[];
  approvals: { step: string; who: string }[];
  does: string[];
  safeguards: string[];
  examples: { title: string; input: Record<string, unknown> }[];
  notes: string[];
  faq: { q: string; a: string }[];
}

/** 管理者の初期設定チェックリストの 1 項目。 */
export interface ChecklistItem {
  id: string; label: string; done: boolean; go: string | null; help: string; note?: string | null; important?: boolean;
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
/** 人の状態の 1 人分（仕様書 第6.7.4.1節）。 */
export interface PresenceView {
  userId: string;
  name: string;
  state: 'approval' | 'activity' | 'running' | 'talking' | 'idle' | 'offline';
  detail: string;
  agentName: string | null;
  route: string | null;
  device: string | null;
}

export interface DashboardLive {
  generatedAt: string;
  counts: {
    activeUsers: number; running: number; awaitingApproval: number; failedToday: number;
    todayRuns: number; todayCostJpy: number; todaySavedMinutes: number;
  };
  /** 業務エージェントごとの受け持ち（仕様書 第6.7.4.2節）。使える業務はすべて入る。 */
  agents: {
    agentId: string; name: string;
    running: number; awaiting: number; queued: number;
    todayRuns: number; todayFailed: number;
  }[];
  /** いま動いている業務だけ。失敗は `failures` へ回す（第6.7.5.1節）。 */
  flows: {
    runId: string; agentName: string; status: string; requester: string; origin: string; startedAt: string;
    steps: { label: string; state: 'done' | 'current' | 'waiting' | 'failed' | 'todo' }[];
    waitingFor: { who: string; since: string; kind: 'approval' | 'confirm' } | null;
  }[];
  /** 今日（日本時間の 0 時以降）に失敗した業務。日が変わると消える（第6.7.5.1節）。 */
  failures: { runId: string; agentName: string; requester: string; at: string; reason: string }[];
  /** 人の状態。会社の設定が「人数と業務だけ」なら `null`（第6.7.4.1節）。 */
  people: PresenceView[] | null;
  /** 人数と業務だけの見せ方。個人名で表示する会社では `null`。 */
  peopleSummary: { counts: { state: string; label: string; n: number }[]; agents: string[] } | null;
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
  /** 版と、分けた節の数（一覧でだけ返る）。 */
  version?: number; sectionCount?: number;
  /** 業務から登録した場合、登録した実行の ID。Google から読んだデータで作ったか（仕様書 第9.5.2節）。 */
  originRunId?: string | null; googleDerived?: boolean;
}

/** 知識の節（分け方の確認用。仕様書 第11.7.2節）。 */
export interface KnowledgeSectionView {
  heading: string; path: string[]; chars: number;
}

/** 昇華の提案（仕様書 第11.3.1節）。 */
export interface PromotionView {
  id: string; text: string; status: 'proposed' | 'pending' | 'approved' | 'rejected' | 'withdrawn';
  comment: string | null; createdAt: string; decidedAt: string | null;
}

/** 記憶の候補（仕様書 第11.5.2節）。 */
export interface MemoryCandidateView {
  id: string; text: string; sourceDay: string; createdAt: string;
}

/** 会話ログの 1 往復（仕様書 第11.9.4.1節）。 */
export interface ConversationView {
  id: string; message: string; reply: string; layer: 'direct' | 'light' | 'full';
  agentId: string | null; runId: string | null; createdAt: string;
}

/** 個人記憶の 1 件（仕様書 第11.5.1節）。 */
export interface MemoryView {
  id: string; text: string; source: string; createdAt: string;
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
  /** 拡張機能の業務エージェントなら、その拡張機能と提供者。公式なら `null`。 */
  extension: { id: string; name: string; publisher: string } | null;
}

/** 導入できる拡張機能（仕様書 第12.9.3節）。 */
/** 拡張機能 1 つ分の表示（仕様書 第12.10.5節）。 */
export interface ExtensionView {
  id: string; name: string; version: string; description: string;
  publisher: { name: string; verified?: boolean };
  icon: string | null;
  readme: string | null;
  counts: { agents: number; connectors: number; tools: number };
  agents: { id: string; name: string; summary: string }[];
  connectors: {
    id: string; name: string; description: string; url: string; auth: string; authText: string;
    tools: { name: string; description: string; risk: string; riskText: string; enabled: boolean }[];
  }[];
  permissions: {
    maxRisk: string; maxRiskText: string;
    tools: { name: string; does: string; risk: string | null }[];
  };
  /** 公式の配布元か、ファイルから取り込んだもの（自社専用）か。 */
  origin: 'official' | 'private';
  originText: string;
  installed: { version: string; installedAt: string } | null;
  enabled: boolean;
  /** 権限が増えた版。有効にする前に再同意が要る。 */
  needsReconsent: boolean;
  active: boolean;
  /** 利用できる人（第16.7節）。 */
  scope: ScopeValue;
}

/** 管理者ページ「接続」の設定（仕様書 第14.3.3節）。秘密の値は含まない。 */
export interface ConnectionSettings {
  gemini: {
    mode: 'platform' | 'byok'; keyRegistered: boolean; updatedAt: string | null;
    models: Record<string, string>; defaults: Record<string, string>;
    effective: 'tenant' | 'platform' | 'none'; platformKeyAvailable: boolean;
  };
  google: {
    clientId: string; secretRegistered: boolean; updatedAt: string | null; redirectUri: string;
    requiredScopes: { scope: string; level: string; label: string }[];
    workspaceSource: string;
    users: { userId: string; name: string; email: string; connected: boolean; googleEmail: string | null; connectedAt: string | null; missing: string[] }[];
  };
}

/** 本人の Google 連携（仕様書 第6.5.2節）。 */
export interface MyGoogle {
  available: boolean; connected: boolean; googleEmail: string | null; connectedAt: string | null; checkedAt: string | null;
  scopes: { scope: string; label: string; granted: boolean }[]; needsReconnect: boolean;
}

/** 利用範囲（仕様書 第16.7節）。`'all'` は全員。 */
export type ScopeValue = 'all' | { groups: string[]; users: string[] };

/** 利用範囲の画面の選択肢。 */
export interface AccessOptions {
  scopes: Record<string, { groups: string[]; users: string[] }>;
  targets: { id: string; name: string; kind: 'agent' | 'extension' }[];
  groups: { id: string; name: string; memberCount: number }[];
  users: { id: string; displayName: string; email: string }[];
}

/** グループ（仕様書 第16.7.2節）。 */
export interface GroupView {
  id: string; name: string; description: string; memberIds: string[];
  /** 割り当てられている権限区画と業務（第16.7.5節）。所属を変える前に影響を示す。 */
  usedBy?: { compartments: string[]; agents: string[] };
}

/** 権限区画と、その割当（第16.3節・第16.7.5節）。 */
export interface CompartmentView {
  id: string; name: string; description: string | null; enabled: boolean; groups: string[]; users: string[];
}

/** コネクタの接続の確認の結果。 */
export type ConnectorCheck =
  | { ok: true; tools: { name: string; provided: boolean }[] }
  | { ok: false; error: string };

export interface JsonSchemaField {
  type: string;
  title?: string;
  format?: string;
  /**
   * 入力の例（JSON Schema の `examples`）。**1 つ目を入力欄に薄く置く**（仕様書 第6.10.4.1節）。
   * 説明の文を足すより、例のほうが短く確実に伝わる。
   */
  examples?: string[];
}

export interface RunDetail {
  run: Run;
  job: { agentId: string; input: Record<string, unknown>; requestedBy: string } | null;
  /** 段。API が表示名（仕様書 第9.2.4節）を足して返す。 */
  steps: (RunStep & { label: string })[];
  artifacts: Artifact[];
}

/** 後ろへ回した調べもの 1 件（仕様書 第10.11節）。 */
export interface Lookup {
  runId: string;
  request: string;
  status: string;
  /** 何をしているか。終わっていれば `null`。見込みの時間は出さない（第10.11.5節）。 */
  progress: string | null;
  /** 答え。終わるまでは `null`。 */
  text: string | null;
  failureReason: string | null;
  /** 終わった時刻。まだ終わっていなければ `null`。 */
  endedAt: string | null;
  /** 結果を伝えたか（仕様書 第10.11.7節）。 */
  told: boolean;
}

export interface SecretaryReply {
  layer: 'direct' | 'light' | 'full';
  text: string;
  evidence: { label: string; value: string }[];
  suggestedAgent?: { id: string; version: number; name: string };
  /** 使い方の質問に答えたとき、材料にしたヘルプの記事。 */
  helpArticles?: { id: string; title: string }[];
  /** 渡したファイルを受け取ったとき、その名前（仕様書 第10.10節）。 */
  file?: { name: string; note: string | null };
  /**
   * 後ろへ回した調べもの（仕様書 第10.11節）。
   *
   * @remarks **これがあるときは、まだ結果が出ていない。** 結果として扱わないこと。
   */
  lookup?: { runId: string; request: string };
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

/** 1 つのコネクタのツールを指す道（`/impact` と `/enabled` の手前まで）。 */
const toolPath = (id: string, connectorId: string, tool: string) =>
  `/admin/extensions/${encodeURIComponent(id)}/connectors/${encodeURIComponent(connectorId)}`
  + `/tools/${encodeURIComponent(tool)}`;

export const api = {
  download,
  help: {
    list: () => call<{ items: HelpArticleMeta[] }>('/help/articles'),
    get: (id: string) => call<HelpArticleMeta & { body: string }>(`/help/articles/${encodeURIComponent(id)}`),
    search: (q: string) => call<{ items: { id: string; title: string; category: string; excerpt: string }[] }>(
      `/help/search?q=${encodeURIComponent(q)}`),
    agent: (agentId: string) => call<AgentHelpView>(`/help/agents/${encodeURIComponent(agentId)}`),
  },
  onboarding: {
    tour: () => call<{ completedAt: string | null }>('/onboarding/tour'),
    finishTour: () => call('/onboarding/tour', { method: 'POST', body: JSON.stringify({}) }),
    resetTour: () => call('/onboarding/tour', { method: 'POST', body: JSON.stringify({ reset: true }) }),
    checklist: () => call<{ items: ChecklistItem[]; done: boolean }>('/onboarding/checklist'),
    notified: () => call('/onboarding/checklist/notified', { method: 'POST', body: JSON.stringify({}) }),
  },
  me: async () => {
    const me = await call<Me>('/me');
    csrfToken = me.csrfToken;
    return me;
  },
  providers: () => call<LoginProviders>('/auth/providers'),
  /** Google の同意画面の URL を得る（仕様書 第16.1.2節）。 */
  googleLoginUrl: () => call<{ url: string }>('/auth/google/start'),
  /**
   * 引換券を、このホストでのログイン状態に換える（仕様書 第16.1.2節）。
   *
   * @remarks 券は 1 回しか使えない。失敗したらログインをやり直す。
   */
  exchangeTicket: async (ticket: string) => {
    await call('/auth/exchange', { method: 'POST', body: JSON.stringify({ ticket }) });
  },
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
  /** 記憶を会社の知識にする提案（昇華。仕様書 第11.3.1節）。 */
  promoteMemory: (id: string) => call<{ id: string; status: string }>(`/me/memories/${id}/promote`, { method: 'POST', body: '{}' }),
  /** 秘書が作った候補を、組織の承認へ出す／やめる（仕様書 第11.3.1節）。 */
  submitPromotion: (id: string) => call(`/me/promotions/${id}/submit`, { method: 'POST', body: '{}' }),
  withdrawPromotion: (id: string) => call(`/me/promotions/${id}/withdraw`, { method: 'POST', body: '{}' }),
  /** 自分の昇華の履歴。 */
  myPromotions: () => call<{ items: PromotionView[] }>('/me/promotions'),
  /**
   * ファイルを上げる（帳票のロゴなど）。
   *
   * @remarks 受け付ける形式と大きさはサーバーが確かめる（仕様書 第9.4.1節）。
   */
  uploadFile: async (file: File): Promise<{ id: string; name: string }> => {
    const form = new FormData();
    form.append('file', file);
    const res = await fetch('/v1/files', {
      method: 'POST',
      credentials: 'same-origin',
      headers: {
        ...(devTenant ? { 'x-tenant': devTenant } : {}),
        ...(csrfToken ? { 'x-csrf-token': csrfToken } : {}),
      },
      body: form,
    });
    const body = await res.json().catch(() => ({ error: '通信に失敗しました' }));
    if (!res.ok) throw new ApiError(body.error ?? `エラー (${res.status})`, res.status, false);
    return body as { id: string; name: string };
  },
  /** 記憶の候補（仕様書 第11.5.2節）。対話から作られ、本人が採ると記憶になる。 */
  myMemoryCandidates: () => call<{ items: MemoryCandidateView[] }>('/me/memory-candidates'),
  acceptMemoryCandidate: (id: string) =>
    call(`/me/memory-candidates/${id}/accept`, { method: 'POST', body: '{}' }),
  dismissMemoryCandidate: (id: string) =>
    call(`/me/memory-candidates/${id}/dismiss`, { method: 'POST', body: '{}' }),
  /** 会話の要約（仕様書 第11.9.6節）。 */
  myConversationDigests: () => call<{ items: { day: string; summary: string }[] }>('/me/conversation-digests'),
  /** 会話ログ（仕様書 第11.9.4.1節）。本人のやり取りだけが返る。 */
  myConversations: (query = '') =>
    call<{ items: ConversationView[] }>(`/me/conversations${query ? `?q=${encodeURIComponent(query)}` : ''}`),
  deleteConversation: (id: string) => call(`/me/conversations/${id}`, { method: 'DELETE' }),
  clearConversations: () => call<{ removed: number }>('/me/conversations', { method: 'DELETE' }),
  /** 管理者のダッシュボードでの自分の見え方（仕様書 第6.7.10節 規定 4）。 */
  myPresence: () => call<{
    presence: PresenceView; granularity: 'names' | 'counts'; shown: string[]; hidden: string[];
  }>('/me/presence'),
  /** 記憶とデータ（仕様書 第6.5.4節）。本人の記憶だけが返る。 */
  myMemories: () => call<{ items: MemoryView[] }>('/me/memories'),
  deleteMemory: (id: string) => call(`/me/memories/${id}`, { method: 'DELETE' }),
  clearMemories: () => call<{ removed: number }>('/me/memories', { method: 'DELETE' }),
  saveDisplayName: (displayName: string) =>
    call('/me/profile', { method: 'PATCH', body: JSON.stringify({ displayName }) }),
  mySessions: () => call<{ items: {
    id: string; provider: string; userAgent: string | null; createdAt: string; lastSeenAt: string; current: boolean;
  }[] }>('/me/sessions'),
  revokeSession: (id: string) => call(`/me/sessions/${id}`, { method: 'DELETE' }),
  myGoogle: () => call<MyGoogle>('/me/google'),
  connectGoogle: () => call<{ url: string }>('/me/google/connect', { method: 'POST' }),
  checkGoogle: () => call<{ ok: boolean; error?: string }>('/me/google/check', { method: 'POST' }),
  disconnectGoogle: () => call<{ ok: true; revokedAtGoogle: boolean; stoppedRuns: number; purgedRuns: number }>('/me/google', { method: 'DELETE' }),
  /** 取り消すと止まる業務と、飛ばす定時実行の数（仕様書 第6.5.2.1節）。 */
  googleImpact: () => call<{ runs: { runId: string; agentName: string; status: string }[]; schedules: number }>('/me/google/impact'),
  myUsage: () => call<{
    seat: string; thisMonth: { runs: number; costJpy: number }; availableAgents: number;
    compartments: string[]; groups: string[]; plan: null;
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
    connections: () => call<ConnectionSettings>('/admin/connections'),
    saveGemini: (v: { mode: 'platform' | 'byok'; apiKey?: string; models?: Record<string, string> }) =>
      call('/admin/connections/gemini', { method: 'PUT', body: JSON.stringify(v) }),
    deleteGeminiKey: () => call('/admin/connections/gemini/key', { method: 'DELETE' }),
    testGemini: (kind: 'text' | 'live') =>
      call<{ ok: boolean; ms: number; error?: string; source: string; model: string }>('/admin/connections/gemini/test', { method: 'POST', body: JSON.stringify({ kind }) }),
    saveGoogleClient: (v: { clientId: string; clientSecret?: string }) =>
      call('/admin/connections/google', { method: 'PUT', body: JSON.stringify(v) }),
    deleteGoogleClient: () => call<{ ok: true; users: number; stoppedRuns: number }>('/admin/connections/google', { method: 'DELETE' }),
    /** OAuth クライアントを削除する（クライアント ID を替える）と影響する人数と業務の数（仕様書 第6.5.2.1節）。 */
    googleClientImpact: () => call<{ users: number; runs: number }>('/admin/connections/google/impact'),
    googlePermissions: () => call<{ items: { scope: string; level: string; tools: string[]; agents: string[] }[] }>('/admin/google-permissions'),
    connectors: () => call<{ workspace: { source: string; label: string }; llm: { provider: string } }>(
      '/admin/connectors',
    ),
    settings: () => call<TenantSettings & {
      catalog: {
        id: string; name: string; description: string; usesWriteInternal: boolean; defaultMinutes: number;
      }[];
    }>('/admin/settings'),
    /** 昇華の承認待ち（仕様書 第11.3.1節）。 */
    promotions: () => call<{
      items: { id: string; text: string; proposedBy: string; createdAt: string; canDecide: boolean }[];
    }>('/admin/promotions'),
    decidePromotion: (id: string, decision: 'approved' | 'rejected', comment: string | null) =>
      call<{ status: string }>(`/admin/promotions/${id}`, {
        method: 'POST', body: JSON.stringify({ decision, comment }),
      }),
    dashboardLive: () => call<DashboardLive>('/admin/dashboard/live'),
    /**
     * ダッシュボードの状態を受け取り続ける（SSE。仕様書 第6.7.9節）。
     *
     * @param onData 変化が届くたびに呼ぶ
     * @param onError 経路が切れたときに呼ぶ。呼び出し側が取り直しへ切り替える
     * @returns 受け取りをやめる関数
     *
     * @remarks
     * `EventSource` ではなく `fetch` の読み取りで受ける。`EventSource` は
     * 認証のヘッダー（開発用のテナント指定）を付けられないため（ADR-0013）。
     */
    dashboardStream: (onData: (live: DashboardLive) => void, onError: (e: unknown) => void): (() => void) => {
      const controller = new AbortController();
      void (async () => {
        try {
          const res = await fetch('/v1/admin/dashboard/stream', {
            credentials: 'same-origin',
            headers: { ...(devTenant ? { 'x-tenant': devTenant } : {}) },
            signal: controller.signal,
          });
          if (!res.ok || !res.body) throw new Error(`受け取れませんでした (${res.status})`);
          const reader = res.body.getReader();
          const decoder = new TextDecoder();
          let buffer = '';
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            buffer += decoder.decode(value, { stream: true });
            // 1 件は空行で区切られる
            const chunks = buffer.split('\n\n');
            buffer = chunks.pop() ?? '';
            for (const chunk of chunks) {
              const data = chunk.split('\n').find((l) => l.startsWith('data: '));
              if (data) onData(JSON.parse(data.slice('data: '.length)) as DashboardLive);
            }
          }
          throw new Error('接続が終了しました');
        } catch (e) {
          if (!controller.signal.aborted) onError(e);
        }
      })();
      return () => controller.abort();
    },
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
    saveKnowledge: (id: string | 'new', item: Omit<KnowledgeItemView, 'id' | 'updatedAt' | 'version' | 'sectionCount' | 'originRunId' | 'googleDerived'>) =>
      call<{ id: string; sections: KnowledgeSectionView[] }>(`/admin/knowledge/${id}`, { method: 'PUT', body: JSON.stringify(item) }),
    knowledgeSections: (id: string) =>
      call<{ sections: KnowledgeSectionView[] }>(`/admin/knowledge/${id}/sections`),
    deleteKnowledge: (id: string) => call(`/admin/knowledge/${id}`, { method: 'DELETE' }),
    extensions: () => call<{ items: ExtensionView[] }>('/admin/extensions'),
    installExtension: (id: string, scope: ScopeValue = 'all') =>
      call(`/admin/extensions/${encodeURIComponent(id)}/install`, { method: 'POST', body: JSON.stringify({ consent: true, scope }) }),
    groups: () => call<{ items: GroupView[] }>('/admin/groups'),
    createGroup: (name: string, description = '') =>
      call<GroupView>('/admin/groups', { method: 'POST', body: JSON.stringify({ name, description }) }),
    updateGroup: (id: string, patch: { name?: string; description?: string }) =>
      call<GroupView>(`/admin/groups/${encodeURIComponent(id)}`, { method: 'PATCH', body: JSON.stringify(patch) }),
    setGroupMembers: (id: string, userIds: string[]) =>
      call<GroupView>(`/admin/groups/${encodeURIComponent(id)}/members`, { method: 'PUT', body: JSON.stringify({ userIds }) }),
    deleteGroup: (id: string) =>
      call<{ ok: true; emptied: string[] }>(`/admin/groups/${encodeURIComponent(id)}`, { method: 'DELETE' }),
    access: () => call<AccessOptions>('/admin/access'),
    compartments: () => call<{ items: CompartmentView[] }>('/admin/compartments'),
    createCompartment: (name: string, description: string) =>
      call<CompartmentView>('/admin/compartments', { method: 'POST', body: JSON.stringify({ name, description }) }),
    /** 区画を使う・使わない（仕様書 第16.3.6.1節）。無効の間は誰も区画に入れない。 */
    setCompartmentEnabled: (id: string, enabled: boolean) =>
      call(`/admin/compartments/${id}/enabled`, { method: 'PUT', body: JSON.stringify({ enabled }) }),
    /** 区画を消す。知識や業務が残っていれば断られる。 */
    deleteCompartment: (id: string) => call(`/admin/compartments/${id}`, { method: 'DELETE' }),
    setCompartmentAssignment: (id: string, a: { groups: string[]; users: string[] }) =>
      call<CompartmentView>(`/admin/compartments/${encodeURIComponent(id)}/assignment`, { method: 'PUT', body: JSON.stringify(a) }),
    setScope: (target: string, scope: ScopeValue) =>
      call(`/admin/access/${encodeURIComponent(target)}`, { method: 'PUT', body: JSON.stringify({ scope }) }),
    uninstallExtension: (id: string) => call(`/admin/extensions/${encodeURIComponent(id)}`, { method: 'DELETE' }),
    /** `.m2ext` を取り込む。本文はファイルのバイト列そのもの。 */
    importExtension: (file: Blob) =>
      call<{ ok: true; item: ExtensionView | null }>('/admin/extensions/import', {
        method: 'POST', body: file, headers: { 'content-type': 'application/octet-stream' },
      }),
    setExtensionEnabled: (id: string, enabled: boolean) =>
      call(`/admin/extensions/${encodeURIComponent(id)}/enabled`, { method: 'PUT', body: JSON.stringify({ enabled }) }),
    checkConnector: (id: string, connectorId: string) =>
      call<ConnectorCheck>(
        `/admin/extensions/${encodeURIComponent(id)}/connectors/${encodeURIComponent(connectorId)}/check`,
        { method: 'POST' },
      ),
    /** ツールを止めると使えなくなる業務（仕様書 第6.6.3.1節）。止める前に示す。 */
    connectorToolImpact: (id: string, connectorId: string, tool: string) =>
      call<{ tool: string; agents: { id: string; name: string }[]; schedules: number }>(
        `${toolPath(id, connectorId, tool)}/impact`,
      ),
    /** コネクタのツールを 1 つ、有効または無効にする（仕様書 第6.6.3.1節）。 */
    setConnectorToolEnabled: (id: string, connectorId: string, tool: string, enabled: boolean) =>
      call(`${toolPath(id, connectorId, tool)}/enabled`, { method: 'PUT', body: JSON.stringify({ enabled }) }),
  },
  agents: () => call<{ agents: AgentSummary[] }>('/agents'),
  createJob: (agentId: string, input: Record<string, unknown>, origin = 'menu') =>
    call<{ jobId: string; runId: string }>('/jobs', {
      method: 'POST',
      body: JSON.stringify({ agentId, input, origin }),
    }),
  jobs: () => call<{ items: { run: Run; job: { agentId: string } | null }[] }>('/jobs'),
  run: (id: string) => call<RunDetail>(`/runs/${id}`),
  /** 実行を途中で止める（仕様書 第9.3.1節）。止められるのは依頼した本人だけ。 */
  cancelRun: (id: string) =>
    call<{ ok: true; leftoverLinks: string[] }>(`/runs/${id}/cancel`, { method: 'POST' }),
  approvals: () => call<{ items: Approval[] }>('/approvals'),
  decide: (id: string, decision: 'approved' | 'rejected', comment?: string) =>
    call<{ runId: string }>(`/approvals/${id}`, {
      method: 'POST',
      body: JSON.stringify({ decision, comment: comment ?? null }),
    }),
  /** 後ろへ回した調べものの状態（仕様書 第10.11.6節）。画面が定期的に読む。 */
  lookups: () => call<{ items: Lookup[] }>('/secretary/lookups'),
  /**
   * まだ伝えていない調べものを受け取る（仕様書 第10.11.7節「持ち越し」）。
   *
   * **読むだけではない。** 返ってきたものは「伝えた」として記録される。
   * 受け取ったら必ず画面に出すこと。
   */
  claimLookups: () => call<{ items: Lookup[] }>('/secretary/lookups/claim', { method: 'POST' }),
  /** 秘書に聞く。手元のファイルを 1 つ添えられる（仕様書 第10.10節）。 */
  ask: (message: string, fileId?: string) =>
    call<SecretaryReply>('/secretary', {
      method: 'POST',
      body: JSON.stringify({ message, ...(fileId ? { fileId } : {}) }),
    }),
};
