/**
 * @file グループと利用範囲の型と判定。業務ごとに「誰が使えるか」を決める。
 *
 * 利用範囲の対象は、公式の業務エージェントなら業務エージェントの ID、拡張機能の業務エージェントなら
 * 拡張機能の ID である（拡張機能の業務すべてに同じ範囲が効く）。対象の設定が無ければ全員が使える。
 *
 * @see 仕様書 第16.7節 グループと利用範囲
 */

/** 利用者のグループ（部署・役職など）。会社の中だけで意味を持つ。 */
export interface UserGroup {
  id: string;
  tenantId: string;
  name: string;
  description: string;
  /** 所属する利用者の ID。 */
  memberIds: string[];
}

/**
 * 1 つの対象の利用範囲。指定したグループのいずれかに所属する人、または個別に指定した人が使える。
 *
 * @remarks 両方が空の範囲は保存しない（誰も使えない業務は「無効」で表す。第16.7.3節）。
 */
export interface AccessScope {
  groups: string[];
  users: string[];
}

/** 会社の設定の区分 `access`。対象（業務エージェントの ID か拡張機能の ID）ごとの利用範囲。 */
export interface AccessSettings {
  scopes: Record<string, AccessScope>;
}

/**
 * 業務エージェントの ID から、利用範囲の対象を求める。
 *
 * @returns 拡張機能の業務エージェント（`<拡張機能の ID>:<定義の ID>`）なら拡張機能の ID、公式ならその ID
 */
export function scopeTargetOf(agentId: string): string {
  const i = agentId.indexOf(':');
  return i === -1 ? agentId : agentId.slice(0, i);
}

/**
 * 利用者が業務エージェントを使えるか。
 *
 * @param access 会社の利用範囲の設定
 * @param agentId 業務エージェントの ID
 * @param userId 利用者
 * @param groupIds その利用者が所属するグループ
 */
export function canUseAgent(
  access: AccessSettings, agentId: string, userId: string, groupIds: readonly string[],
): boolean {
  const scope = access.scopes[scopeTargetOf(agentId)];
  if (!scope) return true;
  return scope.users.includes(userId) || scope.groups.some((g) => groupIds.includes(g));
}
