/**
 * @file 会員とポイント（内蔵の拡張。仕様書 第40章）の型と決まり。
 *
 * ポイントは来店と購入で貯まり、特典と交換して減る。**お金ではない**。購入の金額は保存せず、ポイントだけを持つ（第40.6節）。
 * ポイントの記録は消さずに足していく（取り消しは逆の記録）。いまのポイントは記録の合計で求める。
 */

/** 会員とポイントの拡張機能の ID。 */
export const MEMBERS_EXTENSION_ID = 'members';

/** 会員のランク（第40.19節）。直近 1 年の来店の回数で決まる。 */
export type MemberRank = 'regular' | 'silver' | 'gold';

/** ランクの名前（regular は会員証などに出さない）。 */
export const MEMBER_RANK_LABELS: Record<MemberRank, string> = { regular: '一般', silver: 'シルバー', gold: 'ゴールド' };

/** ランクの順（上ほど大きい）。 */
export const MEMBER_RANK_ORDER: Record<MemberRank, number> = { regular: 0, silver: 1, gold: 2 };

/** 特典を使えるランクの書き方（「シルバー以上」「ゴールドだけ」。全員なら空）。 */
export const minRankText = (r: MemberRank): string => (r === 'gold' ? 'ゴールドだけ' : r === 'silver' ? 'シルバー以上' : '');

/** 会員（第40.3節）。 */
export interface Member {
  id: string;
  /** 会員番号（会社の中で連番） */
  number: number;
  /** 呼び名（ニックネームでよい） */
  nickname: string;
  /** 電話（任意） */
  phone: string;
  /** 誕生日（月と日だけ。MM-DD。任意。第40.18節） */
  birthday: string | null;
  /** LINE で会員になったか（LINE のお客様の ID そのものは画面に出さない） */
  line: boolean;
  /** いまのポイント */
  balance: number;
  /** 来店の回数 */
  visits: number;
  /** 直近 1 年の来店の回数（ランクの元。第40.19節） */
  yearVisits: number;
  /** ランク */
  rank: MemberRank;
  /** 最後に来店した日時 */
  lastVisitAt: string | null;
  /** 最後にポイントを貯めた日時（有効期限の起点） */
  lastEarnedAt: string | null;
  createdAt: string;
}

/** ポイントの記録の種類。 */
export type MemberPointKind = 'visit' | 'purchase' | 'reward' | 'undo' | 'expire' | 'adjust';

/** 種類の名前。 */
export const MEMBER_POINT_KIND_LABELS: Record<MemberPointKind, string> = {
  visit: '来店', purchase: '購入', reward: '特典', undo: '取り消し', expire: '失効', adjust: '調整',
};

/** ポイントの記録の 1 件。 */
export interface MemberPoint {
  id: string;
  memberId: string;
  kind: MemberPointKind;
  /** 増減（使った・取り消した・失効したは負） */
  points: number;
  /** 特典を使ったとき */
  rewardId: string | null;
  rewardName: string;
  /** 取り消した記録 */
  reversalOf: string | null;
  /** 取り消されたか */
  reversed: boolean;
  note: string;
  createdBy: string;
  createdByName: string;
  createdAt: string;
}

/** 特典（第40.3節）。 */
export interface MemberReward {
  id: string;
  name: string;
  /** 必要なポイント */
  points: number;
  /** 誕生月の会員だけが使えるか（第40.18節） */
  birthdayOnly: boolean;
  /** 使えるいちばん下のランク（regular は全員。第40.19節） */
  minRank: MemberRank;
  /** 使える期間（任意。YYYY-MM-DD） */
  validFrom: string | null;
  validTo: string | null;
  status: 'active' | 'stopped';
  createdAt: string;
}

