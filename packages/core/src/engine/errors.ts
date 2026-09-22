/**
 * @file 実行エンジンが投げる例外の型。
 *
 * @see 仕様書 第9.3節 実行ライフサイクル
 */

/** 実行が再開できない状態にあることを表す。 */
export class RunNotResumableError extends Error {
  constructor(readonly runId: string, readonly status: string) {
    super(`実行 ${runId} は再開できません（状態: ${status}）`);
    this.name = 'RunNotResumableError';
  }
}

/** エージェント定義が基盤の規則に反していることを表す。 */
export class DefinitionInvalidError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DefinitionInvalidError';
  }
}

/** テナントを跨いだアクセスが試みられたことを表す。 */
export class TenantBoundaryError extends Error {
  constructor() {
    super('テナント境界を越えるアクセスは許可されていません');
    this.name = 'TenantBoundaryError';
  }
}

/** 承認の権限を持たない利用者が判断しようとしたことを表す。 */
export class ApprovalForbiddenError extends Error {
  constructor(
    readonly approvalId: string,
    approval: { approverRole: string[]; approverUserId: string | null },
  ) {
    super(
      approval.approverUserId
        ? 'この承認は、依頼した本人だけが判断できます'
        : `この承認を判断する権限がありません（必要なロール: ${approval.approverRole.join('、')}）`,
    );
    this.name = 'ApprovalForbiddenError';
  }
}
