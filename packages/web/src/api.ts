/**
 * @file 画面から API を呼ぶ唯一の入口。Cookie と CSRF トークンを扱い、ログイン切れを画面に知らせる。
 *
 * 画面は API を経由する以外にデータへ到達する手段を持たない（A-2）。
 *
 * @see 仕様書 第13.1節 公開の方針
 * @see 仕様書 第20.7節 認証の実装方針
 */

import type {
  Approval, Artifact, Notification, Run, RunStep, Schedule, ScheduleRule, Tenant,
  TenantSettings, User, UserSettings, CardFields, Contact, ContactScope,
  InventoryItem, InventoryItemView, InventoryLocation, InventoryMove, InventoryMoveKind, InventorySettings, InventoryStockRow,
  HrEmployee, HrEmployeeView, HrSettings, HrTask, HrTerms,
  AttClose, AttDay, AttPeriod, AttPunchKind, AttTotals, LeaveBalance, LeaveGrant, LeaveTake,
  HrFamilyMember, HrPayrollProfile, HrStandardPay, PayRun, PaySlip,
  InventoryCount, InventoryCountRow, InventoryCountScope, InventoryCountView, InventorySupplier,
  InventoryBooking, InventoryBookingMapping, InventoryBookingSource,
} from '@m2office/shared';
import { debugMode, recordCall } from './debug.js';

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

/**
 * 数秒ごとに読み直す口。デバッグモードの記録では、うまくいった読み出しを残さない（直近 100 件が埋まって、見たいものが流れるため）。
 */
const POLLED = /^\/(notifications|approvals|jobs|agents|secretary\/lookups)(\?|$)|^\/secretary\/lookups\/claim$/;

async function call<T>(path: string, init?: RequestInit): Promise<T> {
  const started = performance.now();
  // デバッグモードでは、呼び出しと応答を画面の記録に残す（仕様書 第20.4.1節「デバッグモード」）。記録の読み出しそのものは残さない
  const traced = debugMode() && !path.startsWith('/debug/');
  const note = (status: number, response?: string) => recordCall({
    method: init?.method ?? 'GET', path, status, ms: Math.round(performance.now() - started),
    request: typeof init?.body === 'string' ? init.body : init?.body ? '（ファイルなど）' : undefined, response,
  });
  let res: Response;
  try {
    res = await fetch(`/v1${path}`, {
      ...init,
      credentials: 'same-origin',
      headers: {
        'content-type': 'application/json',
        ...(devTenant ? { 'x-tenant': devTenant } : {}),
        ...(csrfToken ? { 'x-csrf-token': csrfToken } : {}),
        ...(init?.headers ?? {}),
      },
    });
  } catch (err) {
    if (traced) note(0, String(err));
    throw err;
  }
  if (traced) {
    const text = await res.clone().text().catch(() => undefined);
    const quiet = res.ok && POLLED.test(path) && (!init?.method || init.method === 'GET' || text === '{"items":[]}');
    if (!quiet) note(res.status, text);
  }
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

/**
 * ファイルの中身を読む（画像・vCard など）。ログインと、開発で選んだ会社をそのまま使う。
 *
 * @returns 中身。読めなければ `null`
 */
async function fetchBlob(path: string): Promise<Blob | null> {
  const res = await fetch(`/v1${path}`, {
    credentials: 'same-origin', headers: devTenant ? { 'x-tenant': devTenant } : {},
  });
  return res.ok ? res.blob() : null;
}

/** 読んだ中身を、名前を付けて保存させる。 */
function saveBlob(blob: Blob, name: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
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
  examples: { title: string; input: Record<string, unknown> }[];
  notes: string[];
  faq: { q: string; a: string }[];
  /** 書き手が書いた利用者向けの説明（スキルの HELP.md。仕様書 第12.12.4節）。 */
  body?: string;
}

/** 管理者の初期設定チェックリストの 1 項目。 */
export interface ChecklistItem {
  id: string; label: string; done: boolean; go: string | null; help: string; note?: string | null; important?: boolean;
}

export interface Me {
  /** 会社。`name` は正式な会社名、`shortName` は略称、`logo` は会社のロゴの URL（仕様書 第6.6.1節）。 */
  tenant: Tenant & { shortName?: string; logo?: string | null };
  user: User;
  auth: { method: 'session' | 'dev-header' };
  csrfToken: string | null;
  /** 予定やメールの出どころ。`mock` の間は画面にダミーであることを示す。 */
  workspaceSource: 'mock' | 'google';
  /** 本人のアバター（Google のプロフィール写真。仕様書 第6.5.1.1節）の URL。まだ無ければ `null`。 */
  photo: string | null;
  /** サーバーの版（仕様書 第6.1.1.1節）。読めなければ `null`。 */
  serverVersion: string | null;
  /** 名刺管理を使えるか（会社の入り切りと利用範囲。仕様書 第27.2節）。 */
  cards?: boolean;
  /** 在庫管理を使えるか（会社の入り切りと利用範囲。仕様書 第29.2節）。 */
  inventory?: boolean;
  /** 人事・給与の担当者の画面を使えるか（会社の入り切りと人事区画。仕様書 第30.2節）。 */
  hr?: boolean;
  /** 本人の「給与・勤怠」を使えるか（台帳に結び付いているか。仕様書 第30.25節）。 */
  hrSelf?: boolean;
  /** デバッグモードか（`M2O_DEBUG=true`。仕様書 第20.4.1節「デバッグモード」）。 */
  debug?: boolean;
}

/** 1 日の打刻を直すときの入力（日本時間の HH:MM）。 */
export interface DayFixInput {
  in: string;
  out: string | null;
  breaks: { start: string; end: string }[];
}

/** 期間の従業員ごとの勤怠の行（担当者の画面）。 */
export interface AttSummaryRow {
  employeeId: string;
  name: string;
  totals: AttTotals;
  issues: number;
  alerts: string[];
}

/** 本人の「給与・勤怠」。 */
export interface MyHrView {
  employee: { id: string; name: string; hiredOn: string | null };
  state: { state: 'off' | 'working' | 'break'; since: string | null };
  period: AttPeriod;
  days: AttDay[];
  totals: AttTotals;
  today: string;
  leave: Omit<LeaveBalance, 'grants'> & { grants: LeaveBalance['grants']; takes: LeaveTake[] };
  halfDay: boolean;
  closed: boolean;
}

/** 従業員の取り込みの結果（仕様書 第30.5節）。 */
export interface HrImportResult {
  created: number;
  updated: number;
  skipped: { row: number; reason: string }[];
  mapping: { header: string; field: string | null }[];
}

/** デバッグモードのサーバーの記録の 1 件（仕様書 第20.4.1節「デバッグモード」）。 */
export interface DebugEvent {
  id: string;
  at: string;
  kind: 'voice' | 'secretary' | 'error';
  title: string;
  detail?: unknown;
}

/** 在庫の一覧（仕様書 第29.6節）。 */
export interface InventoryList {
  items: InventoryItemView[];
  locations: InventoryLocation[];
  settings: Pick<InventorySettings, 'features' | 'lowDefault'>;
  /** 見ている人が管理者か（品目の止め・場所の削除）。 */
  admin: boolean;
}

/** 品目 1 件の詳しい姿。 */
export interface InventoryDetail {
  item: InventoryItemView;
  stock: InventoryStockRow[];
  moves: InventoryMove[];
}

/** 入出庫を記録するときに送る値。 */
export interface InventoryMoveRequest {
  kind: InventoryMoveKind;
  itemId: string;
  qty: number;
  unit?: 'unit' | 'pack';
  locationId?: string;
  toLocationId?: string;
  lot?: string;
  expiresOn?: string;
  reason?: string;
}

/** 入出庫の記録の結果。 */
export interface InventoryMoveResult {
  ok: true;
  moves: InventoryMove[];
  item: InventoryItemView;
  warnings: string[];
}

/** 見張りの結果の 1 行（仕様書 第29.14節）。 */
export interface InventoryForecastRow {
  itemId: string;
  name: string;
  unit: string;
  packUnit: string;
  packSize: number | null;
  available: number;
  dailyUse: number;
  daysLeft: number | null;
  leadDays: number;
  low: boolean;
  runningOut: boolean;
  expiring: { lot: string | null; expiresOn: string; qty: number; days: number }[];
  proposal: {
    qty: number; packs: number | null; supplierId: string | null; supplierName: string | null;
    method: InventorySupplier['method'] | null; contact: string | null; reason: string;
  } | null;
}

/** 納品書から入庫した結果（仕様書 第29.9節）。 */
export interface InventorySlipResult {
  read: { ok: true; supplier: string; date: string } | { ok: false; reason: string };
  recorded: { line: InventorySlipLine; itemId: string; itemName: string; text: string }[];
  unmatched: { line: InventorySlipLine; reason: string; candidates: { id: string; name: string }[] }[];
  fileId?: string;
}

/** 納品書の 1 行。 */
export interface InventorySlipLine {
  name: string; sku: string; code: string; qty: number | null; unit: string; lot: string; expiresOn: string;
}

/** 発注を始めた結果。メールの仕入先なら業務の実行、それ以外は連絡先と伝える内容。 */
export type InventoryOrderResult =
  | { method: 'mail'; runId: string; supplier: string }
  | { method: 'web' | 'phone'; contact: string; supplier: string; text: string };

/** 品目の取り込みの結果。 */
export interface InventoryImportResult {
  created: number;
  updated: number;
  stocked: number;
  skipped: { row: number; reason: string }[];
  mapping: { header: string; field: string | null }[];
}

/** 名刺の一覧の 1 行（仕様書 第27.8節）。 */
export interface CardSummary {
  id: string; scope: ContactScope; ownerUserId: string; name: string; nameKana: string; company: string;
  department: string; title: string; emails: string[]; status: 'active' | 'trash'; trashedAt: string | null;
  cardId: string | null; frontFileId: string | null; frontRotation: number; frontKind: string | null;
  lastReceivedOn: string | null; cardCount: number;
}

/** 名刺の一覧。 */
export interface CardList {
  items: CardSummary[];
  /** 読み取り中のまとまりの進み具合（何枚中何枚）。無ければ `null`。 */
  progress: { total: number; finished: number } | null;
  /** 本人が取り込んで、読み取り中か読み取れなかった名刺。 */
  unresolved: { id: string; status: 'pending' | 'reading' | 'failed'; failureReason: string | null; frontFileId: string | null; createdAt: string }[];
  defaultScope: ContactScope;
  hasMore: boolean;
}

/** 名刺の受け付けの結果。 */
export interface CardAccept { batchId: string; queued: number; rejected: { name: string; reason: string }[] }

/** 名刺の詳細（仕様書 第27.8節）。 */
export interface CardDetail {
  contact: Contact;
  ownerName: string | null;
  updatedByName: string | null;
  cards: {
    id: string; receivedOn: string; receivedBy: string | null; mine: boolean; hasFront: boolean; hasBack: boolean;
    frontRotation: number; backRotation: number; note: string | null;
  }[];
  history: { receivedOn: string; company: string; department: string; title: string }[];
  canManage: boolean;
}

/** 会った日の本人の予定。 */
export type CardMeetings =
  | { available: true; days: { date: string; events: { title: string; start: string; end: string; allDay: boolean }[] }[] }
  | { available: false; reason: string };

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
  state: 'approval' | 'activity' | 'running' | 'voice' | 'talking' | 'idle' | 'offline';
  detail: string;
  agentName: string | null;
  route: string | null;
  device: string | null;
  /** 本人だけの状態（仕様書 第6.7.4.4節）。 */
  self: { state: 'approval' | 'voice' | 'talking' | 'idle' | 'offline'; detail: string };
  /** その人に付く秘書の状態。`busy` なら秘書が動いている（アバターを輪で囲む）。 */
  secretary: {
    state: 'activity' | 'running' | 'awaiting' | 'queued' | 'voice' | 'talking' | 'idle';
    detail: string; busy: boolean;
  };
}

