/**
 * @file 公式エージェントのカタログと、ID・版から定義を引く関数。
 *
 * @see 仕様書 第9.5節 初期エージェントカタログ
 */

import type { AgentDefinition } from '@m2office/shared';
import { AG01_INBOX } from './ag-01-inbox.js';
import { AG02_MINUTES } from './ag-02-minutes.js';
import { AG03_SCHEDULING } from './ag-03-scheduling.js';
import { AG04_KNOWLEDGE_QA } from './ag-04-knowledge-qa.js';
import { AG05_WEEKLY_BRIEF } from './ag-05-weekly-brief.js';

/**
 * 公式エージェントのカタログ。
 *
 * @remarks
 * 本来はデータベース上のレコードとして持ち、マーケットから導入する
 * （仕様書 第9.5節）。現時点では Phase 1 の 5 つを同梱する。
 * 並びは画面のメニューの既定順であり、実装の順序（第9.5.7節）ではない。
 */
export const OFFICIAL_AGENTS: AgentDefinition[] = [
  AG04_KNOWLEDGE_QA, AG02_MINUTES, AG01_INBOX, AG03_SCHEDULING, AG05_WEEKLY_BRIEF,
];

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

export { AG01_INBOX, AG02_MINUTES, AG03_SCHEDULING, AG04_KNOWLEDGE_QA, AG05_WEEKLY_BRIEF };
