/**
 * @file 承認の画面に出すものを組み立てる（仕様書 第9.3.3節、ADR-0023）。
 *
 * 承認する人が、何を承認するのかを読んで判断できるようにする。出すのは 3 つ。
 * 確認すること（定義の `present`）・判断するもの（前の承認からここまでの文と成果物）・承認すると行うこと。
 */

import type { AgentDefinition, AgentStep, ApprovalStep, Artifact, RunStep } from '@m2office/shared';
import type { ToolRegistry } from '../tools/registry.js';
import { stepLabel } from '../agents/index.js';
import { hideInternalIds } from '@m2office/shared';
import { describeCall, describeDone, type DescribeContext } from './describe-call.js';
import { scanHtml } from '../site-updates/segments.js';

// 以前ここで定義していた。core の利用者のために、ここからも書き出す
export { hideInternalIds };

/** 段の文を、この字数で切る。 */
const TEXT_MAX = 4000;
/** 成果物の本文を、この字数で切る。 */
const ARTIFACT_MAX = 6000;

/** ツールの説明と成果物の題名を引けるようにする。 */
export function describeContext(registry: ToolRegistry, artifacts: Artifact[]): DescribeContext {
  return {
    helpText: (name) => registry.get(name)?.helpText,
    artifactTitle: (id) => artifacts.find((a) => a.id === id)?.title,
    connectionOf: (name) => {
      const t = registry.get(name);
      return t?.connection ? { service: t.connection.name, tool: t.connection.tool, risk: t.risk, ...(t.connection.labels ? { labels: t.connection.labels } : {}) } : undefined;
    },
  };
}

/**
 * 段の文や成果物の中の見出しを、承認の画面の見出しより小さくする。
 *
 * @remarks 議事録の「## 決定事項」が、承認の画面の「## 判断するもの」と同じ大きさで並ぶと、どこまでが議事録か分からない。
 */
