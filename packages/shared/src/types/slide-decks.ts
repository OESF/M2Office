/**
 * @file 作ったスライドの一覧に出す形（仕様書 第9.4.2節「作ったスライドの扱い」、Q-264）。
 *
 * API と画面が同じ形を使う。構成（作り直すための中身）は一覧に載せない。
 */

/** 作ったものの種類（スライド・文書。仕様書 第9.5.5.2節「文書の作成の扱い」）。 */
export type SlideDeckKind = 'slides' | 'doc';

/** 取り出せる形（PowerPoint・Word・PDF）。 */
export type SlideDeckFormat = 'pptx' | 'docx' | 'pdf';

/** 取り出せる形の画面の言葉。 */
export const SLIDE_DECK_FORMAT_LABEL: Record<SlideDeckFormat, string> = { pptx: 'PowerPoint', docx: 'Word', pdf: 'PDF' };

/** 共有の範囲。自分だけ・会社で共有（会社の Google Workspace のドメインの人が見られる）。 */
export type SlideDeckSharing = 'private' | 'company';

/** 共有の範囲の画面の言葉（名刺の範囲と同じ言葉）。 */
export const SLIDE_DECK_SHARING_LABEL: Record<SlideDeckSharing, string> = { private: '自分だけ', company: '会社で共有' };

/** 作ったスライド 1 件（一覧と結果の画面）。 */
export interface SlideDeckSummary {
  id: string;
  /** スライドか文書か。 */
  kind: SlideDeckKind;
  title: string;
  /** 組み込みのデザインの名前か、会社のテンプレートの名前。 */
  design: string | null;
  sharing: SlideDeckSharing;
  /** 開く道。見本の接続口で作ったものは `null`。 */
  url: string | null;
  /** PowerPoint 形式の取り出しの道（スライドだけ）。 */
  pptxUrl: string | null;
  /** 取り出せる形（スライドは PowerPoint、文書は Word と PDF）。見本の接続口で作ったものは空。 */
  downloads: SlideDeckFormat[];
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
  /** スライドのテーマか、文書のテンプレートか。 */
  kind: SlideDeckKind;
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
