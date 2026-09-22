/**
 * @file テナント・利用者・要求ごとの文脈の型。
 *
 * @see 仕様書 第19章 データモデル
 */

export interface Tenant {
  id: string;
  /** サブドメイン。`a.m2office.online` の `a` にあたる。 */
  subdomain: string;
  name: string;
  /** Google Workspace のドメイン。ログイン時に照合する。 */
  workspaceDomain: string | null;
  status: 'trial' | 'active' | 'suspended' | 'cancelled';
}

export type Role = 'admin' | 'approver' | 'member' | 'external' | 'developer';

export interface User {
  id: string;
  tenantId: string;
  email: string;
  displayName: string;
  roles: Role[];
  status: 'active' | 'disabled';
}

/**
 * リクエストごとに確定するテナント境界の情報。
 *
 * @remarks
 * すべてのデータアクセスはこの `tenantId` による絞り込みを伴う（不変則 I-2）。
 */
export interface RequestContext {
  tenant: Tenant;
  user: User;
}
