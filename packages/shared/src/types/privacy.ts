/**
 * @file データの渡し先（委託先）の一覧の型（仕様書 第16.11.3節 G-3、第16.5節「委託先を公開」）。
 */

/** 渡し先との契約の主体。 */
export type DataRecipientContract = 'operator' | 'company' | 'machine';

/** データの渡し先 1 つ。 */
export interface DataRecipient {
  id: string;
  /** 渡し先（事業者とサービス）。 */
  name: string;
  /** 何のために使うか。 */
  purpose: string;
  /** 渡すもの。 */
  data: string;
  /** 置き場・処理の場所。分からなければ「（運営が設定していません）」のように、分からないと書く。 */
  location: string;
  /** 誰の契約で使うか（運営・会社・会社の機械）。 */
  contract: DataRecipientContract;
  /** この会社でいま使っているか。使っていないものも、使えば渡すものとして並べる。 */
  active: boolean;
}

/** 契約の主体の言い方。 */
export const DATA_RECIPIENT_CONTRACT_LABEL: Record<DataRecipientContract, string> = {
  operator: '運営の契約',
  company: '会社の契約',
  machine: '会社の機械（社外に出ない）',
};
