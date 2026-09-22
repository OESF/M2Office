/**
 * @file 秘書エージェント。依頼を 3 層（直接応答・取次・対話）に振り分けて応答する。
 *
 * @see 仕様書 第10章 秘書エージェント
 * @see 仕様書 第10.9節 応答の経路
 */

import { randomUUID } from 'node:crypto';
import type { AgentDefinition } from '@m2office/shared';
import type { Repository } from '../repository/types.js';
import type { LlmProvider } from '../llm/provider.js';
import type { WorkspaceConnector } from '../connectors/types.js';
import type { HelpCatalog } from '../help/articles.js';
import { DIRECT_QUERIES, type DirectAnswer } from './catalog.js';

/** 秘書がどの層で応答したか。計測と表示に使う（仕様書 第10.9.1節）。 */
export type ResponseLayer = 'direct' | 'light' | 'full';

export interface SecretaryReply {
  layer: ResponseLayer;
  text: string;
  evidence: { label: string; value: string }[];
  /** 業務エージェントの起動を提案する場合、その候補。 */
  suggestedAgent?: { id: string; version: number; name: string };
  /** 使い方の質問に答えた場合、材料にしたヘルプの記事（仕様書 第6.10.6節）。 */
  helpArticles?: { id: string; title: string }[];
  tokensUsed: number;
}

export interface SecretaryDeps {
  repo: Repository;
  llm: LlmProvider;
  connector: WorkspaceConnector;
  agents: AgentDefinition[];
  /** ヘルプの記事。あれば使い方の質問に答える（仕様書 第6.10.6節）。 */
  help?: HelpCatalog;
  /** その会社で使える業務エージェント（公式と導入した拡張機能）。省略時は `agents`。 */
  agentsFor?(tenantId: string, userId?: string): Promise<AgentDefinition[]>;
  /** 会社ごとの推論（会社が自社の鍵を登録していればその鍵。仕様書 第14.3.3節）。省略時は `llm`。 */
  llmFor?(tenantId: string): Promise<LlmProvider>;
}

/**
 * 秘書エージェント。従業員とシステムの間に立つ窓口。
 *
 * 依頼を 3 層に振り分ける（仕様書 第10.9節）。
 * 層 1 は LLM を介さず、層 2 は高速モデルで判定し、層 3 で完全な対話を行う。
 *
 * @remarks
 * テナント境界: 秘書は担当する従業員本人の権限を超えない（不変則 I-9）。
 * 権限区画のデータは、本人参照のみ層 1 の対象とする（第16.3.4節）。
 */
export class Secretary {
  constructor(private readonly deps: SecretaryDeps) {}

  /**
   * 依頼に応答する。
   *
   * @param tenantId テナント
   * @param userId 依頼した従業員
   * @param message 依頼の本文
   * @returns 応答と、用いた層
   */
  async respond(tenantId: string, userId: string, message: string): Promise<SecretaryReply> {
    // 使い方の質問は、定型の照会より先に見る。「承認はどうやるの？」を承認待ちの照会と取り違えないため
    if (this.deps.help && HOW_TO.test(message)) {
      return this.answerHowTo(tenantId, userId, message, this.deps.help);
    }

    // 層 1: パターン一致で定型の照会に該当するか（LLM を使わない）
    const direct = this.matchDirect(message);
    if (direct) {
      const answer = await direct.answer({
        tenantId, userId, message, repo: this.deps.repo, connector: this.deps.connector,
      });
      await this.audit(tenantId, userId, 'secretary.direct', direct.id);
      return { layer: 'direct', ...answer, tokensUsed: 0 };
    }

    // 層 2: 高速モデルで業務エージェントへの取次を判定する。無効にされた業務には取り次がない
    const { agents } = await this.deps.repo.getTenantSettings(tenantId);
    // 本人の利用範囲（第16.7節）の外の業務には取り次がない
    const available = this.deps.agentsFor ? await this.deps.agentsFor(tenantId, userId) : this.deps.agents;
    const enabled = available.filter((a) => !agents.disabled.includes(a.id));
    const llm = this.deps.llmFor ? await this.deps.llmFor(tenantId) : this.deps.llm;
    const routed = await this.route(message, enabled, llm);
    if (routed.agent) {
      await this.audit(tenantId, userId, 'secretary.route', routed.agent.id);
      return {
        layer: 'light',
        text: `「${routed.agent.name}」で対応できます。実行してよろしいですか。`,
        evidence: [{ label: '判定', value: routed.reason }],
        suggestedAgent: { id: routed.agent.id, version: routed.agent.version, name: routed.agent.name },
        tokensUsed: routed.tokensUsed,
      };
    }

    // 層 3: 完全な対話。本人が決めた名前・呼ばれ方・応対スタイルに合わせる（仕様書 第6.5.3節）
    const [prefs, user] = await Promise.all([
      this.deps.repo.getUserSettings(tenantId, userId),
      this.deps.repo.findUserById(tenantId, userId),
    ]);
    const s = prefs.secretary;
    const persona = [
      `あなたは中小企業の従業員に付く秘書${s.name ? `「${s.name}」` : ''}です。`,
      `相手を「${s.callMe || `${user?.displayName ?? ''}さん`}」と呼びます。`,
      s.style === 'concise' ? '要点だけを短く答えます。' : '丁寧な日本語で、要点を先に答えます。',
    ].join('');
    const res = await llm.complete({
      tier: 'standard',
      messages: [
        { role: 'system', content: persona },
        { role: 'user', content: message },
      ],
    });
    await this.audit(tenantId, userId, 'secretary.chat', 'full');
    return { layer: 'full', text: res.text, evidence: [], tokensUsed: res.tokensUsed };
  }

