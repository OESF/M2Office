/**
 * @file 意思決定支援の討論を進める（仕様書 第43.4節〜第43.8節・第43.11.2節）。ワーカーが相談ごとに動かす。
 *
 * 流れ: 判断の問いと観点 → 材料集め（付属の業務を始めた人の権限で動かす）→ 本討論（慎重の役と推進の役が交互に。3 ターンごとに判定の役が途中のまとめ）
 * → 決着していない論点の深掘り → 討論の終わりのまとめ（主張の状態・優勢・分かれ目）→ 突き合わせ（使うときだけ）→ 報告。
 *
 * - **進み具合は置き場から作り直す。** ワーカーが止まっても、別のワーカーが続きから受け持てる（書きかけの発言は消して書き直す）。
 * - 発言は書かれるそばから 0.5 秒ごとに置き場へ書き足す。画面はそれを順に受け取る（第43.11.2節）。
 * - 早めの終わりは、主張の形から決まりで見る: 2 ターン続けて「新しい論点」「修正案」も、まだ使っていない材料の番号を根拠にした主張も無ければ終える。
 * - AI の利用の上限に当たったら、そこで討論を終える。上限のため推論を呼べないので、報告はまとめられないことを記録に残す（推測で埋めない）。
 * - 推論は会社の AI の方針に従う（ローカルの方針の会社ではローカル AI。第43.13節）。途中で切り替えない。
 */

import {
  DECISION_LIMITS, DECISION_LEAN_LABELS, DECISION_ROLE_LABELS, DECISION_ROLE_LETTERS, decisionMainTurns,
  type DecisionClaim, type DecisionClaimState, type DecisionComparison, type DecisionDig, type DecisionEndReason, type DecisionIssueState,
  type DecisionLean, type DecisionMaterial, type DecisionReport, type DecisionTurn,
} from '@m2office/shared';
import { completeStreaming, type LlmProvider, type LlmResponse } from '../llm/provider.js';
import { costJpy } from '../llm/models.js';
import { AiLimitError } from '../usage/ai-usage.js';
import { silentLogger, type Logger } from '../log/logger.js';
import { materialNumbers, parseJsonObject, parseSpeech, splitReport, type ParsedClaim } from './format.js';
import {
  JUDGE_SYSTEM, compareAsk, debateContext, digAsk, framingAsk, materialsText, reportAsk, roleSystem, speechAsk, summaryAsk,
} from './prompts.js';
import type { DecisionStore, StoredDecision } from './store.js';

/** 討論を進めるのに要るもの。 */
export interface DecisionEngineDeps {
  store: DecisionStore;
  /** 会社の推論（会社の AI の方針に従う。AI の利用の記録と上限の包みつき） */
  llmFor(tenantId: string): Promise<LlmProvider>;
  /**
   * 材料を集める（付属の業務を始めた人の権限で動かし、終わるまで待つ）。
   *
   * @param onProgress 進み具合の文（「会社の知識を調べています」など）
   */
  gather(tenantId: string, s: StoredDecision, framing: { question: string; viewpoints: string[] }, onProgress: (text: string) => Promise<void>): Promise<{ materials: DecisionMaterial[]; missing: string[] }>;
  /** 討論が終わったことを始めた人に知らせる。 */
  notify?(tenantId: string, s: StoredDecision, title: string, body: string): Promise<void>;
  logger?: Logger;
  /** 書きかけの発言を置き場へ書き足す間隔（ミリ秒。既定 500） */
  flushMs?: number;
}

/** 止めるよう頼まれた。 */
class StopRequested extends Error {
  constructor() { super('止めるよう頼まれました'); this.name = 'StopRequested'; }
}

/** 1 つの討論の中の様子（置き場から作り直す）。 */
interface DebateState {
  debate: number;
  /** 本討論の最後まで終わったターン */
  lastMainTurn: number;
  /** 使ったターンの最後の番号（深掘りも含む） */
  lastTurn: number;
}

/** 区切りの名前。 */
const AT = { turn: (t: number) => `t${t}`, main: 'main', dig: (issue: string) => `dig:${issue}`, end: 'end' };

/** 討論 2 の主張の番号の頭。 */
const debatePrefix = (debate: number) => (debate > 1 ? `${debate}:` : '');
/** 役に見せる番号（討論の頭を外す）。 */
const bare = (code: string) => code.replace(/^\d+:/, '');

const s = (v: unknown, max: number) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
const STATES = new Set<DecisionClaimState>(['standing', 'refuted', 'conceded', 'unanswered']);
const LEANS = new Set<DecisionLean>(['con', 'pro', 'even', 'open']);

/** 討論を進める。 */
export class DecisionEngine {
  private readonly log: Logger;
  private readonly flushMs: number;

  constructor(private readonly deps: DecisionEngineDeps) {
    this.log = deps.logger ?? silentLogger;
    this.flushMs = deps.flushMs ?? 500;
  }

