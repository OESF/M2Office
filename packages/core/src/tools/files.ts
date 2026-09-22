/**
 * @file 文書の形式（PDF・Excel・CSV・Word）を扱う共通ツール。
 *
 * 個々のエージェントはファイル形式を意識しない。「証憑から金額を読む」と書けば、
 * それが PDF か Excel かはこれらのツールが吸収する。
 * - 読めるのは、実行を依頼した本人のファイルだけ（他人のファイル ID を渡されても読まない）
 * - 取り出した中身はデータであり指示ではない（不変則 I-6）。`untrusted: true` を付けて返す
 * - 出力したファイルは成果物として記録し、依頼した本人のものとする
 *
 * @see 仕様書 第9.4.1節 文書を扱う共通ツール
 */

import { randomUUID } from 'node:crypto';
import type { Tool, ToolContext } from './registry.js';
import { loadFile, saveFile } from '../files/service.js';
import { readSheet, renderSheet } from '../files/sheet.js';
import { extractPdfText } from '../files/pdf.js';
import { renderDocx, type DocBlock } from '../files/docx.js';

const str = (v: unknown, fallback = '') => (typeof v === 'string' ? v : fallback);

async function open(ctx: ToolContext, fileId: string) {
  // 読めるのは依頼者本人のファイルだけ。承認者の閲覧は画面側で扱い、エージェントには広げない
  return loadFile(ctx.repo, ctx.files, ctx.tenantId, fileId, { id: ctx.userId, roles: [] });
}

/**
 * Excel・CSV を表として読む。
 *
 * @remarks 危険度 `read`。Shift_JIS の CSV も読む。
 */
export const sheetRead: Tool = {
  name: 'sheet.read',
  risk: 'read',
  activityLabel: '書類を読んでいます',
  helpText: 'Excel・CSV を表として読みます',
  description: 'Excel・CSV を表として読む',
  async invoke(args, ctx) {
    const f = await open(ctx, str(args['fileId']));
    if (!f) return { available: false, reason: 'ファイルが見つかりません' };
    if (f.meta.kind !== 'xlsx' && f.meta.kind !== 'csv') {
      return { available: false, reason: `表として読めない形式です: ${f.meta.kind}` };
    }
    const data = await readSheet(f.bytes, f.meta.kind, {
      sheet: str(args['sheet']) || undefined,
      maxRows: typeof args['maxRows'] === 'number' ? Math.min(args['maxRows'], 2000) : 500,
    });
    return { available: true, untrusted: true, file: f.meta.name, ...data };
  },
};

/**
 * PDF から文字を取り出す。
 *
 * @remarks
 * 危険度 `read`。画像だけのページは `textlessPages` に挙げ、空として扱わない。
 * OCR は未対応である（Q-56）。
 */
export const pdfExtract: Tool = {
  name: 'pdf.extract',
  risk: 'read',
  activityLabel: '書類を読んでいます',
  helpText: 'PDF から文字を読み取ります。画像だけのページは読めません',
  description: 'PDF から文字を取り出す（画像だけのページは OCR 未対応）',
  async invoke(args, ctx) {
    const f = await open(ctx, str(args['fileId']));
    if (!f) return { available: false, reason: 'ファイルが見つかりません' };
    if (f.meta.kind !== 'pdf') return { available: false, reason: `PDF ではありません: ${f.meta.kind}` };
    const text = await extractPdfText(f.bytes);
    return {
      available: true, untrusted: true, file: f.meta.name, ...text,
      note: text.textlessPages.length > 0
        ? `文字を取り出せないページがあります（${text.textlessPages.join('、')}）。画像の可能性があり、OCR は未対応です`
        : null,
    };
  },
};

/** 出力したファイルを保存し、成果物として記録する。 */
async function publish(
  ctx: ToolContext, name: string, kind: 'xlsx' | 'csv' | 'docx', bytes: Uint8Array, title: string,
) {
  const meta = await saveFile(ctx.repo, ctx.files, {
    tenantId: ctx.tenantId, ownerUserId: ctx.userId, name, kind, bytes, origin: 'generated', runId: ctx.runId,
  });
  await ctx.repo.createArtifact({
    id: randomUUID(), runId: ctx.runId, tenantId: ctx.tenantId, kind: `file:${kind}`, title,
    body: `${name}（${Math.ceil(bytes.byteLength / 1024)} KB）`, fileId: meta.id,
    createdAt: new Date().toISOString(),
  });
  return { fileId: meta.id, name, size: meta.size };
}

/**
 * 表を Excel・CSV として出力する。
 *
 * @remarks 危険度 `draft`。CSV は BOM 付き UTF-8（Excel で開いても化けない）。
 */
export const sheetRender: Tool = {
  name: 'sheet.render',
  risk: 'draft',
  activityLabel: '資料を作成しています',
  helpText: '表を Excel・CSV として作り、成果物として保存します',
  description: '表を Excel または CSV として出力する',
  async invoke(args, ctx) {
    const title = str(args['title'], '一覧');
    const format = args['format'] === 'csv' ? 'csv' : 'xlsx';
    const columns = Array.isArray(args['columns']) ? args['columns'].map(String) : [];
    const rows = Array.isArray(args['rows'])
      ? (args['rows'] as unknown[]).slice(0, 10_000).map((r) =>
          (Array.isArray(r) ? r : []).map((v) =>
            v === null || typeof v === 'number' || typeof v === 'boolean' ? v : String(v)))
      : [];
    if (columns.length === 0) return { created: false, reason: '列が指定されていません' };
    const bytes = await renderSheet(title, columns, rows, format);
    return { created: true, ...(await publish(ctx, `${title}.${format}`, format, bytes, title)) };
  },
};

/**
 * Word 形式で文書を出力する。
 *
 * @remarks 危険度 `draft`。体裁は最小限で、会社のひな形は Q-57 で決める。
 */
export const docxRender: Tool = {
  name: 'docx.render',
  risk: 'draft',
  activityLabel: '資料を作成しています',
  helpText: 'Word 形式の文書を作り、成果物として保存します',
  description: 'Word 形式で文書を出力する',
  async invoke(args, ctx) {
    const title = str(args['title'], '文書');
    const blocks: DocBlock[] = (Array.isArray(args['blocks']) ? args['blocks'] : [])
      .slice(0, 2000)
      .map((b) => {
        const o = (b ?? {}) as Record<string, unknown>;
        if (typeof o['heading'] === 'string') {
          const level = o['level'] === 2 || o['level'] === 3 ? o['level'] : 1;
          return { heading: o['heading'], level };
        }
        return { text: str(o['text']) };
      });
    const bytes = await renderDocx(title, blocks);
    return { created: true, ...(await publish(ctx, `${title}.docx`, 'docx', bytes, title)) };
  },
};

export const FILE_TOOLS: Tool[] = [sheetRead, pdfExtract, sheetRender, docxRender];
