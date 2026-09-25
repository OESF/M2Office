/**
 * @file 承認の画面に出すものを組み立てる（仕様書 第9.3.3節、ADR-0023）。
 *
 * 承認する人が、何を承認するのかを読んで判断できるようにする。出すのは 3 つ。
 * 確認すること（定義の `present`）・判断するもの（前の承認からここまでの文と成果物）・承認すると行うこと。
 */

import type { AgentDefinition, AgentStep, ApprovalStep, Artifact, RunStep } from '@m2office/shared';
import type { ToolRegistry } from '../tools/registry.js';
import { stepLabel } from '../agents/index.js';
import { describeCall, describeDone, type DescribeContext } from './describe-call.js';

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

/** 実行・成果物などの ID（UUID）。`g` を付けたもの（置き換え用）と付けないもの（判定用）を分ける。 */
const UUID_SOURCE = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const UUID = new RegExp(UUID_SOURCE, 'gi');
const IS_UUID = new RegExp(`^\\s*${UUID_SOURCE}\\s*$`, 'i');
/** Google のファイルなどの ID。英数字と `-`・`_` が 25 字以上続き、数字を含むもの。 */
const LONG_ID = /(?<![A-Za-z0-9_\-/=])[A-Za-z0-9_-]{25,}(?![A-Za-z0-9_\-])/g;

/**
 * 推論の文から、内部の ID を取り除く（承認の画面に出す前の安全網）。
 *
 * @remarks
 * 推論には ID を書かないよう指示しているが、それでも書くことがある（2026-09-25 に承認の画面で成果物の ID が出た）。
 * **URL の中は触らない**（文書のリンクは押せるように残す）。ID を取り除いて空になった箇条書きと、
 * 「ID:」だけが残った括弧も消す。
 */