  /**
   * 相談を、いまの状態から終わりまで進める。
   *
   * @remarks 呼ぶ側（ワーカー）が受け持つ印を付けてから呼ぶ。失敗しても投げず、相談を「失敗」にする
   */
  async run(tenantId: string, sessionId: string): Promise<void> {
    const store = this.deps.store;
    let session = await store.get(tenantId, sessionId);
    if (!session || session.trashedAt) return;
    const llm = await this.deps.llmFor(tenantId);
    const ai: 'local' | 'cloud' = llm.name === 'local' ? 'local' : 'cloud';
    const ctx = new RunContext(this.deps, this.log, this.flushMs, tenantId, sessionId, llm, session.costJpy ?? 0);
    try {
      if (!session.ai) await store.update(tenantId, sessionId, { ai });
      if (!session.question || session.status === 'queued' || session.status === 'gathering') {
        await this.frameAndGather(ctx, session);
        session = (await store.get(tenantId, sessionId))!;
      }
      const pending = session.pending;
      await store.update(tenantId, sessionId, { status: 'debating', pending: null, endReason: null, endNote: '' });
      session = (await store.get(tenantId, sessionId))!;
      const debates = session.crossCheck ? [1, 2] : [1];
      const ends = await Promise.all(debates.map((d) => ctx.debate(session!, d, pending)));
      await ctx.flushCost();
      await store.update(tenantId, sessionId, { status: 'summarizing', progress: '判定の役が報告をまとめています' });
      session = (await store.get(tenantId, sessionId))!;
      const comparison = session.crossCheck ? await ctx.compare(session) : null;
      await ctx.report(session, comparison);
      const endReason: DecisionEndReason = ends.some((e) => e.reason === 'exhausted') ? 'exhausted' : 'turns';
      await ctx.flushCost();
      await store.update(tenantId, sessionId, { status: 'done', endReason, endNote: ends.map((e) => e.note).filter(Boolean).join(' '), progress: '' });
      const done = (await store.get(tenantId, sessionId))!;
      await this.deps.notify?.(tenantId, done, '意思決定支援の討論が終わりました', `${done.question}\n見立て: ${done.report?.verdict ?? '（報告をまとめられませんでした）'}`).catch(() => undefined);
    } catch (err) {
      await ctx.flushCost().catch(() => undefined);
      if (err instanceof StopRequested) {
        // 止めたら、そこまでの討論で報告をまとめる（第43.6節「止める」）
        await this.finishStopped(ctx, tenantId, sessionId);
        return;
      }
      if (err instanceof AiLimitError) {
        await store.update(tenantId, sessionId, {
          status: 'stopped', endReason: 'cost', progress: '',
          endNote: `AI の費用の上限に当たったため、討論を終えました（${err.message}）。上限のため推論を呼べないので、報告はまとめられませんでした`,
        });
        return;
      }
      this.log.warn('意思決定支援の討論に失敗しました', { tenantId, sessionId, err: err instanceof Error ? err.message : String(err) });
      await store.update(tenantId, sessionId, {
        status: 'failed', endReason: 'failed', progress: '',
        endNote: `討論を続けられませんでした（${err instanceof Error ? err.message.slice(0, 200) : '理由は分かりません'}）`,
      });
    }
  }

  /** 止めた相談の報告をまとめる。 */
  private async finishStopped(ctx: RunContext, tenantId: string, sessionId: string): Promise<void> {
    const store = this.deps.store;
    await store.update(tenantId, sessionId, { status: 'summarizing', progress: '止めたところまでで、判定の役が報告をまとめています', stopRequested: false });
    try {
      const s = (await store.get(tenantId, sessionId))!;
      if ((await store.claims(tenantId, sessionId)).some((c) => c.role !== 'human')) await ctx.report(s, null);
      await store.update(tenantId, sessionId, { status: 'stopped', endReason: 'stopped', endNote: '途中で止めました', progress: '' });
    } catch (err) {
      const cost = err instanceof AiLimitError;
      await store.update(tenantId, sessionId, {
        status: 'stopped', endReason: cost ? 'cost' : 'stopped', progress: '',
        endNote: cost ? 'AI の費用の上限に当たったため、報告はまとめられませんでした' : '途中で止めました（報告はまとめられませんでした）',
      });
    }
  }