const demote = (text: string) => text.replace(/^#{1,6}\s+/gm, '#### ');

/** 比べるために、行の書式（見出し・箇条書きの印・太字・空白）を落とす。 */
const plainLine = (l: string) => l.replace(/^\s*(#{1,6}\s+|[-*+]\s+|\d+[.)]\s+|>\s*)/, '').replace(/\*\*|`/g, '').replace(/\s+/g, '').trim();

/**
 * 段の文が、成果物の本文を繰り返しているか。
 *
 * @remarks
 * 成果物の中身のある行（書式を落として 6 字以上）のうち、**6 割以上が段の文にもある**なら繰り返しとみなす。
 * 推論は同じ内容を見出しの深さや箇条書きの印を変えて書くため、行の書式を落としてから比べる
 */
export function repeatsArtifact(text: string, body: string): boolean {
  const lines = [...new Set(body.split('\n').map(plainLine).filter((l) => l.length >= 6))];
  if (lines.length < 3) return false;
  const inText = new Set(text.split('\n').map(plainLine));
  const hit = lines.filter((l) => inText.has(l)).length;
  return hit / lines.length >= 0.6;
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
  const prevGate = [...steps].reverse().find((s) => s.kind === 'approval' && s.seq < gateSeq && !s.stepId.endsWith(':confirm') && !s.stepId.endsWith(':call'));
  const since = prevGate?.seq ?? -1;
  const shownBefore = new Set(((prevGate?.input ?? {}) as { artifactIds?: string[] }).artifactIds ?? []);

  const ctx = describeContext(registry, artifacts);
  const material: string[] = [];
  // この承認で見せる成果物。段の文がこれを繰り返しているだけなら、段の文は省く（同じ議事録が 2 回並ばないように）
  const shownArtifacts = artifacts.filter((x) => !shownBefore.has(x.id));
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
    const repeated = shownArtifacts.find((a) => repeatsArtifact(text, a.body));
    if (repeated) {
      // 2026-09-25 に、業務「議事録の作成・共有」の「取得」の段が議事録そのものを書き、承認①の画面に同じ議事録が 2 回並んだ
      material.push(`### ${label}`, '', `（下の成果物「${repeated.title}」と同じ内容のため、省きました）`, '');
      continue;
    }
    // 推論の文には内部の ID が混じりうる。承認する人に見せる前に取り除く
    material.push(`### ${label}`, '', demote(cut(hideInternalIds(text), TEXT_MAX)), '');
  }
  for (const a of shownArtifacts) {
    material.push(`### 成果物「${a.title}」`, '', demote(cut(a.body, ARTIFACT_MAX)), '');
  }
  out.push('## 判断するもの', '');
  out.push(...(material.length > 0 ? material : ['（この承認までに作られた文や成果物はありません）', '']));

  // 会社の接続の見直しの結果（いまと後）と、相手が必ず見せるよう求める注意（仕様書 第47.4.2節）
  const review = connectionReview(steps.filter((s) => s.kind === 'agent' && s.seq > since && s.seq < gateSeq), plan?.done ?? [], registry);
  if (review.length > 0) out.push(...review);

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

/** 見直しの結果の値を、承認の画面に出す長さ。 */
const REVIEW_VALUE_MAX = 1500;

/** 行を区切る札（改行にする）。 */
// @wordlist 形を読む（第49.4節）
const LINE_BREAK_TAG = /^<(br|\/p|\/h\d|\/li)\b/i;

/**
 * 見直しの結果の値を、人が読める文にする。HTML は札と注釈を落とす。
 *
 * @remarks 札は {@link scanHtml}（前から 1 回だけ読む）で見分ける。正規表現で札を消すと、消し残しや遅い入力が出るため
 */
function reviewValue(v: unknown): string {
  if (v === null || v === undefined || v === '') return '（なし）';
  const text = typeof v === 'string' ? v : JSON.stringify(v, null, 1);
  const plain = text.includes('<') ? withoutTags(text).replace(/\n{3,}/g, '\n\n').trim() : text;
  return cut(hideInternalIds(plain), REVIEW_VALUE_MAX);
}

/** 札を外す。外して新しく札ができる入れ子（`<scr<script>ipt>`）もあるので、変わらなくなるまで外し、残った札の印は全角にする。 */
function withoutTags(html: string): string {
  let text = html;
  for (let i = 0; i < 5; i++) {
    const next = scanHtml(text).map((t) => (t.kind === 'text' ? t.raw : t.kind === 'tag' && LINE_BREAK_TAG.test(t.raw) ? '\n' : '')).join('');
    if (next === text) break;
    text = next;
  }
  return text.replace(/<(?=[a-z/!?])/gi, '＜');
}

/** 引用の形にする（複数行を保つ）。 */
const quote = (text: string) => text.split('\n').map((l) => `> ${l}`).join('\n');

/** 結果の JSON から、名前の合う項目を探す（いちばん上と、1 段下まで）。 */
function findField(o: Record<string, unknown>, name: string): unknown {
  if (name in o) return o[name];
  for (const v of Object.values(o)) {
    if (v && typeof v === 'object' && !Array.isArray(v) && name in (v as Record<string, unknown>)) return (v as Record<string, unknown>)[name];
  }
  return undefined;
}

/**
 * 会社の接続の、見直しの結果と注意を承認の画面の文にする（仕様書 第47.4.2節）。
 *
 * @remarks
 * 見直しの道具（役割 `review`）の結果が JSON で `current` と `proposed` を持てば、変わる項目（`changedFields` があればそれだけ）を直す前と後で並べる。
 * 注意（道具の `warnings` に挙げた項目）は、**相手の言葉のまま**出す。推論の言い換えにしない
 */
function connectionReview(steps: RunStep[], done: { name: string; result: unknown }[], registry: ToolRegistry): string[] {
  const results: { name: string; text: string }[] = [];
  for (const s of steps) {
    for (const t of ((s.output ?? {}) as { tools?: { name?: string; result?: unknown }[] }).tools ?? []) {
      const r = t.result as { source?: string; text?: unknown } | undefined;
      if (t.name && r?.source === 'external' && typeof r.text === 'string') results.push({ name: t.name, text: r.text });
    }
  }
  for (const d of done) {
    const r = d.result as { source?: string; text?: unknown } | undefined;
    if (r?.source === 'external' && typeof r.text === 'string') results.push({ name: d.name, text: r.text });
  }
  const out: string[] = [];
  const warnings: string[] = [];
  let reviewed: { name: string; o: Record<string, unknown> | null; text: string } | null = null;
  for (const r of results) {
    const tool = registry.get(r.name);
    if (!tool?.connection) continue;
    let o: Record<string, unknown> | null = null;
    try {
      const v = JSON.parse(r.text) as unknown;
      o = v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : null;
    } catch { /* 文で返す相手もある */ }
    if (tool.connection.role === 'review') reviewed = { name: r.name, o, text: r.text };
    for (const w of tool.connection.warnings ?? []) {
      const v = o ? findField(o, w) : undefined;
      if (v === undefined || v === null || v === false || v === '') continue;
      const line = typeof v === 'string' ? v : typeof v === 'object' && v && typeof (v as { message?: unknown }).message === 'string' ? (v as { message: string }).message : `${w}: ${JSON.stringify(v)}`;
      if (!warnings.includes(line)) warnings.push(line);
    }
  }
  if (reviewed) {
    const conn = registry.get(reviewed.name)?.connection;
    out.push(`### ${conn?.name ?? '相手'}の見直しの結果`, '');
    const current = reviewed.o?.['current'];
    const proposed = reviewed.o?.['proposed'];
    if (current && proposed && typeof current === 'object' && typeof proposed === 'object') {
      const c = current as Record<string, unknown>;
      const n = proposed as Record<string, unknown>;
      const listed = Array.isArray(reviewed.o?.['changedFields']) ? (reviewed.o!['changedFields'] as unknown[]).filter((x): x is string => typeof x === 'string') : null;
      const fields = listed ?? [...new Set([...Object.keys(c), ...Object.keys(n)])].filter((k) => JSON.stringify(c[k]) !== JSON.stringify(n[k]));
      if (fields.length === 0) out.push('変わる項目はありません。', '');
      for (const f of fields) {
        out.push(`**${f}**`, '', '直す前:', '', quote(reviewValue(c[f])), '', '直した後:', '', quote(reviewValue(n[f])), '');
      }
      if (listed) out.push(`ここに挙げた項目のほかは変わりません（相手の見直しの結果による）。`, '');
    } else {
      out.push(quote(reviewValue(reviewed.text)), '');
    }
  }
  if (warnings.length > 0) {
    out.push('### 注意（相手の言葉のまま）', '', ...warnings.map((w) => `- ${cut(w, 600)}`), '');
  }
  return out;
}

/** 承認のあとに実際に行った操作 1 件（仕様書 第6.2.5節）。 */
export interface ExecutedCall {
  /** 業務の言葉で、何をしたか（承認の画面の 1 行目と同じ言い方）。 */
  text: string;
  /** 相手のリンク（投稿・文書・予定など）。無ければ `null`。 */
  link: string | null;
  /** 失敗したときの理由。 */
  error: string | null;
}

/**
 * 承認の段の記録から、承認のあとに実際に行った操作と結果を取り出す（仕様書 第6.2.5節「実際に行ったこと」）。
 *
 * @param step 承認の段（`input.toolCalls` に記録した操作、`output.tools` に行った結果がある）
 * @returns 行った操作。承認の前の組み立てが無い・まだ行っていない・却下したときは空
 */
export function executedCalls(step: RunStep | null, ctx: DescribeContext = {}): ExecutedCall[] {
  const input = (step?.input ?? {}) as { toolCalls?: { name: string; args: Record<string, unknown>; shown?: string }[] };
  const output = (step?.output ?? {}) as { executed?: boolean; tools?: { name: string; result?: unknown }[] };
  if (!output.executed || !Array.isArray(output.tools)) return [];
  const calls = input.toolCalls ?? [];
  return output.tools.map((t, i) => {
    const call = calls[i]?.name === t.name ? calls[i]! : calls.find((c) => c.name === t.name) ?? { name: t.name, args: {} };
    const r = (t.result ?? {}) as Record<string, unknown>;
    return {
      // 1 行目だけ（本文は承認の画面に出ている）
      text: describeCall(call, ctx).split('\n')[0]!,
      link: firstLink(t.result),
      error: typeof r['error'] === 'string' ? r['error'] : null,
    };
  });
}

/**
 * 結果の中の最初の相手のリンク（http・https）。深く探しすぎない。
 *
 * @remarks 会社の接続（MCP）の結果は JSON の文字で返ることがある（Slack の `message_link`）ため、文字の中も探す
 */
function firstLink(v: unknown, depth = 0): string | null {
  if (depth > 4 || v === null || v === undefined) return null;
  if (typeof v === 'string') {
    const m = /https?:\\?\/\\?\/[^\s"'<>)\]]+/.exec(v);
    return m ? m[0].replace(/\\\//g, '/') : null;
  }
  if (Array.isArray(v)) {
    for (const x of v) { const l = firstLink(x, depth + 1); if (l) return l; }
    return null;
  }
  if (typeof v === 'object') {
    const o = v as Record<string, unknown>;
    // よく使う名前を先に見る
    for (const k of ['url', 'link', 'message_link', 'webViewLink', 'htmlLink', 'permalink']) {
      if (typeof o[k] === 'string' && /^https?:/.test(o[k] as string)) return o[k] as string;
    }
    for (const x of Object.values(o)) { const l = firstLink(x, depth + 1); if (l) return l; }
  }
  return null;
}

