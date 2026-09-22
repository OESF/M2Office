/**
 * @file 監査ログの型。
 *
 * @see 仕様書 第16.6節 監査
 */

/**
 * 監査ログの型（仕様書 第16.6節）。
 *
 * @remarks
 * 追記のみ。削除と更新は行わない。
 * 層 1 の直接応答も含め、すべての操作を記録する（不変則 I-4）。
 */
export interface AuditEvent {
  id: string;
  tenantId: string;
  /** 操作した主体。人・秘書・外部アプリのいずれか。 */
  actorType: 'user' | 'secretary' | 'agent' | 'api_client' | 'system';
  actorId: string;
  /** 操作の種別。例: `job.create`、`approval.decide`、`tool.invoke`。 */
  action: string;
  targetType: string;
  targetId: string;
  /** 根拠。参照した文書やツール呼び出しの記録。 */
  detail: Record<string, unknown>;
  occurredAt: string;
}
