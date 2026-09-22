/**
 * @file 会社ごとの設定（会社情報・自社の書き方・自動化ポリシー・業務の有効化）と、個人設定の型と既定値。
 *
 * @see 仕様書 第6.5節 個人設定
 * @see 仕様書 第6.6節 管理者ページ
 * @see 仕様書 第9.4節 会社ごとの自動化ポリシー
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

/**
 * 効果の推計の設定（仕様書 第6.7.12節）。
 *
 * @remarks 値が無いエージェントは、公式の既定値を使う。
 */
export interface EffectSettings {
  /** エージェントごとの標準所要時間（分）。手作業なら 1 件に何分かかるか。 */
  minutesPerRun: Record<string, number>;
}

/**
 * 管理者の初期設定の進み具合のうち、他のデータから判定できないもの（仕様書 第6.10.3節）。
 */
export interface TenantOnboarding {
  /** 「業務と承認」を一度保存した日時。 */
  agentsReviewedAt: string | null;
  /** 従業員へダッシュボードの見える範囲を知らせたと、管理者が記録した日時。 */
  employeesNotifiedAt: string | null;
}

export interface TenantSettings {
  company: CompanyInfo;
  writingStyle: WritingStyle;
  automation: AutomationPolicy;
  agents: AgentSettings;
  effect: EffectSettings;
  onboarding: TenantOnboarding;
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
  effect: { minutesPerRun: {} },
  onboarding: { agentsReviewedAt: null, employeesNotifiedAt: null },
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

/**
 * 本人が編集する設定（仕様書 第6.5節）。
 *
 * @remarks 管理者であっても他人の個人設定は編集しない。
 */
export interface UserSettings {
  profile: {
    /** ふりがな。並び順と読み上げに使う。 */
    furigana: string;
    /** 役職・所属。文書の署名に使う。 */
    title: string;
    /** 予定と定時実行の基準（第6.5.1節）。 */
    timezone: string;
  };
  secretary: {
    /** 秘書の名前。呼びかけに使う。 */
    name: string;
    /** 自分の呼ばれ方。空なら表示名に「さん」を付ける。 */
    callMe: string;
    style: 'polite' | 'concise';
    proactivity: 'low' | 'normal' | 'high';
  };
  notifications: {
    /** 受け取る種類（第6.5.5節）。`false` にしたものは届けない。 */
    kinds: Record<'brief' | 'run' | 'approval' | 'failure', boolean>;
    /** 通知しない時間帯（例: 22:00〜7:00）。`null` は指定なし。 */
    quietHours: { from: string; to: string } | null;
  };
  menu: {
    /** メニューに出さない業務。使える業務を増やすことはできない（第6.5.6節）。 */
    hidden: string[];
    /** 並び順。載っていない業務は後ろに既定の順で並ぶ。 */
    order: string[];
  };
  /** 初回の案内を見終えた（または飛ばした）日時。`null` なら次のログインで案内する（第6.10.3節）。 */
  onboarding: { tourCompletedAt: string | null };
}

export const DEFAULT_USER_SETTINGS: UserSettings = {
  profile: { furigana: '', title: '', timezone: 'Asia/Tokyo' },
  secretary: { name: '', callMe: '', style: 'polite', proactivity: 'normal' },
  notifications: { kinds: { brief: true, run: true, approval: true, failure: true }, quietHours: null },
  menu: { hidden: [], order: [] },
  onboarding: { tourCompletedAt: null },
};
