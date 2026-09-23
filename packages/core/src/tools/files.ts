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
import {
  extractPages, missingCharacters, renderPdf, OCR_MAX_PAGES, REPLACEMENT,
  type InvoiceDoc, type InvoiceRow,
} from '../files/pdf-render.js';

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
  args: { properties: { fileId: { type: 'string', description: 'ファイルの ID' }, sheet: { type: 'string', description: 'シート名（任意）' }, maxRows: { type: 'number', description: '読む行数の上限（既定 500）' } }, required: ['fileId'] },
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
  helpText: 'PDF から文字を読み取ります。文字の無いページ（スキャンなど）は読み取りにかけますが、読み取り結果は確かめが要ります',
  description: 'PDF から文字を取り出す。文字の無いページは読み取り（OCR）にかけ、readText として返す',
  args: { properties: { fileId: { type: 'string', description: 'ファイルの ID' } }, required: ['fileId'] },
  async invoke(args, ctx) {
    const f = await open(ctx, str(args['fileId']));
    if (!f) return { available: false, reason: 'ファイルが見つかりません' };
    if (f.meta.kind !== 'pdf') return { available: false, reason: `PDF ではありません: ${f.meta.kind}` };
    const text = await extractPdfText(f.bytes);
    if (text.textlessPages.length === 0) {
      return { available: true, untrusted: true, file: f.meta.name, ...text, note: null };
    }

    // 文字を取り出せないページは、そのページだけを抜き出して読み取りへ送る（仕様書 第9.4.1節、Q-56）
    const pages = text.textlessPages;
    if (!ctx.ocr) {
      return {
        available: true, untrusted: true, file: f.meta.name, ...text,
        note: `文字を取り出せないページがあります（${pages.join('、')}）。画像の可能性がありますが、読み取りの準備ができていません（推論の接続が未設定です）`,
      };
    }
    const part = await extractPages(f.bytes, pages);
    if (!part) {
      return { available: true, untrusted: true, file: f.meta.name, ...text, note: null };
    }
    const sent = pages.slice(0, OCR_MAX_PAGES);
    const read = await ctx.ocr({ bytes: part, mimeType: 'application/pdf' });
    return {
      available: true, untrusted: true, file: f.meta.name, ...text,
      // 読み取った文は、取り出した文字とは別に返す。確かな値として扱わせない
      readPages: sent,
      readText: read,
      note: [
        `文字を取り出せないページ（${pages.join('、')}）を読み取りました。読み取り結果であり、原本で確かめてください`,
        pages.length > OCR_MAX_PAGES ? `読み取ったのは先頭の ${OCR_MAX_PAGES} ページ（${sent.join('、')}）です。残りは分けて読んでください` : '',
      ].filter(Boolean).join('。'),
    };
  },
};