  /** 判断の問いと観点を作り、材料を集める（第43.4節・第43.5節）。 */
  private async frameAndGather(ctx: RunContext, session: StoredDecision): Promise<void> {
    const store = this.deps.store;
    await store.update(ctx.tenantId, ctx.sessionId, { status: 'gathering', progress: '判断の問いを考えています' });
    let question = session.question;
    let viewpoints = session.viewpoints;
    if (!question) {
      const res = await ctx.call('standard', [{ role: 'user', content: framingAsk(session.topic) }], 800);
      const j = parseJsonObject(res.text) ?? {};
      question = s(j['question'], 200) || session.topic.slice(0, 200);
      viewpoints = (Array.isArray(j['viewpoints']) ? j['viewpoints'] : []).map((v) => s(v, 30)).filter(Boolean).slice(0, 6);
      const unclear = s(j['unclear'], 200);
      // 画面からの相談では聞き返さず、読み取れなかった点を記録に残して進める（割り込みで直せる。第43.4節）
      await store.update(ctx.tenantId, ctx.sessionId, { question, viewpoints, endNote: unclear ? `お題から読み取れなかった点: ${unclear}` : '' });
    }
    if ((await store.materials(ctx.tenantId, ctx.sessionId)).some((m) => m.kind !== 'human')) return;
    await store.update(ctx.tenantId, ctx.sessionId, { progress: '材料を集めています' });
    const fresh = (await store.get(ctx.tenantId, ctx.sessionId))!;
    const got = await this.deps.gather(ctx.tenantId, fresh, { question, viewpoints }, (text) => store.update(ctx.tenantId, ctx.sessionId, { progress: text }));
    const existing = await store.materials(ctx.tenantId, ctx.sessionId);
    const start = Math.max(0, ...existing.map((m) => m.no));
    await store.addMaterials(ctx.tenantId, ctx.sessionId, got.materials.map((m, i) => ({ ...m, no: start + i + 1 })));
    await store.update(ctx.tenantId, ctx.sessionId, { missing: got.missing.slice(0, 10) });
  }
}

/** 1 回の動かしの中の文脈。 */
class RunContext {
  private cost: number;
  private costDirty = false;
  private readonly progressByDebate = new Map<number, string>();

  constructor(
    private readonly deps: DecisionEngineDeps,
    private readonly log: Logger,
    private readonly flushMs: number,
    readonly tenantId: string,
    readonly sessionId: string,
    private readonly llm: LlmProvider,
    initialCost: number,
  ) {
    this.cost = initialCost;
  }

  private get store(): DecisionStore { return this.deps.store; }

  /** 推論を呼び、費用を足す。 */
  async call(tier: 'fast' | 'standard' | 'advanced', messages: { role: 'system' | 'user'; content: string }[], maxOutputTokens: number): Promise<LlmResponse> {
    const res = await this.llm.complete({ tier, messages, maxOutputTokens });
    this.addCost(res);
    return res;
  }

  private addCost(res: LlmResponse): void {
    if (this.llm.name === 'local' || this.llm.name === 'stub') return;
    const input = res.inputTokens ?? res.tokensUsed;
    this.cost += costJpy(res.model ?? '', input, res.outputTokens ?? 0);
    this.costDirty = true;
  }

  /** たまった費用の目安を置き場に書く。 */
  async flushCost(): Promise<void> {
    if (!this.costDirty) return;
    this.costDirty = false;
    await this.store.update(this.tenantId, this.sessionId, { costJpy: Math.round(this.cost * 10) / 10 });
  }

  /** 画面の上の様子（討論ごとの文をつなぐ）。 */
  private async progress(debate: number, text: string): Promise<void> {
    this.progressByDebate.set(debate, text);
    const all = [...this.progressByDebate.entries()].sort((a, b) => a[0] - b[0]).map(([d, t]) => (this.progressByDebate.size > 1 ? `討論 ${d}: ${t}` : t));
    await this.store.update(this.tenantId, this.sessionId, { progress: all.join(' ／ ') });
  }

  /** 止めるよう頼まれていたら投げる。 */
  private async checkStop(): Promise<void> {
    const s = await this.store.get(this.tenantId, this.sessionId);
    if (!s || s.stopRequested || s.trashedAt) throw new StopRequested();
  }

  /** 置き場から、討論の様子を作り直す。書きかけの発言は消す（続きから書き直す）。 */
  private async stateOf(debate: number): Promise<DebateState> {
    const turns = await this.store.turns(this.tenantId, this.sessionId);
    for (const t of turns) {
      if (t.debate === debate && !t.done && !t.stopped) await this.store.deleteTurn(this.tenantId, t.id);
    }
    const mine = turns.filter((t) => t.debate === debate && (t.done || t.stopped) && (t.role === 'con' || t.role === 'pro'));
    const fullTurn = (stage: 'main' | 'dig') => {
      const byTurn = new Map<number, Set<string>>();
      for (const t of mine.filter((x) => x.stage === stage)) byTurn.set(t.turn, (byTurn.get(t.turn) ?? new Set()).add(t.role));
      return Math.max(0, ...[...byTurn.entries()].filter(([, r]) => r.size === 2).map(([t]) => t));
    };
    return { debate, lastMainTurn: fullTurn('main'), lastTurn: Math.max(0, ...mine.map((t) => t.turn)) };
  }

