/**
 * @file ツールの型と、エージェントが呼べるツールの登録簿。
 *
 * @see 仕様書 第9.4節 ツールと承認の対応
 */

import type { RiskLevel } from '@m2office/shared';
import type { Repository } from '../repository/types.js';
import type { WorkspaceConnector } from '../connectors/types.js';
import type { FileStore } from '../files/store.js';

/** ツール呼び出しの文脈。テナント境界と実行の同一性を持ち回る。 */
export interface ToolContext {
  tenantId: string;
  /** 実行を依頼した利用者。ツールはこの利用者の権限で動く（不変則 I-9）。 */
  userId: string;
  runId: string;
  /** 実行中のエージェントが属する権限区画。区画外は `null`。 */
  compartment: string | null;
  repo: Repository;
  /** メール・予定・タスク・チャットへの接続口。Google を直接呼ばない。 */
  connector: WorkspaceConnector;
  /** ファイルの中身の置き場。 */
  files: FileStore;
}

/**
 * ツールの定義。
 *
 * @remarks
 * 危険度は基盤側が持つ。エージェント定義から上書きできない
 * （仕様書 第7.2.2節、第7.4節）。
 */
export interface Tool {
  name: string;
  /** 危険度。承認の要否を決める。 */
  risk: RiskLevel;
  description: string;
  invoke(args: Record<string, unknown>, ctx: ToolContext): Promise<unknown>;
}

/**
 * 利用できるツールの登録簿。
 *
 * @remarks
 * エージェント定義の `tools` に列挙されたものだけが呼び出せる（最小権限）。
 * 登録簿に無いツール名は、定義が要求していても呼び出さない。
 */
export class ToolRegistry {
  private readonly tools = new Map<string, Tool>();

  register(tool: Tool): void {
    this.tools.set(tool.name, tool);
  }

  get(name: string): Tool | undefined {
    return this.tools.get(name);
  }

  /** 定義が許可したツールのうち、登録済みのものだけを返す。 */
  allowed(names: string[]): Tool[] {
    return names.map((n) => this.tools.get(n)).filter((t): t is Tool => !!t);
  }
}
