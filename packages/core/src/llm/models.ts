/**
 * @file 使うモデルの既定と、モデルごとの値段。費用の計算もここで行う。
 *
 * モデル名はコードに直書きせず設定で持つ（仕様書 第20.2節）。ここに置くのは**既定値**であり、
 * 会社ごとの上書き（管理者ページ）と環境変数が優先される。
 *
 * @see 仕様書 第20.2節 LLM 抽象化層、第20.2.2節 既定のモデルの選び方
 */

import type { Logger } from '../log/logger.js';
import type { GeminiModels } from '../secrets/tenant-ai.js';
import type { ModelTier } from './provider.js';

/**
 * 1 モデルあたりの値段（100 万トークンあたりの米ドル、文章の場合）。
 *
 * @remarks
 * 出どころ: https://ai.google.dev/gemini-api/docs/pricing （2026-09-24 に確認、有料枠）。
 * **音声・画像の入力は単価が違う。** ここでは文章として概算する。
 */
export interface ModelPrice {
  /** 入力 100 万トークンあたりの米ドル。 */
  inputUsd: number;
  /** 出力 100 万トークンあたりの米ドル。 */
  outputUsd: number;
}

/**
 * モデルごとの値段（2026-09-24 に Google の料金表で確認）。
 *
 * @remarks
 * **`gemini-3.6/3.7/3.8-flash` は 2027-01-01 に単価が 2 倍になる**（入力 $1.50・出力 $7.50）。
 * その日が近づいたら、この表と既定の見直しが要る。
 */
export const MODEL_PRICES: Record<string, ModelPrice> = {
  // 軽いモデル。安い順
  'gemini-2.5-flash-lite': { inputUsd: 0.10, outputUsd: 0.40 },
  'gemini-3.1-flash-lite': { inputUsd: 0.25, outputUsd: 1.50 },
  'gemini-2.5-flash': { inputUsd: 0.30, outputUsd: 2.50 },
  'gemini-3.5-flash-lite': { inputUsd: 0.30, outputUsd: 2.50 },
  // 標準のモデル
  'gemini-3.6-flash': { inputUsd: 0.75, outputUsd: 3.75 },
  'gemini-3.7-flash': { inputUsd: 0.75, outputUsd: 3.75 },
  'gemini-3.8-flash': { inputUsd: 0.75, outputUsd: 3.75 },
  'gemini-3.5-flash': { inputUsd: 1.50, outputUsd: 9.00 },
  // 重いモデル
  'gemini-2.5-pro': { inputUsd: 1.25, outputUsd: 10.00 },
  'gemini-3.1-pro-preview': { inputUsd: 2.00, outputUsd: 12.00 },
  // 埋め込み（知識の意味の検索。第11.7.6.1節）。2026-10-07 に料金の一覧（第三者のもの）で確認。Google の料金表で確かめ直す
  'gemini-embedding-2': { inputUsd: 0.20, outputUsd: 0 },
};

/**
 * 値段の分からないモデルに使う単価。
 *
 * @remarks
 * **推測ではなく、上限として置く。** 表にあるうちで最も高いものに合わせ、
 * 費用を少なく見せないようにする。表に足せば正しい値になる。
 */
export const UNKNOWN_MODEL_PRICE: ModelPrice = { inputUsd: 2.00, outputUsd: 12.00 };

/**
 * 役割ごとの既定のモデル（仕様書 第20.2.2節）。
 *
 * @remarks
 * **安いほうから選ぶ。** 難しくない仕事に高いモデルを使わない。
 * 選んだ理由:
 *
 * | 役割 | 既定 | 入力/出力（$/100万） | 理由 |
 * |---|---|---|---|
 * | 高速 | `gemini-3.5-flash-lite` | 0.30 / 2.50 | 振り分けと分類。判断が短い |
 * | 標準 | `gemini-3.5-flash-lite` | 0.30 / 2.50 | 業務のステップと秘書の対話。**まず安いほうで試す** |
 * | 高性能 | `gemini-3.8-flash` | 0.75 / 3.75 | 難しい計画や長文の分析。いまは使っていない |
 *
 * `gemini-2.5-flash-lite` は 0.10 / 0.40 でさらに安いが、**新しいプロジェクトからは使えない**
 * （Google の廃止予定の頁に「過去の利用者に限る」とある。2026-09-24 に確認）。使えるなら上書きしてよい。
 */
export const DEFAULT_MODELS: Record<ModelTier, string> = {
  fast: 'gemini-3.5-flash-lite',
  standard: 'gemini-3.5-flash-lite',
  advanced: 'gemini-3.8-flash',
};

