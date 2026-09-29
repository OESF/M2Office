/**
 * @file 社内のお知らせの型（仕様書 第10.15節、ADR-0047）。
 *
 * 部署などから社内へのお願い・連絡を、宛先の人の朝のブリーフに載せる。出すのは秘書に頼むだけでよい。
 */

/** お知らせの宛先。全員か、会社のグループ（仕様書 第16.7.2節）。 */
export interface NoticeAudience {
  /** 全員宛てか。`true` なら `groupIds` は見ない。 */
  all: boolean;
  /** 宛先のグループ。どれかに入っている人に載せる。 */
  groupIds: string[];
}

/** 社内のお知らせ 1 件。 */
export interface Notice {
  id: string;
  tenantId: string;
  /** 出した人。 */
  authorId: string;
  /** 出した人の表示名。載せるときに添える。 */
  authorName: string;
  title: string;
  body: string;
  /** 申し込み先などのリンク（`https` だけ）。無ければ空。 */
  link: string;
  audience: NoticeAudience;
  /** 締切（`YYYY-MM-DD`）。無ければ `null`。 */
  dueOn: string | null;
  /** 載せる最後の日（`YYYY-MM-DD`。締切があれば締切の日、無ければ出した日から 14 日）。 */
  until: string;
  createdAt: string;
  withdrawnAt: string | null;
  withdrawnBy: string | null;
}

/** 本人に向けたお知らせ。朝のブリーフと秘書の答えに使う。 */
export interface NoticeForUser extends Notice {
  /** まだ朝のブリーフに載せていない（本文ごと載せる）。 */
  isNew: boolean;
  /** 締切まであと何日か（当日は 0）。締切が無ければ `null`。 */
  daysLeft: number | null;
}

/** 締切の無いお知らせを載せる日数（仕様書 第10.15節）。 */
export const NOTICE_DEFAULT_DAYS = 14;

/** 締切を目立たせ始める日数（締切の 3 日前から。仕様書 第10.15節）。 */
export const NOTICE_SOON_DAYS = 3;
