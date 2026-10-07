/**
 * @file 知識の節の埋め込みを後から作る見回りと、質問を埋め込む口（仕様書 第11.7.6.1節、ADR-0009）。
 *
 * 知識の保存を待たせないため、節の埋め込みはワーカーが後から作る。作り終わるまでの節は、言葉の検索（段階 2）だけで見つかる。
 * 会社の推論の口（Gemini か、ローカルの方針ならローカル AI）で作り、ほかの口で代えない（ローカルの方針の会社の節を外へ出さないため）。
 * モデルが替わったら、古いモデルの埋め込みを順に作り直す（違うモデルの埋め込みどうしは比べられない）。
 */

import type { LlmProvider } from '../llm/provider.js';
import { aiAvailable } from '../llm/unconfigured.js';
import type { Repository } from '../repository/types.js';
import { withAiUsage } from '../usage/ai-usage.js';
import { silentLogger, type Logger } from '../log/logger.js';

/**
 * 意味での検索を使うか（環境変数 `KNOWLEDGE_SEMANTIC` の `on`・`off`）。
 *
 * @remarks 既定は、本番（`NODE_ENV=production`）では切り、それ以外では入り。本番では、評価（第11.7.6.5節）で採用の条件を満たしたと確かめてから入れる
 */
export function semanticSearchEnabled(env: Record<string, string | undefined> = process.env): boolean {
  const v = env['KNOWLEDGE_SEMANTIC']?.trim().toLowerCase();
  if (v === 'on') return true;
  if (v === 'off') return false;
  return env['NODE_ENV'] !== 'production';
}

/** 1 回に埋め込む節の数（Gemini の `batchEmbedContents` の上限より小さく）。 */
export const EMBED_BATCH = 32;
/** 失敗したら、やり直すまで待つ時間（ミリ秒）。5 回で諦める（置き場の側で数える）。 */
const RETRY_MS = 30 * 60_000;
/** モデルを替えたとき、1 回に作り直しの待ちに戻す数。 */
const RESET_BATCH = 200;

export interface KnowledgeEmbedderDeps {
  repo: Repository;
  /** その会社の推論（埋め込みを持たない口なら、その会社は意味での検索を使わない）。 */
  llmFor(tenantId: string): Promise<LlmProvider>;
  logger?: Logger;
  /** 意味での検索を使うか（既定は {@link semanticSearchEnabled}）。 */
  enabled?: () => boolean;
}

/**
 * 知識の節の埋め込みを作る見回り（ワーカーから呼ぶ）。
 */
export class KnowledgeEmbedder {
  private readonly log: Logger;
  /** 会社ごとの、いまの埋め込みのモデル（作ってみて分かる）。 */
  private readonly models = new Map<string, string>();

  constructor(private readonly deps: KnowledgeEmbedderDeps) {
    this.log = deps.logger ?? silentLogger;
  }

  /**
   * 会社ごとに、待っている節を 1 回分（{@link EMBED_BATCH} 節まで）埋め込む。
   *
   * @returns 作った節と、失敗した節の数
   */
  async tick(): Promise<{ embedded: number; failed: number }> {
    const { repo } = this.deps;
    if (!(this.deps.enabled ?? semanticSearchEnabled)()) return { embedded: 0, failed: 0 };
    let embedded = 0;
    let failed = 0;
    for (const tenantId of await repo.listTenantIds()) {
      const llm = await this.deps.llmFor(tenantId).catch(() => null);
      if (!llm || !aiAvailable(llm) || !llm.embed) continue;
      const pending = await repo.knowledgeEmbedPending(tenantId, EMBED_BATCH);
      if (pending.length === 0) {
        // 待つ節が無ければ、ほかのモデルで作った埋め込みを作り直しの待ちに戻す
        const model = this.models.get(tenantId);
        if (model) await repo.resetKnowledgeEmbeddings(tenantId, model, RESET_BATCH);
        continue;
      }
      try {
        const out = await withAiUsage({ purpose: 'worker:knowledge-embed' }, () => llm.embed!({
          items: pending.map((p) => ({ title: p.title, text: p.body })), kind: 'document',
        }));
        await repo.saveKnowledgeEmbeddings(tenantId, pending.map((p, i) => ({ itemId: p.itemId, ordinal: p.ordinal, vector: out.vectors[i]! })), out.model);
        this.models.set(tenantId, out.model);
        embedded += pending.length;
      } catch (err) {
        failed += pending.length;
        await repo.failKnowledgeEmbeddings(tenantId, pending, new Date(Date.now() + RETRY_MS).toISOString()).catch(() => undefined);
        // 節の中身はログに残さない
        this.log.warn('知識の節を埋め込めませんでした', { tenantId, sections: pending.length, err: err instanceof Error ? err.message : String(err) });
      }
    }
    return { embedded, failed };
  }
}

/**
 * 質問を埋め込む口を作る（知識の検索の `embed` に渡す。第11.7.6節）。
 *
 * @returns 埋め込みを持たない推論・意味での検索を切っているときは `undefined`（言葉の検索だけで探す）
 * @remarks 失敗してもその検索だけ言葉の検索で答える（利用者を止めない）。質問の埋め込みは保存しない（第11.7.6.4節）
 */
export function queryEmbedder(
  llm: LlmProvider, log: Pick<Logger, 'warn'> = silentLogger, enabled: () => boolean = semanticSearchEnabled,
): ((query: string) => Promise<{ vector: number[]; model: string } | null>) | undefined {
  if (!llm.embed || !aiAvailable(llm) || !enabled()) return undefined;
  return async (query) => {
    try {
      const out = await llm.embed!({ items: [{ text: query }], kind: 'query' });
      return out.vectors[0] ? { vector: out.vectors[0], model: out.model } : null;
    } catch (err) {
      log.warn('質問を埋め込めなかったため、言葉の検索だけで探します', { err: err instanceof Error ? err.message : String(err) });
      return null;
    }
  };
}
