/**
 * @file 補助金・助成金の案内（内蔵の拡張。仕様書 第39章）の型と決まり。
 *
 * 公的な制度の情報を知らせるだけで、会社のお金は扱わない。申請の書類は作らず、申請を代わりに行わない（第39.6節）。
 * 金額と日付は出典に書かれたとおりにし、書かれていなければ空（「不明」）にする（推測で埋めない）。
 */

/** 補助金・助成金の案内の拡張機能の ID。 */
export const SUBSIDIES_EXTENSION_ID = 'subsidies';

/** 補助金（公募で審査がある）か、助成金（条件を満たせば受けられることが多い）か。 */
export type SubsidyKind = 'subsidy' | 'grant';

/** 種類の名前。 */
export const SUBSIDY_KIND_LABELS: Record<SubsidyKind, string> = { subsidy: '補助金', grant: '助成金' };

/** 見立て（受けられると断定しない）。 */
export type SubsidyFit = 'likely' | 'check';

/** 見立ての名前。 */
export const SUBSIDY_FIT_LABELS: Record<SubsidyFit, string> = { likely: '合いそう', check: '条件を確かめたい' };

/** 状態。見送りにした制度は出し直さない。 */
export type SubsidyStatus = 'new' | 'interested' | 'skipped';

/** 状態の名前。 */
export const SUBSIDY_STATUS_LABELS: Record<SubsidyStatus, string> = { new: '新しい', interested: '気になる', skipped: '見送り' };

/** 候補の 1 件（第39.5節）。 */
export interface Subsidy {
  id: string;
  /** 制度の名前 */
  name: string;
  /** 実施する所（国・県・市・厚生労働省など） */
  provider: string;
  kind: SubsidyKind;
  fit: SubsidyFit;
  /** 合う理由（会社のどの点が対象に合うか） */
  reason: string;
  /** 確かめたい条件 */
  conditions: string;
  /** 上限額（出典の文のまま。書かれていなければ空） */
  amount: string;
  /** 補助率（出典の文のまま。書かれていなければ空） */
  rate: string;
  /** 受付の始め（YYYY-MM-DD。不明なら `null`） */
  startOn: string | null;
  /** 締め切り（YYYY-MM-DD。不明なら `null`） */
  deadline: string | null;
  sourceTitle: string;
  sourceUrl: string;
  /** どこで見つけたか（jGrants の公開の API か、Web の調べものか） */
  origin: 'jgrants' | 'web';
  status: SubsidyStatus;
  /** 状態を変えた人（締め切りの知らせの宛先） */
  statusBy: string | null;
  /** 見つけた日時 */
  foundAt: string;
  updatedAt: string;
}

/** 調べるのに使った会社のこと（第39.3節）。個人の情報は入れない。 */
export interface SubsidyProfile {
  /** 業種（AI がまとめたもの。管理者が直したらそれ） */
  industry: string;
  /** 所在地（都道府県と市区町村だけ。番地は持たない） */
  region: string;
  /** 従業員の数の幅（「6〜20 人」。分からなければ空） */
  employees: string;
}

/** 相談先の地域の窓口（第39.18節）。 */
export interface SubsidyContact {
  /** 窓口の名前（「大阪府よろず支援拠点」など） */
  name: string;
  /** 何を相談できるか */
  role: string;
  /** 出典の URL（Web の調べもので見つけたときだけ。決まった形で作ったものは空） */
  url: string;
}

/** 会社の設定。 */
export interface SubsidySettings {
  enabled: boolean;
  /** 会社の関心（管理者が一言で書く。任意） */
  interest: string;
  /** 管理者が直した業種（空なら AI がまとめる） */
  industry: string;
  /** いちばん新しく調べたときの会社のこと */
  profile: SubsidyProfile | null;
  /** いちばん新しく調べた日時 */
  searchedAt: string | null;
  /** 月の調べものをした月（YYYY-MM） */
  monthlyMonth: string | null;
  /** 調べている間の印（始めた日時。終われば `null`） */
  searchingSince: string | null;
  /** 「気になる」にした国の公募を読み直した日（YYYY-MM-DD。日本時間。第39.18節） */
  refreshedOn: string | null;
  /** 相談先の地域の窓口（Web の調べもので見つけたもの。空なら決まった形で作る） */
  contacts: SubsidyContact[];
  /** 窓口を調べたときの所在地（変わったら調べ直す） */
  contactsRegion: string;
  /** 窓口を調べた日時 */
  contactsAt: string | null;
}

/** 補助金・助成金の案内は既定で切り（第39.2節）。 */
export const DEFAULT_SUBSIDY_SETTINGS: SubsidySettings = {
  enabled: false, interest: '', industry: '', profile: null, searchedAt: null, monthlyMonth: null, searchingSince: null,
  refreshedOn: null, contacts: [], contactsRegion: '', contactsAt: null,
};

/** 決まり（第39.4節・第39.7節）。 */
export const SUBSIDY_LIMITS = {
  /** 1 回に出す新しい候補の数 */
  newMax: 5,
  /** 締め切りの何日前に知らせるか（「気になる」にした制度） */
  deadlineDaysBefore: [14, 3],
  /** 月の調べものの日と時刻（日本時間） */
  monthlyDay: 1,
  monthlyHour: 8,
  /** 関心の長さ */
  interestMax: 100,
  /** 業種の長さ */
  industryMax: 60,
  /** 朝のブリーフに載せる、締め切りまでの日数（「気になる」にした制度。第39.18節） */
  briefDays: 7,
  /** 「気になる」にした国の公募を読み直す時刻（日本時間。1 日 1 回） */
  refreshHour: 8,
  /** 締め切りが過ぎても読み直す日数（延長に気づくため） */
  refreshAfterDays: 14,
  /** 相談先の窓口の数 */
  contactsMax: 6,
  /** 相談先の窓口を調べ直す日数（所在地が変わったときはすぐ） */
  contactsDays: 90,
} as const;