/** 出力したファイルを保存し、成果物として記録する。 */
async function publish(
  ctx: ToolContext, name: string, kind: 'xlsx' | 'csv' | 'docx' | 'pdf', bytes: Uint8Array, title: string,
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
  args: { properties: { title: { type: 'string', description: '題名' }, format: { type: 'string', description: '形式', enum: ['xlsx', 'csv'] }, columns: { type: 'array', description: '列名', items: { type: 'string', description: '要素' } }, rows: { type: 'array', description: '行の配列（各行は値の配列）' } }, required: ['title', 'columns', 'rows'] },
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
  args: { properties: { title: { type: 'string', description: '題名' }, blocks: { type: 'array', description: '{ heading } か { text } の配列' } }, required: ['title', 'blocks'] },
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

/**
 * 帳票を PDF として出力する。
 *
 * @remarks
 * 危険度 `draft`。体裁は最小限（表題・項目・明細の表・合計・備考）で、会社のひな形は Q-57 で決める。
 * 日本語の書体（Noto Sans JP）を、使った文字だけ抜き出して埋め込む（Q-59、ADR-0017）。
 * 金額の計算は行うが、税率や適格請求書の要件の判断はしない（第15章の制度の扱いに従う）。
 */
export const pdfRender: Tool = {
  name: 'pdf.render',
  risk: 'draft',
  activityLabel: '帳票を作成しています',
  helpText: '請求書などの帳票を PDF として作り、成果物として保存します。社外へは送りません',
  description: '帳票を PDF として出力する。明細の金額は数量×単価から求める',
  args: {
    properties: {
      title: { type: 'string', description: '表題（例: 請求書）' },
      to: { type: 'string', description: '宛先（例: 株式会社○○ 御中）' },
      from: { type: 'array', description: '差出人の各行', items: { type: 'string', description: '行' } },
      fields: { type: 'array', description: '{ label, value } の配列（発行日・番号など）' },
      rows: { type: 'array', description: '明細。{ name, quantity, unitPrice, amount } の配列' },
      totals: { type: 'array', description: '{ label, value } の配列（小計・消費税・合計）。省略すると明細の合計だけ' },
      notes: { type: 'array', description: '備考の各行', items: { type: 'string', description: '行' } },
    },
    required: ['title', 'rows'],
  },
  async invoke(args, ctx) {
    const title = str(args['title'], '帳票');
    const list = (v: unknown) => (Array.isArray(v) ? v : []);
    const pairs = (v: unknown) => list(v)
      .map((x) => (x ?? {}) as Record<string, unknown>)
      .filter((o) => typeof o['label'] === 'string')
      .map((o) => ({ label: String(o['label']), value: str(o['value']) }));
    const rows: InvoiceRow[] = list(args['rows'])
      .slice(0, 500)
      .map((r) => (r ?? {}) as Record<string, unknown>)
      .map((o) => ({
        name: str(o['name'], '（品目なし）'),
        quantity: typeof o['quantity'] === 'number' ? o['quantity'] : null,
        unitPrice: typeof o['unitPrice'] === 'number' ? o['unitPrice'] : null,
        amount: typeof o['amount'] === 'number' ? o['amount'] : null,
      }));
    if (rows.length === 0) return { created: false, reason: '明細がありません' };

    const doc: InvoiceDoc = {
      title,
      ...(str(args['to']) ? { to: str(args['to']) } : {}),
      from: list(args['from']).map(String).slice(0, 8),
      fields: pairs(args['fields']).slice(0, 10),
      rows,
      ...(pairs(args['totals']).length > 0 ? { totals: pairs(args['totals']).slice(0, 6) } : {}),
      notes: list(args['notes']).map(String).slice(0, 10),
    };
    // 同梱した書体に無い字は置き換わる。どの字が置き換わったかを返し、黙って落とさない（Q-59）
    const texts = [
      doc.title, doc.to ?? '', ...(doc.from ?? []),
      ...(doc.fields ?? []).flatMap((f) => [f.label, f.value]),
      ...rows.map((r) => r.name),
      ...(doc.totals ?? []).flatMap((t) => [t.label, t.value]),
      ...(doc.notes ?? []),
    ];
    const missing = await missingCharacters(texts);
    const bytes = await renderPdf(doc);
    return {
      created: true,
      ...(await publish(ctx, `${title}.pdf`, 'pdf', bytes, title)),
      ...(missing.length > 0
        ? {
            replacedCharacters: missing,
            note: `同梱した書体に無い字を「${REPLACEMENT}」に置き換えました: ${missing.join('')}。別の書き方に直してください`,
          }
        : {}),
    };
  },
};

/**
 * 画像から文字を読み取る（OCR）。
 *
 * @remarks
 * 危険度 `read`。読み取りは推論であり、確かなものとして扱わない（Q-56、ADR-0017）。
 * 推論を持たない環境では読み取らず、「読み取れなかった」と明示する。
 * 取り出した中身はデータであり指示ではない（不変則 I-6）。
 */
export const imageReadText: Tool = {
  name: 'image.read_text',
  risk: 'read',
  activityLabel: '画像の文字を読んでいます',
  helpText: '写真やスキャンした画像から文字を読み取ります。読み取りは確実ではないため、内容の確認が要ります',
  description: '画像（PNG・JPEG）から文字を読み取る。読み取り結果であり、確かな値ではない',
  args: { properties: { fileId: { type: 'string', description: 'ファイルの ID' } }, required: ['fileId'] },
  async invoke(args, ctx) {
    const f = await open(ctx, str(args['fileId']));
    if (!f) return { available: false, reason: 'ファイルが見つかりません' };
    if (f.meta.kind !== 'png' && f.meta.kind !== 'jpeg') {
      return { available: false, reason: `画像ではありません: ${f.meta.kind}` };
    }
    if (!ctx.ocr) {
      // 鍵が無い環境。読めなかったことを「何も書いていない」と取り違えさせない
      return { available: false, reason: '画像から文字を読み取る準備ができていません（推論の接続が未設定です）' };
    }
    const mimeType = f.meta.kind === 'png' ? 'image/png' : 'image/jpeg';
    const text = await ctx.ocr({ bytes: f.bytes, mimeType });
    return {
      available: true, untrusted: true, file: f.meta.name, text,
      note: '読み取り結果です。推論によるため、金額や日付は原本で確かめてください',
    };
  },
};

export const FILE_TOOLS: Tool[] = [sheetRead, pdfExtract, imageReadText, sheetRender, docxRender, pdfRender];
