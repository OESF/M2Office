/**
 * @file 画面から API を呼ぶ唯一の入口。Cookie と CSRF トークンを扱い、ログイン切れを画面に知らせる。
 *
 * 画面は API を経由する以外にデータへ到達する手段を持たない（A-2）。
 *
 * @see 仕様書 第13.1節 公開の方針
 * @see 仕様書 第20.7節 認証の実装方針
 */

import type { CardCorners,
  Approval, Artifact, Notification, Run, RunStep, Schedule, ScheduleRule, Tenant,
  TenantSettings, User, UserSettings, CardFields, Contact, ContactChange, ContactScope,
  InventoryItem, InventoryItemView, InventoryLocation, InventoryMove, InventoryMoveKind, InventorySettings, InventoryStockRow,
  HrEmployee, HrEmployeeView, HrSettings, HrTask, HrTerms,
  AttClose, AttDay, AttPeriod, AttPunchKind, AttTotals, LeaveBalance, LeaveGrant, LeaveTake,
  HrFamilyMember, HrPayrollProfile, HrStandardPay, PayRun, PaySlip, PayCheck, HrNoticeSettings, HrDeadline, PayAdjustment, BonusPlan,
  YeaDeclaration, YeaDeclarationView, YeaResult, SocialDetermination, SocialEvent, InsuranceEligibility, LaborInsuranceData, LaborInsuranceView, ShiftView, HrShiftSettings, HrShift,
  InventoryCount, InventoryCountRow, InventoryCountScope, InventoryCountView, InventorySupplier,
  InventoryBooking, InventoryBookingMapping, InventoryBookingSource, InventoryPublication, InventoryPublicationScope, InventoryPublicSnapshot,
  SignageAsset, SignageEntry, SignageScreen, SignageSettings, SignageInterruptInput, SignageInterruptView, SignagePhrase, SignageSound, SignageSource,
  ColumnWordPress, WebColumn, WebColumnSettings, WebColumnVersion, WebColumnTheme, ColumnPlanSlot, ColumnSignageSet,
  Inquiry, InquiryDetail, InquiryParty, InquiryTask, InquiryReply, InquiryMailSkipped, InquiryMonthStats, InquirySettings, InquiryFaqTopic,
  CompetitorOverview, CompetitorFact, CompetitorReport, CompetitorSettings,
  Announcement, AnnouncementDetail, AnnouncementPreview, AnnouncementRecipient, AnnouncementRecipientsRefined, AnnouncementSettings, AnnouncementTexts,
  WebReviewCandidates, WebReviewReport, WebReviewReportBrief, WebReviewSettings, WebReviewStatus, WebReviewFinding, WebReviewFindingStatus, WebPageMetrics,
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

/** 規程から作った設定の案の 1 項目（仕様書 第30.8.2節）。 */
export interface HrProposalField {
  key: string;
  label: string;
  current: string;
  proposed: string;
  value: unknown;
  quote: string;
  problem?: string;
}

/** 年末調整の本人の画面（仕様書 第30.15.1節）。 */
export interface YeaSelfView {
  declaration: YeaDeclarationView;
  /** 年末調整の対象か（対象でなければ理由）。 */
  target: boolean;
  reason: string | null;
  /** 本人が直せるか（担当者が確かめた後は直せない）。 */
  canEdit: boolean;
  /** 確定した年末調整の結果（同意のある人だけ）。 */
  result: YeaResult | null;
  /** 申告の不備の指摘。 */
  problems: string[];
}

/** 控除証明書の読み取りの結果。 */
export type CertificateReading =
  | { status: 'insurance'; items: { kind: keyof YeaDeclaration['insurance']; amount: number; company: string }[] }
  | { status: 'previous-job'; pay: number; social: number; tax: number; company: string }
  | { status: 'unreadable'; reason: string };

/** 本人の明細の一覧の 1 つ。 */
export interface MySlipSummary {
  id: string;
  payMonth: string;
  payDate: string;
  kind: string;
  gross: number;
  deductions: number;
  net: number;
}

/** ファイルを送る（multipart。既定は POST）。失敗なら ApiError（`problems` つき）。 */
async function postForm<T>(path: string, form: FormData, method: 'POST' | 'PUT' = 'POST'): Promise<T> {
  const res = await fetch(`/v1${path}`, {
    method, credentials: 'same-origin', body: form,
    headers: { ...(devTenant ? { 'x-tenant': devTenant } : {}), ...(csrfToken ? { 'x-csrf-token': csrfToken } : {}) },
  });
  const body = await res.json().catch(() => ({ error: '通信に失敗しました' }));
  if (!res.ok) throw new ApiError(body.error ?? `エラー (${res.status})`, res.status, false, null, Array.isArray(body.problems) ? body.problems : []);
  return body as T;
}

/** ファイルの中身そのものを本文にして送る（店頭サイネージの素材。仕様書 第31.6.1節）。失敗なら ApiError。 */
async function sendRaw<T>(method: 'POST' | 'PUT', path: string, body: Blob, headers: Record<string, string> = {}): Promise<T> {
  const res = await fetch(`/v1${path}`, {
    method, credentials: 'same-origin', body,
    headers: { 'content-type': body.type || 'application/octet-stream', ...headers, ...(devTenant ? { 'x-tenant': devTenant } : {}), ...(csrfToken ? { 'x-csrf-token': csrfToken } : {}) },
  });
  const b = await res.json().catch(() => ({ error: '通信に失敗しました' }));
  if (!res.ok) throw new ApiError(b.error ?? `エラー (${res.status})`, res.status);
  return b as T;
}

/** POST で作ったファイルを受け取る（振込データ）。失敗なら ApiError（`problems` つき）。 */
async function postBlob(path: string): Promise<{ blob: Blob; headers: Headers }> {
  const res = await fetch(`/v1${path}`, {
    method: 'POST', credentials: 'same-origin',
    headers: { ...(devTenant ? { 'x-tenant': devTenant } : {}), ...(csrfToken ? { 'x-csrf-token': csrfToken } : {}) },
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({ error: '通信に失敗しました' }));
    const problems = Array.isArray(body.problems) ? body.problems.map((p: unknown) => (typeof p === 'string' ? p : `${(p as { where: string }).where}: ${(p as { text: string }).text}`)) : [];
    throw new ApiError(body.error ?? `エラー (${res.status})`, res.status, false, null, problems);
  }
  return { blob: await res.blob(), headers: res.headers };
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
  id: string; title: string; audience: string; category: string; related: string[]; source: 'official' | 'agent' | 'manual';
  /** 業務の区分（マニュアルの名前）。ヘルプの木で同じ業務の下にまとめる（仕様書 第6.10.7.3節）。 */
  business?: string;
  /** 木の中の小分け（管理者向けの「はじめに」「設定」「記録」）。 */
  group?: string;
  /** マニュアルの中の順（0 がはじめに）。 */
  order?: number;
}

/** ヘルプを出す所（仕様書 第6.10.7節）。 */
export type HelpScope = 'workspace' | 'admin';

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
  /** 店頭サイネージを使えるか（会社の入り切りと利用範囲。仕様書 第31.2節）。 */
  signage?: boolean;
  /** Web のコラムを使えるか（会社の入り切りと利用範囲。仕様書 第32.18.1節）。 */
  webColumns?: boolean;
  /** 問い合わせの記録を使えるか（会社の入り切りと利用範囲。仕様書 第33.17節）。 */
  inquiries?: boolean;
  /** 競合の分析を使えるか（会社の入り切りと利用範囲。仕様書 第36.18節）。 */
  competitors?: boolean;
  /** お知らせの作成を使えるか（会社の入り切りと利用範囲。仕様書 第35.17節）。 */
  announcements?: boolean;
  /** Webの分析を使えるか（会社の入り切りと利用範囲。仕様書 第34.18節）。 */
  webReview?: boolean;
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

/** 在庫の Web への公開のまとまり 1 つ（管理者向け。仕様書 第29.12.1節・第29.12.2節）。 */
export interface InventoryPublicationView {
  publication: InventoryPublication;
  /** 承認した品目のうち、いま止めている品目の数（出ていない）。 */
  stoppedInScope: number;
  /** 貼るための URL（埋め込みのページと公開のデータ）。承認する前は `null`。 */
  urls: { page: string; data: string } | null;
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
  /** 名刺の四隅（画面が切り出しに使う。仕様書 第27.5節）。 */
  frontCorners: CardCorners | null;
  lastReceivedOn: string | null; cardCount: number;
}

/** まとめてのメールの宛先 1 人。 */
export interface BulkMailRecipient { contactId: string | null; name: string; company: string; email: string }

/** まとめてのメールの見本と、送る前の確かめ（仕様書 第27.9.1節）。 */
export interface BulkMailPreview {
  id: string;
  status: 'draft' | 'awaiting' | 'sending' | 'done' | 'cancelled';
  subject: string; body: string;
  advertising: boolean | null;
  recipients: BulkMailRecipient[];
  excluded: (BulkMailRecipient & { reason: string })[];
  sample: { to: string; subject: string; body: string } | null;
  problems: string[];
  progress: { total: number; sent: number; failed: number; skipped: number; pending: number };
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

/** 表からの名刺の取り込みの結果（仕様書 第27.4節）。 */
export interface CardTableImport {
  created: number; merged: number;
  skipped: { row: number; reason: string }[];
  mapping: { header: string; field: string | null }[];
}

/** 名刺の詳細（仕様書 第27.8節）。 */
export interface CardDetail {
  contact: Contact;
  ownerName: string | null;
  updatedByName: string | null;
  cards: {
    id: string; receivedOn: string; receivedBy: string | null; mine: boolean; hasFront: boolean; hasBack: boolean;
    frontRotation: number; backRotation: number; note: string | null;
    frontCorners: CardCorners | null; backCorners: CardCorners | null;
  }[];
  history: { receivedOn: string; company: string; department: string; title: string }[];
  /** メールの署名から新しくした記録（仕様書 第27.6.1節）。 */
  changes: Pick<ContactChange, 'id' | 'occurredAt' | 'fields'>[];
  /** 自分がこの人に送ったまとめてのメール（仕様書 第27.9.1節）。 */
  bulkMails: { bulkMailId: string; subject: string; sentAt: string }[];
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
    /** 同梱の絵の番号（1〜50。仕様書 第6.7.4.3節）。 */
    face: number;
    /** まとまり（拡張機能か業務の分野。仕様書 第6.7.4.2.1節）。古い API では無い。 */
    group?: { id: string; name: string };
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
  /** 接続先（仕様書 第6.7.6節）。古い API では無い。 */
  connections?: ConnectionHealth[];
}

/** 接続先 1 つの状態（仕様書 第6.7.6節）。直近 15 分の呼び出しの成否と時間から決める。 */
export interface ConnectionHealth {
  target: string;
  group: 'ai' | 'google' | 'mcp';
  name: string;
  /** 正常・遅延・失敗・未接続。 */
  state: 'ok' | 'slow' | 'fail' | 'off';
  /** 直近 2 分に呼び出しがあったか。 */
  active: boolean;
  calls: number;
  fails: number;
  avgMs: number | null;
  /** 最後の失敗の種類の言葉（「混雑」など）。 */
  lastError: string | null;
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
  /** 種類（社内規程・議事録・秘書が学んだこと）と状態（使う・廃止・しまった）。仕様書 第11.11節。 */
  category?: 'rule' | 'minutes' | 'learned';
  status?: 'active' | 'retired' | 'archived';
  statusAt?: string | null;
  /** しまった理由（merged・stale・unused・conflict）。 */
  statusReason?: string | null;
  /** 施行している版の施行日（社内規程）と、施行日が先の版。 */
  effectiveFrom?: string | null;
  pending?: { version: number; effectiveFrom: string } | null;
  /** 答えの根拠に最後に使った日。 */
  lastUsedAt?: string | null;
}

/** 社内規程の 1 つの版（仕様書 第11.11.2節）。 */
export interface KnowledgeVersionView {
  itemId: string; version: number; effectiveFrom: string; title: string; body: string; source: string;
  savedAt: string; current: boolean; pending: boolean; chars: number;
}

/** 最後に秘書が学んだことを整理した日と数（仕様書 第11.11.4節）。 */
export interface ConsolidationView {
  at: string;
  detail: { merged?: number; stale?: number; unused?: number; conflict?: number; ai?: boolean };
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
  /** しまった日と理由（しまったものの一覧でだけ。仕様書 第11.11.4節）。 */
  archivedAt?: string | null; archiveReason?: string | null;
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
  cards?: { defaultScope: ContactScope; mailSignature: boolean; bulkMailAdminApproval: boolean; optOuts: number };
  /** 在庫管理の会社の設定（機能の入り切りと既定の目安。仕様書 第29.4.1節）。在庫管理のときだけある。 */
  inventory?: InventorySettings;
  /** 人事・給与の会社の設定（仕様書 第30.8.1節）。人事・給与のときだけある。 */
  hr?: HrSettings;
  /** 店頭サイネージの会社の設定（仕様書 第31.4節）。店頭サイネージのときだけある。 */
  signage?: SignageSettings;
  /** Web のコラムの会社の設定（仕様書 第32.18.1節）。Web のコラムのときだけある。パスワードは含まない。 */
  webColumns?: WebColumnSettings;
  /** 今月、カバーの AI の挿絵を描いた枚数と上限（第32.18.2節）。Web のコラムのときだけある。 */
  columnAiUsage?: { used: number; limit: number };
  /** 問い合わせの記録の設定（窓口のアカウント。第33.18節）。問い合わせの記録のときだけある。 */
  inquiries?: InquirySettings;
  /** 競合の分析の設定（地図の鍵を預けたか。第36.18節）。競合の分析のときだけある。 */
  competitors?: CompetitorSettings;
  /** お知らせの作成の設定（Web の出し方・カテゴリー。第35.4節）。お知らせの作成のときだけある。 */
  announcements?: AnnouncementSettings;
  /** Webの分析の設定（担当の許可・選んだプロパティとサイト。第34.18節）。Webの分析のときだけある。 */
  webReview?: WebReviewSettings;
}

/** 問い合わせを残した結果（仕様書 第33.17節）。どの続きか決まらなければ `ambiguous` と候補。 */
export type InquiryRecorded =
  | { kind: 'created' | 'appended'; inquiry: Inquiry; task: InquiryTask | null; closedTask: InquiryTask | null; sensitive: boolean; contactCreated: boolean }
  | { ambiguous: true; candidates: Inquiry[] };

/** Web のコラム 1 つと版（仕様書 第32.18.1節）。 */
export interface ColumnDetail {
  column: WebColumn;
  /** 版（新しい順）。 */
  versions: WebColumnVersion[];
  wordpress: ColumnWordPress | null;
  /** 公開されたコラムの数字（この 28 日。Webの分析を使える人にだけある。第34.19節）。 */
  webMetrics?: WebPageMetrics | null;
  /** 公開の URL（WordPress で公開された URL か、貼るだけのページの記事の URL。SNS の告知文に足す。第32.18.4節）。 */
  publicUrl?: string | null;
}

/** 店頭サイネージの管理の画面の中身（仕様書 第31.9.4節）。 */
export interface SignageOverview {
  screens: SignageScreen[];
  usage: { bytes: number; limit: number };
  maxScreens: number;
  settings: SignageSettings;
  admin: boolean;
}

/** 店頭サイネージの素材（どの画面の流れに入っているかつき）。 */
export type SignageAssetView = SignageAsset & { screens: string[] };

/** 管理者ページ「接続」の設定（仕様書 第14.3.3節）。秘密の値は含まない。 */
export interface ConnectionSettings {
  /** 配備の形と会社の AI の方針（仕様書 第8.6節・第16.3.7.1節）。 */
  ai: {
    deployment: 'cloud' | 'onsite';
    policy: 'cloud' | 'local-first' | 'local-only';
    effective: 'cloud' | 'local-first' | 'local-only';
    /** ローカル AI の口が設定されているか。 */
    localConfigured: boolean;
  };
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
  /** 業務の段の並び（動いている間の進み具合に使う。仕様書 第6.2.2.2節）。 */
  plan?: { stepId: string; label: string; kind: 'agent' | 'approval' }[];
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
  /** いまの動きを始めた時刻（経過した時間を数える。第10.11.6節）。承認待ち・分からないときは `null`。 */
  since: string | null;
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
  /** その接続のツールを使う業務。 */
  usedBy: { id: string; name: string }[];
  /** 認証の状態（仕様書 第12.11.6節）。秘密の値は返らない。 */
  authState: McpAuthState;
  /** ローカルの方針のときに、この接続（社外）に送ってよいもの（仕様書 第16.3.7.1節）。 */
  sendPolicy: 'block' | 'deidentified';
}

/** 会社の接続の認証の状態。 */
export type McpAuthState =
  | { type: 'none'; text: string; ready: true }
  | { type: 'api_key'; text: string; ready: boolean; keySet: boolean; header: string }
  | {
    type: 'oauth'; text: string; ready: boolean;
    /** クライアント ID（秘密ではない）。シークレットは登録したかだけ。自動で登録したものは空。 */
    clientId: string; secretSet: boolean;
    /** 相手がアプリの自動登録に対応しているか・M2Office が自動で登録したか（仕様書 第12.11.6.2節、Q-99）。 */
    autoRegister: boolean; autoRegistered: boolean;
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
  /** 会社がツールを足して権限が増えた。接続し直しを促す。 */
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
    list: (scope: HelpScope = 'workspace') => call<{ items: HelpArticleMeta[]; manuals: { id: string; title: string }[] }>(`/help/articles?scope=${scope}`),
    get: (id: string) => call<HelpArticleMeta & { body: string }>(`/help/articles/${encodeURIComponent(id)}`),
    search: (q: string, scope: HelpScope = 'workspace') => call<{ items: { id: string; title: string; category: string; excerpt: string }[] }>(
      `/help/search?q=${encodeURIComponent(q)}&scope=${scope}`),
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
    list: (q: { q?: string; scope?: 'all' | ContactScope; trash?: boolean; from?: string; to?: string } = {}) => {
      const p = new URLSearchParams();
      if (q.q) p.set('q', q.q);
      if (q.scope && q.scope !== 'all') p.set('scope', q.scope);
      if (q.trash) p.set('trash', '1');
      // 交換した日の範囲（まとめてのメールの宛先を探す。第27.9.1節）
      if (q.from) p.set('from', q.from);
      if (q.to) p.set('to', q.to);
      return call<CardList>(`/cards?${p.toString()}`);
    },
    /** まとめてのメール（仕様書 第27.9.1節）。下書きは作った本人だけが見られる。 */
    bulk: {
      create: (d: { contactIds: string[]; subject: string; body: string }) =>
        call<{ id: string }>('/cards/bulk-mails', { method: 'POST', body: JSON.stringify(d) }),
      get: (id: string) => call<BulkMailPreview>(`/cards/bulk-mails/${encodeURIComponent(id)}`),
      update: (id: string, d: { contactIds?: string[]; subject?: string; body?: string }) =>
        call<{ ok: true }>(`/cards/bulk-mails/${encodeURIComponent(id)}`, { method: 'PUT', body: JSON.stringify(d) }),
      remove: (id: string) => call<{ ok: true }>(`/cards/bulk-mails/${encodeURIComponent(id)}`, { method: 'DELETE' }),
      /** 承認へ進める（業務「まとめてのメール」を始め、本人の承認を待つ）。 */
      submit: (id: string) => call<{ runId: string }>(`/cards/bulk-mails/${encodeURIComponent(id)}/submit`, { method: 'POST', body: JSON.stringify({}) }),
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
    /** 表（CSV・Excel）から名刺を取り込む（仕様書 第27.4節）。1 行を 1 枚として、その場で登録する。 */
    importTable: (file: File, scope?: ContactScope) => {
      const form = new FormData();
      form.append('file', file);
      if (scope) form.append('scope', scope);
      return postForm<CardTableImport>('/cards/import', form);
    },
    /** 会社で共有の名刺を CSV・Excel で書き出す（管理者だけ。仕様書 第27.10節）。 */
    exportTable: async (format: 'csv' | 'xlsx') => {
      const blob = await fetchBlob(`/cards/export?format=${format}`);
      if (!blob) throw new ApiError('書き出せませんでした', 404);
      saveBlob(blob, `business-cards-${new Date().toISOString().slice(0, 10)}.${format}`);
    },
    get: (id: string) => call<CardDetail>(`/cards/${encodeURIComponent(id)}`),
    /** 項目とメモをその場で直す。 */
    update: (id: string, patch: Partial<CardFields> & { note?: string }) =>
      call<{ ok: true }>(`/cards/${encodeURIComponent(id)}`, { method: 'PATCH', body: JSON.stringify(patch) }),
    setScope: (id: string, scope: ContactScope) =>
      call<{ ok: true }>(`/cards/${encodeURIComponent(id)}/scope`, { method: 'PUT', body: JSON.stringify({ scope }) }),
    /** メールの署名から新しくした記録を戻す（仕様書 第27.6.1節）。 */
    revertChange: (id: string, changeId: string) =>
      call<{ ok: true }>(`/cards/${encodeURIComponent(id)}/changes/${encodeURIComponent(changeId)}/revert`, { method: 'POST' }),
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
  /** 問い合わせの記録（内蔵の拡張。仕様書 第33章）。 */
  inquiries: {
    list: (q: { status?: 'open' | 'all'; q?: string; contactId?: string } = {}) => {
      const p = new URLSearchParams();
      if (q.status) p.set('status', q.status);
      if (q.q) p.set('q', q.q);
      if (q.contactId) p.set('contactId', q.contactId);
      return call<{ items: Inquiry[] }>(`/inquiries${p.size ? `?${p}` : ''}`);
    },
    /** 1 行の欄に書いた文から残す。続きなら同じ問い合わせに足す。どの続きか決まらなければ候補が返る。 */
    record: (text: string) => call<InquiryRecorded>('/inquiries', { method: 'POST', body: JSON.stringify({ text }) }),
    get: (id: string) => call<InquiryDetail>(`/inquiries/${encodeURIComponent(id)}`),
    /** 1 件の画面から続きを足す。 */
    append: (id: string, text: string) => call<InquiryRecorded>(`/inquiries/${encodeURIComponent(id)}/events`, { method: 'POST', body: JSON.stringify({ text }) }),
    update: (id: string, patch: Partial<{ from: Partial<InquiryParty>; channel: string; category: string; summary: string; source: string; temperature: string; status: string }>) =>
      call<{ ok: true }>(`/inquiries/${encodeURIComponent(id)}`, { method: 'PATCH', body: JSON.stringify(patch) }),
    addTask: (id: string, task: { what: string; due: string | null }) =>
      call<{ ok: true }>(`/inquiries/${encodeURIComponent(id)}/tasks`, { method: 'POST', body: JSON.stringify(task) }),
    updateTask: (taskId: string, patch: Partial<{ what: string; due: string | null; done: boolean }>) =>
      call<{ ok: true }>(`/inquiries/tasks/${encodeURIComponent(taskId)}`, { method: 'PATCH', body: JSON.stringify(patch) }),
    remove: (id: string) => call<{ ok: true }>(`/inquiries/${encodeURIComponent(id)}`, { method: 'DELETE' }),
    /** 会話の履歴 1 つを、別の問い合わせに分ける。 */
    split: (eventId: string) => call<{ id: string }>(`/inquiries/events/${encodeURIComponent(eventId)}/split`, { method: 'POST', body: '{}' }),
    /** 窓口のアカウントの新しいメールを今すぐ読む（30 秒に 1 回まで）。 */
    checkMail: () => call<{ created: number; appended: number; skipped: number; sent: number; throttled?: boolean }>('/inquiries/mail/check', { method: 'POST', body: '{}' }),
    /** 窓口のアカウントのメールのうち、問い合わせでないと見分けたもの。 */
    skipped: () => call<{ items: InquiryMailSkipped[] }>('/inquiries/mail/skipped'),
    /** 問い合わせでないとしたメールを、問い合わせにする。 */
    promote: (messageId: string) => call<{ id: string }>(`/inquiries/mail/${encodeURIComponent(messageId)}/promote`, { method: 'POST', body: '{}' }),
    /** 会話の履歴のメールの中身（窓口のアカウントから読む）。 */
    mail: (eventId: string) => call<{ from: string; to: string[]; subject: string; date: string; body: string }>(`/inquiries/events/${encodeURIComponent(eventId)}/mail`),
    /** 返事の下書きを書いてもらう（下書きがあれば書き直す）。 */
    draftReply: (id: string, instruction = '') => call<{ reply: InquiryReply }>(`/inquiries/${encodeURIComponent(id)}/replies`, { method: 'POST', body: JSON.stringify({ instruction }) }),
    updateReply: (replyId: string, patch: Partial<{ to: string; subject: string; body: string }>) =>
      call<{ ok: true }>(`/inquiries/replies/${encodeURIComponent(replyId)}`, { method: 'PUT', body: JSON.stringify(patch) }),
    deleteReply: (replyId: string) => call<{ ok: true }>(`/inquiries/replies/${encodeURIComponent(replyId)}`, { method: 'DELETE' }),
    /** 返事を承認へ進める（承認の後に窓口のアカウントから送る）。 */
    submitReply: (replyId: string) => call<{ runId: string }>(`/inquiries/replies/${encodeURIComponent(replyId)}/submit`, { method: 'POST', body: '{}' }),
    /** よくある質問の話題（誰が聞いたかは返さない）。 */
    faq: () => call<{ topics: InquiryFaqTopic[] }>('/inquiries/faq'),
    /** 月の振り返り（無ければ先月）。 */
    review: (month?: string) => call<{ stats: InquiryMonthStats; text: string }>(`/inquiries/review${month ? `?month=${encodeURIComponent(month)}` : ''}`),
  },
  /** Webの分析（内蔵の拡張。仕様書 第34章）。 */
  webReview: {
    /** 状態（始める前の手伝い）といちばん新しい便りと、便りの一覧。 */
    overview: () => call<{ status: WebReviewStatus; latest: WebReviewReport | null; reports: WebReviewReportBrief[]; admin: boolean; findings: WebReviewFinding[]; checkedAt: string | null; checkRequested: boolean; agency: { email: string; name: string } | null }>('/web-review'),
    /** 依頼文を制作会社に送る業務を始める（承認の後に送る。第34.21節）。 */
    sendRequest: (findingId: string, to?: string) => call<{ runId: string }>(`/web-review/findings/${encodeURIComponent(findingId)}/send`, { method: 'POST', body: JSON.stringify(to ? { to } : {}) }),
    report: (month: string) => call<{ report: WebReviewReport }>(`/web-review/reports/${encodeURIComponent(month)}`),
    /** 直すべき所の状態を変える（見た・済んだ・見送り。第34.19節）。 */
    setFinding: (id: string, status: WebReviewFindingStatus) =>
      call<{ ok: true }>(`/web-review/findings/${encodeURIComponent(id)}`, { method: 'PATCH', body: JSON.stringify({ status }) }),
    /** 今すぐチェック（管理者。ワーカーが次の見回りで探す）。 */
    check: () => call<{ ok: true }>('/web-review/check', { method: 'POST', body: '{}' }),
  },
  /** お知らせの作成（内蔵の拡張。仕様書 第35章）。 */
  announcements: {
    list: () => call<{ items: Announcement[] }>('/announcements'),
    /** 1 行の欄に書いた頼みから下書きを作る。 */
    draft: (text: string) => call<{ announcement: Announcement }>('/announcements', { method: 'POST', body: JSON.stringify({ text }) }),
    get: (id: string) => call<AnnouncementDetail>(`/announcements/${encodeURIComponent(id)}`),
    update: (id: string, patch: Partial<{ title: string; body: string; startDate: string | null; endDate: string | null; publishAt: string | null; channels: string[]; texts: AnnouncementTexts; mailContactIds: string[] }>) =>
      call<{ ok: true }>(`/announcements/${encodeURIComponent(id)}`, { method: 'PATCH', body: JSON.stringify(patch) }),
    remove: (id: string) => call<{ ok: true }>(`/announcements/${encodeURIComponent(id)}`, { method: 'DELETE' }),
    preview: (id: string) => call<AnnouncementPreview>(`/announcements/${encodeURIComponent(id)}/preview`),
    /** 承認へ進める（管理者か承認者が承認すると出る）。 */
    submit: (id: string) => call<{ runId: string }>(`/announcements/${encodeURIComponent(id)}/submit`, { method: 'POST', body: '{}' }),
    cancel: (id: string) => call<{ ok: true }>(`/announcements/${encodeURIComponent(id)}/cancel`, { method: 'POST', body: '{}' }),
    /** メールの宛先（名刺管理の連絡先）。 */
    recipients: (id: string) => call<{ recipients: AnnouncementRecipient[] }>(`/announcements/${encodeURIComponent(id)}/recipients`),
    /** メールの宛先を言葉で絞り直す（保存はしない。第35.19節）。`current` は画面のいまの宛先。 */
    refineRecipients: (id: string, request: string, current: string[]) =>
      call<AnnouncementRecipientsRefined>(`/announcements/${encodeURIComponent(id)}/recipients/refine`, { method: 'POST', body: JSON.stringify({ request, current }) }),
    /** WordPress が無い会社が写して使う文。 */
    copy: (id: string) => call<{ html: string; text: string }>(`/announcements/${encodeURIComponent(id)}/copy`),
    lineStatus: () => call<{ line: { followers: number | null; limit: number | null; used: number; remaining: number | null } | null }>('/announcements/line/status'),
    /** サイネージの画面の 1 枚の見本。`texts` を渡すと、保存する前の文で組む（直している間の見本）。 */
    screenUrl: (id: string, v: string, texts?: Partial<Record<'headline' | 'period' | 'detail' | 'note' | 'color', string>>) =>
      `/v1/announcements/${encodeURIComponent(id)}/screen.png?${new URLSearchParams({ v, ...Object.fromEntries(Object.entries(texts ?? {}).filter(([, x]) => typeof x === 'string')) }).toString()}`,
  },
  /** 競合の分析（内蔵の拡張。仕様書 第36章）。 */
  competitors: {
    overview: () => call<CompetitorOverview>('/competitors'),
    /** 競合を探す作業を受け付ける（`radiusKm`・`nationwide`・`auto` で商圏を変える）。 */
    discover: (area: { radiusKm?: number; nationwide?: boolean; auto?: boolean }) =>
      call<{ jobId: string; already: boolean }>('/competitors/discover', { method: 'POST', body: JSON.stringify(area) }),
    /** 今すぐ見回る作業を受け付ける。 */
    check: () => call<{ jobId: string; already: boolean }>('/competitors/check', { method: 'POST', body: '{}' }),
    /** URL か店の名前で競合を入れる。 */
    add: (text: string) => call<{ id: string; jobId: string }>('/competitors', { method: 'POST', body: JSON.stringify({ text }) }),
    remove: (id: string) => call<{ ok: true }>(`/competitors/${encodeURIComponent(id)}`, { method: 'DELETE' }),
    /** 1 社（`self` なら自社）の事実。 */
    facts: (id: string) => call<{ facts: CompetitorFact[] }>(`/competitors/${encodeURIComponent(id)}/facts`),
    reports: () => call<{ reports: CompetitorReport[] }>('/competitors/reports/list'),
    /** いまある事実から、その場のレポートを作る。 */
    makeReport: () => call<{ report: CompetitorReport }>('/competitors/reports', { method: 'POST', body: '{}' }),
  },
  /** Web のコラム（内蔵の拡張。仕様書 第32章）。 */
  columns: {
    list: () => call<{ columns: WebColumn[]; wordpress: ColumnWordPress | null; themes: WebColumnTheme[]; plan: ColumnPlanSlot[]; pageUrl: string | null }>('/columns'),
    /** テーマ案を作る（第32.18.4節）。 */
    makeThemes: () => call<{ added: WebColumnTheme[] }>('/columns/themes', { method: 'POST', body: '{}' }),
    /** テーマ案から書き始める（書き直しの案なら書き直す）。 */
    writeTheme: (id: string) => call<{ columnId: string }>(`/columns/themes/${encodeURIComponent(id)}/write`, { method: 'POST', body: '{}' }),
    dismissTheme: (id: string) => call<{ ok: true }>(`/columns/themes/${encodeURIComponent(id)}/dismiss`, { method: 'POST', body: '{}' }),
    /** 公開の日時（予約）を入れる・外す（下書きのときだけ）。 */
    setPublishAt: (id: string, publishAt: string | null) => call<{ ok: true }>(`/columns/${encodeURIComponent(id)}/publish-at`, { method: 'PUT', body: JSON.stringify({ publishAt }) }),
    /** 取り下げる（管理者と承認者）。 */
    withdraw: (id: string) => call<{ ok: true }>(`/columns/${encodeURIComponent(id)}/withdraw`, { method: 'POST', body: '{}' }),
    /** 書き始める。書き上げは裏で進む。 */
    create: (theme: string, memo: string) => call<{ id: string }>('/columns', { method: 'POST', body: JSON.stringify({ theme, memo }) }),
    get: (id: string) => call<ColumnDetail>(`/columns/${encodeURIComponent(id)}`),
    /** 直して保存する（新しい版になる）。 */
    save: (id: string, patch: { title?: string; body?: string; description?: string; sns?: { short?: string; long?: string } }) =>
      call<{ ok: true }>(`/columns/${encodeURIComponent(id)}`, { method: 'PUT', body: JSON.stringify(patch) }),
    rewrite: (id: string, instruction: string) =>
      call<{ ok: true }>(`/columns/${encodeURIComponent(id)}/rewrite`, { method: 'POST', body: JSON.stringify({ instruction }) }),
    retry: (id: string) => call<{ ok: true }>(`/columns/${encodeURIComponent(id)}/retry`, { method: 'POST' }),
    applySuggestion: (id: string, index: number) => call<{ ok: true }>(`/columns/${encodeURIComponent(id)}/suggestions/${index}`, { method: 'POST' }),
    restore: (id: string, version: number) => call<{ ok: true }>(`/columns/${encodeURIComponent(id)}/versions/${version}/restore`, { method: 'POST' }),
    exported: (id: string) => call<{ title: string; markdown: string; html: string; description: string }>(`/columns/${encodeURIComponent(id)}/export`),
    submit: (id: string) => call<{ runId: string }>(`/columns/${encodeURIComponent(id)}/submit`, { method: 'POST' }),
    remove: (id: string) => call<{ ok: true }>(`/columns/${encodeURIComponent(id)}`, { method: 'DELETE' }),
    /** カバー画像の URL（`<img>` に使う。版を変えると URL が変わる）。 */
    coverUrl: (id: string, fileId: string) => `/v1/columns/${encodeURIComponent(id)}/cover?v=${encodeURIComponent(fileId)}`,
    /** カバーを作り直す（新しい版になる）。 */
    recover: (id: string, req: { kind?: 'template' | 'ai' | 'photo'; hint?: string } = {}) =>
      call<{ ok: true }>(`/columns/${encodeURIComponent(id)}/cover`, { method: 'POST', body: JSON.stringify(req) }),
    /** 前に作ったカバーに戻す（新しい版になる。本文はいまのまま）。 */
    useCover: (id: string, fileId: string) => call<{ ok: true }>(`/columns/${encodeURIComponent(id)}/cover/restore`, { method: 'POST', body: JSON.stringify({ fileId }) }),
    /** 前の版のカバー画像の URL。 */
    coverUrlOf: (id: string, version: number) => `/v1/columns/${encodeURIComponent(id)}/cover?version=${version}`,
    /** 店頭サイネージ用の組と、作れるか（仕様書 第32.18.6節）。 */
    signage: (id: string) => call<{ usable: boolean; reason: string | null; sets: ColumnSignageSet[] }>(`/columns/${encodeURIComponent(id)}/signage`),
    /** 店頭サイネージ用を作り始める（ワーカーが後ろで作る）。 */
    makeSignage: (id: string, kind: 'slides' | 'video' = 'slides') => call<{ id: string }>(`/columns/${encodeURIComponent(id)}/signage`, { method: 'POST', body: JSON.stringify({ kind }) }),
    submitSignage: (setId: string) => call<{ runId: string }>(`/columns/signage/${encodeURIComponent(setId)}/submit`, { method: 'POST', body: '{}' }),
    withdrawSignage: (setId: string) => call<{ ok: true }>(`/columns/signage/${encodeURIComponent(setId)}/withdraw`, { method: 'POST', body: '{}' }),
    signageFileUrl: (setId: string, fileId: string) => `/v1/columns/signage/${encodeURIComponent(setId)}/files/${encodeURIComponent(fileId)}`,
    /** 写真を入れ、そのコラムのカバーにする（会社の写真の置き場にも入る）。 */
    addPhoto: (id: string, file: File) => call<{ ok: true }>(`/columns/${encodeURIComponent(id)}/photos`, {
      method: 'POST', body: file, headers: { 'content-type': file.type, 'x-file-name': encodeURIComponent(file.name) },
    }),
    /** カバー画像を保存する。 */
    downloadCover: async (id: string, title: string) => {
      const blob = await fetchBlob(`/columns/${encodeURIComponent(id)}/cover?download=1`);
      if (!blob) throw new ApiError('書き出せませんでした', 404);
      saveBlob(blob, `${title.slice(0, 40) || 'column-cover'}.png`);
    },
  },
  /** 店頭サイネージ（仕様書 第31章）。 */
  signage: {
    overview: () => call<SignageOverview>('/signage'),
    updateScreen: (id: string, patch: { name?: string; orientation?: 'landscape' | 'portrait'; rotation?: number }) =>
      call<{ screen: SignageScreen }>(`/signage/screens/${encodeURIComponent(id)}`, { method: 'PATCH', body: JSON.stringify(patch) }),
    flow: (id: string) => call<{ version: number; entries: SignageEntry[] }>(`/signage/screens/${encodeURIComponent(id)}/entries`),
    /** 流れを並びごと置き換える（読んだ版を送る。ほかの人が先に直していれば 409）。 */
    saveFlow: (id: string, version: number, entries: SignageEntry[]) =>
      call<{ version: number }>(`/signage/screens/${encodeURIComponent(id)}/entries`, { method: 'PUT', body: JSON.stringify({ version, entries }) }),
    assets: () => call<{ assets: SignageAssetView[] }>('/signage/assets'),
    /** 素材を足す（画面で縮めた画像か MP4 そのもの）。同じ中身なら前の素材が返る。 */
    upload: (file: Blob, name: string, size?: { width: number; height: number }) =>
      sendRaw<{ asset: SignageAsset; existing: boolean }>('POST', '/signage/assets', file, {
        'x-file-name': encodeURIComponent(name), ...(size ? { 'x-width': String(size.width), 'x-height': String(size.height) } : {}),
      }),
    setThumbnail: (id: string, jpeg: Blob) => sendRaw<{ ok: true }>('PUT', `/signage/assets/${encodeURIComponent(id)}/thumbnail`, jpeg),
    renameAsset: (id: string, name: string) => call<{ asset: SignageAsset }>(`/signage/assets/${encodeURIComponent(id)}`, { method: 'PATCH', body: JSON.stringify({ name }) }),
    /** 素材を消す（流れに入っていても外す）。外した画面の名前が返る。 */
    deleteAsset: (id: string) => call<{ screens: string[] }>(`/signage/assets/${encodeURIComponent(id)}`, { method: 'DELETE' }),
    /** 縮小画像（無ければ `null`）。 */
    thumbnail: (id: string) => fetchBlob(`/signage/assets/${encodeURIComponent(id)}/thumbnail`),
    /** 素材の中身（HTML の見本に使う。無ければ `null`）。 */
    content: (id: string) => fetchBlob(`/signage/assets/${encodeURIComponent(id)}/content`),
    /** 割り込みの素材にする・外す、その音（`null` なら会社の既定）。 */
    setAssetInterrupt: (id: string, patch: { isInterrupt?: boolean; jingle?: string | null }) =>
      call<{ asset: SignageAsset }>(`/signage/assets/${encodeURIComponent(id)}`, { method: 'PATCH', body: JSON.stringify(patch) }),
    /** 割り込みを出す（仕様書 第31.7.2節）。まとめた画面は `merged`。 */
    sendInterrupt: (input: SignageInterruptInput) =>
      call<{ id: string; screens: string[]; merged: string[] }>('/signage/interrupts', { method: 'POST', body: JSON.stringify(input) }),
    /** 最近 24 時間の割り込み。 */
    interrupts: () => call<{ interrupts: SignageInterruptView[] }>('/signage/interrupts'),
    clearInterrupt: (id: string) => call<{ cleared: number }>(`/signage/interrupts/${encodeURIComponent(id)}/clear`, { method: 'POST', body: '{}' }),
    /** すべて消す（画面を選べる）。 */
    clearAll: (screens?: string[]) => call<{ cleared: number }>('/signage/clear', { method: 'POST', body: JSON.stringify(screens ? { screens } : {}) }),
    /** よく出す案内と、割り込みの素材の回数。 */
    phrases: () => call<{ phrases: SignagePhrase[]; assets: { assetId: string; count: number }[] }>('/signage/phrases'),
    hidePhrase: (id: string) => call<{ ok: true }>(`/signage/phrases/${encodeURIComponent(id)}/hide`, { method: 'POST', body: '{}' }),
    /** 会社のジングルの音。 */
    sounds: () => call<{ sounds: SignageSound[] }>('/signage/sounds'),
    /** スタッフのページを開く QR。 */
    mobileQr: () => fetchBlob('/signage/mobile-qr.svg'),
  },
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
    /** Web への公開のまとまりの一覧（管理者。仕様書 第29.12.2節）。 */
    publications: () => call<{ items: InventoryPublicationView[]; max: number }>('/inventory/publications'),
    /** まとまりを足す（名前を省けば「公開 N」）。 */
    createPublication: (name?: string) =>
      call<InventoryPublicationView>('/inventory/publications', { method: 'POST', body: JSON.stringify(name ? { name } : {}) }),
    /** まとまりの名前を変える。 */
    renamePublication: (id: string, name: string) =>
      call<InventoryPublicationView>(`/inventory/publications/${encodeURIComponent(id)}/name`, { method: 'PUT', body: JSON.stringify({ name }) }),
    /** 承認する前の見本（公開されるとおりの中身）。 */
    previewPublication: (scope: InventoryPublicationScope) =>
      call<{ snapshot: InventoryPublicSnapshot }>('/inventory/publications/preview', { method: 'POST', body: JSON.stringify(scope) }),
    /** この内容で公開する（押した管理者が承認者。中身を変えたとき・止めたあとの再開も同じ）。 */
    approvePublication: (id: string, scope: InventoryPublicationScope) =>
      call<InventoryPublicationView>(`/inventory/publications/${encodeURIComponent(id)}`, { method: 'PUT', body: JSON.stringify(scope) }),
    /** まとまりの公開を止める。 */
    stopPublication: (id: string) => call<InventoryPublicationView>(`/inventory/publications/${encodeURIComponent(id)}/stop`, { method: 'POST' }),
    /** まとまりを削除する（止めてあるものだけ）。 */
    deletePublication: (id: string) => call<{ ok: true }>(`/inventory/publications/${encodeURIComponent(id)}`, { method: 'DELETE' }),
    /** JAN から商品名を引く（Gemini の Google 検索。仕様書 第29.6節）。見つからなければ `found: false`。 */
    jan: (code: string) => call<{ found: boolean; name?: string; maker?: string; category?: string }>(`/inventory/jan/${encodeURIComponent(code)}`),
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
    /** 労働条件通知書の中身と足りない事項（仕様書 第30.5.3節）。 */
    termsNotice: (id: string) => call<{ notice: { items: { label: string; value: string; missing: boolean }[]; missing: string[]; notes: string[] }; texts: HrNoticeSettings }>(`/hr/employees/${encodeURIComponent(id)}/terms-notice`),
    /** 労働条件通知書の PDF を保存させる。書いた会社の定めは次からの既定になる。 */
    termsNoticePdf: async (id: string, notice: HrNoticeSettings, name: string) => {
      const res = await fetch(`/v1/hr/employees/${encodeURIComponent(id)}/terms-notice`, {
        method: 'POST', credentials: 'same-origin', body: JSON.stringify({ notice }),
        headers: { 'content-type': 'application/json', ...(devTenant ? { 'x-tenant': devTenant } : {}), ...(csrfToken ? { 'x-csrf-token': csrfToken } : {}) },
      });
      if (!res.ok) throw new ApiError((await res.json().catch(() => ({})) as { error?: string }).error ?? `エラー (${res.status})`, res.status);
      saveBlob(await res.blob(), `労働条件通知書-${name}.pdf`);
    },
    /** 労務の期限（仕様書 第30.19.1節）。 */
    calendar: (days = 90) => call<{ items: HrDeadline[] }>(`/hr/calendar?days=${days}`),
    /** 顔写真を入れる（縮めた JPEG。第30.5.4節）。 */
    setPhoto: (id: string, photo: Blob) => {
      const form = new FormData();
      form.append('file', photo, 'photo.jpg');
      return postForm<{ photoAt: string }>(`/hr/employees/${encodeURIComponent(id)}/photo`, form, 'PUT');
    },
    /** 顔写真を外す。 */
    deletePhoto: (id: string) => call<{ ok: true }>(`/hr/employees/${encodeURIComponent(id)}/photo`, { method: 'DELETE' }),
    /** まとめて取り込むときの 1 枚。ファイル名か写真の中の名札で人に当てる（当てられなければ ApiError）。 */
    importPhoto: (name: string, photo: Blob) => {
      const form = new FormData();
      form.append('file', photo, name);
      return postForm<{ employeeId: string; name: string; by: 'file-name' | 'name-tag' }>('/hr/photos/import', form);
    },
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
    leaveOverview: () => call<{ rows: { employeeId: string; name: string; balance: LeaveBalance; lowAttendance: number | null; takes: LeaveTake[] }[] }>('/hr/leave'),
    /** 担当者が有給の取得を記録する（締めた期間も入れられる）。 */
    takeLeave: (employeeId: string, date: string, days: number) =>
      call<{ remaining: number }>(`/hr/leave/${encodeURIComponent(employeeId)}/takes`, { method: 'POST', body: JSON.stringify({ date, days }) }),
    /** 担当者が有給の取得を取り消す。 */
    cancelTake: (id: string) => call<{ ok: true }>(`/hr/leave/takes/${encodeURIComponent(id)}`, { method: 'DELETE' }),
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
      run: (id: string) => call<{ run: PayRun; slips: PaySlip[]; blockers: PayCheck[]; canConfirm: boolean; adjustments: PayAdjustment[] }>(`/hr/payroll/runs/${encodeURIComponent(id)}`),
      /** 調整の行（仕様書 第30.10.4節）。 */
      addAdjustment: (a: Partial<PayAdjustment>) => call<{ adjustment: PayAdjustment }>('/hr/payroll/adjustments', { method: 'POST', body: JSON.stringify(a) }),
      removeAdjustment: (id: string, kind: 'monthly' | 'bonus', month: string) =>
        call<{ ok: true }>(`/hr/payroll/adjustments/${encodeURIComponent(id)}?kind=${kind}&month=${month}`, { method: 'DELETE' }),
      /** 賞与（仕様書 第30.11.1節）。 */
      bonus: (month: string) => call<{ plan: BonusPlan & { saved: boolean }; employees: { id: string; name: string }[] }>(`/hr/payroll/bonus?month=${month}`),
      saveBonus: (plan: Partial<BonusPlan>) => call<{ plan: BonusPlan }>('/hr/payroll/bonus', { method: 'PUT', body: JSON.stringify(plan) }),
      calculateBonus: (month: string) => call<{ run: PayRun; slips: PaySlip[] }>('/hr/payroll/bonus/calculate', { method: 'POST', body: JSON.stringify({ month }) }),
      bonusReport: async (id: string, date: string) => {
        const blob = await fetchBlob(`/hr/payroll/runs/${encodeURIComponent(id)}/bonus-report?format=xlsx`);
        if (!blob) throw new ApiError('賞与支払届の下書きを出せませんでした', 400);
        saveBlob(blob, `賞与支払届（下書き）-${date}.xlsx`);
      },
      /** 年末調整（仕様書 第30.15.1節）。 */
      yea: (year: number) => call<{ rows: { employeeId: string; name: string; target: boolean; reason: string | null; submittedAt: string | null; checkedAt: string | null; problems: string[] }[]; runs: PayRun[]; decemberConfirmed: boolean }>(`/hr/yea?year=${year}`),
      yeaRequest: (year: number) => call<{ sent: number }>('/hr/yea/request', { method: 'POST', body: JSON.stringify({ year }) }),
      yeaCalculate: (year: number, payDate: string) => call<{ run: PayRun; slips: PaySlip[] }>('/hr/yea/calculate', { method: 'POST', body: JSON.stringify({ year, payDate }) }),
      yeaDeclaration: (employeeId: string, year: number) => call<{ declaration: YeaDeclarationView }>(`/hr/yea/${encodeURIComponent(employeeId)}?year=${year}`),
      yeaSave: (employeeId: string, year: number, data: YeaDeclaration) => call<{ declaration: YeaDeclarationView }>(`/hr/yea/${encodeURIComponent(employeeId)}`, { method: 'PUT', body: JSON.stringify({ year, data }) }),
      yeaCheck: (employeeId: string, year: number, checked: boolean) => call<{ ok: true }>(`/hr/yea/${encodeURIComponent(employeeId)}/check`, { method: 'POST', body: JSON.stringify({ year, checked }) }),
      yeaWithholding: async (employeeId: string, year: number, name: string) => {
        const blob = await fetchBlob(`/hr/yea/${encodeURIComponent(employeeId)}/withholding.pdf?year=${year}`);
        if (!blob) throw new ApiError('源泉徴収票を出せませんでした', 404);
        saveBlob(blob, `源泉徴収票-${year}-${name}.pdf`);
      },
      yeaReport: async (year: number) => {
        const blob = await fetchBlob(`/hr/yea/report?year=${year}&format=xlsx`);
        if (!blob) throw new ApiError('書き出せませんでした', 403);
        saveBlob(blob, `源泉徴収票・給与支払報告書（下書き）-${year}.xlsx`);
      },
      /** 社会保険（仕様書 第30.12.1節）。 */
      social: (year: number) => call<{
        year: number; regular: SocialDetermination[]; changes: SocialDetermination[]; events: SocialEvent[]; eligibility: InsuranceEligibility[];
        specificOffice: { value: boolean; auto: boolean; insured: number; size: number }; rules: { version: string; reviewed: boolean } | null;
      }>(`/hr/social?year=${year}`),
      /** 届出の下書き（表計算）を作って保存させる。標準報酬月額に入れた人数を返す。 */
      socialReport: async (kind: 'regular' | 'change' | 'acquire' | 'lose' | 'age70', name: string, year?: number): Promise<number> => {
        const path = kind === 'regular' ? `/hr/social/regular/report?year=${year}` : kind === 'change' ? '/hr/social/change/report' : `/hr/social/events/${kind}/report`;
        const { blob, headers } = await postBlob(path);
        saveBlob(blob, `${name}（下書き）.xlsx`);
        return Number(headers.get('x-applied') ?? 0);
      },
      /** シフト（仕様書 第30.6.2節）。`month` は締め日の月（省略すれば次の期間）。 */
      shifts: (month?: string) => call<ShiftView>(`/hr/shifts${month ? `?month=${month}` : ''}`),
      shiftSettings: (patch: Partial<HrShiftSettings>) => call<HrShiftSettings>('/hr/shifts/settings', { method: 'PUT', body: JSON.stringify(patch) }),
      shiftGenerate: (month: string) => call<ShiftView>('/hr/shifts/generate', { method: 'POST', body: JSON.stringify({ month }) }),
      shiftCell: (month: string, employeeId: string, date: string, patternId: string | null) =>
        call<ShiftView>('/hr/shifts/cell', { method: 'PUT', body: JSON.stringify({ month, employeeId, date, patternId }) }),
      shiftPublish: (month: string) => call<ShiftView>('/hr/shifts/publish', { method: 'POST', body: JSON.stringify({ month }) }),
      /** 労働保険の年度更新（仕様書 第30.13.1節）。 */
      labor: (year: number) => call<LaborInsuranceView>(`/hr/labor-insurance?year=${year}`),
      laborSave: (year: number, patch: Partial<LaborInsuranceData>) => call<LaborInsuranceView>('/hr/labor-insurance', { method: 'PUT', body: JSON.stringify({ year, ...patch }) }),
      laborReport: async (year: number) => {
        const { blob } = await postBlob(`/hr/labor-insurance/report?year=${year}`);
        saveBlob(blob, `労働保険の年度更新（下書き）-${year}.xlsx`);
      },
      /** 確定した月の給与の訂正の回を作る。 */
      correction: (id: string, payDate: string) => call<{ run: PayRun; slips: PaySlip[] }>(`/hr/payroll/runs/${encodeURIComponent(id)}/correction`, { method: 'POST', body: JSON.stringify({ payDate }) }),
      /** 確定する（管理者。お金の確定。仕様書 第30.10.3節）。 */
      confirm: (id: string) => call<{ run: PayRun; published: number; pdf: string[] }>(`/hr/payroll/runs/${encodeURIComponent(id)}/confirm`, { method: 'POST' }),
      requestConfirm: (id: string) => call<{ sent: number }>(`/hr/payroll/runs/${encodeURIComponent(id)}/request`, { method: 'POST' }),
      /** 振込データ（全銀協の形式）を作って保存させる。入らなかった人を返す。 */
      transfer: async (id: string, month: string): Promise<{ count: number; excluded: string[] }> => {
        const { blob, headers } = await postBlob(`/hr/payroll/runs/${encodeURIComponent(id)}/transfer`);
        saveBlob(blob, `振込データ-${month}.txt`);
        const ex = decodeURIComponent(headers.get('x-transfer-excluded') ?? '');
        return { count: Number(headers.get('x-transfer-count') ?? 0), excluded: ex ? ex.split('、') : [] };
      },
      slipPdf: async (slipId: string, name: string) => {
        const blob = await fetchBlob(`/hr/payroll/slips/${encodeURIComponent(slipId)}/pdf`);
        if (!blob) throw new ApiError('明細の PDF を出せませんでした', 404);
        saveBlob(blob, name);
      },
      ledger: async (year: number, format: 'csv' | 'xlsx') => {
        const blob = await fetchBlob(`/hr/payroll/ledger?year=${year}&format=${format}`);
        if (!blob) throw new ApiError('書き出せませんでした', 403);
        saveBlob(blob, `賃金台帳-${year}.${format}`);
      },
      readNotice: (file: File) => {
        const form = new FormData();
        form.append('file', file);
        return postForm<{ applied: { employeeId: string; name: string; fiscalYear: number; june: number; monthly: number }[]; skipped: { name: string; reason: string }[] }>('/hr/payroll/resident-tax/read', form);
      },
      trial: (month: string, file: File) => {
        const form = new FormData();
        form.append('month', month);
        form.append('file', file);
        return postForm<{ run: PayRun; slips: PaySlip[] }>('/hr/payroll/trials', form);
      },
    },
    /** 労働者名簿を書き出す。 */
    roster: async (format: 'csv' | 'xlsx') => {
      const blob = await fetchBlob(`/hr/roster?format=${format}`);
      if (!blob) throw new ApiError('書き出せませんでした', 403);
      saveBlob(blob, `労働者名簿-${new Date().toISOString().slice(0, 10)}.${format}`);
    },
    /** 帳簿をまとめて ZIP で書き出す（管理者。解約のときに渡す。仕様書 第30.17節）。ファイルの数を返す。 */
    books: async (): Promise<number> => {
      const { blob, headers } = await postBlob('/hr/books/export');
      saveBlob(blob, `人事・給与の帳簿-${new Date().toISOString().slice(0, 10)}.zip`);
      return Number(headers.get('x-books-files') ?? 0);
    },
  },
  /** 本人の「給与・勤怠」（人事・給与の段 2。仕様書 第30.25節）。 */
  myHr: {
    get: (month?: string) => call<MyHrView>(`/me/hr${month ? `?month=${month}` : ''}`),
    punch: (kind: AttPunchKind, source: 'screen' | 'mobile' = 'screen') => call<{ punch: { at: string } }>('/me/hr/punch', { method: 'POST', body: JSON.stringify({ kind, source }) }),
    fixDay: (date: string, fix: DayFixInput) => call<{ day: AttDay }>(`/me/hr/days/${date}`, { method: 'PUT', body: JSON.stringify(fix) }),
    leave: (date: string, days: number) => call<{ remaining: number }>('/me/hr/leave', { method: 'POST', body: JSON.stringify({ date, days }) }),
    cancelLeave: (id: string) => call<{ ok: true }>(`/me/hr/leave/${encodeURIComponent(id)}`, { method: 'DELETE' }),
    /** 自分のシフトと休みの希望（仕様書 第30.6.2節）。 */
    shifts: () => call<{ periods: { period: { start: string; end: string; label: string }; published: boolean; shifts: HrShift[]; requests: string[]; canRequest: boolean }[]; patterns: HrShiftSettings['patterns'] }>('/me/hr/shifts'),
    shiftRequest: (date: string, on: boolean) => call<{ ok: true }>('/me/hr/shift-requests', { method: 'PUT', body: JSON.stringify({ date, on }) }),
    /** 給与明細（段 4。画面で受け取るには本人の同意が要る）。 */
    payslips: () => call<{ consentAt: string | null; slips: MySlipSummary[] }>('/me/hr/payslips'),
    payslip: (id: string) => call<{ slip: PaySlip & { run: { payMonth: string; payDate: string; periodStart: string; periodEnd: string } }; diff: string | null; previousNet: number | null }>(`/me/hr/payslips/${encodeURIComponent(id)}`),
    payslipPdf: async (id: string, month: string) => {
      const blob = await fetchBlob(`/me/hr/payslips/${encodeURIComponent(id)}/pdf`);
      if (!blob) throw new ApiError('明細の PDF を出せませんでした', 404);
      saveBlob(blob, `給与明細-${month}.pdf`);
    },
    consent: (consent: boolean) => call<{ consentAt: string | null }>('/me/hr/payslip-consent', { method: 'PUT', body: JSON.stringify({ consent }) }),
    /** 年末調整の申告（仕様書 第30.15.1節）。 */
    yea: (year: number) => call<YeaSelfView>(`/me/hr/yea?year=${year}`),
    saveYea: (year: number, data: YeaDeclaration, submit: boolean) => call<{ declaration: YeaDeclarationView }>('/me/hr/yea', { method: 'PUT', body: JSON.stringify({ year, data, submit }) }),
    readCertificate: (file: File) => {
      const form = new FormData();
      form.append('file', file);
      return postForm<CertificateReading>('/me/hr/yea/certificate', form);
    },
    withholdingPdf: async (year: number) => {
      const blob = await fetchBlob(`/me/hr/yea/withholding.pdf?year=${year}`);
      if (!blob) throw new ApiError('源泉徴収票を出せませんでした', 404);
      saveBlob(blob, `源泉徴収票-${year}.pdf`);
    },
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
  /** 整理でしまった記憶と、戻す（仕様書 第11.11.4節）。 */
  myArchivedMemories: () => call<{ items: MemoryView[] }>('/me/memories/archived'),
  restoreMemory: (id: string) => call(`/me/memories/${id}/restore`, { method: 'POST' }),
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
  /** お知らせを消す（本人の分だけ。仕様書 第6.5.5節）。 */
  deleteNotification: (id: string) => call<{ ok: true }>(`/notifications/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  deleteNotifications: (ids: string[]) => call<{ deleted: number }>('/notifications/delete', { method: 'POST', body: JSON.stringify({ ids }) }),
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
    /** 会社の AI の方針（仕様書 第16.3.7.1節）。ローカルの方針はローカルの形でだけ選べる。 */
    saveAiPolicy: (mode: 'cloud' | 'local-first' | 'local-only') =>
      call<{ ok: true }>('/admin/connections/ai-policy', { method: 'PUT', body: JSON.stringify({ mode }) }),
    /** ローカル AI に届くかを確かめる。 */
    testLocalLlm: () => call<{ ok: boolean; models?: string[]; error?: string }>('/admin/connections/local-llm/test', { method: 'POST', body: JSON.stringify({}) }),
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
    /** 接続先の状態（仕様書 第6.7.6節）。管理者ページの「接続」で使う。 */
    connectionHealth: () => call<{ items: ConnectionHealth[] }>('/admin/dashboard/connections'),
    /**
     * 今日、失敗した業務を確認したものとして、囲みから外す（仕様書 第6.7.5.1節）。実行の記録は残る。
     *
     * @param runIds 外す実行。省くと今日の失敗をすべて外す
     */
    dismissFailures: (runIds?: string[]) =>
      call<{ dismissed: number }>('/admin/dashboard/failures/dismiss', { method: 'POST', body: JSON.stringify(runIds ? { runIds } : {}) }),
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
    /** 利用者を直す。止めたときは、止めた業務の数と、30 日後に削除される自分だけの名刺の数を返す（仕様書 第27.7節）。 */
    updateUser: (id: string, patch: { displayName?: string; roles?: string[]; status?: string }) =>
      call<User & { stoppedRuns?: number; personalCards?: number }>(`/admin/users/${id}`, { method: 'PATCH', body: JSON.stringify(patch) }),
    /** その人のメールの署名から名刺を新しくした値を戻し、記録を削除する（Google のデータの削除の求め。仕様書 第27.6.1節、Q-152）。 */
    forgetMailSignatures: (id: string) =>
      call<{ ok: true; count: number }>(`/admin/users/${id}/forget-mail-signatures`, { method: 'POST' }),
    knowledge: () => call<{
      items: KnowledgeItemView[]; compartments: { id: string; name: string; description: string | null }[];
      consolidated: ConsolidationView | null;
    }>('/admin/knowledge'),
    /** 登録・直す。社内規程は版を残し、施行日（`effectiveFrom`）が先なら施行日まで前の版で答える（仕様書 第11.11.2節）。 */
    saveKnowledge: (id: string | 'new', item: { title: string; body: string; source: string; compartment: string | null; effectiveFrom?: string | null }) =>
      call<{ id: string; sections: KnowledgeSectionView[]; version?: number; applied?: boolean }>(`/admin/knowledge/${id}`, { method: 'PUT', body: JSON.stringify(item) }),
    knowledgeSections: (id: string) =>
      call<{ sections: KnowledgeSectionView[] }>(`/admin/knowledge/${id}/sections`),
    knowledgeVersions: (id: string) => call<{ versions: KnowledgeVersionView[] }>(`/admin/knowledge/${id}/versions`),
    knowledgeVersion: (id: string, version: number) => call<{ version: KnowledgeVersionView }>(`/admin/knowledge/${id}/versions/${version}`),
    /** 社内規程・議事録を廃止する（消さない。1 年は戻せる）。 */
    retireKnowledge: (id: string) => call(`/admin/knowledge/${id}/retire`, { method: 'POST' }),
    /** 廃止した・しまったものを戻す。 */
    restoreKnowledge: (id: string) => call(`/admin/knowledge/${id}/restore`, { method: 'POST' }),
    /** 秘書が学んだことを消す（社内規程と議事録は消せない）。 */
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
    /** メールの署名から名刺を新しくするかの入り切り（仕様書 第27.6.1節）。 */
    setCardsMailSignature: (mailSignature: boolean) =>
      call<{ ok: true }>('/admin/extensions/business-cards/settings', { method: 'PUT', body: JSON.stringify({ mailSignature }) }),
    /** まとめてのメールで、本人の承認のあとに管理者の承認を加えるか（仕様書 第27.9.1節）。 */
    setCardsBulkMailAdminApproval: (bulkMailAdminApproval: boolean) =>
      call<{ ok: true }>('/admin/extensions/business-cards/settings', { method: 'PUT', body: JSON.stringify({ bulkMailAdminApproval }) }),
    /** 配信を停止したアドレスの一覧（新しい順。`q` はアドレスの一部。仕様書 第27.9.1節）。 */
    cardsOptOuts: (q = '') =>
      call<{ items: { email: string; source: 'url' | 'reply'; createdAt: string }[] }>(`/admin/extensions/business-cards/opt-outs?q=${encodeURIComponent(q)}`),
    /** 配信の停止を外す（本人から求められたとき）。 */
    removeCardsOptOut: (email: string) =>
      call<{ ok: true }>('/admin/extensions/business-cards/opt-outs/remove', { method: 'POST', body: JSON.stringify({ email }) }),
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
    /** 就業規則・賃金規程から、人事・給与の設定の案を作る（仕様書 第30.8.2節）。保存はしない。 */
    hrProposal: (file: File) => {
      const form = new FormData();
      form.append('file', file);
      return postForm<{ fields: HrProposalField[] }>('/admin/extensions/hr/proposal', form);
    },
    /** 知識に登録した社内規程から、人事・給与の設定の案を作る（仕様書 第30.8.2節）。 */
    hrProposalFromRule: (knowledgeId: string) =>
      call<{ fields: HrProposalField[] }>('/admin/extensions/hr/proposal', { method: 'POST', body: JSON.stringify({ knowledgeId }) }),
    /** 社内規程の登録・改定で見つかった、今の設定と食い違う項目（仕様書 第11.11.2節）。 */
    hrRuleChecks: () => call<{ checks: { itemId: string; version: number; title: string; effectiveFrom: string; fields: HrProposalField[] }[] }>('/admin/extensions/hr/rule-checks'),
    dismissHrRuleCheck: (itemId: string, version: number) => call(`/admin/extensions/hr/rule-checks/${itemId}/${version}/dismiss`, { method: 'POST' }),
    /** 手当の扱い（雇用条件の手当の名前と、割増の基礎・所得税の対象。設定が無ければ名前から決めたもの）。 */
    hrAllowances: () => call<{ items: { name: string; premiumBase: boolean; taxable: boolean; set: boolean }[] }>('/admin/extensions/hr/allowances'),
    /** 労災保険率表の事業の種類（会社の設定で選ぶ）。 */
    hrLaborIndustries: () => call<{ industries: { code: string; category: string; name: string; rate: number }[] }>('/admin/extensions/hr/labor-industries'),
    setHrSettings: (patch: Partial<HrSettings>) =>
      call<{ ok: true; hr: HrSettings }>('/admin/extensions/hr/settings', { method: 'PUT', body: JSON.stringify(patch) }),
    /** Web のコラムの会社の設定（仕様書 第32.18.1節）。送った項目だけを変える。 */
    /** 問い合わせの窓口のアカウントをつなぐ（Google の認可の URL。見本の会社ではすぐつながる）。 */
    connectInquiryMailbox: () => call<{ url?: string; connected?: boolean }>('/admin/extensions/inquiries/mailbox/connect', { method: 'POST', body: '{}' }),
    disconnectInquiryMailbox: () => call<{ ok: true }>('/admin/extensions/inquiries/mailbox', { method: 'DELETE' }),
    /** Webの分析の担当の許可をつなぐ（Google の認可の URL。見本の会社ではすぐつながる。第34.18節）。 */
    connectWebReview: () => call<{ url?: string; connected?: boolean }>('/admin/extensions/web-review/connect', { method: 'POST', body: '{}' }),
    disconnectWebReview: () => call<{ ok: true }>('/admin/extensions/web-review/connection', { method: 'DELETE' }),
    /** 担当が見られるプロパティとサイトと、いまの状態。 */
    webReviewCandidates: () => call<{ candidates: WebReviewCandidates | null; error: string | null; status: WebReviewStatus }>('/admin/extensions/web-review/candidates'),
    /** 制作会社の宛先（依頼文を承認の後に送る。第34.21節）。 */
    setWebReviewAgency: (email: string | null, name = '') => call<{ ok: true }>('/admin/extensions/web-review/agency', { method: 'PUT', body: JSON.stringify({ email, name }) }),
    selectWebReview: (p: { propertyId?: string | null; siteUrl?: string | null }) =>
      call<{ ok: true; status: WebReviewStatus }>('/admin/extensions/web-review/selection', { method: 'PUT', body: JSON.stringify(p) }),
    /** LINE 公式アカウントをつなぐ（受け口の URL が返る。1 度だけ）。 */
    connectInquiryLine: (secret: string, token: string) =>
      call<{ ok: true; webhookUrl: string }>('/admin/extensions/inquiries/line', { method: 'PUT', body: JSON.stringify({ secret, token }) }),
    disconnectInquiryLine: () => call<{ ok: true }>('/admin/extensions/inquiries/line', { method: 'DELETE' }),
    /** 競合の分析の地図の鍵（Google Cloud の API キー）を預ける。Places API を使えるかを確かめてから預ける。 */
    setCompetitorMapKey: (key: string) => call<{ ok: true }>('/admin/extensions/competitors/map-key', { method: 'PUT', body: JSON.stringify({ key }) }),
    removeCompetitorMapKey: () => call<{ ok: true }>('/admin/extensions/competitors/map-key', { method: 'DELETE' }),
    /** お知らせの作成の設定（Web の出し方・カテゴリー。第35.4節）。 */
    setAnnouncementSettings: (patch: Partial<{ webPublish: 'publish' | 'draft'; webCategory: string; screens: string[] | null }>) =>
      call<{ ok: true }>('/admin/extensions/announcements/settings', { method: 'PUT', body: JSON.stringify(patch) }),
    /** お知らせを流す画面の選び先（店頭サイネージの画面。`selected` が `null` ならすべて）。 */
    announcementScreens: () => call<{ screens: { id: string; name: string }[]; selected: string[] | null }>('/admin/extensions/announcements/screens'),
    /** 競合の分析で自動で覚える数（1〜20）を変える。 */
    setCompetitorAutoMax: (autoMax: number) => call<{ ok: true }>('/admin/extensions/competitors/settings', { method: 'PUT', body: JSON.stringify({ autoMax }) }),
    /** 競合の分析の定期の見回りの間隔（毎月・毎週・しない）を変える。 */
    setCompetitorWatch: (watch: 'monthly' | 'weekly' | 'off') => call<{ ok: true }>('/admin/extensions/competitors/settings', { method: 'PUT', body: JSON.stringify({ watch }) }),
    /** コラムの貼るだけのページを入れる・止める（第32.18.4節）。 */
    enableColumnPage: () => call<{ ok: true; urls: { page: string; data: string; rss: string } }>('/admin/extensions/web-columns/page', { method: 'POST', body: '{}' }),
    disableColumnPage: () => call<{ ok: true }>('/admin/extensions/web-columns/page', { method: 'DELETE' }),
    setWebColumnSettings: (patch: Partial<Omit<WebColumnSettings, 'enabled' | 'wordpress'>>) =>
      call<{ ok: true; webColumns: WebColumnSettings }>('/admin/extensions/web-columns/settings', { method: 'PUT', body: JSON.stringify(patch) }),
    /** WordPress の入れ先とアプリケーションパスワードを預ける。つながるかを確かめてから預ける。 */
    saveWordPress: (input: { siteUrl: string; username: string; password: string }) =>
      call<{ ok: true; wordpress: ColumnWordPress }>('/admin/extensions/web-columns/wordpress', { method: 'PUT', body: JSON.stringify(input) }),
    removeWordPress: () => call<{ ok: true }>('/admin/extensions/web-columns/wordpress', { method: 'DELETE' }),
    /** 店頭サイネージの会社の設定（画像の秒数・店の色。仕様書 第31.4節）。送った項目だけを変える。 */
    setSignageSettings: (patch: Partial<Omit<SignageSettings, 'enabled'>>) =>
      call<{ ok: true; signage: SignageSettings }>('/admin/extensions/signage/settings', { method: 'PUT', body: JSON.stringify(patch) }),
    /** 番号で店頭サイネージの画面を登録する（管理者だけ。仕様書 第31.5.1節）。 */
    claimSignageScreen: (code: string) =>
      call<{ screen: SignageScreen; restored: boolean }>('/admin/extensions/signage/pairings/claim', { method: 'POST', body: JSON.stringify({ code }) }),
    /** 店頭サイネージの呼び出しの受け口（仕様書 第31.8.2節）。 */
    signageSources: () => call<{ sources: SignageSource[] }>('/admin/extensions/signage/sources'),
    /** 受け口を作る。URL は作ったときだけ返る。 */
    createSignageSource: (name: string) => call<{ source: SignageSource; url: string; key: string }>('/admin/extensions/signage/sources', { method: 'POST', body: JSON.stringify({ name }) }),
    setSignageSourceStatus: (id: string, status: 'active' | 'stopped') =>
      call<{ ok: true }>(`/admin/extensions/signage/sources/${encodeURIComponent(id)}/status`, { method: 'PUT', body: JSON.stringify({ status }) }),
    resetSignageSourceMapping: (id: string) => call<{ ok: true }>(`/admin/extensions/signage/sources/${encodeURIComponent(id)}/reset-mapping`, { method: 'POST', body: '{}' }),
    /** 会社のジングルの音を入れる（MP3・WAV。画面で調べた長さ）。 */
    addSignageSound: (file: Blob, name: string, durationMs: number) =>
      sendRaw<{ sound: SignageSound }>('POST', '/admin/extensions/signage/sounds', file, { 'x-sound-name': encodeURIComponent(name), 'x-duration-ms': String(Math.round(durationMs)) }),
    deleteSignageSound: (id: string) => call<{ ok: true; resetDefault: boolean }>(`/admin/extensions/signage/sounds/${encodeURIComponent(id)}`, { method: 'DELETE' }),
    /** 店頭サイネージの画面を外す（管理者だけ。確認を挟まない）。 */
    removeSignageScreen: (id: string) => call<{ ok: true }>(`/admin/extensions/signage/screens/${encodeURIComponent(id)}`, { method: 'DELETE' }),
    setExtensionEnabled: (id: string, enabled: boolean) =>
      call(`/admin/extensions/${encodeURIComponent(id)}/enabled`, { method: 'PUT', body: JSON.stringify({ enabled }) }),
    /** 会社の接続（コネクタ。仕様書 第12.11.0節）。 */
    mcpConnections: () => call<{ items: McpConnectionView[]; risks: { value: string; text: string }[]; presets: ConnectionPresetView[]; localPolicy: boolean }>('/admin/connections/mcp'),
    /**
     * 接続を登録する。認証の要らない接続は、MCP サーバにツールの一覧を問い合わせる。
     * `preset` を渡すと型（Slack など）から登録する（仕様書 第12.11.6.7節）。
     */
    addMcpConnection: (v: { url?: string; name?: string; id?: string; preset?: string; auth?: 'none' | 'oauth' | 'api_key'; header?: string }) =>
      call<{ ok: true; id: string; tools: number; auth: string }>('/admin/connections/mcp', { method: 'POST', body: JSON.stringify(v) }),
    /** 認証情報を登録する（仕様書 第12.11.6.2節）。値は暗号化され、返らない。 */
    setMcpCredentials: (id: string, v: { clientId?: string; clientSecret?: string; apiKey?: string }) =>
      call<{ ok: true; reset?: number; tools?: number; warning?: string }>(`${mcpPath(id)}/credentials`, { method: 'PUT', body: JSON.stringify(v) }),
    /** ツールごとの危険度などを変える。 */
    updateMcpConnection: (id: string, v: { tools?: { name: string; risk: string }[]; name?: string; sendPolicy?: 'block' | 'deidentified' }) =>
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
