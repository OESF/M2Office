/**
 * 会社（テナント）ごとの設定。管理者ページで編集する（仕様書 第6.6節）。
 */

/** 会社情報（仕様書 第6.6.1節）。帳票とメールの署名に使う。 */
export interface CompanyInfo {
  /** 正式な会社名（前株・後株を含む）。 */
  legalName: string;
  address: string;
  phone: string;
  /** 会計年度の開始月（1〜12）。 */
  fiscalYearStartMonth: number;
  /** 適格請求書発行事業者の登録番号（T＋13 桁）。未登録なら空文字。 */
  invoiceRegistrationNumber: string;
  /** 消費税の端数処理（税率ごとに 1 回）。 */
  taxRounding: 'floor' | 'round' | 'ceil';
  /** 締め日（1〜28、または月末）。 */
  closingDay: number | 'end';
  /** 支払サイト（例: 翌月末払い）。 */
  paymentTerms: string;
}

/** 自社の書き方（仕様書 第15.2.1節）。すべてのエージェントに同じものを差し込む。 */
export interface WritingStyle {
  /** 自社の呼び方（弊社・当社など）。 */
  selfReference: string;
  greeting: string;
  closing: string;
  signature: string;
  /** 用語の言い換え。`avoid` と書かず `use` と書く。 */
  terms: { use: string; avoid: string }[];
  notes: string;
}

export type ApprovalPolicy = 'require' | 'allow';

/**
 * 自動化ポリシー（仕様書 第9.4節「会社ごとの自動化ポリシー」）。
 *
 * @remarks
 * 設定できるのは `write-internal` だけである。`external-send` 以上は項目自体を持たない。
 */
export interface AutomationPolicy {
  /** 社内への書き込みの既定。 */
  writeInternal: ApprovalPolicy;
  /** エージェントごとの例外。無いものは全体に従う。 */
  perAgent: Record<string, ApprovalPolicy>;
}

export interface AgentSettings {
  /** 無効にしたエージェントの ID。 */
  disabled: string[];
}

export interface TenantSettings {
  company: CompanyInfo;
  writingStyle: WritingStyle;
  automation: AutomationPolicy;
  agents: AgentSettings;
}

/** 設定が未保存の会社に使う既定値。 */
export const DEFAULT_TENANT_SETTINGS: TenantSettings = {
  company: {
    legalName: '', address: '', phone: '', fiscalYearStartMonth: 4,
    invoiceRegistrationNumber: '', taxRounding: 'floor', closingDay: 'end', paymentTerms: '',
  },
  writingStyle: { selfReference: '弊社', greeting: '', closing: '', signature: '', terms: [], notes: '' },
  // AG-05 の本人宛通知は既定で承認なし（Q-53）
  automation: { writeInternal: 'require', perAgent: { 'weekly-brief': 'allow' } },
  agents: { disabled: [] },
};

/**
 * `write-internal` の操作に承認が要るかを返す。
 *
 * @param policy 会社の自動化ポリシー
 * @param agentId 実行中のエージェント
 */
export function writeInternalNeedsApproval(policy: AutomationPolicy, agentId: string): boolean {
  return (policy.perAgent[agentId] ?? policy.writeInternal) === 'require';
}

/** 適格請求書発行事業者の登録番号の形式（T＋13 桁）かどうか。空文字は未登録として許す。 */
export function isValidInvoiceNumber(v: string): boolean {
  return v === '' || /^T\d{13}$/.test(v);
}
