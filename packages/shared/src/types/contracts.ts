/**
 * @file 契約の管理（内蔵の拡張）の型（仕様書 第38章）。
 *
 * 結んだ契約を台帳にし、更新・解約の申し出の期限を見張って知らせる。契約書チェック（第28章）の先につなぐ。
 * 契約書は会社の Google ドライブに置き、台帳には項目とファイルへのつなぎだけを持つ。**金額は持たない**（お金は扱わない方針）。
 */

/** 契約の管理の拡張の ID（内蔵の拡張。第12.13節）。 */
export const CONTRACTS_EXTENSION_ID = 'contracts';

/** 契約の種類（第38.4節）。 */
export type ContractKind = 'nda' | 'basic' | 'sale' | 'outsourcing' | 'contracting' | 'lease_property' | 'lease' | 'maintenance' | 'software' | 'other';

/** 種類の呼び方。 */
export const CONTRACT_KIND_LABELS: Record<ContractKind, string> = {
  nda: '秘密保持（NDA）', basic: '取引基本契約', sale: '売買', outsourcing: '業務委託', contracting: '請負',
  lease_property: '賃貸借', lease: 'リース', maintenance: '保守', software: 'ソフトの利用', other: 'そのほか',
};

/** 契約の状態（第38.4節）。 */
export type ContractStatus = 'active' | 'cancel_requested' | 'ended';

/** 状態の呼び方。 */
export const CONTRACT_STATUS_LABELS: Record<ContractStatus, string> = { active: '有効', cancel_requested: '解約を申し出た', ended: '終了' };

/** 読めなかった項目に付ける印（推測で埋めない）。 */
export type ContractUnknownField = 'party' | 'kind' | 'signedOn' | 'startOn' | 'endOn' | 'autoRenew' | 'noticeDeadline';

/** 読めなかった項目の呼び方。 */
export const CONTRACT_UNKNOWN_LABELS: Record<ContractUnknownField, string> = {
  party: '相手', kind: '種類', signedOn: '締結日', startOn: '始め', endOn: '終わり', autoRenew: '自動更新', noticeDeadline: '解約の申し出の期限',
};

/** 台帳の 1 件（第38.4節）。日付は `YYYY-MM-DD`。 */
export interface Contract {
  id: string;
  /** 相手の会社名（個人なら氏名） */
  party: string;
  kind: ContractKind;
  /** 契約書の題名と、何についての契約かの一言 */
  title: string;
  signedOn: string | null;
  startOn: string | null;
  /** 終わり。期間の無い契約は `null` */
  endOn: string | null;
  autoRenew: boolean;
  /** 更新の期間（月数。1 年なら 12）。自動更新なし・分からなければ `null` */
  renewMonths: number | null;
  /** 解約の申し出の決まり（条文の引用。「第 12 条: 期間満了の 3 か月前までに…」） */
  noticeRule: string;
  /** 終わりの何日前までに申し出るか（決まりから読んだ日数。分からなければ `null`） */
  noticeDays: number | null;
  /** 解約の申し出の期限（プログラムが計算する。分からなければ `null`） */
  noticeDeadline: string | null;
  status: ContractStatus;
  /** 担当の利用者の ID */
  ownerId: string;
  ownerName: string;
  /** 会社のドライブの契約書のファイルの ID（置いていなければ `null`） */
  driveFileId: string | null;
  driveFileName: string;
  /** 契約書チェックの実行（チェックから入れたとき） */
  reviewRunId: string | null;
  /** 前の版（変更契約・覚書を入れたとき、もとの契約） */
  previousId: string | null;
  note: string;
  /** 読めなかった項目（「確かめてください」） */
  unknown: ContractUnknownField[];
  /** 自動で次の期間に進めた回数 */
  renewedCount: number;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

/** 契約書の置き場（会社の Google ドライブのフォルダ。第38.7節）。 */
export interface ContractStorage {
  folderId: string;
  folderName: string;
  /** フォルダを作った（ドライブをつないだ）管理者 */
  connectedBy: string;
  connectedAt: string;
}

/** 会社の設定 `contracts`（第38.2節）。 */
export interface ContractSettings {
  /** 使うか（既定は切り）。 */
  enabled: boolean;
  /** 契約書の置き場。つないでいなければ `null`。 */
  storage: ContractStorage | null;
}

/** 既定（切り）。 */
export const DEFAULT_CONTRACT_SETTINGS: ContractSettings = { enabled: false, storage: null };

/** 解約の申し出の期限を知らせる日（何日前。第38.6節。Q-186）。 */
export const CONTRACT_NOTICE_DAYS_BEFORE = [60, 30, 7] as const;

/** 自動更新の無い契約の、終わりを知らせる日（何日前）。 */
export const CONTRACT_END_DAYS_BEFORE = 30;

/** 契約書の置き場のフォルダの名前。 */
export const CONTRACT_FOLDER_NAME = '契約書（M2Office）';