  /**
   * 1 つの討論を進める（本討論・深掘り・終わりのまとめ）。
   *
   * @param pending 討論のあとに頼まれたこと（続ける・掘り下げる）
   * @returns 終わった理由と、その説明
   */
  async debate(session: StoredDecision, debate: number, pending: StoredDecision['pending']): Promise<{ reason: DecisionEndReason; note: string }> {
    const order: ('con' | 'pro')[] = debate === 1 ? ['con', 'pro'] : ['pro', 'con'];
    const viewpoints = debate === 1 ? session.viewpoints : [...session.viewpoints].reverse();
    const label = session.crossCheck ? `討論 ${debate}: ` : '';
    let state = await this.stateOf(debate);
    const states = await this.store.issueStates(this.tenantId, this.sessionId);
    const mainEnded = states.some((x) => x.debate === debate && x.at === AT.main);
    // 終わりまでまとめた討論は、頼まれたこと（続ける・掘り下げる）が無ければ、やり直さない（ワーカーが報告の前に止まったとき）
    if (!pending && states.some((x) => x.debate === debate && x.at === AT.end)) return { reason: 'turns', note: '' };
    let reason: DecisionEndReason = 'turns';
    let note = '';

    // 本討論（続けるときは、指定のターン数を足す）
    const mainLimit = pending?.kind === 'continue'
      ? state.lastTurn + pending.turns
      : mainEnded ? state.lastMainTurn : decisionMainTurns(session.turns);
    const runMain = pending?.kind === 'continue' || !mainEnded;
    if (runMain) {
      let staleRun = 0;
      for (let t = (pending?.kind === 'continue' ? state.lastTurn : state.lastMainTurn) + 1; t <= mainLimit; t++) {
        for (const role of order) {
          await this.checkStop();
          await this.progress(debate, `${DECISION_ROLE_LABELS[role]}が考えています（${t} / ${pending?.kind === 'continue' ? mainLimit : session.turns} ターン）`);
          await this.speak(session, { debate, role, turn: t, viewpoints, first: t === 1, dig: null });
        }
        staleRun = (await this.turnIsFresh(debate, t)) ? 0 : staleRun + 1;
        if (t % DECISION_LIMITS.summaryEvery === 0 && t < mainLimit) await this.summarize(session, debate, AT.turn(t), `${t} ターン`, false);
        if (staleRun >= 2) {
          reason = 'exhausted';
          note = `${label}${t} ターンで論点が出尽くしました（${t - 1}・${t} ターン目に新しい論点も、まだ使っていない材料による根拠もありませんでした）。`;
          break;
        }
      }
      state = await this.stateOf(debate);
      if (pending?.kind !== 'continue') await this.summarize(session, debate, AT.main, '本討論の終わり', false);
    }

    // 深掘り（第43.6.3節）。人が選んだときは、その論点を
    if (pending?.kind === 'dig') {
      await this.dig(session, debate, { debate, issue: pending.issue, question: '', turns: pending.turns, used: 0, byHuman: true, done: false }, order, viewpoints);
    } else if (pending?.kind !== 'continue' && session.turns > DECISION_LIMITS.digMinTurns) {
      const fresh = (await this.store.get(this.tenantId, this.sessionId))!;
      let digs = fresh.digs.filter((d) => d.debate === debate && !d.byHuman);
      if (digs.length === 0 && !mainEnded) {
        const remaining = session.turns - state.lastMainTurn;
        digs = remaining > 0 ? await this.chooseDigs(session, debate, remaining) : [];
        if (digs.length) await this.saveDigs(digs);
      }
      for (const d of digs.filter((x) => !x.done)) await this.dig(session, debate, d, order, viewpoints);
    }

    await this.progress(debate, '判定の役が討論をまとめています');
    await this.summarize(session, debate, AT.end, '討論の終わり', true);
    return { reason, note };
  }

  /** そのターンに、新しい論点・修正案、またはまだ使っていない材料を根拠にした主張があったか。 */
  private async turnIsFresh(debate: number, turn: number): Promise<boolean> {
    const turns = await this.store.turns(this.tenantId, this.sessionId);
    const ids = new Set(turns.filter((t) => t.debate === debate && t.turn === turn && (t.role === 'con' || t.role === 'pro')).map((t) => t.id));
    const before = new Set(turns.filter((t) => t.debate === debate && t.turn < turn).map((t) => t.id));
    const claims = (await this.store.claims(this.tenantId, this.sessionId)).filter((c) => c.debate === debate);
    const usedBefore = new Set(claims.filter((c) => before.has(c.turnId)).flatMap((c) => materialNumbers(c.grounds)));
    return claims.filter((c) => ids.has(c.turnId)).some((c) => c.kind === 'new' || c.kind === 'revise' || materialNumbers(c.grounds).some((n) => !usedBefore.has(n)));
  }

  /** 役に渡す、討論の様子。 */
  private async contextFor(session: StoredDecision, debate: number, viewpoints: string[], digIssue: string | null): Promise<string> {
    const [materials, turns, allClaims, fresh] = await Promise.all([
      this.store.materials(this.tenantId, this.sessionId),
      this.store.turns(this.tenantId, this.sessionId),
      this.store.claims(this.tenantId, this.sessionId),
      this.store.get(this.tenantId, this.sessionId),
    ]);
    const claims = allClaims.filter((c) => c.debate === debate || c.role === 'human').map((c) => ({ ...c, code: bare(c.code), target: c.target ? bare(c.target) : null }));
    const spoken = turns.filter((t) => t.debate === debate && (t.role === 'con' || t.role === 'pro') && (t.done || t.stopped));
    const lastTurns = [...new Set(spoken.map((t) => t.turn))].sort((a, b) => a - b).slice(-2);
    let recent = spoken.filter((t) => lastTurns.includes(t.turn));
    // 深掘りでは、その論点の主張の全文を渡す（第43.6.3節）
    if (digIssue) {
      const onIssue = new Set(allClaims.filter((c) => c.debate === debate && c.issue === digIssue).map((c) => c.turnId));
      recent = spoken.filter((t) => onIssue.has(t.id) || lastTurns.includes(t.turn));
    }
    const summaries = turns.filter((t) => t.debate === debate && t.role === 'judge' && t.stage === 'summary' && t.done);
    return debateContext({
      question: fresh?.question ?? session.question,
      viewpoints,
      materials: materialsText(materials, fresh?.missing ?? session.missing),
      claims,
      summary: summaries.at(-1)?.text ?? '',
      recent,
      human: turns.filter((t) => t.role === 'human'),
    });
  }