export function hideInternalIds(text: string): string {
  const cleaned = text.split(/(https?:\/\/[^\s)）]+)/).map((part, i) => {
    if (i % 2 === 1) return part; // URL
    return part
      .replace(/`([^`]*)`/g, (m, inner: string) => (IS_UUID.test(inner) || isLongId(inner) ? '' : m))
      .replace(UUID, '')
      .replace(LONG_ID, (m) => (/\d/.test(m) ? '' : m))
      .replace(/[（(]\s*[^（）()\n]{0,12}ID\s*[:：]?\s*[）)]/g, '')
      .replace(/ {2,}/g, ' ');
  }).join('');
  return cleaned.split('\n')
    // 「ID は以下の通りです」のように、ID を紹介するだけの行は、ID を消すと意味を失う
    .filter((l) => !/ID\s*(は|を)?[^。\n]{0,12}(以下|次)の(通り|とおり)/.test(l))
    // ID を消して「- （題名）」だけが残った箇条書きは、括弧を外す
    .map((l) => l.replace(/^(\s*[-*]\s*)[（(](.+)[）)]\s*$/, '$1$2'))
    .filter((l) => !/^\s*[-*]\s*$/.test(l))
    .join('\n');
}

/** 1 つの語が、長い ID か。 */
function isLongId(v: string): boolean {
  return /^[A-Za-z0-9_-]{25,}$/.test(v.trim()) && /\d/.test(v);
}

/** 「〜します」の言い方を「〜しました」にする（行ったことを出すとき）。1 行目だけを使う。 */
const done = (description: string) => description.split('\n')[0]!.replace(/ます\*\*/, 'ました**');

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
  /**
   * 承認の前に組み立てた、承認の直後の段と、記録した操作。
   * `unable` は承認の前の確かめで行えないと分かった操作（記録していない。ADR-0024）。
   */
  plan: {
    step: AgentStep;
    calls: { name: string; args: Record<string, unknown>; shown?: string; caution?: string }[];
    unable?: { name: string; args: Record<string, unknown>; reason: string }[];
    /** 組み立ての中で実行した下書き（Google ドキュメントへの保存など）と、その結果（ADR-0025）。 */
    done?: { name: string; args: Record<string, unknown>; result: unknown }[];
  } | null;
  registry: ToolRegistry;
}): string {
  const { def, gate, gateSeq, steps, artifacts, plan, registry } = p;
  const out: string[] = [gate.present, ''];

  // 前の承認（無ければ実行の始め）を探す。そこから先に作られたものが、この承認で判断するもの
  const prevGate = [...steps].reverse().find((s) => s.kind === 'approval' && s.seq < gateSeq && !s.stepId.endsWith(':confirm'));
  const since = prevGate?.seq ?? -1;
  const shownBefore = new Set(((prevGate?.input ?? {}) as { artifactIds?: string[] }).artifactIds ?? []);

  const ctx = describeContext(registry, artifacts);
  const material: string[] = [];
  for (const s of steps) {
    if (s.kind !== 'agent' || s.status !== 'succeeded' || s.seq <= since || s.seq >= gateSeq) continue;
    const output = (s.output ?? {}) as { text?: string; planned?: boolean; executed?: boolean };
    const text = output.text?.trim();
    const def0 = def.steps.find((d) => d.id === s.stepId);
    const label = def0 ? stepLabel(def0) : s.stepId;
    if (output.planned && output.executed) {
      // 前の承認のあとに実行した段。推論の文は承認の前に書いたもので古い（「承認待ちです」などと書いている）。
      // 行ったことを出す（2026-09-25 に承認の画面で確認）
      const gateRecord = steps.find((x) => x.kind === 'approval' && (x.input as { plannedStep?: number } | null)?.plannedStep === s.seq);
      const calls = ((gateRecord?.input ?? {}) as { toolCalls?: { name: string; args: Record<string, unknown> }[] }).toolCalls ?? [];
      if (calls.length > 0) {
        material.push(`### ${label}（前の承認のあとに行ったこと）`, '', ...calls.map((c) => `- ${done(describeCall(c, ctx))}`), '');
        continue;
      }
    }
    if (!text) continue;
    // 推論の文には内部の ID が混じりうる。承認する人に見せる前に取り除く
    material.push(`### ${label}`, '', demote(cut(hideInternalIds(text), TEXT_MAX)), '');
  }
  for (const a of artifacts.filter((x) => !shownBefore.has(x.id))) {
    material.push(`### 成果物「${a.title}」`, '', demote(cut(a.body, ARTIFACT_MAX)), '');
  }
  out.push('## 判断するもの', '');
  out.push(...(material.length > 0 ? material : ['（この承認までに作られた文や成果物はありません）', '']));

  // 承認の前の組み立てで済ませたこと。承認する人が、作られた文書を開いて確かめられるようにする（ADR-0025）
  const doneLines = (plan?.done ?? []).map((d) => describeDone(d, d.result)).filter((x): x is string => !!x);
  if (doneLines.length > 0) {
    out.push('## 承認の前に済ませたこと', '', ...doneLines.map((l) => `- ${l}`), '');
  }

  out.push('## 承認すると', '');
  const unable = plan?.unable ?? [];
  if (!plan) {
    out.push('この業務の次の段へ進みます。', '');
  } else if (plan.calls.length === 0) {
    out.push(`「${stepLabel(plan.step)}」に進みます。社内への書き込みや、社外への送信は行いません。`, '');
  } else {
    out.push(`「${stepLabel(plan.step)}」に進み、**次のことをこのとおりに行います**（承認のあとで内容を変えることはありません）。`, '');
    // 1 行で済むものは箇条書きに、本文を伴うもの（投稿・メール）は、本文の改行を保って独立したまとまりにする
    let listOpen = false;
    for (const c of plan.calls) {
      const d = describeCall(c, ctx);
      // 承認の前に確かめられなかったもの（Google に届かないなど）は、そのことを添える（ADR-0024）
      const caution = c.caution ? `承認の前に確かめられませんでした（${c.caution}）。承認のあとで改めて試します` : '';
      if (!d.includes('\n')) {
        out.push(`- ${d}`, ...(caution ? [`  - ${caution}`] : []));
        listOpen = true;
        continue;
      }
      if (listOpen) { out.push(''); listOpen = false; }
      out.push(d, ...(caution ? ['', caution] : []), '');
    }
    if (listOpen) out.push('');
  }
  if (unable.length > 0) {
    // 行えないことを黙って消さない。何が・なぜを出し、承認するか却下するかは承認する人が決める（ADR-0024）
    out.push('**次のことは行えません（承認しても行いません）**:', '');
    for (const u of unable) {
      const what = describeCall(u, ctx).split('\n')[0]!.replace(/:\s*$/, '');
      out.push(`- ${what}`, `  - 理由: ${u.reason}`);
    }
    out.push('', '行えないことを直すには、却下して、依頼し直してください。', '');
  }
  out.push('却下すると、ここで止まり、上のことは行いません。');
  return out.join('\n').trim();
}
