/**
 * @file 会社ごとの設定（会社情報・自社の書き方・自動化ポリシー・業務の有効化）と、個人設定の型と既定値。
 *
 * @see 仕様書 第6.5節 個人設定
 * @see 仕様書 第6.6節 管理者ページ
 * @see 仕様書 第9.4節 会社ごとの自動化ポリシー
 * @see 仕様書 第16.7節 グループと利用範囲
 */

import type { AccessSettings } from './access.js';

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

/**
 * スライドのテンプレート（仕様書 第9.4.2節「スライドのテンプレート」）。Google スライドのファイルを URL で登録する。
 */
export interface SlideTemplate {
  id: string;
  name: string;
  /** Google スライドのファイルの ID（URL の `/presentation/d/<ID>/` の部分）。 */
  presentationId: string;
  description: string;
  /** 既定のテンプレートか。登録があれば 1 つだけが既定になる。 */
  isDefault: boolean;
}

export interface SlidesSettings {
  templates: SlideTemplate[];
}

/**
 * Google スライドの URL か ID から、ファイルの ID を取り出す。取り出せなければ `null`。
 *
 * @example parsePresentationId('https://docs.google.com/presentation/d/1EVrKer.../edit') // '1EVrKer...'
 */
export function parsePresentationId(input: string): string | null {
  const s = input.trim();
  const fromUrl = /\/presentation\/d\/([A-Za-z0-9_-]{20,})/.exec(s);
  if (fromUrl) return fromUrl[1]!;
  return /^[A-Za-z0-9_-]{20,}$/.test(s) ? s : null;
}

/**
 * 組織知識の言い換え（仕様書 第11.7.7節）。同じ意味の言葉の組で、言葉による検索（段階 2）を補う。
 */
export interface KnowledgeSettings {
  /** 標準の言い換え（`STANDARD_SYNONYMS`）を使うか。既定は使う。 */
  standardSynonyms: boolean;
  /** 自社の言い換えの組。1 組に 2〜10 語。 */
  synonyms: string[][];
}

/** 言い換えの上限（第11.7.7節）。 */
export const SYNONYM_LIMITS = { groups: 300, wordsPerGroup: 10, minChars: 2, maxChars: 30 } as const;

/**
 * 標準の言い換え。労務と経費でよく使う組（第11.7.7節の表）。
 *
 * @remarks 会社の設定でまとめて無効にできる。一部だけ直すときは、無効にして自社の組として登録し直す。
 */
export const STANDARD_SYNONYMS: readonly (readonly string[])[] = [
  ['育休', '育児休業'],
  ['産休', '産前産後休業'],
  ['介護休業', '介護休み'],
  ['有休', '有給', '年休', '年次有給休暇'],
  ['忌引', '忌引き', '慶弔休暇'],
  ['残業', '時間外労働', '時間外勤務'],
  ['休日出勤', '休日労働'],
  ['在宅勤務', 'テレワーク', 'リモートワーク'],
  ['給料', '給与', '賃金'],
  ['ボーナス', '賞与'],
  ['退職金', '退職手当'],
  ['宿代', 'ホテル代', '宿泊費'],
  ['日当', '出張手当'],
  ['立替', '立て替え', '経費精算'],
];

/**
 * 管理者が書いた言い換えの文（1 行に 1 組）を、組の並びにする。
 *
 * @param text 1 行に 1 組。語は「、」「,」「=」のどれで区切ってもよい
 * @returns 組の並び。規則（第11.7.7節）に合わない行があれば、その行番号と理由
 *
 * @example parseSynonymLines('育休、育児休業\n残業 = 時間外労働') // { groups: [['育休','育児休業'],['残業','時間外労働']] }
 */