  /**
   * 1 回の発言。書かれるそばから置き場へ書き足し、終わったら主張を読み取る。形が崩れていたら 1 回だけ書き直させる。
   */
  private async speak(session: StoredDecision, p: { debate: number; role: 'con' | 'pro'; turn: number; viewpoints: string[]; first: boolean; dig: { issue: string; question: string } | null }): Promise<void> {
    const prefix = `${DECISION_ROLE_LETTERS[p.role]}${p.turn}-`;
    const row = await this.store.createTurn(this.tenantId, this.sessionId, { debate: p.debate, turn: p.turn, stage: p.dig ? 'dig' : 'main', issue: p.dig?.issue ?? null, role: p.role });
    await this.store.heartbeat(this.tenantId, this.sessionId);
    const context = await this.contextFor(session, p.debate, p.viewpoints, p.dig?.issue ?? null);
    const allClaims = await this.store.claims(this.tenantId, this.sessionId);
    const known = new Set(allClaims.filter((c) => c.debate === p.debate || c.role === 'human').map((c) => bare(c.code)));
    const messages: { role: 'system' | 'user' | 'assistant'; content: string }[] = [
      { role: 'system', content: roleSystem(p.role) },
      { role: 'user', content: `${context}\n\n${speechAsk({ role: p.role, turn: p.turn, prefix, first: p.first, dig: p.dig })}` },
    ];
    let text = await this.stream(row.id, messages);
    let parsed = parseSpeech(text, prefix, known);
    let rewritten = false;
    if (parsed.problems.length > 0) {
      // 形が崩れていたら、その発言だけを 1 回書き直させる（第43.6.2節「形の確かめ」）
      rewritten = true;
      await this.store.setTurn(this.tenantId, row.id, { text: '', rewritten: true });
      messages.push({ role: 'assistant', content: text }, { role: 'user', content: `形が崩れていました（${parsed.problems.join('、')}）。決められた形を守って、同じ内容を書き直してください。` });
      text = await this.stream(row.id, messages);
      parsed = parseSpeech(text, prefix, known);
    }
    if (parsed.claims.length === 0) {
      parsed.claims = [{ code: `${prefix}1`, kind: 'new', target: null, issue: '（分類できなかった発言）', grounds: [], body: text.trim(), gist: text.trim().slice(0, 80) }];
    }
    const byCode = new Map(allClaims.map((c) => [c.code, c]));
    const pre = debatePrefix(p.debate);
    const claims: DecisionClaim[] = parsed.claims.map((c: ParsedClaim) => {
      const target = c.target ? (c.target.startsWith('人') ? c.target : `${pre}${c.target}`) : null;
      // 返しの主張は、向けた主張の論点に属する（論点の流れの同じ列に並べるため）
      const issue = (target && byCode.get(target)?.issue) || p.dig?.issue || c.issue || '（論点の名前なし）';
      return {
        code: `${pre}${c.code}`, debate: p.debate, turnId: row.id, role: p.role, issue, kind: c.kind, target, grounds: c.grounds,
        gist: c.gist, body: c.body, state: 'standing', stateReason: '', refutedBy: null, pivot: false,
      };
    });
    await this.store.upsertClaims(this.tenantId, this.sessionId, claims);
    await this.store.setTurn(this.tenantId, row.id, { text, done: true, ...(rewritten ? { rewritten: true } : {}) });
    await this.flushCost();
  }

  /** 推論を少しずつ受け取り、0.5 秒ごとに置き場へ書き足す。止めるよう頼まれたら、そこまでを残して止める。 */
  private async stream(turnId: string, messages: { role: 'system' | 'user' | 'assistant'; content: string }[], tier: 'standard' | 'advanced' = 'standard'): Promise<string> {
    let text = '';
    let last = Date.now();
    let chain: Promise<void> = Promise.resolve();
    let stopped = false;
    const flush = () => {
      chain = chain.then(async () => {
        if (stopped) return;
        await this.store.setTurn(this.tenantId, turnId, { text });
        const s = await this.store.get(this.tenantId, this.sessionId);
        if (!s || s.stopRequested || s.trashedAt) stopped = true;
      }).catch((err: unknown) => this.log.warn('書きかけの発言を残せませんでした', { err: err instanceof Error ? err.message : String(err) }));
    };
    const res = await completeStreaming(this.llm, { tier, messages, maxOutputTokens: 2000 }, (chunk) => {
      if (stopped) return;
      text += chunk;
      if (Date.now() - last >= this.flushMs) { last = Date.now(); flush(); }
    });
    this.addCost(res);
    await chain;
    if (stopped) {
      await this.store.setTurn(this.tenantId, turnId, { text, stopped: true });
      throw new StopRequested();
    }
    return text || res.text;
  }

