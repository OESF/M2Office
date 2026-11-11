/**
 * @file API の入口から、直しを秘書の学びに渡す（仕様書 第11.13.7節、ADR-0134。秘書の成長 段 4）。
 *
 * 作り直しの頼み（スライド・文書・印刷物・メールの下書き）と承認の差し戻しを、待たずに学びに渡す。
 * 学べなくても（推論が使えない・失敗した）、本人の操作の答えは止めない。
 */

import { learnFromCorrection, type CorrectionInput } from '@m2office/core';
import type { AppDeps } from './context.js';

/**
 * 直しを 1 つ学びに渡す（待たない）。数え、次からもそうしてほしい直しなら、業務ごとの好みとして覚える。
 *
 * @remarks 直しの文はデータとして推論に渡す（不変則 I-6）。本人の好みは本人だけのもの（不変則 I-10）
 */
export function passCorrection(deps: Pick<AppDeps, 'repo' | 'ai'>, input: CorrectionInput): void {
  if (!input.correction.trim()) return;
  void learnFromCorrection({ repo: deps.repo, llmFor: (tenantId) => deps.ai.llmFor(tenantId) }, input).catch(() => undefined);
}
