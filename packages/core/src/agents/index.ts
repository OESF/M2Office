/**
 * @file 公式エージェントのカタログと、ID・版から定義を引く関数。
 *
 * @see 仕様書 第9.5節 初期エージェントカタログ
 */

import { AGENT_FACE_COUNT, type AgentDefinition } from '@m2office/shared';
import { AG01_INBOX } from './ag-01-inbox.js';
import { AG02_MINUTES } from './ag-02-minutes.js';
import { AG03_SCHEDULING } from './ag-03-scheduling.js';
import { AG04_KNOWLEDGE_QA } from './ag-04-knowledge-qa.js';
import { AG05_WEEKLY_BRIEF } from './ag-05-weekly-brief.js';
import { SECRETARY_LOOKUP } from './secretary-lookup.js';
import { SECRETARY_PLAN_REPORT } from './secretary-plan-report.js';
import { SECRETARY_CALENDAR } from './secretary-calendar.js';
import { MORNING_BRIEF } from './morning-brief.js';
import { BASIC_AGENTS } from './basic.js';

/**
 * 公式エージェントのカタログ。
 *
 * @remarks
 * 本来はデータベース上のレコードとして持ち、マーケットから導入する
 * （仕様書 第9.5節）。現時点では Phase 1 の 5 つを同梱する。
 * 並びは画面のメニューの既定順であり、実装の順序（第9.5.7節）ではない。
 */
export const OFFICIAL_AGENTS: AgentDefinition[] = [
  AG04_KNOWLEDGE_QA, AG02_MINUTES, AG01_INBOX, AG03_SCHEDULING, AG05_WEEKLY_BRIEF, MORNING_BRIEF, ...BASIC_AGENTS, SECRETARY_LOOKUP, SECRETARY_CALENDAR, SECRETARY_PLAN_REPORT,
];

/** 秘書の段取りの報告に使う業務の ID（仕様書 第10.14節）。 */
export const PLAN_REPORT_AGENT_ID = SECRETARY_PLAN_REPORT.id;

/**
 * 秘書が、時間のかかる依頼を後ろへ回すときに使う業務の ID（仕様書 第10.11.4節）。
 *
 * @remarks 読むだけの業務であり、承認を経ずに秘書が自分で起こしてよい。
 */
export const LOOKUP_AGENT_ID = SECRETARY_LOOKUP.id;

/**
 * ダッシュボードに出す絵の番号を返す（1〜{@link AGENT_FACE_COUNT}。仕様書 第6.7.4.3節）。
 *
 * @param def エージェント定義
 * @returns 画像 `agent<NN>.png` の番号
 *
 * @remarks
 * **定義に `face` があれば、それをそのまま使う。**
 * 無いのは拡張機能で入った業務であり、ID から機械的に決める。
 * 決め方は場所と時によらない（同じ業務は、いつどの画面で見ても同じ絵になる）。
 * 他の業務と重なることはあるが、絵が出ないよりはよい。
 */
export function agentFace(def: Pick<AgentDefinition, 'id' | 'face'>): number {
  if (def.face !== undefined) return def.face;
  let h = 0;
  for (const ch of def.id) h = (h * 31 + ch.codePointAt(0)!) % 1_000_003;
  return (h % AGENT_FACE_COUNT) + 1;
}

/**
 * 一覧に並べる業務の絵の番号を、**重ならないように**決める（仕様書 第6.7.4.3節。第 0.269.0 版）。
 *
 * @param defs 並べる業務（並びの順に決める）
 * @returns 業務の ID ごとの絵の番号
 *
 * @remarks
 * 定義に `face` がある業務（M2Office に入っている業務）は、その番号を先に押さえる。
 * `face` が無い業務（拡張機能で入った業務）は、ID から決めた番号（{@link agentFace}）を使い、
 * ほかの業務と重なれば、次の空いている番号にずらす。50 枚を使い切ったときだけ重なりを許す。
 */