  /** 判定の役の途中のまとめ（主張の状態と論点の優勢）。 */
  private async summarize(session: StoredDecision, debate: number, at: string, label: string, final: boolean, issue?: string): Promise<void> {
    const claims = (await this.store.claims(this.tenantId, this.sessionId)).filter((c) => c.debate === debate || c.role === 'human');
    const mine = claims.filter((c) => c.role !== 'human');
    if (mine.length === 0) return;
    const prevStates = (await this.store.issueStates(this.tenantId, this.sessionId)).filter((x) => x.debate === debate);
    const lastLean = new Map<string, DecisionIssueState>();
    for (const x of prevStates) lastLean.set(x.issue, x);
    const viewpoints = debate === 1 ? session.viewpoints : [...session.viewpoints].reverse();
    const context = await this.contextFor(session, debate, viewpoints, issue ?? null);
    const res = await this.call('advanced', [
      { role: 'system', content: JUDGE_SYSTEM },
      { role: 'user', content: summaryAsk({ context, label, claims: mine, leans: [...lastLean.values()], final, ...(issue ? { issue } : {}) }) },
    ], 3000);
    const j = parseJsonObject(res.text) ?? {};
    const pre = debatePrefix(debate);
    const full = (code: unknown) => {
      const c = s(code, 20);
      if (!c) return null;
      const withPre = c.startsWith('人') ? c : `${pre}${bare(c)}`;
      return claims.some((x) => x.code === withPre) ? withPre : null;
    };
    // 主張の状態
    const changed: DecisionClaim[] = [];
    for (const item of Array.isArray(j['claims']) ? j['claims'] as Record<string, unknown>[] : []) {
      const code = full(item['code']);
      const state = item['state'] as DecisionClaimState;
      const target = mine.find((c) => c.code === code);
      if (!target || !STATES.has(state)) continue;
      const by = state === 'refuted' ? full(item['by']) : null;
      const reason = s(item['reason'], 200);
      if (target.state === state && target.refutedBy === by) continue;
      changed.push({ ...target, state, refutedBy: by, stateReason: reason });
    }
    // 分かれ目
    const pivots = new Map<string, string>();
    if (final) {
      for (const item of (Array.isArray(j['pivots']) ? j['pivots'] as Record<string, unknown>[] : []).slice(0, 3)) {
        const code = full(item['code']);
        if (code) pivots.set(code, s(item['change'], 200));
      }
      for (const c of mine) {
        const isPivot = pivots.has(c.code);
        if (c.pivot !== isPivot) {
          const i = changed.findIndex((x) => x.code === c.code);
          if (i >= 0) changed[i] = { ...changed[i]!, pivot: isPivot }; else changed.push({ ...c, pivot: isPivot });
        }
      }
    }
    if (changed.length) await this.store.upsertClaims(this.tenantId, this.sessionId, changed);
    // 論点の優勢
    const issues = [...new Set(mine.map((c) => c.issue))].filter((x) => !issue || x === issue);
    const got = new Map<string, Record<string, unknown>>();
    for (const item of Array.isArray(j['issues']) ? j['issues'] as Record<string, unknown>[] : []) {
      const name = s(item['issue'], 40);
      if (issues.includes(name)) got.set(name, item);
    }
    const rows: DecisionIssueState[] = issues.map((name) => {
      const item = got.get(name);
      const lean = LEANS.has(item?.['lean'] as DecisionLean) ? item!['lean'] as DecisionLean : (lastLean.get(name)?.lean ?? 'open');
      const prev = lastLean.get(name)?.lean;
      return { debate, issue: name, at, label, lean, changedBy: prev !== undefined && prev !== lean ? full(item?.['changedBy']) : (prev === undefined ? full(item?.['changedBy']) : null), reason: s(item?.['reason'], 200) };
    });
    if (rows.length) await this.store.addIssueStates(this.tenantId, this.sessionId, rows);
    // 判定の役の途中のまとめを、発言として残す（全文を見せる）
    const lines = [s(j['note'], 600)];
    if (final && s(j['verdict'], 80)) lines.unshift(`この討論の見立て: ${s(j['verdict'], 80)}`);
    for (const r of rows) lines.push(`${r.issue}: ${DECISION_LEAN_LABELS[r.lean]}${r.changedBy ? `（${r.changedBy} で変化）` : ''}${r.reason ? ` — ${r.reason}` : ''}`);
    for (const [code, change] of pivots) lines.push(`分かれ目 ${code}: ${change}`);
    const lastTurn = (await this.stateOf(debate)).lastTurn;
    await this.store.createTurn(this.tenantId, this.sessionId, { debate, turn: lastTurn, stage: 'summary', issue: issue ?? null, role: 'judge', text: `【${label}のまとめ】\n${lines.filter(Boolean).join('\n')}`, done: true });
    await this.flushCost();
  }

