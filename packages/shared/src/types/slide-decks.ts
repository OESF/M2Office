/**
 * @file 作ったスライドの一覧に出す形（仕様書 第9.4.2節「作ったスライドの扱い」、Q-264）。
 *
 * API と画面が同じ形を使う。構成（作り直すための中身）は一覧に載せない。
 */

/** 共有の範囲。自分だけ・会社で共有（会社の Google Workspace のドメインの人が見られる）。 */
export type SlideDeckSharing = 'private' | 'company';

/** 共有の範囲の画面の言葉（名刺の範囲と同じ言葉）。 */
export const SLIDE_DECK_SHARING_LABEL: Record<SlideDeckSharing, string> = { private: '自分だけ', company: '会社で共有' };

/** 作ったスライド 1 件（一覧と結果の画面）。 */
export interface SlideDeckSummary {
  id: string;
  title: string;
  /** 組み込みのデザインの名前か、会社のテンプレートの名前。 */
  design: string | null;
  sharing: SlideDeckSharing;
  /** 開く道。見本の接続口で作ったものは `null`。 */
  url: string | null;
  /** PowerPoint 形式の取り出しの道。 */
  pptxUrl: string | null;
  /** 作った人の表示名（会社で共有されたものを並べるとき）。 */
  ownerName?: string;
  /** 見ている人が作ったものか（作り直す・共有の切り替え・削除は作った人だけ）。 */
  mine: boolean;
  createdAt: string;
  updatedAt: string;
}

/** Google スライドのテーマ 1 件（デザインの見本の並びに出す。第9.4.2節「Google スライドのテーマを使う」）。 */
export interface SlideThemeSummary {
  id: string;
  name: string;
  /** 会社のテーマ（管理者が登録）か。 */
  company: boolean;
  /** 見ている人が削除できるか（自分のテーマ。会社のテーマは管理者）。 */
  removable: boolean;
  /** 見本の縮小の絵があるか（`GET /v1/slide-themes/:id/thumbnail`）。 */
  thumbnail: boolean;
}

/** デザインの値でテーマを表す頭（`theme:<ID>`）。 */
export const SLIDE_THEME_PREFIX = 'theme:';
