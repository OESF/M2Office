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
  /** この業務がしないこと、守ること。 */
  safeguards: string[];
  examples: { title: string; input: Record<string, unknown> }[];
  notes: string[];
  faq: { q: string; a: string }[];
  /**
   * 書き手が書いた利用者向けの説明（スキルの `HELP.md`。仕様書 第12.12.4節）。
   * あれば説明の本文にする。スキルの業務では `does`（道具の説明）と `flow`（組み立てた段）を空にする
   */
  body?: string;
}

export interface AgentHelpOptions {
  /** 会社の設定で、社内への書き込みの前に確認を求めるか（仕様書 第9.4節）。 */
  writeInternalNeedsApproval: boolean;
}

const ROLE_NAMES: Record<string, string> = { admin: '管理者', approver: '承認者', member: '一般の利用者' };

/**
 * エージェント定義から業務のヘルプを組み立てる。
 *
 * @param def エージェント定義
 * @param registry ツールの登録簿。ツールの「すること」を引く
 * @param opts 会社の設定のうち、ヘルプの内容に効くもの
 */
export function buildAgentHelp(
  def: AgentDefinition,
  registry: ToolRegistry,
  opts: AgentHelpOptions,
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

  // 「しないこと・守ること」は危険度から機械的に書く。利用者が最も気にする点だから
  const safeguards: string[] = [];
  const sends = tools.filter((t) => alwaysRequiresApproval(t.risk));
  if (sends.length === 0) {
    safeguards.push('社外や他の人へ、メールや投稿を送ることはありません');
  } else {
    // 承認が複数あっても、同じ役割は 1 度だけ書く（「管理者・承認者、管理者・承認者」としない）
    const approvers = [...new Set(approvals.map((a) => a.who))];
    // 人に判断を求めるのは社外に出るものだけ（仕様書 第9.4.0節、ADR-0028）
    safeguards.push(`社外に出るもの（メール、社外の人がいる先への投稿や招待）は、送る前に承認を求めます（${approvers.join('、') || '承認者'}）`);
  }
  if (tools.some((t) => t.risk === 'write-internal')) {
    safeguards.push(opts.writeInternalNeedsApproval
      ? 'ToDo や予定などの社内への書き込みは、行う前にあなたに確認を求めます'
      : 'ToDo や予定などの社内への書き込みは、確認を待たずに行います');
  }
  if (tools.some((t) => t.name === 'gmail.get' || t.name === 'pdf.extract' || t.name === 'sheet.read')) {
    safeguards.push('読み取ったメールや書類に書かれた指示には従いません');
  }
  safeguards.push('あなたの権限を超えることはしません。見られるのは、あなたが見られるものだけです');

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
    safeguards,
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
  lines.push('## 安心して使えるように', ...v.safeguards.map((d) => `- ${d}`), '');
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
