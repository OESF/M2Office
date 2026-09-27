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
  /** 略称（例: OESF。仕様書 第6.6.1節）。秘書が名乗るときの会社の呼び方と、画面の見出しに使う。 */
  shortName: string;
  /** 郵便番号（例: 123-4567）。帳票の差出人に「〒」を付けて出す。 */
  postalCode: string;
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
  /** 会社のロゴ（PNG・JPEG のファイル ID。仕様書 第6.6.1節）。画面の左上に出す。無ければ `null`。 */
  logoFileId: string | null;
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
  /** 第 0.115.0 版より前に会社が登録した言い換えの組。そのまま効かせ、新しくは登録しない（第11.7.7.0節）。 */
  synonyms: string[][];
}

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

/**
 * 帳票の体裁（仕様書 第15.2.2節、Q-57）。
 *
 * @remarks
 * 自社の書き方（{@link WritingStyle}）は文章の規則で、推論に渡す指示文に差し込まれる。
 * こちらは帳票を描くための値であり、推論を通さない。混ぜないために分けて持つ。
 */
export interface InvoiceStyle {
  /** ロゴの画像（PNG・JPEG）のファイル ID。未設定なら出さない。 */
  logoFileId: string | null;
  /** 振込先（銀行名・支店・種別・番号・名義）。1 つの文として持つ。 */
  bankAccount: string;
  /** 支払期限の既定（例: 翌月末）。 */
  paymentDue: string;
  /** 備考の定型文。毎回入れる断り書き。 */
  notes: string;
  /** 印の欄を出すか。 */
  sealBox: boolean;
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
  /** 帳票の体裁（第15.2.2節）。 */
  invoice: InvoiceStyle;
}

/** 設定が未保存の会社に使う既定値。 */
export const DEFAULT_TENANT_SETTINGS: TenantSettings = {
  company: {
    legalName: '', shortName: '', postalCode: '', address: '', phone: '', fiscalYearStartMonth: 4,
    invoiceRegistrationNumber: '', taxRounding: 'floor', closingDay: 'end', paymentTerms: '', logoFileId: null,
  },
  writingStyle: { selfReference: '弊社', greeting: '', closing: '', signature: '', terms: [], notes: '' },
  // 社内への書き込みは既定で承認なし。人に判断を求めるのは社外とお金だけ（第9.4.0節、ADR-0028）
  automation: { writeInternal: 'allow', perAgent: {} },
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
  // 帳票の体裁。未設定でも帳票は出せる（無い欄は出さない）
  invoice: { logoFileId: null, bankAccount: '', paymentDue: '', notes: '', sealBox: false },
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
    /**
     * 自宅（地域か最寄り駅。第6.5.1節）。行程の出発地と、朝のブリーフの天気の地域に使う。
     *
     * @remarks 本人の秘書と、本人の依頼で動く業務（`profile.read` を宣言したもの）だけが使う。管理者には見せない
     */
    home: string;
    /** いつもの勤務地（第6.5.1節）。空なら会社情報の住所。 */
    workplace: string;
  };
  secretary: {
    /** 秘書の名前。呼びかけに使う。 */
    name: string;
    /** 自分の呼ばれ方。空なら表示名に「さん」を付ける。 */
    callMe: string;
    style: 'polite' | 'concise';
    proactivity: 'low' | 'normal' | 'high';
    /**
     * 声で答えるか（個人設定「声で答える」。仕様書 第6.5.3節・第10.5.5節）。切ると、音声の対話でも文字だけを返す。
     *
     * @remarks 入力欄に書いた依頼には、この設定によらず声を使わない（第6.2.0節）
     */
    speak: boolean;
    /**
     * 音声で話している間、秘書バーに字幕（聞こえた言葉と秘書の言葉）を出すか（個人設定「会話を文字で出す」。第10.5.2節）。
     *
     * @remarks
     * `speak` が切りのときは、この値によらず出す（声も文字も無いと答えが伝わらない）。{@link showsCaptions} で判定する。
     * 消しても、会話ログへの保存と秘書のキャンバスに出す答えは変わらない
     */
    captions: boolean;
    /**
     * 読み上げの声（仕様書 第10.5.6節）。提供者が用意する声の名前。空なら提供者の既定。
     *
     * @remarks 選べる声は {@link VOICE_CHOICES}。一覧は提供者の更新で変わる
     */
    voice: string;
    /** 話し方の指示（例: 「関西弁で話して」）。100 字まで。音声のときだけ使う（第10.5.6節）。 */
    voiceStyle: string;
    /**
     * 秘書バーの左端に出すアバター（仕様書 第6.1.3節）。
     *
     * @remarks
     * `preset:<id>` は同梱の線画、`file:<ファイルの ID>` は本人が上げた画像。
     * 空なら人の形のアイコンを出す。
     */
    avatar: string;
  };
  notifications: {
    /** 受け取る種類（第6.5.5節）。`false` にしたものは届けない。 */
    kinds: Record<'brief' | 'run' | 'approval' | 'failure', boolean>;
    /** 通知しない時間帯（例: 22:00〜7:00）。`null` は指定なし。 */
    quietHours: { from: string; to: string } | null;
    /**
     * 画面内のお知らせに加えて控えを届ける先（第6.5.5.2節）。既定は切（画面内のみ）。
     *
     * @remarks
     * 画面内は切れない。控えには種類・題名・画面へのリンクだけを載せる。
     * メールは送らない（Q-86）。届けるのは Google Chat だけである
     */
    channels: { chat: boolean };
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
    /**
     * ピン止めした業務（仕様書 第6.1.1節「業務の並び」）。左のメニューの上に常に出し、ほかは「ほかの業務」にたたむ。
     *
     * @remarks `null` はまだ一度も変えていないことを表し、{@link DEFAULT_PINNED} を使う。使った回数では変えない
     */
    pinned?: string[] | null;
  };
  /** 初回の案内を見終えた（または飛ばした）日時。`null` なら次のログインで案内する（第6.10.3節）。 */
  onboarding: {
    tourCompletedAt: string | null;
    /** 朝のブリーフの定時実行を秘書が用意した時刻（第9.5.5.1節）。一度用意したら、止めたり消したりしても作り直さない。 */
    morningBriefAt?: string | null;
  };
}

