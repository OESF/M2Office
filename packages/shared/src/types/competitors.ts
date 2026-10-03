/**
 * @file 競合の分析（内蔵の拡張）の型（仕様書 第36章・第36.18節）。
 *
 * 自社の Web サイトと会社情報から AI が自社の像をまとめ、商圏の有無と半径を決め、近くの同業（Google Places API）か
 * 同じような事業の会社を探して覚える。競合の公開のページだけを robots.txt に従って読み、事実だけを取り出して残す。
 * 段 1 はその場のレポートと秘書からの問い合わせまで。月 1 回の見回りは段 2。
 */

/** 競合の分析の拡張の ID（内蔵の拡張。第12.13節）。 */
export const COMPETITORS_EXTENSION_ID = 'competitors';

/** 自動で覚える競合の上限（第36.5節）。 */
export const COMPETITORS_AUTO_MAX = 5;

/** 人が入れるのを含めた競合の上限（第36.5節）。 */
export const COMPETITORS_MAX = 10;

/** 1 社で読むページの上限（第36.7節）。 */
export const COMPETITOR_PAGES_MAX = 10;

/** 競合の見つけ方。地図（Places API）・AI が挙げた・人が入れた。 */
export type CompetitorOrigin = 'map' | 'ai' | 'manual';

/** 見つけ方の呼び方。 */
export const COMPETITOR_ORIGIN_LABELS: Record<CompetitorOrigin, string> = { map: '地図', ai: 'AI', manual: '手で入れた' };

/** 商圏（第36.5節）。`radiusM` は商圏ありのときの半径（メートル）。 */
export interface CompetitorArea {
  local: boolean;
  radiusM: number | null;
  /** 業種の言葉（地図で探すときに使う。例: 歯科医院） */
  keyword: string;
  /** AI が決めた理由（一言） */
  reason: string;
}

/** 自社の像（第36.6節）。会社の非公開の知識は使わない。 */
export interface CompetitorProfile {
  /** 事業（一言） */
  business: string;
  /** 主なサービスと価格帯 */
  services: { name: string; price: string }[];
  /** 対応の範囲（地域・時間・対象のお客様） */
  coverage: string;
  /** 打ち出していること（強みとして書いていること） */
  strengths: string[];
  /** 場所（会社情報の住所） */
  location: string;
  /** 読んだ自社の Web サイト（会社情報か、地図で見つけた自社のもの。無ければ空） */
  website: string;
  area: CompetitorArea;
  /** 読んだページの数・読めなかった数 */
  pagesRead: number;
  pagesFailed: number;
  updatedAt: string;
  /**
   * 自社の位置（地図で引いたもの。30 日まで。距離を計算するためだけに持ち、画面と秘書には出さない）。
   */
  geo?: { lat: number; lng: number; at: string } | null;
}

/** 競合 1 社（画面と秘書に返す形）。地図で見つけたものの名前・URL は残さず、表示のたびに引き直す。 */
export interface Competitor {
  id: string;
  origin: CompetitorOrigin;
  /** 名前（地図で見つけたものは引き直した値。引けなければ空） */
  name: string;
  url: string;
  /** 自社からの距離（メートル。商圏ありで分かるときだけ） */
  distanceM: number | null;
  /** 候補にした理由（一言） */
  reason: string;
  status: 'watching' | 'removed';
  /** 最後に読んだ日時と、読んだ・読めなかったページの数 */
  lastReadAt: string | null;
  pagesRead: number;
  pagesFailed: number;
  /** 読めなかった理由（robots.txt で断られた・届かない など） */
  readNote: string;
  /** いまの事実の数 */
  factCount: number;
  /** 地図の出典の表示（Places が返したもの。無ければ空） */
  attributions: string[];
  createdBy: string;
  createdAt: string;
}

/** 取り出した事実の種類（第36.7節）。 */
export type CompetitorFactKind = 'service' | 'campaign' | 'news' | 'hours' | 'coverage' | 'strength';

/** 事実の種類の呼び方。 */
export const COMPETITOR_FACT_LABELS: Record<CompetitorFactKind, string> = {
  service: 'サービスと値段', campaign: 'キャンペーン', news: 'お知らせ・ブログ', hours: '営業時間', coverage: '対応の範囲', strength: '打ち出していること',
};

/** 取り出した事実 1 つ。相手の文章は残さず、事実と出典の URL だけを残す。 */
export interface CompetitorFact {
  id: string;
  /** 競合（自社なら `null`） */
  competitorId: string | null;
  /** 回（年月。YYYY-MM） */
  period: string;
  kind: CompetitorFactKind;
  /** 事実（短い文。例: 「ホワイトニング 1 回 22,000 円」） */
  text: string;
  sourceUrl: string;
  createdAt: string;
}

/** レポート（第36.8節）。社内向け。 */
export interface CompetitorReport {
  id: string;
  period: string;
  text: string;
  /** 前の回から変わった事実の数 */
  changes: number;
  createdBy: string;
  createdAt: string;
}

/** 後ろで行う作業（探す・読む）。画面は状態を見て読み直す。 */
export interface CompetitorJob {
  id: string;
  kind: 'discover' | 'check';
  status: 'queued' | 'running' | 'done' | 'failed';
  /** 進み具合か、終わったときの一言 */
  message: string;
  requestedBy: string;
  createdAt: string;
  finishedAt: string | null;
}

/** 会社の設定 `competitors`（第36.14節）。 */
export interface CompetitorSettings {
  /** 使うか（既定は切り）。 */
  enabled: boolean;
  /**
   * 商圏の上書き（秘書や画面で「半径 2 km で」「全国で」と言われたとき）。`null` なら AI が決める。
   */
  areaOverride: { local: boolean; radiusM: number | null } | null;
}

/** 既定（切り）。 */
export const DEFAULT_COMPETITOR_SETTINGS: CompetitorSettings = { enabled: false, areaOverride: null };

/** 競合の分析の画面の全体。 */
export interface CompetitorOverview {
  profile: CompetitorProfile | null;
  competitors: Competitor[];
  /** 動いている作業（無ければ `null`） */
  job: CompetitorJob | null;
  /** 最後に終わった作業（失敗の理由を出すため） */
  lastJob: CompetitorJob | null;
  /** 地図（Places API）を使えるか。使えなければ理由 */
  mapNote: string;
}