/**
 * ダッシュボードの人の状態の 1 組（本人と秘書。仕様書 第6.7.4.4節）。個人名で表示する会社にだけ返る。
 *
 * @remarks `photo` と `secretary.avatar` は画面が読む URL。無ければ `null`（人の形のアイコンを出す）
 */
export interface PresencePairView extends PresenceView {
  photo: string | null;
  secretary: PresenceView['secretary'] & { name: string; avatar: string | null };
}

/** 承認待ち 1 件。どの業務かを添える（仕様書 第6.2.4節）。定義が見つからなければ `null`。 */
export type ApprovalView = Approval & { agentName: string | null };

export interface DashboardLive {
  generatedAt: string;
  counts: {
    activeUsers: number; running: number; awaitingApproval: number; failedToday: number;
    todayRuns: number; todayCostJpy: number; todaySavedMinutes: number;
  };
  /** 業務エージェントごとの受け持ち（仕様書 第6.7.4.2節）。使える業務はすべて入る。 */
  agents: {
    agentId: string; name: string;
    /** 同梱の絵の番号（1〜25。仕様書 第6.7.4.3節）。 */
    face: number;
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
  people: PresencePairView[] | null;
  /** 人数と業務だけの見せ方。個人名で表示する会社では `null`。 */
  peopleSummary: { counts: { state: string; label: string; n: number }[]; agents: string[] } | null;
  backlog: { approvalId: string; agentName: string; what: string; requester: string; approver: string; since: string }[];
  events: { at: string; kind: 'start' | 'done' | 'fail' | 'wait'; text: string }[];
}

/** OAuth クライアントを Google で確かめた結果（仕様書 第14.3.3節「登録の確認」）。 */
export type GoogleClientVerdict = 'ok' | 'bad-secret' | 'no-client' | 'unreachable' | 'unexpected';

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

/**
 * 管理者の定時実行の一覧の 1 行（仕様書 第6.6.8.2節）。
 *
 * @remarks **業務の入力は入らない。** `blockedReason` は次の回に動かない理由（起動役と同じ判定）
 */
export interface AdminSchedule {
  id: string; userId: string; userName: string; agentId: string; agentName: string;
  label: string; timezone: string; nextRunAt: string | null; lastRunAt: string | null;
  state: 'active' | 'paused' | 'blocked'; blockedReason: string | null;
}

/**
 * 実行 1 件の**状態だけ**（仕様書 第6.6.8節）。管理者の一覧で、その場に開くために使う。
 *
 * @remarks **中身は入らない。** 段の入力と出力、成果物、業務の入力は返らない。
 */
export interface AdminRunStatus {
  id: string; status: string; startedAt: string; endedAt: string | null;
  failureReason: string | null;
  tokensUsed: number; costJpy: number; savedMinutes: number; origin: string | null;
  steps: { seq: number; label: string; kind: string; status: string; startedAt: string; endedAt: string | null }[];
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
  /** メニューに出すか（スキルの user-invocable。仕様書 第12.12.2節）。`false` なら秘書が取り次いだときだけ使う。 */
  menu?: boolean;
  /** 定時実行に登録できるか（仕様書 第6.1.7節）。 */
  schedulable?: boolean;
  /** 使う前に本人が接続しておく会社の接続（仕様書 第12.11.6.3節）。無ければ空。 */
  needsConnection?: { id: string; name: string }[];
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
  /** 公式の配布元か、ファイルから取り込んだもの（自社専用）か、中核に組み込んだ内蔵の拡張（仕様書 第12.13節）か。 */
  origin: 'official' | 'private' | 'builtin';
  originText: string;
  installed: { version: string; installedAt: string } | null;
  enabled: boolean;
  /** 権限が増えた版。有効にする前に再同意が要る。 */
  needsReconsent: boolean;
  active: boolean;
  /** 利用できる人（第16.7節）。 */
  scope: ScopeValue;
  /** 名刺管理の会社の設定（取り込んだ名刺の既定の範囲。仕様書 第27.7節）。名刺管理のときだけある。 */
  cards?: { defaultScope: ContactScope };
  /** 在庫管理の会社の設定（機能の入り切りと既定の目安。仕様書 第29.4.1節）。在庫管理のときだけある。 */
  inventory?: InventorySettings;
  /** 人事・給与の会社の設定（仕様書 第30.8.1節）。人事・給与のときだけある。 */
  hr?: HrSettings;
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
  /** 誰がいつ判断したか（仕様書 第6.2.5節）。自動で通過した承認は判断した人が無い。 */
  decisions?: { runStepId: string; decision: string; decidedBy: string | null; decidedAt: string | null; comment: string | null }[];
}

/** 自分が判断した承認 1 件（仕様書 第6.2.5節）。 */
export interface DecidedApprovalView {
  id: string;
  runId: string;
  agentName: string;
  decision: 'approved' | 'rejected';
  decidedAt: string;
  comment: string | null;
  /** 判断したときの承認の画面（何を承認したか）。 */
  present: string;
  /** 依頼した人。自分の依頼なら `null`。 */
  requestedBy: string | null;
  /** 承認のあとに実際に行ったことと結果。 */
  done: { text: string; link: string | null; error: string | null }[];
}

/** 後ろへ回した調べもの 1 件（仕様書 第10.11節）。 */
export interface Lookup {
  runId: string;
  request: string;
  /** 秘書が頼んだ業務の名前。調べものなら `null`（仕様書 第10.9.6節）。 */
  agentName: string | null;
  /** 業務の ID（朝のブリーフは `morning-brief`）。 */
  agentId: string;
  /** 秘書が先回りして起こしたもの（仕様書 第10.12節）。 */
  proactive: boolean;
  status: string;
  /** 終わったか（完了・失敗・中止・期限切れ）。 */
  done: boolean;
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
  /** 根拠。`kind: 'source'` は社内の知識の出典、`cited` は答えで根拠にした出典（仕様書 第6.2節「出典の見せ方」）。 */
  evidence: { label: string; value: string; kind?: 'source'; cited?: boolean }[];
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

/**
 * 監査ログを CSV で保存する（仕様書 第6.6.8.1節）。画面の絞り込みをそのまま渡す。
 */
async function downloadAuditCsv(q: AuditFilter): Promise<void> {
  const res = await fetch(`/v1/admin/audit-events/export?${auditParams(q)}`, {
    credentials: 'same-origin',
    headers: devTenant ? { 'x-tenant': devTenant } : {},
  });
  if (!res.ok) throw new ApiError('監査ログを出力できませんでした', res.status);
  const url = URL.createObjectURL(await res.blob());
  const a = document.createElement('a');
  a.href = url;
  a.download = `監査ログ-${new Date().toISOString().slice(0, 10)}.csv`;
  a.click();
  URL.revokeObjectURL(url);
}

/** 監査ログの絞り込み（仕様書 第6.6.8.1節）。日付は `YYYY-MM-DD`（日本時間の一日）。 */
export interface AuditFilter { from?: string; to?: string; user?: string; category?: string; offset?: number }

function auditParams(q: AuditFilter): string {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(q)) if (v !== undefined && v !== '') p.set(k, String(v));
  return p.toString();
}

/** 監査ログの 1 行（誰が・何をしたか・何に対して。記録の名前と値も並べる）。 */
export interface AuditRowView {
  id: string;
  occurredAt: string;
  who: string;
  what: string;
  target: string;
  category: string;
  action: string;
  actor: string;
  targetRaw: string;
  detail: Record<string, unknown>;
}

/** 会社の接続（仕様書 第12.11.0節）を指す道。 */
const mcpPath = (id: string) => `/admin/connections/mcp/${encodeURIComponent(id)}`;

/** 会社の接続 1 つ（仕様書 第12.11.0節、ADR-0037）。 */
export interface McpConnectionView {
  id: string;
  name: string;
  description: string;
  url: string;
  auth: string;
  origin: string;
  originText: string;
  tools: { name: string; description: string; risk: string; riskText: string; enabled: boolean }[];
  /** その接続の道具を使う業務。 */
  usedBy: { id: string; name: string }[];
  /** 認証の状態（仕様書 第12.11.6節）。秘密の値は返らない。 */
  authState: McpAuthState;
}

/** 会社の接続の認証の状態。 */
export type McpAuthState =
  | { type: 'none'; text: string; ready: true }
  | { type: 'api_key'; text: string; ready: boolean; keySet: boolean; header: string }
  | {
    type: 'oauth'; text: string; ready: boolean;
    /** クライアント ID（秘密ではない）。シークレットは登録したかだけ。 */
    clientId: string; secretSet: boolean;
    /** 相手のサービスのアプリに登録する戻り先の URL。 */
    redirectUri: string;
    /** 求める権限（相手のアプリに足す）。 */
    scopes: string[];
    connectedUsers: number;
    preset: { id: string; name: string; setup: string[]; source: string; checkedAt: string } | null;
  };

/** よく使うサービスの登録の型（仕様書 第12.11.6.7節）。 */
export interface ConnectionPresetView { id: string; name: string; description: string; url: string }

/** 個人設定「サービスとの接続」の 1 つ（仕様書 第6.5.9節）。 */
export interface MyConnectionView {
  id: string;
  name: string;
  description: string;
  /** 会社の設定が済んでいて、接続できるか。 */
  available: boolean;
  connected: boolean;
  /** 許可したアカウントの表示名。 */
  account: string;
  connectedAt: string | null;
  /** 会社が道具を足して権限が増えた。接続し直しを促す。 */
  needsReconnect: boolean;
  usedBy: { id: string; name: string }[];
}

export const api = {
  download,
  /** デバッグモードのサーバーの記録（仕様書 第20.4.1節「デバッグモード」）。 */
  debug: {
    events: (after?: string) => call<{ events: DebugEvent[] }>(`/debug/events${after ? `?after=${encodeURIComponent(after)}` : ''}`),
    clear: () => call<{ ok: true }>('/debug/events', { method: 'DELETE' }),
  },
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
  /**
   * 声を試す（仕様書 第10.5.8節）。画面に入っている秘書の設定（保存の前でもよい）で、秘書に名乗らせる。
   * 声は PCM を base64 にしたもの。鳴らしたら捨てる。
   */
  voiceTest: (secretary: UserSettings['secretary']) =>
    call<{ text: string; audio: string; sampleRate: number; notes: string[] }>('/me/voice-test', { method: 'POST', body: JSON.stringify(secretary) }),
  /** 自分の記憶から、秘書が会社の知識にしたものの履歴（仕様書 第6.5.4節）。 */
  myPromotions: () => call<{ items: PromotionView[] }>('/me/promotions'),
  /**
   * ファイルを上げる（帳票のロゴなど）。
   *
   * @remarks 受け付ける形式と大きさはサーバーが確かめる（仕様書 第9.4.1節）。
   */
  /** ファイルの名前などを引く（本人が上げたもの・判断のために見られるものだけ）。 */
  fileMeta: (id: string) => call<{ id: string; name: string; kind: string; size: number }>(`/files/${encodeURIComponent(id)}`),
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
  /** 名刺管理（内蔵の拡張。仕様書 第27章）。 */
  cards: {
    /** 一覧と検索。本人の読み取り中・読み取れなかった名刺と、進み具合も返る（第27.8節）。 */
    list: (q: { q?: string; scope?: 'all' | ContactScope; trash?: boolean } = {}) => {
      const p = new URLSearchParams();
      if (q.q) p.set('q', q.q);
      if (q.scope && q.scope !== 'all') p.set('scope', q.scope);
      if (q.trash) p.set('trash', '1');
      return call<CardList>(`/cards?${p.toString()}`);
    },
    /**
     * 名刺のファイルを渡す（第27.4節）。読み取りは後ろで進むため、受け付けだけを待つ。
     *
     * @param backOf ファイルごとに、組にする表のファイルの番号（撮るときの「裏も撮る」）。表なら `null`
     */
    upload: async (files: File[], opts: { scope?: ContactScope; backOf?: (number | null)[] } = {}): Promise<CardAccept> => {
      const form = new FormData();
      for (const f of files) form.append('file', f);
      if (opts.backOf) form.append('backOf', JSON.stringify(opts.backOf));
      if (opts.scope) form.append('scope', opts.scope);
      const res = await fetch('/v1/cards', {
        method: 'POST', credentials: 'same-origin', body: form,
        headers: { ...(devTenant ? { 'x-tenant': devTenant } : {}), ...(csrfToken ? { 'x-csrf-token': csrfToken } : {}) },
      });
      const body = await res.json().catch(() => ({ error: '通信に失敗しました' }));
      if (!res.ok && !(body as CardAccept).rejected) throw new ApiError(body.error ?? `エラー (${res.status})`, res.status, false);
      return body as CardAccept;
    },
    get: (id: string) => call<CardDetail>(`/cards/${encodeURIComponent(id)}`),
    /** 項目とメモをその場で直す。 */
    update: (id: string, patch: Partial<CardFields> & { note?: string }) =>
      call<{ ok: true }>(`/cards/${encodeURIComponent(id)}`, { method: 'PATCH', body: JSON.stringify(patch) }),
    setScope: (id: string, scope: ContactScope) =>
      call<{ ok: true }>(`/cards/${encodeURIComponent(id)}/scope`, { method: 'PUT', body: JSON.stringify({ scope }) }),
    split: (id: string, cardId: string) =>
      call<{ contactId: string }>(`/cards/${encodeURIComponent(id)}/split`, { method: 'POST', body: JSON.stringify({ cardId }) }),
    trash: (id: string) => call<{ ok: true }>(`/cards/${encodeURIComponent(id)}`, { method: 'DELETE' }),
    restore: (id: string) => call<{ ok: true }>(`/cards/${encodeURIComponent(id)}/restore`, { method: 'POST' }),
    purge: (id: string) => call<{ ok: true }>(`/cards/${encodeURIComponent(id)}/purge`, { method: 'DELETE' }),
    /** 受け取った日を直す（受け取った本人だけ。第27.3節）。 */
    setReceivedOn: (cardId: string, receivedOn: string) =>
      call<{ ok: true }>(`/cards/card/${encodeURIComponent(cardId)}/received`, { method: 'PUT', body: JSON.stringify({ receivedOn }) }),
    dismiss: (cardId: string) => call<{ ok: true }>(`/cards/card/${encodeURIComponent(cardId)}`, { method: 'DELETE' }),
    /** 名刺交換のお礼のメールの件名と本文（第27.8節）。送らない。 */
    mailDraft: (id: string) => call<{ to: string; subject: string; body: string }>(`/cards/${encodeURIComponent(id)}/mail-draft`, { method: 'POST' }),
    /** 会った日の本人の予定（保存しない。第27.8節）。 */
    meetings: (id: string) => call<CardMeetings>(`/cards/${encodeURIComponent(id)}/meetings`),
    /**
     * 名刺の画像を読む。画面では `URL.createObjectURL` で出す（ログインと会社の指定をそのまま使うため）。
     *
     * @returns 画像。見られなければ `null`
     */
    image: (cardId: string, side: 'front' | 'back') => fetchBlob(`/cards/card/${encodeURIComponent(cardId)}/${side}`),
    /** vCard を保存する（1 件）。 */
    downloadVCard: async (id: string, name: string) => {
      const blob = await fetchBlob(`/cards/${encodeURIComponent(id)}/vcard`);
      if (!blob) throw new ApiError('書き出せませんでした', 404);
      saveBlob(blob, `${name || 'contact'}.vcf`);
    },
  },
  /** 在庫管理（内蔵の拡張。仕様書 第29章）。 */
  inventory: {
    list: (q: { q?: string; stopped?: boolean } = {}) => {
      const p = new URLSearchParams();
      if (q.q) p.set('q', q.q);
      if (q.stopped) p.set('stopped', '1');
      return call<InventoryList>(`/inventory?${p.toString()}`);
    },
    get: (id: string) => call<InventoryDetail>(`/inventory/items/${encodeURIComponent(id)}`),
    /**
     * 品目を作る。はじめの数があれば入庫として記録する。
     *
     * @returns 単位の欄の数をはじめの数として読んだときは、そのことを `note` で返す
     */
    create: (item: Partial<InventoryItem> & { initialQty?: number | null }) =>
      call<{ item: InventoryItemView; note: string | null }>('/inventory/items', { method: 'POST', body: JSON.stringify(item) }),
    update: (id: string, item: Partial<InventoryItem>) =>
      call<{ item: InventoryItem }>(`/inventory/items/${encodeURIComponent(id)}`, { method: 'PUT', body: JSON.stringify(item) }),
    /** 品目を止める・使うに戻す（管理者）。 */
    setStatus: (id: string, status: 'active' | 'stopped') =>
      call<{ ok: true }>(`/inventory/items/${encodeURIComponent(id)}/status`, { method: 'PUT', body: JSON.stringify({ status }) }),
    removeCode: (id: string, code: string) =>
      call<{ ok: true }>(`/inventory/items/${encodeURIComponent(id)}/codes/${encodeURIComponent(code)}`, { method: 'DELETE' }),
    /** 読んだバーコード・QR から品目か棚を引く（仕様書 第29.11節）。 */
    lookup: (code: string) => call<{
      parsed: { code: string; gtin: string | null; expiresOn: string | null; lot: string | null; kind: 'gs1' | 'ean' | 'other' };
      item: InventoryItem | null; location: InventoryLocation | null;
    }>(`/inventory/lookup?code=${encodeURIComponent(code)}`),
    addLocation: (warehouse: string, shelf: string) =>
      call<{ location: InventoryLocation }>('/inventory/locations', { method: 'POST', body: JSON.stringify({ warehouse, shelf }) }),
    removeLocation: (id: string) => call<{ ok: true }>(`/inventory/locations/${encodeURIComponent(id)}`, { method: 'DELETE' }),
    move: (m: InventoryMoveRequest) => call<InventoryMoveResult>('/inventory/moves', { method: 'POST', body: JSON.stringify(m) }),
    undo: (moveId: string) => call<InventoryMoveResult>(`/inventory/moves/${encodeURIComponent(moveId)}/undo`, { method: 'POST' }),
    /** CSV・Excel から品目を取り込む。列の見出しは AI が読む（仕様書 第29.6節）。 */
    importFile: async (file: File): Promise<InventoryImportResult> => {
      const form = new FormData();
      form.append('file', file);
      const res = await fetch('/v1/inventory/import', {
        method: 'POST', credentials: 'same-origin', body: form,
        headers: { ...(devTenant ? { 'x-tenant': devTenant } : {}), ...(csrfToken ? { 'x-csrf-token': csrfToken } : {}) },
      });
      const body = await res.json().catch(() => ({ error: '通信に失敗しました' }));
      if (!res.ok) throw new ApiError(body.error ?? `エラー (${res.status})`, res.status, false);
      return body as InventoryImportResult;
    },
    /**
     * スマホ用のページを開く QR（仕様書 第29.11.1節）。画面では `<img>` に出す。
     *
     * @returns 画像の URL（`URL.createObjectURL`）。作れなければ `null`
     */
    mobileQrUrl: async (): Promise<string | null> => {
      const blob = await fetchBlob('/inventory/mobile-qr.svg');
      return blob ? URL.createObjectURL(blob) : null;
    },
    /** 棚のラベル（QR）の PDF を保存する（仕様書 第29.7節）。`ids` を省けばすべての場所。 */
    downloadLabels: async (ids?: string[]) => {
      const blob = await fetchBlob(`/inventory/locations/labels.pdf${ids?.length ? `?ids=${ids.map(encodeURIComponent).join(',')}` : ''}`);
      if (!blob) throw new ApiError('ラベルを作れませんでした', 404);
      saveBlob(blob, '棚のラベル.pdf');
    },
    /** 予約との引き当て（仕様書 第29.13節）。今日から先の予約と、日を過ぎた取り置き・品目の分からない予約。 */
    bookings: () => call<{ bookings: InventoryBooking[]; overdue: InventoryBooking[]; unmapped: InventoryBooking[] }>('/inventory/bookings'),
    /** 画面で取り置く。 */
    hold: (b: { itemId: string; qty: number; startsAt: string; externalId?: string; menu?: string }) =>
      call<{ booking: InventoryBooking }>('/inventory/bookings', { method: 'POST', body: JSON.stringify(b) }),
    /** 予約で使った（取り置きを使用の記録にする）。 */
    useBooking: (id: string) => call<{ booking: InventoryBooking }>(`/inventory/bookings/${encodeURIComponent(id)}/use`, { method: 'POST' }),
    /** 予約の取り置きを取り消す。 */
    cancelBooking: (id: string) => call<{ booking: InventoryBooking }>(`/inventory/bookings/${encodeURIComponent(id)}/cancel`, { method: 'POST' }),
    /** メニューで使う品目を覚えさせる（`items` が空なら在庫を使わない）。 */
    teachMenu: (menu: string, items: { itemId: string; qty: number }[]) =>
      call<{ ok: true; applied: number }>('/inventory/menus', { method: 'POST', body: JSON.stringify({ menu, items }) }),
    /** 仕入先（仕様書 第29.4.1節）。 */
    suppliers: () => call<{ suppliers: InventorySupplier[] }>('/inventory/suppliers'),
    /** 仕入先を足す（`id` があれば直す）。 */
    saveSupplier: (s: Partial<InventorySupplier>) =>
      call<{ supplier: InventorySupplier }>('/inventory/suppliers', { method: 'POST', body: JSON.stringify(s) }),
    /** 見張りの結果（無くなる見込み・残りわずか・使用期限・発注の案。急ぐ順。第29.14節）。 */
    forecast: () => call<{ rows: InventoryForecastRow[] }>('/inventory/forecast'),
    /** 発注を始める。メールの仕入先なら「発注の下書き」を起こす（送るのは承認のあと）。 */
    order: (supplierId: string, lines: { itemId: string; qty: number }[]) =>
      call<InventoryOrderResult>('/inventory/orders', { method: 'POST', body: JSON.stringify({ supplierId, lines }) }),
    /** 納品書の写真か PDF を渡して入庫する（仕様書 第29.9節）。読めなかったときも結果を返す。 */
    slip: async (file: File, locationId?: string): Promise<InventorySlipResult> => {
      const form = new FormData();
      form.append('file', file);
      if (locationId) form.append('locationId', locationId);
      const res = await fetch('/v1/inventory/slips', {
        method: 'POST', credentials: 'same-origin', body: form,
        headers: { ...(devTenant ? { 'x-tenant': devTenant } : {}), ...(csrfToken ? { 'x-csrf-token': csrfToken } : {}) },
      });
      const body = await res.json().catch(() => ({ error: '通信に失敗しました' }));
      if (!res.ok && !(body as InventorySlipResult).read) throw new ApiError(body.error ?? `エラー (${res.status})`, res.status, false);
      return body as InventorySlipResult;
    },
    /** 棚卸し（仕様書 第29.10節）。 */
    counts: {
      /** 開いている棚卸し（無ければ `open: null`）と、最近の棚卸し。 */
      current: () => call<{ open: InventoryCountView | null; recent: InventoryCount[] }>('/inventory/counts'),
      /** 始める。開いていれば、それを続ける。 */
      start: (scope: InventoryCountScope, value?: string) =>
        call<{ view: InventoryCountView; created: boolean }>('/inventory/counts', { method: 'POST', body: JSON.stringify({ scope, value }) }),
      get: (id: string) => call<InventoryCountView>(`/inventory/counts/${encodeURIComponent(id)}`),
      /** 数える。読むたびに 1 つ足す（`add`）か、数え直して置き換える（`set`）。 */
      count: (id: string, line: { itemId: string; qty?: number; mode?: 'add' | 'set'; unit?: 'unit' | 'pack'; locationId?: string; lot?: string; expiresOn?: string }) =>
        call<{ row: InventoryCountRow }>(`/inventory/counts/${encodeURIComponent(id)}/lines`, { method: 'POST', body: JSON.stringify(line) }),
      /** 差の大きい品目の、考えられる理由（秘書の推測）。 */
      explain: (id: string) => call<{ text: string | null }>(`/inventory/counts/${encodeURIComponent(id)}/explain`, { method: 'POST' }),
      close: (id: string) => call<{ adjusted: number; uncounted: number }>(`/inventory/counts/${encodeURIComponent(id)}/close`, { method: 'POST' }),
      cancel: (id: string) => call<{ ok: true }>(`/inventory/counts/${encodeURIComponent(id)}/cancel`, { method: 'POST' }),
      exportFile: async (id: string) => {
        const blob = await fetchBlob(`/inventory/counts/${encodeURIComponent(id)}/export`);
        if (!blob) throw new ApiError('書き出せませんでした', 404);
        saveBlob(blob, `棚卸し-${new Date().toISOString().slice(0, 10)}.csv`);
      },
    },
    /** 品目と数を書き出す。 */
    exportFile: async (format: 'csv' | 'xlsx') => {
      const blob = await fetchBlob(`/inventory/export?format=${format}`);
      if (!blob) throw new ApiError('書き出せませんでした', 403);
      saveBlob(blob, `在庫-${new Date().toISOString().slice(0, 10)}.${format}`);
    },
  },
  /** 人事・給与の担当者（人事区画。仕様書 第30章）。 */
  hr: {
    list: () => call<{ employees: HrEmployeeView[]; tasks: HrTask[]; settings: HrSettings }>('/hr/employees'),
    get: (id: string) => call<{ employee: HrEmployee; terms: HrTerms[]; tasks: HrTask[] }>(`/hr/employees/${encodeURIComponent(id)}`),
    create: (input: Partial<HrEmployee> & { terms?: Partial<HrTerms> }) =>
      call<{ employee: HrEmployee; tasks: number }>('/hr/employees', { method: 'POST', body: JSON.stringify(input) }),
    update: (id: string, input: Partial<HrEmployee>) =>
      call<{ employee: HrEmployee }>(`/hr/employees/${encodeURIComponent(id)}`, { method: 'PUT', body: JSON.stringify(input) }),
    addTerms: (id: string, input: Partial<HrTerms>) =>
      call<{ terms: HrTerms }>(`/hr/employees/${encodeURIComponent(id)}/terms`, { method: 'POST', body: JSON.stringify(input) }),
    leave: (id: string, leftOn: string, reason: string) =>
      call<{ employee: HrEmployee; tasks: number }>(`/hr/employees/${encodeURIComponent(id)}/leave`, { method: 'POST', body: JSON.stringify({ leftOn, reason }) }),
    setTaskDone: (id: string, done: boolean) =>
      call<{ task: HrTask }>(`/hr/tasks/${encodeURIComponent(id)}`, { method: 'PUT', body: JSON.stringify({ done }) }),
    /** CSV・Excel から従業員を取り込む。列の見出しは AI が読む（仕様書 第30.5節）。 */
    importFile: async (file: File): Promise<HrImportResult> => {
      const form = new FormData();
      form.append('file', file);
      const res = await fetch('/v1/hr/import', {
        method: 'POST', credentials: 'same-origin', body: form,
        headers: { ...(devTenant ? { 'x-tenant': devTenant } : {}), ...(csrfToken ? { 'x-csrf-token': csrfToken } : {}) },
      });
      const body = await res.json().catch(() => ({ error: '通信に失敗しました' }));
      if (!res.ok) throw new ApiError(body.error ?? `エラー (${res.status})`, res.status, false);
      return body as HrImportResult;
    },
    /** 期間の勤怠の一覧（`month`: 締め日の月）。 */
    attendance: (month?: string) => call<{ period: AttPeriod; rows: AttSummaryRow[]; close: AttClose | null }>(`/hr/attendance${month ? `?month=${month}` : ''}`),
    attendanceOf: (employeeId: string, month?: string) =>
      call<{ employee: { id: string; name: string }; period: AttPeriod; days: AttDay[]; totals: AttTotals }>(`/hr/attendance/${encodeURIComponent(employeeId)}${month ? `?month=${month}` : ''}`),
    fixDay: (employeeId: string, date: string, fix: DayFixInput) =>
      call<{ day: AttDay }>(`/hr/attendance/${encodeURIComponent(employeeId)}/days/${date}`, { method: 'PUT', body: JSON.stringify(fix) }),
    closeAttendance: (month: string) => call<{ close: AttClose }>('/hr/attendance/close', { method: 'POST', body: JSON.stringify({ month }) }),
    reopenAttendance: (closeId: string) => call<{ ok: true }>(`/hr/attendance/closes/${encodeURIComponent(closeId)}/reopen`, { method: 'POST' }),
    attendanceBook: async (month: string) => {
      const blob = await fetchBlob(`/hr/attendance/book?month=${month}&format=xlsx`);
      if (!blob) throw new ApiError('書き出せませんでした', 403);
      saveBlob(blob, `出勤簿-${month}.xlsx`);
    },
    leaveOverview: () => call<{ rows: { employeeId: string; name: string; balance: LeaveBalance; lowAttendance: number | null }[] }>('/hr/leave'),
    addGrant: (employeeId: string, grantedOn: string, days: number, note: string) =>
      call<{ grant: LeaveGrant }>(`/hr/leave/${encodeURIComponent(employeeId)}/grants`, { method: 'POST', body: JSON.stringify({ grantedOn, days, note }) }),
    leaveRegister: async () => {
      const blob = await fetchBlob('/hr/leave/register?format=xlsx');
      if (!blob) throw new ApiError('書き出せませんでした', 403);
      saveBlob(blob, `年次有給休暇管理簿-${new Date().toISOString().slice(0, 10)}.xlsx`);
    },
    users: () => call<{ users: { id: string; name: string; email: string }[] }>('/hr/users'),
    /** 給与（段 3。仕様書 第30.10.1節）。 */
    payroll: {
      employee: (id: string) => call<{ profile: HrPayrollProfile; standardPays: HrStandardPay[]; family: HrFamilyMember[] }>(`/hr/payroll/employees/${encodeURIComponent(id)}`),
      saveProfile: (id: string, patch: Partial<HrPayrollProfile>) =>
        call<{ profile: HrPayrollProfile }>(`/hr/payroll/employees/${encodeURIComponent(id)}/profile`, { method: 'PUT', body: JSON.stringify(patch) }),
      addStandardPay: (id: string, fromMonth: string, pay: number) =>
        call<{ standardPay: HrStandardPay; grade: number }>(`/hr/payroll/employees/${encodeURIComponent(id)}/standard-pay`, { method: 'POST', body: JSON.stringify({ fromMonth, pay }) }),
      addFamily: (id: string, m: Partial<HrFamilyMember>) =>
        call<{ member: HrFamilyMember }>(`/hr/payroll/employees/${encodeURIComponent(id)}/family`, { method: 'POST', body: JSON.stringify(m) }),
      removeFamily: (id: string, memberId: string) =>
        call<{ ok: true }>(`/hr/payroll/employees/${encodeURIComponent(id)}/family/${encodeURIComponent(memberId)}`, { method: 'DELETE' }),
      runs: (month?: string) => call<{ runs: PayRun[]; schedule: { payDate: string; period: { start: string; end: string; label: string } } | null }>(`/hr/payroll/runs${month ? `?month=${month}` : ''}`),
      calculate: (month: string) => call<{ run: PayRun; slips: PaySlip[] }>('/hr/payroll/runs', { method: 'POST', body: JSON.stringify({ month }) }),
      run: (id: string) => call<{ run: PayRun; slips: PaySlip[] }>(`/hr/payroll/runs/${encodeURIComponent(id)}`),
    },
    /** 労働者名簿を書き出す。 */
    roster: async (format: 'csv' | 'xlsx') => {
      const blob = await fetchBlob(`/hr/roster?format=${format}`);
      if (!blob) throw new ApiError('書き出せませんでした', 403);
      saveBlob(blob, `労働者名簿-${new Date().toISOString().slice(0, 10)}.${format}`);
    },
  },
  /** 本人の「給与・勤怠」（人事・給与の段 2。仕様書 第30.25節）。 */
  myHr: {
    get: (month?: string) => call<MyHrView>(`/me/hr${month ? `?month=${month}` : ''}`),
    punch: (kind: AttPunchKind, source: 'screen' | 'mobile' = 'screen') => call<{ punch: { at: string } }>('/me/hr/punch', { method: 'POST', body: JSON.stringify({ kind, source }) }),
    fixDay: (date: string, fix: DayFixInput) => call<{ day: AttDay }>(`/me/hr/days/${date}`, { method: 'PUT', body: JSON.stringify(fix) }),
    leave: (date: string, days: number) => call<{ remaining: number }>('/me/hr/leave', { method: 'POST', body: JSON.stringify({ date, days }) }),
    cancelLeave: (id: string) => call<{ ok: true }>(`/me/hr/leave/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  },
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
  updateMemory: (id: string, text: string) =>
    call(`/me/memories/${id}`, { method: 'PATCH', body: JSON.stringify({ text }) }),
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
  createSchedule: (agentId: string, rule: ScheduleRule, input: Record<string, unknown> = {}) =>
    call<ScheduleView>('/schedules', { method: 'POST', body: JSON.stringify({ agentId, rule, input }) }),
  updateSchedule: (id: string, patch: { enabled?: boolean; rule?: ScheduleRule; input?: Record<string, unknown> }) =>
    call<ScheduleView>(`/schedules/${id}`, { method: 'PATCH', body: JSON.stringify(patch) }),
  deleteSchedule: (id: string) => call(`/schedules/${id}`, { method: 'DELETE' }),
  triggerSchedule: (id: string) => call(`/schedules/${id}/trigger`, { method: 'POST' }),
  admin: {
    usage: () => call<{
      items: { agentId: string; name: string; runs: number; costJpy: number; tokens: number }[];
      total: { runs: number; costJpy: number }; note: string | null;
    }>('/admin/usage'),
    runs: () => call<{ items: AdminRun[] }>('/admin/runs'),
    /** 会社の全員の定時実行（仕様書 第6.6.8.2節）。見るだけ。 */
    schedules: () => call<{ items: AdminSchedule[] }>('/admin/schedules'),
    /** 実行 1 件の状態だけ（仕様書 第6.6.8節）。**中身は返らない。** */
    runStatus: (id: string) => call<AdminRunStatus>(`/admin/runs/${id}`),
    users: () => call<{ items: User[] }>('/admin/users'),
    /** 監査ログ（仕様書 第6.6.8.1節）。期間・人・操作の種類で絞る。 */
    audit: (q: AuditFilter = {}) => call<{
      items: AuditRowView[]; hasMore: boolean; people: { id: string; name: string }[]; categories: { id: string; label: string }[];
    }>(`/admin/audit-events?${auditParams(q)}`),
    downloadAudit: downloadAuditCsv,
    connections: () => call<ConnectionSettings>('/admin/connections'),
    saveGemini: (v: { mode: 'platform' | 'byok'; apiKey?: string; models?: Record<string, string> }) =>
      call('/admin/connections/gemini', { method: 'PUT', body: JSON.stringify(v) }),
    deleteGeminiKey: () => call('/admin/connections/gemini/key', { method: 'DELETE' }),
    testGemini: (kind: 'text' | 'live') =>
      call<{ ok: boolean; ms: number; error?: string; source: string; model: string }>('/admin/connections/gemini/test', { method: 'POST', body: JSON.stringify({ kind }) }),
    /**
     * 会社の OAuth クライアントを保存する。保存の前に Google で組を確かめ、誤りなら保存せずに断る（仕様書 第14.3.3節）。
     *
     * @returns 判定と、保存のボタンの横に出す文
     */
    saveGoogleClient: (v: { clientId: string; clientSecret?: string }) =>
      call<{ ok: true; verdict: GoogleClientVerdict; message: string; users: number; stoppedRuns: number }>(
        '/admin/connections/google', { method: 'PUT', body: JSON.stringify(v) },
      ),
    /** 登録済みの OAuth クライアントを Google で確かめる。何も変えない（仕様書 第14.3.3節）。 */
    testGoogleClient: () =>
      call<{ ok: boolean; verdict: GoogleClientVerdict; message: string }>('/admin/connections/google/test', { method: 'POST' }),
    deleteGoogleClient: () => call<{ ok: true; users: number; stoppedRuns: number }>('/admin/connections/google', { method: 'DELETE' }),
    /** OAuth クライアントを削除する（クライアント ID を替える）と影響する人数と業務の数（仕様書 第6.5.2.1節）。 */
    googleClientImpact: () => call<{ users: number; runs: number }>('/admin/connections/google/impact'),
    googlePermissions: () => call<{ items: { scope: string; level: string; tools: string[]; agents: string[] }[] }>('/admin/google-permissions'),
    settings: () => call<TenantSettings & {
      catalog: {
        id: string; name: string; description: string; usesWriteInternal: boolean; defaultMinutes: number;
      }[];
    }>('/admin/settings'),
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
      call<{ ok: true; item: ExtensionView | null; notices?: string[] }>('/admin/extensions/import', {
        method: 'POST', body: file, headers: { 'content-type': 'application/octet-stream' },
      }),
    /** 名刺管理の、取り込んだ名刺の既定の範囲（仕様書 第27.7節）。 */
    setCardsDefaultScope: (defaultScope: ContactScope) =>
      call<{ ok: true }>('/admin/extensions/business-cards/settings', { method: 'PUT', body: JSON.stringify({ defaultScope }) }),
    /** 在庫管理の予約の受け口（仕様書 第29.13.1節）。 */
    bookingSources: () => call<{ sources: InventoryBookingSource[] }>('/admin/extensions/inventory/booking-sources'),
    /** 予約の受け口を作る。URL（鍵を含む）はこの応答で一度だけ返る。 */
    createBookingSource: (name: string) =>
      call<{ source: InventoryBookingSource; url: string }>('/admin/extensions/inventory/booking-sources', { method: 'POST', body: JSON.stringify({ name }) }),
    setBookingSourceStatus: (id: string, status: 'active' | 'stopped') =>
      call<{ ok: true }>(`/admin/extensions/inventory/booking-sources/${encodeURIComponent(id)}/status`, { method: 'PUT', body: JSON.stringify({ status }) }),
    /** 受け口の型を直す（`null` なら次の通知から AI が推測し直す）。 */
    setBookingSourceMapping: (id: string, mapping: InventoryBookingMapping | null) =>
      call<{ ok: true }>(`/admin/extensions/inventory/booking-sources/${encodeURIComponent(id)}/mapping`, { method: 'PUT', body: JSON.stringify({ mapping }) }),
    /** 在庫管理の、機能の入り切りと既定の目安（仕様書 第29.4.1節）。送った項目だけを変える。 */
    setInventorySettings: (patch: Partial<InventorySettings>) =>
      call<{ ok: true; inventory: InventorySettings }>('/admin/extensions/inventory/settings', { method: 'PUT', body: JSON.stringify(patch) }),
    /** 人事・給与の会社の設定（仕様書 第30.8.1節）。送った項目だけを変える。 */
    setHrSettings: (patch: Partial<HrSettings>) =>
      call<{ ok: true; hr: HrSettings }>('/admin/extensions/hr/settings', { method: 'PUT', body: JSON.stringify(patch) }),
    setExtensionEnabled: (id: string, enabled: boolean) =>
      call(`/admin/extensions/${encodeURIComponent(id)}/enabled`, { method: 'PUT', body: JSON.stringify({ enabled }) }),
    /** 会社の接続（コネクタ。仕様書 第12.11.0節）。 */
    mcpConnections: () => call<{ items: McpConnectionView[]; risks: { value: string; text: string }[]; presets: ConnectionPresetView[] }>('/admin/connections/mcp'),
    /**
     * 接続を登録する。認証の要らない接続は、MCP サーバに道具の一覧を問い合わせる。
     * `preset` を渡すと型（Slack など）から登録する（仕様書 第12.11.6.7節）。
     */
    addMcpConnection: (v: { url?: string; name?: string; id?: string; preset?: string; auth?: 'none' | 'oauth' | 'api_key'; header?: string }) =>
      call<{ ok: true; id: string; tools: number; auth: string }>('/admin/connections/mcp', { method: 'POST', body: JSON.stringify(v) }),
    /** 認証情報を登録する（仕様書 第12.11.6.2節）。値は暗号化され、返らない。 */
    setMcpCredentials: (id: string, v: { clientId?: string; clientSecret?: string; apiKey?: string }) =>
      call<{ ok: true; reset?: number; tools?: number; warning?: string }>(`${mcpPath(id)}/credentials`, { method: 'PUT', body: JSON.stringify(v) }),
    /** 道具ごとの危険度などを変える。 */
    updateMcpConnection: (id: string, v: { tools?: { name: string; risk: string }[]; name?: string }) =>
      call(mcpPath(id), { method: 'PUT', body: JSON.stringify(v) }),
    refreshMcpConnection: (id: string) =>
      call<{ ok: true; added: string[]; removed: string[] }>(`${mcpPath(id)}/refresh`, { method: 'POST' }),
    checkMcpConnection: (id: string) => call<ConnectorCheck>(`${mcpPath(id)}/check`, { method: 'POST' }),
    /** 接続を消すと使えなくなる業務。 */
    mcpConnectionImpact: (id: string) => call<{ agents: { id: string; name: string }[]; connectedUsers: number }>(`${mcpPath(id)}/impact`),
    deleteMcpConnection: (id: string) => call(mcpPath(id), { method: 'DELETE' }),
    /** ツールを止めると使えなくなる業務（仕様書 第6.6.3.1節）。止める前に示す。 */
    mcpToolImpact: (id: string, tool: string) =>
      call<{ tool: string; agents: { id: string; name: string }[]; schedules: number }>(`${mcpPath(id)}/tools/${encodeURIComponent(tool)}/impact`),
    /** 接続のツールを 1 つ、有効または無効にする（仕様書 第6.6.3.1節）。 */
    setMcpToolEnabled: (id: string, tool: string, enabled: boolean) =>
      call(`${mcpPath(id)}/tools/${encodeURIComponent(tool)}/enabled`, { method: 'PUT', body: JSON.stringify({ enabled }) }),
  },
  agents: () => call<{ agents: AgentSummary[] }>('/agents'),
  /** 個人設定「サービスとの接続」（仕様書 第6.5.9節）。 */
  myConnections: () => call<{ items: MyConnectionView[] }>('/me/connections'),
  /** 相手のサービスの許可の画面の URL を受け取る（画面を移す）。 */
  connectConnection: (id: string) => call<{ url: string }>(`/me/connections/${encodeURIComponent(id)}/connect`, { method: 'POST' }),
  /** 取り消すと止まるもの。 */
  connectionImpact: (id: string) =>
    call<{ runs: number; agents: { id: string; name: string }[]; schedules: number }>(`/me/connections/${encodeURIComponent(id)}/impact`),
  disconnectConnection: (id: string) =>
    call<{ ok: true; stopped: number }>(`/me/connections/${encodeURIComponent(id)}`, { method: 'DELETE' }),
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
  /** 承認待ち。どの業務かを添える（仕様書 第6.2.4節）。 */
  approvals: () => call<{ items: ApprovalView[] }>('/approvals'),
  /** 自分が判断した承認と却下（仕様書 第6.2.5節）。新しい順に 100 件まで。 */
  decidedApprovals: () => call<{ items: DecidedApprovalView[] }>('/approvals/decided'),
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
