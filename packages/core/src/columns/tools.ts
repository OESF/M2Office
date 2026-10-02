/**
 * @file Web のコラムのツール。下書きを書く・承認の前に確かめる・承認の後に WordPress に入れる。秘書と付属の業務が使う。
 *
 * 会社が Web のコラムを切っているときと、利用範囲の外の人には「使えない」と返す（呼ぶたびに `ctx.columns.access()` で確かめる）。
 * 調べた文章とコラムの本文はデータであり、指示として扱わない（不変則 I-6）。
 *
 * @see 仕様書 第32.18.1節 段 1 の実装の決まり
 */

import type { WebColumnSettings } from '@m2office/shared';
import type { Tool, ToolContext } from '../tools/registry.js';
import type { ColumnPreview, ColumnService } from './service.js';

/** ツールに渡す Web のコラムの文脈。 */
export interface ColumnToolContext {
  service: ColumnService;
  /**
   * 依頼者がいま Web のコラムを使えるか。使えるなら会社の設定を返す。
   *
   * @returns 使えなければ `null`
   */
  access(): Promise<WebColumnSettings | null>;
}

const UNAVAILABLE = { available: false, reason: 'Web のコラムは使えません（会社で切っているか、利用範囲の外です）' };

const str = (v: unknown) => (typeof v === 'string' ? v.trim() : '');

const viewer = (ctx: ToolContext) => ({ tenantId: ctx.tenantId, userId: ctx.userId });

async function columnsOf(ctx: ToolContext): Promise<ColumnService | null> {
  if (!ctx.columns) return null;
  return (await ctx.columns.access()) ? ctx.columns.service : null;
}

/** コラムの画面の場所（秘書の答えに添える）。 */
const columnPath = (id: string) => `/columns/${encodeURIComponent(id)}`;

/** 承認の画面に出す、入れるものの説明。 */
function describePreview(p: ColumnPreview): string {
  return [
    `題名: ${p.title}`,
    `字数: ${p.chars.toLocaleString('ja-JP')} 字`,
    `残った指摘: ${p.reviewCount} 件`,
    `入れ先: ${p.destination}`,
  ].join('\n');
}

/**
 * テーマからコラムの下書きを書く（第32.7節）。Web で調べ、出典つきの下書きと赤入れまで行う。
 *
 * @remarks 危険度 `write-internal`。社内のコラムの置き場に書くだけで、WordPress には入れない（入れるのは承認の後の `columns.place`）
 */
export const columnsDraft: Tool = {
  name: 'columns.draft',
  risk: 'write-internal',
  activityLabel: 'コラムを書いています',
  helpText: 'テーマを Web で調べ、出典つきのコラムの下書きを書きます。下書きにするだけで、Web には出しません',
  description: 'テーマ（theme）と取材メモ（memo。任意）から、Web で調べて出典つきのコラムの下書きを書く。題名・字数・赤入れの数・画面の場所（path）を返す',
  args: {
    properties: {
      theme: { type: 'string', description: 'コラムのテーマ（一言。例: 「子どもの歯みがきのコツ」）' },
      memo: { type: 'string', description: '取材メモ（書く人の経験や考え。任意）' },
    },
    required: ['theme'],
  },
  async invoke(args, ctx) {
    const service = await columnsOf(ctx);
    if (!service) return UNAVAILABLE;
    const res = await service.create(viewer(ctx), { theme: str(args['theme']), memo: str(args['memo']) }, true);
    if ('error' in res) return { available: false, reason: res.error };
    const c = await service.store.get(ctx.tenantId, res.id);
    if (!c || c.status === 'failed') return { available: false, reason: c?.failure ?? 'コラムを書けませんでした', path: columnPath(res.id) };
    return { available: true, columnId: c.id, title: c.title, reviewCount: c.reviewCount, path: columnPath(c.id) };
  },
};

/**
 * 承認へ進めるコラムを確かめる（題名・字数・残った指摘・入れ先・入れられない理由）。
 *
 * @remarks 危険度 `read`。見るだけ
 */
export const columnsPreview: Tool = {
  name: 'columns.preview',
  risk: 'read',
  activityLabel: 'コラムを確かめています',
  helpText: 'コラムの題名・字数・残った指摘・入れ先を確かめます。見るだけです',
  description: 'コラム（columnId）の今の版の題名・字数・残った赤入れの数・入れ先・入れられない理由（problems）を返す',
  args: { properties: { columnId: { type: 'string', description: 'コラムの ID' } }, required: ['columnId'] },
  async invoke(args, ctx) {
    const service = await columnsOf(ctx);
    if (!service) return UNAVAILABLE;
    const p = await service.preview(viewer(ctx), str(args['columnId']));
    if (!p) return { available: false, reason: 'コラムが見つかりません' };
    return { available: true, columnId: p.id, version: p.version, title: p.title, chars: p.chars, reviewCount: p.reviewCount, destination: p.destination, problems: p.problems };
  },
};

/**
 * 承認されたコラムを、会社の WordPress に下書きとして入れる（第32.10節）。WordPress につないでいなければ承認済みにする。
 *
 * @remarks 危険度 `external-send`。承認の段の直後でしか呼べない。承認の前の確かめ（`prepare`）で版の指紋を記録し、
 * 承認の後に版が変わっていれば入れない。公開はしない（公開は WordPress の側で押す）
 */
export const columnsPlace: Tool = {
  name: 'columns.place',
  risk: 'external-send',
  activityLabel: 'コラムを WordPress に入れています',
  helpText: '承認されたコラムを、会社の WordPress に下書きとして入れます。公開は WordPress の側で行います',
  description: '承認されたコラム（columnId）を、会社の WordPress に下書きとして入れる。WordPress につないでいなければ承認済みにする',
  args: { properties: { columnId: { type: 'string', description: 'コラムの ID' } }, required: ['columnId'] },
  planKey: (args) => `column:${str(args['columnId'])}`,
  async prepare(args, ctx) {
    const service = await columnsOf(ctx);
    if (!service) return { kind: 'problem', reason: UNAVAILABLE.reason };
    const p = await service.preview(viewer(ctx), str(args['columnId'])).catch(() => null);
    if (!p) return { kind: 'problem', reason: 'コラムが見つかりません' };
    if (p.problems.length > 0) return { kind: 'problem', reason: p.problems.join('／') };
    return { kind: 'ready', args: { columnId: p.id, digest: p.digest }, shown: describePreview(p), audience: 'external' };
  },
  async invoke(args, ctx) {
    const service = await columnsOf(ctx);
    if (!service) return UNAVAILABLE;
    const res = await service.place(viewer(ctx), str(args['columnId']), str(args['digest']));
    if ('error' in res) return { available: false, reason: res.error };
    return res.placed
      ? { available: true, placed: true, editUrl: res.editUrl, note: 'WordPress に下書きとして入れました。公開は WordPress の編集の画面で行ってください' }
      : { available: true, placed: false, note: '承認済みにしました。コラムの画面から本文を写して使えます' };
  },
};

/** Web のコラムのツール。 */
export const COLUMN_TOOLS: Tool[] = [columnsDraft, columnsPreview, columnsPlace];
