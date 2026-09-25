/**
 * @file 承認の画面に出すものを組み立てる（仕様書 第9.3.3節、ADR-0023）。
 *
 * 承認する人が、何を承認するのかを読んで判断できるようにする。出すのは 3 つ。
 * 確認すること（定義の `present`）・判断するもの（前の承認からここまでの文と成果物）・承認すると行うこと。
 */

import type { AgentDefinition, AgentStep, ApprovalStep, Artifact, RunStep } from '@m2office/shared';
import type { ToolRegistry } from '../tools/registry.js';
import { stepLabel } from '../agents/index.js';
import { describeCall, type DescribeContext } from './describe-call.js';

/** 段の文を、この字数で切る。 */
const TEXT_MAX = 4000;
/** 成果物の本文を、この字数で切る。 */
const ARTIFACT_MAX = 6000;

/** 道具の説明と成果物の題名を引けるようにする。 */
export function describeContext(registry: ToolRegistry, artifacts: Artifact[]): DescribeContext {
  return {
    helpText: (name) => registry.get(name)?.helpText,
    artifactTitle: (id) => artifacts.find((a) => a.id === id)?.title,
  };
}

/**
 * 段の文や成果物の中の見出しを、承認の画面の見出しより小さくする。
 *
 * @remarks 議事録の「## 決定事項」が、承認の画面の「## 判断するもの」と同じ大きさで並ぶと、どこまでが議事録か分からない。
 */
const demote = (text: string) => text.replace(/^#{1,6}\s+/gm, '#### ');

const cut = (text: string, max: number) =>
  (text.length > max ? `${text.slice(0, max)}\n\n…（長いため、ここで切りました。続きは実行の詳細で見られます）` : text);

/**
 * 承認の画面に出す文（Markdown）を組み立てる。
 *
 * @returns **1 行目は定義の `present`**。一覧・ダッシュボード・通知は 1 行目だけを出すため、中身はそこへ漏れない
 */
export function composeApprovalPresent(p: {
  def: AgentDefinition;
  gate: ApprovalStep;
  /** この承認の段の位置（定義の中の番号）。 */
  gateSeq: number;
  /** ここまでに記録された段。 */
  steps: RunStep[];
  /** この実行の成果物。 */
  artifacts: Artifact[];
  /** 承認の前に組み立てた、承認の直後の段と、記録した操作。 */
  plan: { step: AgentStep; calls: { name: string; args: Record<string, unknown> }[] } | null;
  registry: ToolRegistry;
}): string {
  const { def, gate, gateSeq, steps, artifacts, plan, registry } = p;
  const out: string[] = [gate.present, ''];

  // 前の承認（無ければ実行の始め）を探す。そこから先に作られたものが、この承認で判断するもの
  const prevGate = [...steps].reverse().find((s) => s.kind === 'approval' && s.seq < gateSeq && !s.stepId.endsWith(':confirm'));
  const since = prevGate?.seq ?? -1;
  const shownBefore = new Set(((prevGate?.input ?? {}) as { artifactIds?: string[] }).artifactIds ?? []);

  const material: string[] = [];
  for (const s of steps) {
    if (s.kind !== 'agent' || s.status !== 'succeeded' || s.seq <= since || s.seq >= gateSeq) continue;
    const text = ((s.output ?? {}) as { text?: string }).text?.trim();
    if (!text) continue;
    const def0 = def.steps.find((d) => d.id === s.stepId);
    material.push(`### ${def0 ? stepLabel(def0) : s.stepId}`, '', demote(cut(text, TEXT_MAX)), '');
  }
  for (const a of artifacts.filter((x) => !shownBefore.has(x.id))) {
    material.push(`### 成果物「${a.title}」`, '', demote(cut(a.body, ARTIFACT_MAX)), '');
  }
  out.push('## 判断するもの', '');
  out.push(...(material.length > 0 ? material : ['（この承認までに作られた文や成果物はありません）', '']));

  out.push('## 承認すると', '');
  if (!plan) {
    out.push('この業務の次の段へ進みます。', '');
  } else if (plan.calls.length === 0) {
    out.push(`「${stepLabel(plan.step)}」に進みます。社内への書き込みや、社外への送信は行いません。`, '');
  } else {
    const ctx = describeContext(registry, artifacts);
    out.push(`「${stepLabel(plan.step)}」に進み、**次のことをこのとおりに行います**（承認のあとで内容を変えることはありません）。`, '');
    // 1 行で済むものは箇条書きに、本文を伴うもの（投稿・メール）は、本文の改行を保って独立したまとまりにする
    let listOpen = false;
    for (const c of plan.calls) {
      const d = describeCall(c, ctx);
      if (!d.includes('\n')) { out.push(`- ${d}`); listOpen = true; continue; }
      if (listOpen) { out.push(''); listOpen = false; }
      out.push(d, '');
    }
    if (listOpen) out.push('');
  }
  out.push('却下すると、ここで止まり、上のことは行いません。');
  return out.join('\n').trim();
}
