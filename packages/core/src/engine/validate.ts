/**
 * @file エージェント定義が基盤の規則（承認ゲート・ツール・承認者の指定）を満たすかを検証する。
 *
 * 導入時と実行開始時の両方で呼ぶ。定義側の記述で規則を緩めることはできない。
 *
 * @see 仕様書 第9.2節 エージェント定義のスキーマ
 * @see 仕様書 第9.4節 ツールと承認の対応
 */

import { alwaysRequiresApproval, type AgentDefinition } from '@m2office/shared';
import { DefinitionInvalidError } from './errors.js';
import type { ToolRegistry } from '../tools/registry.js';

/**
 * エージェント定義が基盤の規則を満たすか検証する。
 *
 * 導入時と実行開始時の両方で呼ぶ。定義側の記述で規則を緩めることはできない。
 *
 * @param def 検証するエージェント定義
 * @param registry ツールの登録簿
 * @throws {DefinitionInvalidError} 規則に反している場合
 *
 * @remarks
 * 最も重要なのは 2 点目である。危険度 `external-send` 以上のツールを
 * 使う定義に承認ゲートが無ければ、導入も実行も認めない（仕様書 第7.4節）。
 *
 * @see 仕様書 第7.4節 ツールと承認の対応
 * @see 仕様書 第10.5節 審査の観点
 */
export function validateDefinition(def: AgentDefinition, registry: ToolRegistry): void {
  if (def.schemaVersion !== 1) {
    throw new DefinitionInvalidError(
      `対応していない schemaVersion です: ${def.schemaVersion}`,
    );
  }

  // 1. 登録簿に無いツールを要求していないか
  const unknown = def.tools.filter((t) => !registry.get(t));
  if (unknown.length > 0) {
    throw new DefinitionInvalidError(`未登録のツールを要求しています: ${unknown.join(', ')}`);
  }

  // 2. 危険度に見合う承認ゲートがあるか
  const risky = registry.allowed(def.tools).filter((t) => alwaysRequiresApproval(t.risk));
  const hasApproval = def.steps.some((s) => s.type === 'approval');
  if (risky.length > 0 && !hasApproval) {
    throw new DefinitionInvalidError(
      `承認ゲートが必要です。対象のツール: ${risky.map((t) => t.name).join(', ')}`,
    );
  }

  // 3. ステップ ID の重複と、restartFrom の参照先
  const ids = new Set<string>();
  for (const step of def.steps) {
    if (ids.has(step.id)) {
      throw new DefinitionInvalidError(`ステップ ID が重複しています: ${step.id}`);
    }
    ids.add(step.id);
  }
  for (const step of def.steps) {
    if (step.type === 'approval' && typeof step.onReject === 'object') {
      if (!ids.has(step.onReject.restartFrom)) {
        throw new DefinitionInvalidError(
          `restartFrom の参照先が存在しません: ${step.onReject.restartFrom}`,
        );
      }
    }
  }

  // 4. 承認者の指定。ロールで判断する承認には、ロールが 1 つ以上要る
  for (const step of def.steps) {
    if (step.type !== 'approval') continue;
    const mode = step.approver ?? 'role';
    if (mode !== 'role' && mode !== 'requester') {
      throw new DefinitionInvalidError(`approver の値が不正です: ${String(mode)}`);
    }
    if (mode === 'role' && step.approverRole.length === 0) {
      throw new DefinitionInvalidError(`承認できるロールが指定されていません: ${step.id}`);
    }
  }

  if (def.steps.length === 0) {
    throw new DefinitionInvalidError('ステップが 1 つもありません');
  }
}