export function parseSynonymLines(text: string): { groups: string[][] } | { error: string } {
  const groups: string[][] = [];
  const seen = new Map<string, number>();
  const lines = text.split(/\r?\n/);
  for (const [i, line] of lines.entries()) {
    if (!line.trim()) continue;
    const words = [...new Set(line.split(/[、,，=＝]/).map((w) => w.trim()).filter(Boolean))];
    const at = `${i + 1} 行目`;
    if (words.length < 2) return { error: `${at}: 2 語以上を「、」で区切って書いてください` };
    if (words.length > SYNONYM_LIMITS.wordsPerGroup) return { error: `${at}: 1 組は ${SYNONYM_LIMITS.wordsPerGroup} 語までです` };
    for (const w of words) {
      if (w.length < SYNONYM_LIMITS.minChars || w.length > SYNONYM_LIMITS.maxChars) {
        return { error: `${at}: 「${w}」は ${SYNONYM_LIMITS.minChars}〜${SYNONYM_LIMITS.maxChars} 字で書いてください` };
      }
      const dup = seen.get(w);
      if (dup !== undefined) return { error: `${at}: 「${w}」は ${dup} 行目の組にもあります。1 つの組にまとめてください` };
      seen.set(w, i + 1);
    }
    groups.push(words);
  }
  if (groups.length > SYNONYM_LIMITS.groups) return { error: `言い換えは ${SYNONYM_LIMITS.groups} 組までです` };
  return { groups };
}

/**
 * プライバシーの設定（仕様書 第14.3.2節）。
 */
export interface PrivacySettings {
  /** Google から取得したデータを、実行が終わってから残す日数（0〜7）。0 は実行が終わったらすぐ消す。 */
  googleDataRetentionDays: number;
}

/**
 * ダッシュボードの見せ方（仕様書 第6.7.4.1節、Q-64）。
 */
export interface DashboardSettings {
  /** 人の状態の粒度。`names`: 個人名で表示（既定）、`counts`: 人数と業務だけ。 */
  people: 'names' | 'counts';
}

export interface TenantSettings {
  company: CompanyInfo;
  writingStyle: WritingStyle;
  automation: AutomationPolicy;
  agents: AgentSettings;
  effect: EffectSettings;
  onboarding: TenantOnboarding;
  /** 業務ごとの利用範囲（第16.7節）。 */
  access: AccessSettings;
  /** スライドのテンプレート（第9.4.2節）。 */
  slides: SlidesSettings;
  /** 組織知識の言い換え（第11.7.7節）。 */
  knowledge: KnowledgeSettings;
  /** Google から取得したデータの保持（第14.3.2節）。 */
  privacy: PrivacySettings;
  /** ダッシュボードの見せ方（第6.7.4.1節）。 */
  dashboard: DashboardSettings;
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
  // 対象の設定が無い業務は全員が使える
  access: { scopes: {} },
  // 登録が無ければ標準のテンプレートを使う
  slides: { templates: [] },
  // 標準の言い換えは既定で使う（第11.7.7節）
  knowledge: { standardSynonyms: true, synonyms: [] },
  // 上限の 7 日。会社は短くできるが、長くはできない（第14.3.2節）
  privacy: { googleDataRetentionDays: 7 },
  // 承認の滞留が誰の判断待ちかを示すため、既定は個人名（Q-64）
  dashboard: { people: 'names' },
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
    /**
     * 画面内のお知らせに加えて控えを届ける先（第6.5.5.2節）。既定はどちらも切（画面内のみ）。
     *
     * @remarks 画面内は切れない。控えには種類・題名・画面へのリンクだけを載せる
     */
    channels: { chat: boolean; email: boolean };
  };
  /** 記憶とデータ（第6.5.4節）。本人だけが変えられる。 */
  memory: {
    /** 覚えることを許すか。止めている間は、頼まれても覚えない（第11.5.1節）。 */
    learning: boolean;
    /** 対象外の言葉。これを含む指示は覚えない（「この件は覚えないで」）。 */
    excludes: string[];
    /** 秘書とのやり取りを会話ログに残すか（第11.9.4.1節）。切ると 1 件も残さない。 */
    keepConversations: boolean;
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
  notifications: {
    kinds: { brief: true, run: true, approval: true, failure: true },
    quietHours: null,
    channels: { chat: false, email: false },
  },
  memory: { learning: true, excludes: [], keepConversations: true },
  menu: { hidden: [], order: [] },
  onboarding: { tourCompletedAt: null },
};
