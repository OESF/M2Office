/**
 * @file 外部のアプリ（仕様書 第13.4.1節、ADR-0090）の型。会社の管理者がアプリを登録し、鍵と機能を選んで承認する。
 *
 * 機能（スコープ）は、外のシステムに許す操作のまとまりで、機能ごとに呼べる道が決まっている。
 * 新しいつなぐ依頼は、機能を 1 つ足し、道と定義と使い方の例を足して受ける。
 */

import type { InventoryCatalogScope } from './inventory.js';

/** 1 社で登録できるアプリの数。 */
export const EXTERNAL_APP_MAX = 20;

/** 外部のアプリの機能。 */
export type AppFunctionId = 'company.profile' | 'inventory.catalog' | 'inventory.sales';

/** 機能の説明（画面と、選べるかの判定に使う）。 */
export interface AppFunctionInfo {
  id: AppFunctionId;
  /** 画面に出す名前。 */
  label: string;
  /** 呼べる道（定義と画面に出す）。 */
  routes: string[];
  /** この機能を選べる条件。`inventory` は在庫管理を入れた会社だけ。 */
  requires?: 'inventory';
}

/** 機能の一覧（第13.4.1節の表）。案の機能（アカウントの結び付け・ナレッジの検索）は、作るまで入れない。 */
export const APP_FUNCTIONS: readonly AppFunctionInfo[] = [
  { id: 'company.profile', label: '会社の基本情報を読む', routes: ['GET /v1/company/profile'] },
  { id: 'inventory.catalog', label: '商品の一覧を読む', routes: ['GET /v1/inventory/catalog'], requires: 'inventory' },
  { id: 'inventory.sales', label: '販売を知らせる', routes: ['POST /v1/inventory/sales-events'], requires: 'inventory' },
];

/** 機能ごとの設定（承認の対象）。 */
export interface AppSettings {
  /** 機能「商品の一覧を読む」で渡す品目と項目（第29.20.1節）。 */
  catalog?: InventoryCatalogScope;
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