  /**
   * 使い方の質問に、ヘルプの記事から答える（仕様書 第6.10.6節）。
   *
   * @remarks
   * LLM を使わない。記事の抜粋と出典を返す。
   * 社内規程も検索し、「M2Office の使い方」と「社内の決まり」を分けて示す（方針 h5）。
   * どちらにも見当たらなければ、推測で答えずにそう伝える。
   */
  private async answerHowTo(
    tenantId: string, userId: string, message: string, help: HelpCatalog,
  ): Promise<SecretaryReply> {
    const [user, settings] = await Promise.all([
      this.deps.repo.findUserById(tenantId, userId),
      this.deps.repo.getTenantSettings(tenantId),
    ]);
    const agents = this.deps.agentsFor ? await this.deps.agentsFor(tenantId, userId) : this.deps.agents;
    const ctx = {
      roles: user?.roles ?? [], disabledAgents: settings.agents.disabled, automation: settings.automation, agents,
    };
    const hits = help.search(message, ctx, 3);
    // 区画の外として検索する。区画内の文書を使い方の答えに混ぜない
    const rules = (await this.deps.repo.searchKnowledge(tenantId, message, null)).slice(0, 2);

    const parts: string[] = [];
    const top = hits[0];
    if (top) parts.push(`M2Office の使い方（「${top.article.title}」より）: ${top.excerpt}`);
    if (rules.length > 0) {
      parts.push(`社内の規程では、${rules.map((r) => `「${r.title}」（${r.source}）`).join('、')}に記載があります。`);
    }
    if (parts.length === 0) {
      parts.push('ヘルプと社内の規程のどちらにも見当たりませんでした。言い方を変えて聞き直すか、社内の管理者に問い合わせてください。');
    }

    const agentId = top?.article.id.startsWith('agent-') ? top.article.id.slice('agent-'.length) : null;
    const agent = agentId ? agents.find((a) => a.id === agentId) : undefined;
    await this.audit(tenantId, userId, 'secretary.help', top?.article.id ?? 'none');
    return {
      layer: 'direct',
      text: parts.join('\n'),
      evidence: [
        ...hits.map((h) => ({ label: 'ヘルプ', value: h.article.title })),
        ...rules.map((r) => ({ label: '社内の規程', value: `${r.title}（${r.source}）` })),
      ],
      helpArticles: hits.map((h) => ({ id: h.article.id, title: h.article.title })),
      ...(agent ? { suggestedAgent: { id: agent.id, version: agent.version, name: agent.name } } : {}),
      tokensUsed: 0,
    };
  }

  private matchDirect(message: string) {
    return DIRECT_QUERIES.find(
      (q) => q.patterns.some((p) => p.test(message)) && !q.excludes?.some((p) => p.test(message)),
    );
  }

  /**
   * 依頼に対応する業務エージェントを判定する。
   *
   * @remarks
   * 判定には高速モデルを用いる。コストを抑えるため、
   * まず名前と説明の語句一致を試し、外れた場合のみ推論に回す。
   */
  private async route(
    message: string,
    candidates: AgentDefinition[],
    llm: LlmProvider = this.deps.llm,
  ): Promise<{ agent?: AgentDefinition; reason: string; tokensUsed: number }> {
    const byKeyword = candidates.find(
      (a) =>
        message.includes(a.name) ||
        a.category === 'meeting' && /議事録|会議/.test(message) ||
        a.category === 'knowledge' && /規程|ルール|決まり|教えて/.test(message) ||
        a.category === 'mail' && /返信|下書き|受信箱/.test(message) ||
        a.category === 'calendar' && /日程|調整|空いて/.test(message) ||
        a.category === 'briefing' && /ブリーフ|まとめて|今週/.test(message),
    );
    if (byKeyword) return { agent: byKeyword, reason: '語句の一致', tokensUsed: 0 };

    if (candidates.length === 0) return { reason: '使える業務がありません', tokensUsed: 0 };
    const list = candidates.map((a) => `${a.id}: ${a.name} — ${a.description}`).join('\n');
    const res = await llm.complete({
      tier: 'fast',
      maxOutputTokens: 50,
      messages: [
        {
          role: 'system',
          content: [
            '依頼に最も合う業務を 1 つ選び、その ID だけを返してください。',
            '該当しない場合は none と返してください。',
            '',
            list,
          ].join('\n'),
        },
        { role: 'user', content: message },
      ],
    });
    const picked = candidates.find((a) => res.text.includes(a.id));
    return picked
      ? { agent: picked, reason: '推論による判定', tokensUsed: res.tokensUsed }
      : { reason: '該当なし', tokensUsed: res.tokensUsed };
  }

  /** 層 1 の応答も含め、すべての応答を監査ログに残す（不変則 I-4）。 */
  private async audit(tenantId: string, userId: string, action: string, target: string) {
    await this.deps.repo.appendAudit({
      id: randomUUID(),
      tenantId,
      actorType: 'secretary',
      actorId: userId,
      action,
      targetType: 'secretary',
      targetId: target,
      detail: {},
      occurredAt: new Date().toISOString(),
    });
  }
}

export type { DirectAnswer };

/**
 * 使い方の質問に多い言い回し。
 *
 * @remarks 「今日の予定は？」のような照会や、「議事録をまとめて」のような依頼には当たらないようにする。
 */
const HOW_TO = /どうやって|どうすれば|どうやる|どうなる[？?]?$|どうなりますか|やり方|使い方|方法は|って何|とは[？?]?$|何ができ|できますか|どこで|どこから|ヘルプ|わからない|分からない|勝手に|見られ/;
