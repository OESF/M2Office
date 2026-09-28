/**
 * @file 名刺管理（内蔵の拡張）の型。連絡先・名刺・読み取った項目。画面・API・ワーカーで共通に使う。
 *
 * @see 仕様書 第27章 名刺管理
 * @see 仕様書 第27.11節 データモデル
 */

/** 持ち主の範囲。`company` は会社で共有、`personal` は自分だけ（第27.7節）。 */
export type ContactScope = 'company' | 'personal';

/** 電話の種類。代表・直通・携帯・FAX（第27.5節）。 */
export type PhoneKind = 'main' | 'direct' | 'mobile' | 'fax';

/** 電話番号 1 つ。 */
export interface ContactPhone {
  kind: PhoneKind;
  number: string;
}

/**
 * 名刺から取り出す項目（第27.5節）。名刺に無い項目は空にする（推測で埋めない）。
 *
 * @remarks 連絡先の現在の値と、名刺ごとの読み取り結果の両方に使う
 */
export interface CardFields {
  name: string;
  nameKana: string;
  /** ふりがなを名刺から読んだのでなく推定したか。 */
  kanaEstimated: boolean;
  company: string;
  department: string;
  title: string;
  postalCode: string;
  address: string;
  phones: ContactPhone[];
  emails: string[];
  website: string;
  /** 資格・SNS など、ほかの項目。 */
  extra: string;
}

/** 連絡先（1 人の人。第27.3節）。同じ人の名刺が何枚あっても 1 つ。 */
export interface Contact extends CardFields {
  id: string;
  tenantId: string;
  scope: ContactScope;
  /** 取り込んだ人。自分だけの名刺はこの人だけが見られる。 */
  ownerUserId: string;
  note: string;
  status: 'active' | 'trash';
  trashedAt: string | null;
  createdBy: string;
  createdAt: string;
  updatedBy: string | null;
  updatedAt: string;
}

/** 名刺の読み取りの状態。 */
export type CardStatus = 'pending' | 'reading' | 'done' | 'failed';

/** 名刺（受け取った 1 枚の紙。表と裏の画像と、読み取った結果。第27.3節）。 */
export interface ContactCard {
  id: string;
  tenantId: string;
  contactId: string | null;
  scope: ContactScope;
  /** 受け取った（取り込んだ）人。 */
  ownerUserId: string;
  batchId: string;
  seq: number;
  frontFileId: string | null;
  backFileId: string | null;
  /** 画像を正しい向きに回す角度（0・90・180・270）。 */
  frontRotation: number;
  backRotation: number;
  /** 撮るときに表と裏を組にしたか。 */
  paired: boolean;
  status: CardStatus;
  failureReason: string | null;
  /** 読み取ったままの結果。 */
  extracted: CardFields | null;
  /** 人が直した項目。 */
  corrected: Partial<CardFields>;
  /** 受け取った日（`YYYY-MM-DD`）。 */
  receivedOn: string;
  createdAt: string;
}

/** 空の項目。読み取れなかった項目を空のまま持つための初期値。 */
export const EMPTY_CARD_FIELDS: CardFields = {
  name: '', nameKana: '', kanaEstimated: false, company: '', department: '', title: '',
  postalCode: '', address: '', phones: [], emails: [], website: '', extra: '',
};

/** 内蔵の拡張「名刺管理」の ID。利用範囲の対象（第16.7.3節）と、付属の業務の ID の頭に使う。 */
export const CARDS_EXTENSION_ID = 'business-cards';