  /** 深掘りする論点を選ぶ（第43.6.3節）。 */
  private async chooseDigs(session: StoredDecision, debate: number, remaining: number): Promise<DecisionDig[]> {
    const [states, claims] = await Promise.all([this.store.issueStates(this.tenantId, this.sessionId), this.store.claims(this.tenantId, this.sessionId)]);
    const mainLeans = states.filter((x) => x.debate === debate && x.at === AT.main);
    const unanswered = new Set(claims.filter((c) => c.debate === debate && c.state === 'unanswered').map((c) => c.issue));
    const candidates = mainLeans.filter((x) => x.lean === 'even' || x.lean === 'open' || unanswered.has(x.issue)).map((x) => x.issue);
    if (candidates.length === 0) return [];
    const max = Math.min(DECISION_LIMITS.digIssuesMax, candidates.length, remaining);
    const viewpoints = debate === 1 ? session.viewpoints : [...session.viewpoints].reverse();
    const context = await this.contextFor(session, debate, viewpoints, null);
    const res = await this.call('advanced', [{ role: 'system', content: JUDGE_SYSTEM }, { role: 'user', content: digAsk({ context, candidates, max }) }], 1000);
    const j = parseJsonObject(res.text) ?? {};
    const picked = (Array.isArray(j['digs']) ? j['digs'] as Record<string, unknown>[] : [])
      .map((d) => ({ issue: s(d['issue'], 40), question: s(d['question'], 200) }))
      .filter((d) => candidates.includes(d.issue) && d.question)
      .filter((d, i, all) => all.findIndex((x) => x.issue === d.issue) === i)
      .slice(0, max);
    if (picked.length === 0) return [];
    const per = Math.max(1, Math.floor(remaining / picked.length));
    return picked.map((d) => ({ debate, issue: d.issue, question: d.question, turns: per, used: 0, byHuman: false, done: false }));
  }

  /** 深掘りの一覧を相談に書き足す（同じ討論・同じ論点は置き換える）。 */
  private async saveDigs(digs: DecisionDig[]): Promise<void> {
    const s = (await this.store.get(this.tenantId, this.sessionId))!;
    const rest = s.digs.filter((x) => !digs.some((d) => d.debate === x.debate && d.issue === x.issue && d.byHuman === x.byHuman));
    await this.store.update(this.tenantId, this.sessionId, { digs: [...rest, ...digs] });
  }

  /** 1 つの論点の深掘り。 */
  private async dig(session: StoredDecision, debate: number, d: DecisionDig, order: ('con' | 'pro')[], viewpoints: string[]): Promise<void> {
    if (!d.question) {
      // 人が選んだ論点は、決着させたい問いを判定の役が書く
      const context = await this.contextFor(session, debate, viewpoints, d.issue);
      const res = await this.call('advanced', [{ role: 'system', content: JUDGE_SYSTEM }, { role: 'user', content: digAsk({ context, candidates: [d.issue], max: 1 }) }], 600);
      const j = parseJsonObject(res.text) ?? {};
      const first = Array.isArray(j['digs']) ? (j['digs'] as Record<string, unknown>[])[0] : undefined;
      d = { ...d, question: s(first?.['question'], 200) || `論点「${d.issue}」はどちらが正しいか` };
      await this.saveDigs([d]);
    }
    let staleRun = 0;
    for (let i = d.used; i < d.turns; i++) {
      const start = (await this.stateOf(debate)).lastTurn;
      const t = start + 1;
      for (const role of order) {
        await this.checkStop();
        await this.progress(debate, `深掘り（${d.issue}）: ${DECISION_ROLE_LABELS[role]}が考えています（${i + 1} / ${d.turns} ターン）`);
        await this.speak(session, { debate, role, turn: t, viewpoints, first: false, dig: { issue: d.issue, question: d.question } });
      }
      d = { ...d, used: i + 1 };
      await this.saveDigs([d]);
      staleRun = (await this.turnIsFresh(debate, t)) ? 0 : staleRun + 1;
      if (staleRun >= 1) break;
    }
    await this.summarize(session, debate, AT.dig(d.issue), `深掘りの終わり: ${d.issue}`, false, d.issue);
    await this.saveDigs([{ ...d, done: true }]);
  }

  /** 1 つの討論の結果の文（突き合わせと報告に使う）。 */
  private async debateDigest(debate: number): Promise<string> {
    const [turns, claims, states] = await Promise.all([
      this.store.turns(this.tenantId, this.sessionId),
      this.store.claims(this.tenantId, this.sessionId),
      this.store.issueStates(this.tenantId, this.sessionId),
    ]);
    const end = turns.filter((t) => t.debate === debate && t.role === 'judge' && t.stage === 'summary').at(-1);
    const last = new Map<string, DecisionIssueState>();
    for (const x of states.filter((y) => y.debate === debate)) last.set(x.issue, x);
    const lines = [end ? end.text : '（まとめがありません）', '', '論点ごとの優勢:'];
    for (const x of last.values()) lines.push(`- ${x.issue}: ${DECISION_LEAN_LABELS[x.lean]}${x.changedBy ? `（${x.changedBy} で変化）` : ''}`);
    lines.push('', '主な主張:');
    for (const c of claims.filter((y) => y.debate === debate && y.state !== 'refuted').slice(0, 40)) lines.push(`- ${c.code}（${c.issue}）${c.gist}`);
    return lines.join('\n');
  }

