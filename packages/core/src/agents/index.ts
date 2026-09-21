import type { AgentDefinition } from '@m2office/shared';
import { AG04_KNOWLEDGE_QA } from './ag-04-knowledge-qa.js';
import { AG02_MINUTES } from './ag-02-minutes.js';

/**
 * 公式エージェントのカタログ。
 *
 * @remarks
 * 本来はデータベース上のレコードとして持ち、マーケットから導入する
 * （仕様書 第7.1節）。プロトタイプでは 2 つを同梱し、
 * カタログの解決経路だけ先に用意する。
 */
export const OFFICIAL_AGENTS: AgentDefinition[] = [AG04_KNOWLEDGE_QA, AG02_MINUTES];

/**
 * エージェント定義を ID と版で解決する。
 *
 * @param agentId エージェントの識別子
 * @param version 定義の版
 * @returns 見つかった定義。無ければ `undefined`
 */
export function resolveOfficialAgent(
  agentId: string,
  version: number,
): AgentDefinition | undefined {
  return OFFICIAL_AGENTS.find((a) => a.id === agentId && a.version === version);
}

export { AG04_KNOWLEDGE_QA, AG02_MINUTES };
