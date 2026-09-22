/**
 * @file 基盤が提供するツールの全体と、知識検索・会議の記録・文書作成のツール。
 *
 * 危険度は仕様書 第9.4節の区分に従う。
 * `external-send` 以上のツールは、定義に承認ゲートが無ければ実行前に拒否される。
 *
 * @see 仕様書 第9.4節 ツールと承認の対応
 */

import { randomUUID } from 'node:crypto';
import type { Tool } from './registry.js';
import { WORKSPACE_TOOLS } from './workspace.js';
import { FILE_TOOLS } from './files.js';

/** 組織知識を検索する。出典を伴って返す（仕様書 第9.7節）。 */
export const knowledgeSearch: Tool = {
  name: 'knowledge.search',
  risk: 'read',
  description: '組織知識を検索し、出典つきで返す',
  async invoke(args, ctx) {
    const query = String(args['query'] ?? '');
    const hits = await ctx.repo.searchKnowledge(ctx.tenantId, query, ctx.compartment);
    return {
      query,
      hits: hits.map((h) => ({ title: h.title, source: h.source, body: h.body })),
      found: hits.length,
    };
  },
};

/** 会議の記録を取得する。プロトタイプでは入力に貼り付けた本文を用いる。 */
export const meetingGetTranscript: Tool = {
  name: 'meeting.get_transcript',
  risk: 'read',
  description: '会議の文字起こしを取得する',
  async invoke(args) {
    const text = String(args['transcript'] ?? '');
    if (!text.trim()) {
      // 取得できなかった値を推測で埋めない（仕様書 第7.2節）
      return { available: false, reason: '文字起こしを取得できませんでした' };
    }
    return { available: true, text };
  },
};

/** 文書を生成して成果物として保存する。 */
export const documentCreate: Tool = {
  name: 'document.create',
  risk: 'draft',
  description: '文書を作成し、成果物として保存する',
  async invoke(args, ctx) {
    const id = randomUUID();
    await ctx.repo.createArtifact({
      id,
      runId: ctx.runId,
      tenantId: ctx.tenantId,
      kind: String(args['kind'] ?? 'document'),
      title: String(args['title'] ?? '無題'),
      body: String(args['body'] ?? ''),
      createdAt: new Date().toISOString(),
    });
    return { artifactId: id, title: args['title'] };
  },
};

/** 基盤が提供するツールの全体。エージェント定義はここから選ぶ。 */
export const BUILTIN_TOOLS: Tool[] = [
  knowledgeSearch,
  meetingGetTranscript,
  documentCreate,
  ...WORKSPACE_TOOLS,
  ...FILE_TOOLS,
];