/**
 * 名前が「そのときの最新」を指す別名かどうか。
 *
 * @remarks
 * `gemini-flash-latest` のような別名は、**新しい版が出るたび中身が入れ替わる**。
 * 入れ替わった先が試験中の版や高い版であることもある（Google の説明。2026-09-24 に確認）。
 * 既定には使わない。設定されていたら、起動のときに知らせる。
 */
export function isHotSwapAlias(model: string): boolean {
  return /-latest$/.test(model.trim());
}

/**
 * 米ドルを円に直すときの相場。
 *
 * @remarks
 * **概算である。** 実際の請求は Google の為替で決まる。`USD_JPY` で変えられる。
 */
export function usdJpy(env: Record<string, string | undefined> = process.env): number {
  const v = Number(env['USD_JPY']);
  return Number.isFinite(v) && v > 0 ? v : 155;
}

/**
 * 1 回の呼び出しの概算費用（円）。
 *
 * @param model 実際に使ったモデル名。分からなければ空文字
 * @param inputTokens 入力のトークン数
 * @param outputTokens 出力のトークン数
 *
 * @remarks
 * 入力と出力は単価が違う（出力は 5〜10 倍）。**まとめて数えると実態から外れる。**
 * 表に無いモデルは、費用を少なく見せないよう最も高い単価で見積もる。
 */
export function costJpy(model: string, inputTokens: number, outputTokens: number): number {
  const price = MODEL_PRICES[model.replace(/^models\//, '')] ?? UNKNOWN_MODEL_PRICE;
  const usd = (inputTokens * price.inputUsd + outputTokens * price.outputUsd) / 1_000_000;
  // 小数 4 桁まで残す。1 回の呼び出しは 0.01 円に満たないことがある
  return Math.round(usd * usdJpy() * 10_000) / 10_000;
}

/**
 * 役割ごとのモデル名を、環境変数と既定から決める（仕様書 第20.2.2節）。
 *
 * @remarks
 * **既定は安いほうから選ぶ**（`DEFAULT_MODELS`）。会社ごとの上書きは管理者ページで行う。
 * 「そのときの最新」を指す別名（`…-latest`）は、中身が入れ替わって高い版や試験中の版に
 * なることがあるため既定にしない。設定されていたら起動のときに知らせる。
 */
export function defaultGeminiModels(): GeminiModels {
  const standard = process.env['MODEL_STANDARD'] ?? DEFAULT_MODELS.standard;
  return {
    fast: process.env['MODEL_FAST'] ?? DEFAULT_MODELS.fast,
    standard,
    advanced: process.env['MODEL_ADVANCED'] ?? DEFAULT_MODELS.advanced,
    research: process.env['MODEL_RESEARCH'] ?? standard,
    live: process.env['MODEL_LIVE'] ?? DEFAULT_LIVE_MODEL,
    // 退避先（仕様書 第20.2.5節）。既定は置かない（設定にあるほかの役割のモデルに退避する）
    fallback: process.env['MODEL_FALLBACK']?.trim() ?? '',
  };
}

/**
 * 画像を作る既定のモデル（Nano Banana 2.1。コラムのカバーとサイネージの挿絵・販促物の画像。仕様書 第32.18.2節・第41.17節）。
 *
 * @remarks
 * 2026-10-06 に一般提供になった。それまでの `gemini-3.1-flash-image`（Nano Banana 2）は 2026-10-29 に終了する
 * （https://ai.google.dev/gemini-api/docs/changelog）。次に替わるときは `MODEL_IMAGE` で切り替えられる
 */
export const DEFAULT_IMAGE_MODEL = 'gemini-nano-banana-2.1';

/** 画像を作るモデル（`MODEL_IMAGE` があればそれ、無ければ既定）。 */
export function imageModel(): string {
  return process.env['MODEL_IMAGE']?.trim() || DEFAULT_IMAGE_MODEL;
}

/** 音声の既定のモデル。B-3 で接続を確かめたもの（仕様書 第24.4.2節）。 */
export const DEFAULT_LIVE_MODEL = 'gemini-3.1-flash-live-preview';

/**
 * 「そのときの最新」を指す別名が設定されていたら知らせる。
 *
 * @remarks
 * 止めはしない。**意図して選んだのかどうかが分かるようにする**だけである。
 */
export function warnHotSwapModels(models: GeminiModels, log: Pick<Logger, 'warn'>): void {
  const swapping = Object.entries(models).filter(([, v]) => isHotSwapAlias(v));
  if (swapping.length === 0) return;
  log.warn(
    'モデル名に「そのときの最新」を指す別名が使われています。新しい版が出ると中身が入れ替わり、'
    + '高い版や試験中の版になることがあります（仕様書 第20.2.2節）',
    Object.fromEntries(swapping),
  );
}
