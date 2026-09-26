/**
 * @file 業務のヘルプを、エージェント定義から組み立てる。
 *
 * 入力・進み方・承認の場所・「すること／しないこと」は定義とツールから機械的に作り、
 * 人が書くのは定義の `help` にある補足だけにする。業務が増えてもヘルプの書き漏れが起きない。
 *
 * @see 仕様書 第6.10.5節 業務のヘルプは定義から作る
 */

import { alwaysRequiresApproval, type AgentDefinition } from '@m2office/shared';
import type { ToolRegistry } from '../tools/registry.js';
import { stepLabel } from '../agents/index.js';

/** 画面とヘルプセンターに出す、業務の説明。 */
export interface AgentHelpView {
  agentId: string;
  name: string;
  summary: string;
  /** 入力するもの。 */
  inputs: { key: string; title: string; required: boolean }[];
  /** 進み方（ステップの表示名）。 */
  flow: string[];
  /** 承認が入る場所と、判断する人。 */
  approvals: { step: string; who: string }[];
  /** この業務がすること（使うツールの説明）。 */
  does: string[];
  examples: { title: string; input: Record<string, unknown> }[];
  notes: string[];
  faq: { q: string; a: string }[];
  /**
   * 書き手が書いた利用者向けの説明（スキルの `HELP.md`。仕様書 第12.12.4節）。
   * あれば説明の本文にする。スキルの業務では `does`（道具の説明）と `flow`（組み立てた段）を空にする
   */
  body?: string;
}

const ROLE_NAMES: Record<string, string> = { admin: '管理者', approver: '承認者', member: '一般の利用者' };

/**
 * エージェント定義から業務のヘルプを組み立てる。
 *
 * @param def エージェント定義
 * @param registry ツールの登録簿。ツールの「すること」を引く
 *
 * @remarks
 * どの業務にも同じになる決まり文句（「社外へ送ることはありません」など）は載せない（仕様書 第6.10.5節、第 0.130.0 版）
 */
export function buildAgentHelp(
  def: AgentDefinition,
  registry: ToolRegistry,
): AgentHelpView {
  const tools = registry.allowed(def.tools);
  const props = (def.inputs['properties'] ?? {}) as Record<string, { title?: string }>;
  const required = new Set((def.inputs['required'] ?? []) as string[]);

  const approvals = def.steps
    .filter((s) => s.type === 'approval')
    .map((s) => ({
      step: stepLabel(s),
      who: s.type === 'approval' && s.approver === 'requester'
        ? '依頼したあなた'
        : (s.type === 'approval' ? s.approverRole : []).map((r) => ROLE_NAMES[r] ?? r).join('・'),
    }));

  const examples = def.help?.examples
    ?? (def.evals ?? []).map((e) => ({ title: e.name, input: e.input }));

  return {
    agentId: def.id,
    name: def.name,
    summary: def.help?.summary ?? def.description,
    inputs: Object.entries(props).map(([key, p]) => ({ key, title: p.title ?? key, required: required.has(key) })),
    // スキルの業務では、組み立てた段の名前と道具の説明を出さない（仕組みを見せるだけ。第12.12.4節）
    flow: def.skill ? [] : def.steps.map((s) => stepLabel(s)),
    approvals,
    does: def.skill ? [] : [...new Set(tools.map((t) => t.helpText))],
    examples,
    notes: def.help?.notes ?? [],
    faq: def.help?.faq ?? [],
    ...(def.help?.body ? { body: def.help.body } : {}),
  };
}

/**
 * 業務のヘルプを、ヘルプセンターの記事の本文（Markdown）にする。
 *
 * @remarks 記事の ID は `agent-<エージェント ID>` とする。
 */
export function agentHelpMarkdown(v: AgentHelpView): string {
  const lines = [v.summary, ''];
  // 書き手の説明（HELP.md）があれば、それを本文にする。見出しは記事の見出しより小さくする
  if (v.body) lines.push(v.body.replace(/^#\s+.*\n+/, '').replace(/^(#{1,5})\s/gm, '#$1 '), '');
  if (v.does.length > 0) lines.push('## この業務がすること', ...v.does.map((d) => `- ${d}`), '');
  if (v.flow.length > 0) lines.push('## 進み方', v.flow.join(' → '), '');
  if (v.approvals.length > 0) {
    lines.push('## 承認が入る場所', ...v.approvals.map((a) => `- **${a.step}**: ${a.who}が判断します`), '');
  }
  if (v.inputs.length > 0) {
    lines.push('## 入力するもの', ...v.inputs.map((i) => `- ${i.title}${i.required ? '（必須）' : ''}`), '');
  }
  if (v.notes.length > 0) lines.push('## 注意点', ...v.notes.map((n) => `- ${n}`), '');
  if (v.faq.length > 0) {
    lines.push('## よくある質問');
    for (const f of v.faq) lines.push(`**${f.q}**`, '', f.a, '');
  }
  return lines.join('\n').trim();
}
