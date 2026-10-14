/**
 * @file 本人の記憶と会話の要約の埋め込みを後から作る見回り（仕様書 第11.13.4節。秘書の成長の段 2）。
 *
 * 秘書が答えるときに、依頼の文と意味の近い記憶と要約を選ぶため。会社の知識の埋め込み（`knowledge/embed.ts`）と同じ作りで、
 * 会社の推論の口で作り、ほかの口で代えない（ローカルの方針の会社の記憶を外へ出さないため）。モデルが替わったら順に作り直す。
 */

import type { LlmProvider } from '../llm/provider.js';
import { aiAvailable } from '../llm/unconfigured.js';
import type { Repository } from '../repository/types.js';
import { withAiUsage } from '../usage/ai-usage.js';
import { silentLogger, type Logger } from '../log/logger.js';

/**
 * 記憶と要約を意味で探すか（環境変数 `MEMORY_SEMANTIC` の `on`・`off`。既定は入り）。
 *
 * @remarks 会社の知識の意味の検索（`KNOWLEDGE_SEMANTIC`）とは別に決める。本人の記憶の中から材料を選ぶだけで、規程を根拠として示す使い方ではないため
 */
export function memorySemanticEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return env['MEMORY_SEMANTIC']?.trim().toLowerCase() !== 'off';
}

/** 1 回に埋め込む数（会社ごと）。 */
export const MEMORY_EMBED_BATCH = 32;
/** 失敗したら、やり直すまで待つ時間（ミリ秒）。5 回で諦める（置き場の側で数える）。 */
const RETRY_MS = 30 * 60_000;
/** モデルを替えたとき、1 回に作り直しの待ちに戻す数。 */
const RESET_BATCH = 200;

/** 記憶の埋め込みを作る部品が使うもの。 */
export interface MemoryEmbedderDeps {
  repo: Repository;
  /** その会社の推論（埋め込みを持たない口なら、その会社は言葉で探す） */
  llmFor(tenantId: string): Promise<LlmProvider>;
  logger?: Logger;
  /** 意味で探すか（既定は {@link memorySemanticEnabled}） */
  enabled?: () => boolean;
}

/**
 * 記憶と要約の埋め込みを作る見回り（ワーカーから呼ぶ）。
 *
 * @remarks テナント境界: 会社ごとに、その会社のものだけを読む（不変則 I-2）。中身はログに残さない
 */
export class MemoryEmbedder {
  private readonly log: Logger;
  /** 会社ごとの、いまの埋め込みのモデル（作ってみて分かる）。 */
  private readonly models = new Map<string, string>();

  constructor(private readonly deps: MemoryEmbedderDeps) {
    this.log = deps.logger ?? silentLogger;
  }

  /**
   * 会社ごとに、待っている記憶と要約を 1 回分（{@link MEMORY_EMBED_BATCH} 件まで）埋め込む。
   *
   * @returns 作った数と、失敗した数
   */
  async tick(): Promise<{ embedded: number; failed: number }> {
    const { repo } = this.deps;
    if (!(this.deps.enabled ?? memorySemanticEnabled)()) return { embedded: 0, failed: 0 };
    let embedded = 0;
    let failed = 0;
    for (const tenantId of await repo.listTenantIds()) {
      const llm = await this.deps.llmFor(tenantId).catch(() => null);
      if (!llm || !aiAvailable(llm) || !llm.embed) continue;
      const pending = await repo.memoryEmbedPending(tenantId, MEMORY_EMBED_BATCH).catch(() => []);
      if (pending.length === 0) {
        // 待つものが無ければ、ほかのモデルで作った埋め込みを作り直しの待ちに戻す
        const model = this.models.get(tenantId);
        if (model) await repo.resetMemoryEmbeddings(tenantId, model, RESET_BATCH).catch(() => 0);
        continue;
      }
      try {
        const out = await withAiUsage({ purpose: 'worker:memory-embed' }, () => llm.embed!({ items: pending.map((p) => ({ text: p.text })), kind: 'document' }));
        await repo.saveMemoryEmbeddings(tenantId, pending.map((p, i) => ({ kind: p.kind, id: p.id, userId: p.userId, vector: out.vectors[i]! })), out.model);
        this.models.set(tenantId, out.model);
        embedded += pending.length;
      } catch (err) {
        failed += pending.length;
        await repo.failMemoryEmbeddings(tenantId, pending, new Date(Date.now() + RETRY_MS).toISOString()).catch(() => undefined);
        // 記憶の中身はログに残さない
        this.log.warn('記憶を埋め込めませんでした', { tenantId, items: pending.length, err: err instanceof Error ? err.message : String(err) });
      }
    }
    return { embedded, failed };
  }
}