export function assignAgentFaces(defs: Pick<AgentDefinition, 'id' | 'face'>[]): Map<string, number> {
  const out = new Map<string, number>();
  const used = new Set<number>();
  for (const d of defs) {
    if (d.face === undefined) continue;
    out.set(d.id, d.face);
    used.add(d.face);
  }
  for (const d of defs) {
    if (d.face !== undefined) continue;
    let n = agentFace(d);
    for (let i = 0; i < AGENT_FACE_COUNT && used.has(n); i++) n = (n % AGENT_FACE_COUNT) + 1;
    out.set(d.id, n);
    used.add(n);
  }
  return out;
}

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

export { AG01_INBOX, AG02_MINUTES, AG03_SCHEDULING, AG04_KNOWLEDGE_QA, AG05_WEEKLY_BRIEF, SECRETARY_LOOKUP, SECRETARY_CALENDAR, SECRETARY_PLAN_REPORT, MORNING_BRIEF };

/**
 * 公式エージェントの標準所要時間（分）の既定値。手作業なら 1 件に何分かかるか。
 *
 * @remarks
 * 削減時間の推計に使う（仕様書 第6.7.12節）。過大に見せないよう控えめに置き、
 * 会社ごとに管理者が変えられる。値は推奨であり、要確認である（Q-66）。
 */
export const DEFAULT_STANDARD_MINUTES: Record<string, number> = {
  'inbox-triage': 15,
  minutes: 30,
  scheduling: 15,
  'knowledge-qa': 10,
  'calendar-register': 5,
  'morning-brief': 10,
  'meeting-prep': 15,
  'reply-followup': 10,
  'document-draft': 20,
  'sheet-builder': 15,
  slides: 60,
  'weekly-brief': 20,
  // 秘書が引き受ける業務（第 0.315.0 版）
  'secretary-lookup': 10,
  'secretary-plan-report': 5,
  // 内蔵の拡張機能の業務（第 0.315.0 版。控えめに置き、会社が実態に合わせて変える）
  'business-cards:import': 3,
  'business-cards:update': 3,
  'business-cards:bulk-mail': 30,
  'inventory:record': 3,
  'inventory:slip': 10,
  'inventory:order': 10,
  'web-columns:draft': 120,
  'web-columns:place': 15,
  'web-columns:cover': 20,
  'web-columns:rules': 5,
  'web-columns:signage': 30,
  'web-columns:signage-publish': 5,
  'inquiries:record': 5,
  'inquiries:lookup': 10,
  'inquiries:reply-draft': 15,
  'inquiries:reply-send': 5,
  'competitors:find': 60,
  'competitors:analyze': 45,
  'announcements:draft': 30,
  'announcements:publish': 20,
  'web-review:ask': 30,
  'web-review:request': 15,
  'contracts:ledger': 10,
  'subsidies:guide': 60,
  'members:desk': 5,
  'members:line-send': 20,
  'print-designs:desk': 60,
  // 同梱の拡張機能の業務
  'jp.m2office.legal.contract-review:contract-review': 45,
  'jp.m2office.samples.research-slides:research-slides': 60,
  'jp.m2office.samples.deepwiki-research:research': 20,
};

/**
 * その会社でのエージェントの標準所要時間（分）を返す。
 *
 * @param minutesPerRun 会社の設定（`TenantSettings.effect.minutesPerRun`）
 * @param agentId 対象のエージェント
 * @returns 会社の設定、無ければ公式の既定値、それも無ければ 0
 */
export function standardMinutes(minutesPerRun: Record<string, number>, agentId: string): number {
  return minutesPerRun[agentId] ?? DEFAULT_STANDARD_MINUTES[agentId] ?? 0;
}

/**
 * ステップの表示名を返す（仕様書 第9.2.4節）。
 *
 * @remarks 省略時は、承認は「承認」、それ以外はステップ ID。操作の確認は「確認」。
 */
export function stepLabel(step: { id: string; type: 'agent' | 'approval'; label?: string }): string {
  if (step.label) return step.label;
  return step.type === 'approval' ? '承認' : step.id;
}