/** まだピン止めを変えていない人に、はじめからピン止めしておく業務（仕様書 第6.1.1節）。 */
export const DEFAULT_PINNED = ['minutes', 'inbox-triage', 'knowledge-qa', 'scheduling', 'slides', 'document-draft'];

export const DEFAULT_USER_SETTINGS: UserSettings = {
  profile: { furigana: '', title: '', timezone: 'Asia/Tokyo', home: '', workplace: '' },
  secretary: { name: '', callMe: '', style: 'polite', proactivity: 'normal', speak: true, captions: true, voice: '', voiceStyle: '', avatar: '' },
  notifications: {
    kinds: { brief: true, run: true, approval: true, failure: true },
    quietHours: null,
    channels: { chat: false },
  },
  memory: { learning: true, excludes: [], keepConversations: true },
  menu: { hidden: [], order: [], pinned: null },
  onboarding: { tourCompletedAt: null, morningBriefAt: null },
};

/**
 * 読み上げに選べる声（仕様書 第10.5.6節）。
 *
 * @remarks
 * Gemini が用意する声の名前をそのまま並べる。M2Office では声を作らない。
 * 添えた言葉は、Google の説明（Bright・Firm など）を日本語にしたもので、
 * **聞いた印象の目安**である。性別として断定しない。
 *
 * 出どころ: https://ai.google.dev/gemini-api/docs/speech-generation （2026-09-24 に確認、30 種）。
 * 一覧は提供者の更新で変わる。**選んだ声を相手が受け付けないことがある**ため、
 * そのときは既定の声に落として対話を続ける（`packages/core/src/voice/gemini-live.ts`）。
 */
