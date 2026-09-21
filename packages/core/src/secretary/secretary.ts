import { randomUUID } from 'node:crypto';
import type { AgentDefinition } from '@m2office/shared';
import type { Repository } from '../repository/types.js';
import type { LlmProvider } from '../llm/provider.js';
import { DIRECT_QUERIES, type DirectAnswer } from './catalog.js';

/** 秘書がどの層で応答したか。計測と表示に使う（仕様書 第8.9.1節）。 */
export type ResponseLayer = 'direct' | 'light' | 'full';

export interface SecretaryReply {
  layer: ResponseLayer;
  text: string;
  evidence: { label: string; value: string }[];
  /** 業務エージェントの起動を提案する場合、その候補。 */
  suggestedAgent?: { id: string; version: number; name: string };
  tokensUsed: number;
}

export interface SecretaryDeps {
  repo: Repository;
  llm: LlmProvider;
  agents: AgentDefinition[];
}

/**
 * 秘書エージェント。従業員とシステムの間に立つ窓口。
 *
 * 依頼を 3 層に振り分ける（仕様書 第8.9節）。
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
    // 層 1: パターン一致で定型の照会に該当するか（LLM を使わない）
    const direct = this.matchDirect(message);
    if (direct) {
      const answer = await direct.answer({ tenantId, userId, repo: this.deps.repo });
      await this.audit(tenantId, userId, 'secretary.direct', direct.id);
      return { layer: 'direct', ...answer, tokensUsed: 0 };
    }

    // 層 2: 高速モデルで業務エージェントへの取次を判定する
    const routed = await this.route(message);
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

    // 層 3: 完全な対話
    const res = await this.deps.llm.complete({
      tier: 'standard',
      messages: [
        { role: 'system', content: 'あなたは中小企業の従業員に付く秘書です。簡潔な日本語で答えます。' },
        { role: 'user', content: message },
      ],
    });
    await this.audit(tenantId, userId, 'secretary.chat', 'full');
    return { layer: 'full', text: res.text, evidence: [], tokensUsed: res.tokensUsed };
  }

  private matchDirect(message: string) {
    return DIRECT_QUERIES.find((q) => q.patterns.some((p) => p.test(message)));
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
  ): Promise<{ agent?: AgentDefinition; reason: string; tokensUsed: number }> {
    const byKeyword = this.deps.agents.find(
      (a) =>
        message.includes(a.name) ||
        a.category === 'meeting' && /議事録|会議/.test(message) ||
        a.category === 'knowledge' && /規程|ルール|決まり|教えて/.test(message),
    );
    if (byKeyword) return { agent: byKeyword, reason: '語句の一致', tokensUsed: 0 };

    const list = this.deps.agents.map((a) => `${a.id}: ${a.name} — ${a.description}`).join('\n');
    const res = await this.deps.llm.complete({
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
    const picked = this.deps.agents.find((a) => res.text.includes(a.id));
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