  /** 2 つの討論の突き合わせ（第43.6.4節）。 */
  async compare(session: StoredDecision): Promise<DecisionComparison> {
    const [one, two] = await Promise.all([this.debateDigest(1), this.debateDigest(2)]);
    const res = await this.call('advanced', [{ role: 'system', content: JUDGE_SYSTEM }, { role: 'user', content: compareAsk({ question: session.question, one, two }) }], 2000);
    const j = parseJsonObject(res.text) ?? {};
    const comparison: DecisionComparison = {
      agreement: j['agreement'] === 'agree' ? 'agree' : 'split',
      splits: (Array.isArray(j['splits']) ? j['splits'] as Record<string, unknown>[] : []).map((x) => ({ issue: s(x['issue'], 40), reason: s(x['reason'], 300) })).filter((x) => x.issue).slice(0, 8),
      onlyIn: (Array.isArray(j['onlyIn']) ? j['onlyIn'] as Record<string, unknown>[] : []).map((x) => ({ debate: x['debate'] === 2 ? 2 : 1, issue: s(x['issue'], 40) })).filter((x) => x.issue).slice(0, 10),
    };
    await this.store.update(this.tenantId, this.sessionId, { comparison });
    const lines = [`【突き合わせ】2 つの討論の見立ては${comparison.agreement === 'agree' ? 'そろいました' : '割れました'}。`];
    for (const x of comparison.splits) lines.push(`割れた論点 ${x.issue}: ${x.reason}`);
    for (const x of comparison.onlyIn) lines.push(`討論 ${x.debate} にだけ出た論点: ${x.issue}`);
    await this.store.createTurn(this.tenantId, this.sessionId, { debate: 0, turn: 0, stage: 'compare', issue: null, role: 'judge', text: lines.join('\n'), done: true });
    await this.flushCost();
    return comparison;
  }

  /** 報告（第43.7節）。書かれるそばから流し、終わったら見出しで分ける。 */
  async report(_session: StoredDecision, comparison: DecisionComparison | null): Promise<DecisionReport> {
    const fresh = (await this.store.get(this.tenantId, this.sessionId))!;
    const debates = fresh.crossCheck ? [1, 2] : [1];
    const materials = await this.store.materials(this.tenantId, this.sessionId);
    const digests = await Promise.all(debates.map(async (d) => `${fresh.crossCheck ? `討論 ${d}:\n` : ''}${await this.debateDigest(d)}`));
    const claims = (await this.store.claims(this.tenantId, this.sessionId)).filter((c) => c.role === 'human');
    const context = [
      `判断の問い: ${fresh.question}`,
      `観点: ${fresh.viewpoints.join('、')}`,
      '',
      '材料:',
      materialsText(materials, fresh.missing),
      '',
      ...digests,
      claims.length ? `\n経営者の発言: ${claims.map((c) => c.body).join(' ／ ')}` : '',
      fresh.digs.length ? `\n深掘りした論点: ${fresh.digs.map((d) => `${d.issue}（${d.question}）`).join('、')}` : '',
    ].join('\n');
    const comparisonText = comparison
      ? [`見立て: ${comparison.agreement === 'agree' ? 'そろった' : '割れた'}`, ...comparison.splits.map((x) => `割れた論点 ${x.issue}: ${x.reason}`)].join('\n')
      : '';
    const row = await this.store.createTurn(this.tenantId, this.sessionId, { debate: 0, turn: 0, stage: 'report', issue: null, role: 'judge' });
    const text = await this.stream(row.id, [
      { role: 'system', content: JUDGE_SYSTEM },
      { role: 'user', content: reportAsk({ context, crossCheck: fresh.crossCheck, comparison: comparisonText }) },
    ], 'advanced');
    await this.store.setTurn(this.tenantId, row.id, { text, done: true });
    const sections = splitReport(text);
    const verdictBody = sections.find((x) => x.heading === '見立て')?.body ?? '';
    const verdict = verdictBody.split('\n').find((l) => l.trim())?.trim().replace(/^[-・*]\s*/, '').slice(0, 80) ?? '';
    const report: DecisionReport = { verdict: verdict || '（見立てを読み取れませんでした）', sections: sections.length ? sections : [{ heading: '報告', body: text.trim() }] };
    await this.store.update(this.tenantId, this.sessionId, { report });
    await this.flushCost();
    return report;
  }
}

/** 討論の発言の並び（画面とテストで使う）。 */
export function speechesOf(turns: DecisionTurn[], debate: number): DecisionTurn[] {
  return turns.filter((t) => t.debate === debate && (t.role === 'con' || t.role === 'pro'));
}