export const VOICE_CHOICES: { name: string; note: string }[] = [
  { name: 'Zephyr', note: '明るい' },
  { name: 'Puck', note: '陽気' },
  { name: 'Charon', note: '説明に向く' },
  { name: 'Kore', note: 'しっかりした' },
  { name: 'Fenrir', note: '元気のよい' },
  { name: 'Leda', note: '若々しい' },
  { name: 'Orus', note: 'しっかりした' },
  { name: 'Aoede', note: '軽やか' },
  { name: 'Callirrhoe', note: 'おだやか' },
  { name: 'Autonoe', note: '明るい' },
  { name: 'Enceladus', note: '息づかいのある' },
  { name: 'Iapetus', note: '澄んだ' },
  { name: 'Umbriel', note: 'おだやか' },
  { name: 'Algieba', note: 'なめらか' },
  { name: 'Despina', note: 'なめらか' },
  { name: 'Erinome', note: '澄んだ' },
  { name: 'Algenib', note: 'かすれた低め' },
  { name: 'Rasalgethi', note: '説明に向く' },
  { name: 'Laomedeia', note: '陽気' },
  { name: 'Achernar', note: 'やわらかい' },
  { name: 'Alnilam', note: 'しっかりした' },
  { name: 'Schedar', note: '平らな' },
  { name: 'Gacrux', note: '落ち着いた' },
  { name: 'Pulcherrima', note: '前へ出る' },
  { name: 'Achird', note: '親しみやすい' },
  { name: 'Zubenelgenubi', note: 'くだけた' },
  { name: 'Vindemiatrix', note: 'やさしい' },
  { name: 'Sadachbia', note: '生き生きした' },
  { name: 'Sadaltager', note: '物知りな' },
  { name: 'Sulafat', note: 'あたたかい' },
];

/**
 * 音声で話している間に字幕を出すか（仕様書 第6.5.3節「会話を文字で出す」）。
 *
 * @remarks 「声で答える」を切っているときは、設定によらず出す。声も文字も無いと、秘書の答えが伝わらないため
 */
export function showsCaptions(s: Pick<UserSettings['secretary'], 'speak' | 'captions'>): boolean {
  return s.captions !== false || !s.speak;
}

/** 話し方の指示の長さの上限（字）。 */
export const VOICE_STYLE_MAX = 100;

/**
 * 同梱する秘書のアバター（仕様書 第6.1.3節）。
 *
 * @remarks
 * 画像は `packages/web/public/avatars/<id>.png` に置く（置き方はそこの README）。
 * **置いていないものは画面に出さない。** 壊れた画像を並べないためである。
 *
 * 画像そのものはリポジトリの持ち主が用意する。
 * 権利の確かめられない画像を同梱しない。
 */
export const AVATAR_PRESETS: { id: string; label: string }[] = [
  { id: 'secretary1', label: '眼鏡・ボブ（女性）' },
  { id: 'secretary2', label: 'スカーフ（女性）' },
  { id: 'secretary3', label: 'ショートヘア（女性）' },
  { id: 'secretary4', label: '紺のスーツ（男性）' },
  { id: 'secretary5', label: '眼鏡・グレー（男性）' },
  { id: 'secretary6', label: '黒のスーツ（男性）' },
  { id: 'secretary7', label: 'ショートヘア・カーディガン（女性）' },
  { id: 'secretary8', label: 'ミリタリージャケット（女性）' },
  { id: 'secretary9', label: 'ダンガリーシャツ（女性）' },
  { id: 'secretary10', label: '眼鏡・グレーのニット（女性）' },
  { id: 'secretary11', label: 'ベージュのジャケット（女性）' },
  { id: 'secretary12', label: '三つ編み・メモ帳（女性）' },
];

/**
 * アバターの指定として妥当か（仕様書 第6.1.3節）。
 *
 * @remarks
 * 受け付けるのは、同梱の見本（`preset:<id>`）か、上げた画像（`file:<ファイルの ID>`）だけ。
 * 空は「未設定」を表す。ほかの文字列は受け付けない（任意の URL を出させない）。
 */
export function isValidAvatar(v: string): boolean {
  if (v === '') return true;
  if (v.startsWith('preset:')) return AVATAR_PRESETS.some((a) => a.id === v.slice('preset:'.length));
  return /^file:[A-Za-z0-9_-]{1,64}$/.test(v);
}