/** 会社の設定（第40.4節）。 */
export interface MemberSettings {
  enabled: boolean;
  /** 1 回の来店のポイント */
  visitPoints: number;
  /** 何円で 1 ポイントか */
  yenPerPoint: number;
  /** 最後に貯めた日から失効までの日数 */
  expiryDays: number;
  /** LINE の会員証のページ（LINE ミニアプリ）の LIFF ID（無ければ LINE の会員証は使わない） */
  liffId: string;
  /** LINE ログインのチャネルの ID（LIFF の ID トークンを確かめる） */
  lineLoginChannelId: string;
  /** 週の見立てを送った日時（第40.18節） */
  digestAt?: string | null;
  /**
   * ランクの境の回数（直近 1 年の来店。第40.19節）。自動なら月に 1 回、会社の会員の来店の分布から仕組みが決める。
   * どちらも `null` ならランクを使わない（来店のある会員がまだ少ない）
   */
  rankSilver?: number | null;
  rankGold?: number | null;
  /** 境の回数を仕組みが決めるか（偽なら管理者が決めた回数のまま） */
  rankAuto?: boolean;
  /** 境の回数を決めた日時 */
  rankAt?: string | null;
  /** 店頭サイネージに特典を流すか（第40.19節） */
  signage?: boolean;
  /** サイネージに流している特典の 1 枚（素材の ID と中身の印） */
  signageAssetId?: string | null;
  signageDigest?: string | null;
}

/** 会員とポイントは既定で切り（第40.2節）。 */
export const DEFAULT_MEMBER_SETTINGS: MemberSettings = {
  enabled: false, visitPoints: 1, yenPerPoint: 100, expiryDays: 365, liffId: '', lineLoginChannelId: '',
  rankSilver: null, rankGold: null, rankAuto: true, rankAt: null, signage: false, signageAssetId: null, signageDigest: null,
};

/** 決まり。 */
export const MEMBER_LIMITS = {
  nicknameMax: 30,
  rewardNameMax: 40,
  noteMax: 100,
  /** 1 回の購入の金額の上限（入れまちがいを防ぐ） */
  purchaseMax: 10_000_000,
  /** 1 回の調整の上限 */
  adjustMax: 10_000,
  /** ランクを数える日数（直近 1 年） */
  rankDays: 365,
  /** 自動のとき、来店のある会員のうち上からどれだけをゴールド・シルバー（ゴールドを含む）にするか */
  rankGoldShare: 0.1,
  rankSilverShare: 0.3,
  /** 自動のときの境の回数の下限（来店の少ない店で 1 回でシルバーにならないように） */
  rankSilverMin: 2,
  rankGoldMin: 3,
  /** 自動で境を決めるのに要る、来店のある会員の数 */
  rankMembersMin: 10,
  /** サイネージに出す特典の数 */
  signageRewardsMax: 6,
} as const;

/** 会員証のページの道（鍵つき）。 */
export const memberCardPath = (key: string) => `/v1/member-card/${encodeURIComponent(key)}`;

/** 会員証の QR・URL から鍵を取り出す（URL でなければそのまま）。 */
export function memberCardKeyOf(raw: string): string {
  const m = /\/member-card\/([A-Za-z0-9_-]{20,64})/.exec(raw.trim());
  return m ? m[1]! : raw.trim();
}

/** 会員への LINE の知らせの宛先（第40.18節）。 */
export type MemberAudience = 'line' | 'away' | 'expiring';

/** 宛先の名前。 */
export const MEMBER_AUDIENCE_LABELS: Record<MemberAudience, string> = {
  line: 'LINE の会員全員', away: 'しばらく来ていない会員（60 日）', expiring: 'ポイントの失効が近い会員（30 日）',
};

/** 会員への LINE の知らせの状態。 */
export type MemberMessageStatus = 'draft' | 'awaiting' | 'sent' | 'failed' | 'rejected';

/** 会員への LINE の知らせ（社外への送信。承認の後に送る。第40.18節）。 */
export interface MemberMessage {
  id: string;
  /** 失効の前の知らせ（自動で用意したもの）か、管理者が書いたものか */
  kind: 'expiry' | 'custom';
  audience: MemberAudience;
  /** 文（{呼び名}・{ポイント}・{失効日} を 1 人ずつ差し込む） */
  text: string;
  /** 宛先の会員の数（用意したとき） */
  count: number;
  status: MemberMessageStatus;
  runId: string | null;
  /** 送れた数 */
  sent: number;
  note: string;
  createdBy: string;
  createdAt: string;
  sentAt: string | null;
}

/** 失効の前の知らせの文（自動で用意するときの既定）。 */
export const MEMBER_EXPIRY_TEXT = '{呼び名} さん、いつもありがとうございます。お持ちの {ポイント} ポイントは {失効日} に失効します。それまでにご来店のうえお使いください。';

/** 文に差し込める言葉。 */
export const MEMBER_MESSAGE_FIELDS = ['{呼び名}', '{ポイント}', '{失効日}'] as const;

/** 会員への知らせの文の長さ。 */
export const MEMBER_MESSAGE_MAX = 500;
