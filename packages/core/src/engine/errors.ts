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
