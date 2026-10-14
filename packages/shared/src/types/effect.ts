/**
 * @file 効果の欄と効果のレポートの型（仕様書 第6.7.13節）。
 *
 * 推計の削減時間と AI の費用を、期間ごとにプログラムが計算する（`EffectFigures`）。レポートは、その数字と AI が書いた文（`EffectReportBody`）を月ごとに 1 つ持つ。
 * 人ごとの数字と、削減時間をお金に換えた値は持たない。
 */

/** 欄の期間。今月（ここまで）・先月・導入から。 */
export type EffectPeriod = 'thisMonth' | 'lastMonth' | 'all';

/** 効果のレポートを自動で作る日（毎月の日。先月の分を作る）。 */
export const EFFECT_REPORT_DAY = 1;

/** 効果のレポートを自動で作る時（日本時間）。 */
export const EFFECT_REPORT_HOUR = 7;

/** 効果のレポートを残す月数（前の年の同じ月と比べられるように）。 */
export const EFFECT_REPORT_KEEP_MONTHS = 25;

/** 業務ごとの貢献。 */
export interface EffectAgentFigure {
  agentId: string;
  /** 業務の名前（画面に出す言葉） */
  name: string;
  /** 完了した件数 */
  completed: number;
  /** 推計の削減時間（分） */
  savedMinutes: number;
  /** いまの標準所要時間（分。1 件あたり） */
  minutesPerRun: number;
  /** 会社で標準所要時間を決めたか（決めていなければ公式の既定値） */
  customized: boolean;
  /** 前の期間の完了した件数（前の期間が無ければ `null`） */
  previousCompleted: number | null;
}

/** 用途ごとの AI の費用。 */
export interface EffectPurposeFigure {
  purpose: string;
  /** 用途の名前（画面に出す言葉） */
  label: string;
  costJpy: number;
  calls: number;
}

/** 前の期間の数字（今月と先月だけ）。 */
export interface EffectPrevious {
  label: string;
  completed: number;
  savedMinutes: number;
  aiCostJpy: number;
}

/** 期間の効果の数字（すべてプログラムが計算する）。 */
export interface EffectFigures {
  period: EffectPeriod;
  /** 期間の名前（「2026 年 10 月（14 日まで）」など） */
  label: string;
  /** 期間の始めの日（日本時間。`YYYY-MM-DD`） */
  from: string;
  /** 期間の終わりの日（日本時間。この日を含む） */
  to: string;
  /** 完了した業務の件数 */
  completed: number;
  /** 推計の削減時間（分） */
  savedMinutes: number;
  /** AI の費用（すべての利用の合計。円） */
  aiCostJpy: number;
  /** 削減 1 時間あたりの AI の費用（円）。削減時間が 0 か、AI の利用の記録が無ければ `null` */
  costPerSavedHourJpy: number | null;
  /** 業務ごとの貢献（削減時間の多い順） */
  byAgent: EffectAgentFigure[];
  /** 用途ごとの AI の費用（多い順） */
  byPurpose: EffectPurposeFigure[];
  /** 前の期間（導入からなら `null`） */
  previous: EffectPrevious | null;
  /** 使える業務のうち、期間に一度も完了しなかったもの（名前） */
  unusedAgents: string[];
}

/** AI が書いた（推論が使えなければ決まった形の）レポートの文。 */
export interface EffectReportBody {
  /** 要点（3 行まで） */
  summary: string[];
  /** 時間の節約 */
  time: string;
  /** AI の費用 */
  cost: string;
  /** 費用と効果の比べ */
  balance: string;
  /** 気づき */
  notices: string[];
  /** 次の月にやるとよいこと */
  next: string[];
}

/** 効果のレポートの作り方（毎月の自動か、管理者が手で）。 */
export type EffectReportKind = 'monthly' | 'manual';

/** 効果のレポート。 */
export interface EffectReport {
  id: string;
  /** 対象の月（`YYYY-MM`） */
  month: string;
  kind: EffectReportKind;
  figures: EffectFigures;
  body: EffectReportBody;
  createdBy: string | null;
  createdAt: string;
}

/** 効果のレポートの一覧の 1 行。 */
export interface EffectReportBrief {
  id: string;
  month: string;
  kind: EffectReportKind;
  /** 要点の 1 行目 */
  headline: string;
  createdAt: string;
}
