/**
 * @file 外部のアプリ（仕様書 第13.4.1節、ADR-0090）の型。会社の管理者がアプリを登録し、鍵と機能を選んで承認する。
 *
 * 機能（スコープ）は、外のシステムに許す操作のまとまりで、機能ごとに呼べる道が決まっている。
 * 新しいつなぐ依頼は、機能を 1 つ足し、道と定義と使い方の例を足して受ける。
 */

import type { RiskLevel } from './agent.js';
import type { InventoryCatalogScope } from './inventory.js';

/** 1 社で登録できるアプリの数。 */
export const EXTERNAL_APP_MAX = 20;

/** 外部のアプリの機能。 */
export type AppFunctionId =
  | 'company.profile' | 'inventory.catalog' | 'inventory.sales' | 'inventory.receipts'
  | 'accounts.link' | 'knowledge.search' | 'knowledge.rules'
  | 'inquiries.intake' | 'notices.post' | 'reservations.book' | 'members.points' | 'columns.read' | 'jobs.run';

/** 機能を選べる条件になる内蔵の拡張（その拡張を入れた会社だけ選べる）。 */
export type AppFunctionRequirement = 'inventory' | 'inquiries' | 'reservations' | 'members' | 'web-columns';

/** 機能の説明（画面と、選べるかの判定に使う）。 */
export interface AppFunctionInfo {
  id: AppFunctionId;
  /** 画面に出す名前。 */
  label: string;
  /** 呼べる道（定義と画面に出す）。 */
  routes: string[];
  /** この機能を選べる条件（その拡張を入れた会社だけ）。 */
  requires?: AppFunctionRequirement;
  /** 一緒に選ぶ必要のある機能（本人として行う機能は、アカウントの結び付けが要る）。 */
  needs?: AppFunctionId;
}

/** 機能の一覧（第13.4.1節・第13.4.2節の表）。画面はこの順に並べる。 */
export const APP_FUNCTIONS: readonly AppFunctionInfo[] = [
  { id: 'company.profile', label: '会社の基本情報を読む', routes: ['GET /v1/company/profile'] },
  { id: 'inventory.catalog', label: '商品の一覧を読む', routes: ['GET /v1/inventory/catalog'], requires: 'inventory' },
  { id: 'inventory.sales', label: '販売を知らせる', routes: ['POST /v1/inventory/sales-events'], requires: 'inventory' },
  { id: 'inventory.receipts', label: '入庫を知らせる', routes: ['POST /v1/inventory/receipts'], requires: 'inventory' },
  {
    id: 'accounts.link', label: 'アカウントを結び付ける',
    routes: ['POST /v1/accounts/link-requests', 'POST /v1/accounts/links', 'DELETE /v1/accounts/links/{bindingId}'],
  },
  { id: 'knowledge.search', label: 'ナレッジを検索する', routes: ['POST /v1/knowledge/search'], needs: 'accounts.link' },
  { id: 'knowledge.rules', label: '社内規程を登録・改定する', routes: ['PUT /v1/knowledge/rules/{ref}', 'POST /v1/knowledge/rules/{ref}/retire'] },
  { id: 'inquiries.intake', label: '問い合わせを受ける', routes: ['POST /v1/inquiries/intake'], requires: 'inquiries' },
  { id: 'notices.post', label: '社内のお知らせを出す', routes: ['POST /v1/notices', 'POST /v1/notices/{id}/withdraw'] },
  {
    id: 'reservations.book', label: '予約の空きを読む・予約を入れる',
    routes: ['GET /v1/reservations/availability', 'POST /v1/reservations', 'DELETE /v1/reservations/{id}'], requires: 'reservations', needs: 'accounts.link',
  },
  { id: 'members.points', label: '会員のポイントを付ける・使う', routes: ['POST /v1/members/points'], requires: 'members' },
  { id: 'columns.read', label: '公開したコラムを読む', routes: ['GET /v1/columns/published', 'GET /v1/columns/published/{id}/cover.png'], requires: 'web-columns' },
  { id: 'jobs.run', label: '業務を依頼して結果を受け取る', routes: ['POST /v1/jobs', 'GET /v1/runs/{id}'], needs: 'accounts.link' },
];

/** 機能「業務を依頼して結果を受け取る」で選べる危険度の上限（お金の確定は外から依頼させない）。 */
export const APP_JOB_RISKS: readonly RiskLevel[] = ['read', 'draft', 'write-internal', 'external-send'];

/** 機能ごとの設定（承認の対象）。 */
export interface AppSettings {
  /** 機能「商品の一覧を読む」で渡す品目と項目（第29.20.1節）。 */
  catalog?: InventoryCatalogScope;
  /** 機能「社内のお知らせを出す」で出してよい宛先（全員か、決めたグループ）。 */
  notices?: { all: boolean; groupIds: string[] };
  /** 機能「予約の空きを読む・予約を入れる」で見せてよい予約できるもの（すべてか、決めたもの）。 */
  reservations?: { all: boolean; itemIds: string[] };
  /** 機能「社内規程を登録・改定する」で書いてよい権限区画（区画なしはいつも書ける）。 */
  knowledgeRules?: { compartments: string[] };
  /** 機能「業務を依頼して結果を受け取る」で依頼してよい業務と、危険度の上限。 */
  jobs?: { agentIds: string[]; maxRisk: RiskLevel };
}

/** 機能ごとの設定を選ぶための候補（管理者の画面）。 */
export interface AppSettingOptions {
  groups: { id: string; name: string }[];
  reservableItems: { id: string; name: string }[];
  compartments: string[];
  agents: { id: string; name: string; risk: RiskLevel }[];
}

/** 本人に見せる、結び付いているアプリ（個人設定の「サービスとの接続」）。 */
export interface AppBindingView {
  /** 結び付きの記録の ID（アプリに渡した結び付きの ID とは別）。 */
  id: string;
  appName: string;
  createdAt: string;
  lastUsedAt: string | null;
}

/** 外部のアプリ 1 つ（管理者に見せる。鍵は持たない）。 */
export interface ExternalApp {
  id: string;
  name: string;
  status: 'active' | 'stopped';
  /** 承認した機能。承認するまでは空で、どの機能も使えない。 */
  functions: AppFunctionId[];
  /** 承認した機能ごとの設定。 */
  settings: AppSettings;
  approvedBy: string | null;
  approvedByName?: string;
  approvedAt: string | null;
  createdAt: string;
  lastUsedAt: string | null;
  /** この 7 日の呼び出しの数。 */
  callsLast7Days: number;
}
