/**
 * @file 見積書のツール（AG-07 見積書作成。仕様書 第9.5.8節、ADR-0103）。
 *
 * 金額は推論に計算させず、数量×単価から決まった計算で出す（消費税は税率ごとに 1 回だけ端数を処理する）。
 * 見積書は金額を示す書類で、お金の確定ではない。送るのは承認の後（`gmail.send`）。
 * 見積書は販売の書類の 1 つとして残す（再見積・失注・見積からの受注。第42.14節）。販売の書類と受注を入れていない会社でも使える。
 * 販売の書類の処理の無い環境（単体のテストなど）では、いままでの見積書の記録（`quotes`）に残す。
 */

import { randomUUID } from 'node:crypto';
import {
  TAX_CATEGORY_LABELS, effectiveTaxTable, guessTaxCategory, plannedTaxNote, taxBreakdown, taxCategoryNote, taxCategoryOf, taxLegend, taxMark, taxRateOn, type TaxCategory,
  SALES_QUOTE_STATE_LABELS, salesQuoteLabel, salesQuoteState, type TenantSettings,
} from '@m2office/shared';
import type { QuoteItem, QuoteRecord } from '../repository/types.js';
import { renderPdf, renderRuledQuote, type InvoiceRow, type InvoiceStyleInput } from '../files/pdf-render.js';
import { loadInvoiceStyle } from '../files/invoice-style.js';
import { saveFile } from '../files/service.js';
import type { Tool, ToolContext } from './registry.js';
import type { CreatedQuote } from '../sales-docs/service.js';
import { docMarkdown } from '../sales-docs/render.js';

/** 有効期限の既定（日）。会社が見積書の型で決めていればそれを使う（第15.2.3節）。 */
export const QUOTE_VALID_DAYS = 30;
/** 1 通の品目の上限。 */
const QUOTE_ITEMS_MAX = 50;

const str = (v: unknown, fallback = '') => (typeof v === 'string' && v.trim() ? v.trim() : fallback);
const num = (v: unknown): number | null => {
  const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() ? Number(v.replace(/[,，円\s]/g, '')) : NaN;
  return Number.isFinite(n) ? n : null;
};

/** 品目の名前を比べる形（前の見積の単価を引くため）。 */
export const quoteItemKey = (name: string) => name.normalize('NFKC').replace(/[\s（）()「」]/g, '').toLowerCase();

/** 端数の処理（会社情報の「端数の扱い」）。 */
function rounder(mode: 'floor' | 'round' | 'ceil'): (n: number) => number {
  return mode === 'ceil' ? Math.ceil : mode === 'round' ? Math.round : Math.floor;
}

/**
 * 見積の金額を決まった計算で出す。消費税は税率ごとに合計してから 1 回だけ端数を処理する（適格請求書と同じ考え方）。
 *
 * @remarks 単価の無い品目は 0 円として数え、呼び出し側が「単価が入っていない」と示す
 */
export function quoteTotals(items: QuoteItem[], rounding: 'floor' | 'round' | 'ceil'): { subtotal: number; tax: number; total: number; byRate: { rate: number; base: number; tax: number }[] } {
  const r = rounder(rounding);
  const amount = quoteItemAmount;
  // 税率は 10・8・1・0（対象外）のどれでもよい（仕様書 第15.1.1節）。高い税率から並べ、対象外は最後
  const rates = [...new Set(items.map((i) => i.taxRate))].sort((a, b) => (a === 0 ? 1 : b === 0 ? -1 : b - a));
  const byRate = rates.map((rate) => {
    const base = items.filter((i) => i.taxRate === rate).reduce((n, i) => n + amount(i), 0);
    return { rate, base, tax: r((base * rate) / 100) };
  }).filter((x) => x.base > 0);
  const subtotal = items.reduce((n, i) => n + amount(i), 0);
  const tax = byRate.reduce((n, x) => n + x.tax, 0);
  return { subtotal, tax, total: subtotal + tax, byRate };
}

/**
 * 品目の金額（数量×単価−値引き）。値引きは 0 から数量×単価までに収める（第15.2.3節）。
 */
export function quoteItemAmount(i: QuoteItem): number {
  const gross = Math.round(i.quantity * (i.unitPrice ?? 0));
  return gross - Math.min(Math.max(0, Math.round(i.discount ?? 0)), Math.max(0, gross));
}

/** 日本時間の日付（`YYYY-MM-DD`）。 */
const jstDay = (d: Date) => new Date(d.getTime() + 9 * 3_600_000).toISOString().slice(0, 10);
const yen = (n: number) => `${n.toLocaleString('ja-JP')} 円`;

/** 渡された品目を整える（名前の無い行は落とす）。 */
function itemsOf(v: unknown): QuoteItem[] {
  return (Array.isArray(v) ? v : []).slice(0, QUOTE_ITEMS_MAX).map((x) => (x ?? {}) as Record<string, unknown>)
    .filter((o) => str(o['name']))
    .map((o) => ({
      name: str(o['name']).slice(0, 80),
      quantity: Math.max(0, num(o['quantity']) ?? 1),
      unit: str(o['unit'], '式').slice(0, 10),
      unitPrice: num(o['unitPrice']),
      // 税率は仮に 10。区分（taxCategory、または書かれた税率）から発行の日の税率を当て直す（仕様書 第15.1.1節）
      taxRate: 10,
      ...(categoryOf(o) ? { taxCategory: categoryOf(o)! } : {}),
      ...(str(o['group']) ? { group: str(o['group']).replace(/^[【\[]|[】\]]$/g, '').slice(0, 30) } : {}),
      ...((num(o['discount']) ?? 0) > 0 ? { discount: Math.round(num(o['discount'])!) } : {}),
    })) as QuoteItem[];
}

/** 渡された税の区分（`taxCategory`、または書かれた税率 8・1 は飲食料品、0 は対象外、10 は標準）。無ければ `undefined`。 */
function categoryOf(o: Record<string, unknown>): TaxCategory | undefined {
  const c = str(o['taxCategory']);
  if (c in TAX_CATEGORY_LABELS) return c as TaxCategory;
  const r = num(o['taxRate']);
  return r === 8 || r === 1 ? 'food' : r === 0 ? 'exempt' : r === 10 ? 'standard' : undefined;
}

/** 宛先に敬称が無ければ「御中」を付ける。 */
const addressee = (to: string) => (!to ? '' : /(御中|様|殿)$/.test(to) ? to : `${to} 御中`);

/** 見積書の備考（条件・備考・税率ごとの内訳・軽減税率の印の説明）。 */
export function quoteNotes(items: QuoteItem[], byRate: { rate: number; base: number; tax: number }[], extra: string[]): string[] {
  return [
    ...extra,
    byRate.length > 1 || byRate.some((x) => x.rate !== 10) ? taxBreakdown(byRate) : '',
    taxLegend(items.map((i) => i.taxRate)) ?? '',
  ].filter(Boolean).slice(0, 6);
}

/** 見積書の PDF に載せるもの。 */
export interface QuotePdfInput {
  /** 番号の欄（再見積なら版を添えたもの） */
  number: string;
  issuedOn: string;
  validUntil: string | null;
  /** 敬称つきの宛名（無ければ空） */
  to: string;
  paymentTerms: string;
  items: QuoteItem[];
  totals: { subtotal: number; total: number; byRate: { rate: number; tax: number }[] };
  notes: string[];
  /** 薄く入れる印（取り消し） */
  stamp?: string;
}

/**
 * 見積書の PDF を作る（会社の見積書の型・文言・ロゴ・差出人・印影。第15.2.3節）。業務の見積書と、販売の書類の見積書（再見積・取り消し）が使う。
 *
 * @param qs 会社の見積書の設定
 */
export async function renderQuotePdf(q: QuotePdfInput, style: InvoiceStyleInput, qs: TenantSettings['invoice']['quote']): Promise<Uint8Array> {
  const fields = [
    { label: qs.labels.number, value: q.number }, { label: qs.labels.issued, value: q.issuedOn },
    ...(q.paymentTerms ? [{ label: qs.labels.payment, value: q.paymentTerms }] : []),
    ...(q.validUntil ? [{ label: qs.labels.validUntil, value: q.validUntil }] : []),
  ];
  const sealStyle = { logo: style.logo ?? null, from: style.from ?? [], sealBox: style.sealBox ?? false, seal: style.seal ?? null };
  if (qs.template === 'simple') {
    return renderPdf({
      title: qs.title,
      style: sealStyle,
      ...(q.to ? { to: q.to } : {}),
      from: style.from ?? [],
      fields,
      rows: q.items.map((i): InvoiceRow => ({
        name: `${i.group ? `【${i.group}】` : ''}${i.name}${taxMark(i.taxRate)}（${i.quantity} ${i.unit}）${i.discount ? `（値引き ${yen(i.discount)}）` : ''}`,
        quantity: i.quantity, unitPrice: i.unitPrice ?? 0, amount: quoteItemAmount(i),
      })),
      totals: [
        { label: '小計', value: yen(q.totals.subtotal) },
        ...q.totals.byRate.filter((x) => x.rate !== 0).map((x) => ({ label: `消費税（${x.rate}%）`, value: yen(x.tax) })),
        { label: '合計', value: yen(q.totals.total) },
      ],
      notes: [...q.notes, ...(qs.notes ? [qs.notes] : [])],
      ...(q.stamp ? { stamp: q.stamp } : {}),
    });
  }
  return renderRuledQuote({
    title: qs.title,
    ...(q.to ? { to: q.to } : {}),
    fields,
    greeting: qs.greeting,
    rows: q.items.map((i) => ({
      ...(i.group ? { group: i.group } : {}), name: `${i.name}${taxMark(i.taxRate)}`, quantity: i.quantity, unit: i.unit,
      unitPrice: i.unitPrice, discount: i.discount ?? 0, amount: quoteItemAmount(i),
    })),
    totals: [
      { label: '小計', value: `￥${q.totals.subtotal.toLocaleString('ja-JP')}` },
      ...q.totals.byRate.filter((x) => x.rate !== 0).map((x, _k, all) => ({ label: all.length > 1 || x.rate !== 10 ? `消費税（${x.rate}%）` : '消費税', value: `￥${x.tax.toLocaleString('ja-JP')}` })),
      { label: '合計', value: `￥${q.totals.total.toLocaleString('ja-JP')}` },
    ],
    notes: [...(qs.notes ? [qs.notes] : []), ...q.notes],
    style: sealStyle,
    ...(q.stamp ? { stamp: q.stamp } : {}),
  });
}

/**
 * 見積書を作る（PDF と記録。本人のドライブに Google ドキュメントも作る）。
 *
 * @remarks
 * 危険度 `draft`（社外へは出さない）。金額は決まった計算。単価の無い品目は、会社が前に作った見積に同じ品目があればその単価を使い、
 * 無ければ 0 円のまま「単価が入っていない品目」として返す（推測で埋めない）。
 */
export const quoteCreate: Tool = {
  name: 'quote.create',
  risk: 'draft',
  activityLabel: '見積書を作っています',
  helpText: '見積書を PDF で作り、あなたのドライブにも保存します。社外へは送りません',
  description: '見積書を作る。品目ごとに名前・数量・単位・単価・税の区分（taxCategory: standard・food・news・exempt。分からなければ空）を渡す。区分（初期費用・月額費用など）と値引きの額は、依頼に書かれていれば渡す（値引きを自分で決めない）。金額・消費税・合計はツールが計算する（自分で計算しない）。単価が分からなければ unitPrice を空にする',
  args: {
    properties: {
      to: { type: 'string', description: '宛先（会社名・担当者。例: 株式会社○○ 山田様）' },
      items: { type: 'array', description: '品目。{ name, quantity, unit, unitPrice, taxCategory, group, discount } の配列。group は区分の見出し（任意）、discount は値引きの額（任意。依頼に書かれたものだけ）' },
      validDays: { type: 'number', description: '有効期限（発行から何日。既定は会社の見積書の設定）' },
      paymentTerms: { type: 'string', description: 'お支払い条件（任意。無ければ会社の既定）' },
      terms: { type: 'string', description: '納期などの条件（任意）' },
      notes: { type: 'string', description: '備考（任意）' },
    },
    required: ['items'],
  },
  async invoke(args, ctx) {
    const items = itemsOf(args['items']);
    if (items.length === 0) return { created: false, reason: '品目がありません' };
    if (ctx.salesDocs) return createAsDocument(args, items, ctx);
    const settings = await ctx.repo.getTenantSettings(ctx.tenantId);

    // 単価の無い品目は、会社が前に作った見積の同じ品目の単価を使う
    const past = await ctx.repo.listQuotes(ctx.tenantId, { limit: 100 });
    const fromPast: string[] = [];
    for (const it of items) {
      if (it.unitPrice !== null) continue;
      const hit = past.flatMap((q) => q.items).find((p) => quoteItemKey(p.name) === quoteItemKey(it.name) && p.unitPrice !== null);
      if (hit) { it.unitPrice = hit.unitPrice; fromPast.push(it.name); }
    }
    const missingPrice = items.filter((i) => i.unitPrice === null).map((i) => i.name);
    const now = new Date();
    const day = jstDay(now);
    // 税の区分: 渡された区分 → 前の見積の同じ品目 → 品名から推し量る。税率は発行の日の税率（第15.1.1節）
    const judged: string[] = [];
    const planned = new Set<string>();
    const table = ctx.taxTable ? await ctx.taxTable().catch(() => effectiveTaxTable(null)) : effectiveTaxTable(null);
    for (const it of items) {
      if (!it.taxCategory) {
        const before = past.flatMap((q) => q.items).find((p) => quoteItemKey(p.name) === quoteItemKey(it.name));
        if (before) it.taxCategory = taxCategoryOf(before);
        else {
          const g = guessTaxCategory(it.name);
          it.taxCategory = g.category;
          const note = taxCategoryNote(it.name, g.category, g.unsure);
          if (note) judged.push(note);
        }
      }
      it.taxRate = taxRateOn(it.taxCategory, day, table);
      const p = plannedTaxNote(it.taxCategory, day, table);
      if (p) planned.add(p);
    }
    const totals = quoteTotals(items, settings.company.taxRounding);

    const number = `Q-${day.replace(/-/g, '')}-${String((await ctx.repo.countQuotesOn(ctx.tenantId, day.replace(/-/g, ''))) + 1).padStart(2, '0')}`;
    const qs = settings.invoice.quote;
    const validDays = Math.min(Math.max(Math.round(num(args['validDays']) ?? qs.validDays ?? QUOTE_VALID_DAYS), 1), 365);
    const validUntil = jstDay(new Date(now.getTime() + validDays * 86_400_000));
    const to = str(args['to']).slice(0, 80);

    // 体裁は請求書と同じ会社の差出人・ロゴ・印。振込先と請求書の定型文は見積書に載せない。型と文言は会社の見積書の設定（第15.2.3節）
    const style = await loadInvoiceStyle(ctx);
    const paymentTerms = str(args['paymentTerms'], qs.paymentTerms).slice(0, 50);
    const notes = quoteNotes(items, totals.byRate, [str(args['terms']) ? `条件: ${str(args['terms'])}` : '', str(args['notes'])]);
    const bytes = await renderQuotePdf({ number, issuedOn: day, validUntil, to: addressee(to), paymentTerms, items, totals, notes }, style, qs);
    const name = `${qs.title}_${number}${to ? `_${to.replace(/[\\/:*?"<>|\s]+/g, '')}` : ''}.pdf`;
    const file = await saveFile(ctx.repo, ctx.files, { tenantId: ctx.tenantId, ownerUserId: ctx.userId, name, kind: 'pdf', bytes, origin: 'generated', runId: ctx.runId });

    const record: QuoteRecord = {
      id: `qt-${randomUUID()}`, tenantId: ctx.tenantId, number, requestedBy: ctx.userId, runId: ctx.runId, toName: to, items,
      subtotal: totals.subtotal, tax: totals.tax, total: totals.total, validUntil, fileId: file.id, createdAt: now.toISOString(),
    };
    await ctx.repo.createQuote(record);
    const markdown = quoteMarkdown(record, totals.byRate, notes);
    await ctx.repo.createArtifact({
      id: randomUUID(), runId: ctx.runId, tenantId: ctx.tenantId, kind: 'quote', title: `${qs.title} ${number}${to ? `（${to}）` : ''}`,
      body: markdown, fileId: file.id, createdAt: now.toISOString(),
    });

    // 本人のドライブに Google ドキュメントとしても残す（共有しない）。できなくても見積書は作れている
    let doc: { url: string | null } | { error: string };
    try {
      const d = await ctx.connector.docs.create({ tenantId: ctx.tenantId, userId: ctx.userId }, { title: `御見積書 ${number}${to ? ` ${to}` : ''}`, body: markdown, folderId: null });
      doc = { url: d.url };
    } catch (err) {
      doc = { error: err instanceof Error ? err.message : 'Google ドキュメントに保存できませんでした' };
    }
    return {
      created: true, quoteId: record.id, number, fileId: file.id, fileName: name, to, subtotal: totals.subtotal, tax: totals.tax, total: totals.total, validUntil,
      ...(fromPast.length ? { fromPast, note: `前の見積書の単価を使いました: ${fromPast.join('、')}` } : {}),
      ...(missingPrice.length || planned.size ? {
        ...(missingPrice.length ? { missingPrice } : {}),
        warning: [...(missingPrice.length ? [`単価が入っていない品目があります（0 円で作りました）: ${missingPrice.join('、')}`] : []), ...planned].join('。'),
      } : {}),
      ...(judged.length ? { taxNote: judged.join('。') } : {}),
      ...('error' in doc ? { docError: doc.error } : { docUrl: doc.url }),
    };
  },
};

/** 見積書の中身を Markdown にする（成果物と Google ドキュメント）。 */
export function quoteMarkdown(q: QuoteRecord, byRate: { rate: number; base?: number; tax: number }[], notes: string[]): string {
  return [
    `# 御見積書 ${q.number}`,
    '',
    `- 宛先: ${q.toName || '（未記入）'}`,
    `- 発行日: ${q.createdAt.slice(0, 10)}`,
    `- 有効期限: ${q.validUntil ?? ''}`,
    '',
    '| 品目 | 数量 | 単価 | 値引き | 金額 |',
    '|---|---|---|---|---|',
    ...q.items.map((i) => `| ${i.group ? `【${i.group}】` : ''}${i.name}${taxMark(i.taxRate)} | ${i.quantity} ${i.unit} | ${i.unitPrice === null ? '（未記入）' : yen(i.unitPrice)} | ${i.discount ? `-${yen(i.discount)}` : ''} | ${yen(quoteItemAmount(i))} |`),
    '',
    `- 小計: ${yen(q.subtotal)}`,
    ...byRate.map((x) => (x.rate === 0 ? `- 対象外: ${yen(x.base ?? 0)}` : `- 消費税（${x.rate}%）: ${yen(x.tax)}`)),
    `- **合計: ${yen(q.total)}**`,
    ...(notes.length ? ['', ...notes.map((n) => `- ${n}`)] : []),
  ].join('\n');
}

/**
 * これまでの見積書を探す（「〇〇社に出した見積は？」）。
 *
 * @remarks 危険度 `read`。宛先・番号・合計・有効期限だけを返す
 */
export const quoteSearch: Tool = {
  name: 'quote.search',
  risk: 'read',
  activityLabel: '見積書を探しています',
  helpText: 'これまでに作った見積書を、宛先で探します',
  description: 'これまでに作った見積書を探す（宛先に言葉を含むもの。空なら新しい順に 20 件）。state は 提出済み・受注済み・失注・期限切れ・取り消し',
  args: { properties: { to: { type: 'string', description: '宛先に含まれる言葉（会社名など）' } } },
  async invoke(args, ctx) {
    const today = jstDay(new Date());
    if (ctx.salesDocs) {
      const list = await ctx.salesDocs.service.listQuotes({ tenantId: ctx.tenantId, userId: ctx.userId }, { ...(str(args['to']) ? { party: str(args['to']) } : {}), limit: 20 });
      return {
        found: list.length,
        quotes: list.map((d) => ({
          quoteId: d.id, number: salesQuoteLabel(d), to: addressee(d.party.name || d.party.person), total: d.total, validUntil: d.validUntil, issuedAt: d.issuedOn,
          state: SALES_QUOTE_STATE_LABELS[salesQuoteState(d, today)], items: d.items.map((i) => `${i.name} ${i.quantity}${i.unit}${i.unitPrice === null ? '' : ` × ${yen(i.unitPrice)}`}`),
          ...(d.outcomeNote ? { lostReason: d.outcomeNote } : {}),
        })),
      };
    }
    const items = (await ctx.repo.listQuotes(ctx.tenantId, { to: str(args['to']), limit: 20 })).map((q) => ({
      number: q.number, to: q.toName, total: q.total, validUntil: q.validUntil, issuedAt: q.createdAt.slice(0, 10),
      expired: !!q.validUntil && q.validUntil < today, items: q.items.map((i) => i.name),
    }));
    return { found: items.length, quotes: items };
  },
};

/**
 * 見積書を送るメールの用意（送り先が無ければ送らない）。
 *
 * @remarks 危険度 `read`（何も送らない・書かない）。送り先が無いときは「取得できなかった」形で返し、送る段へ進ませない（第9.2.1節 `on_empty`）
 */
export const quotePrepareMail: Tool = {
  name: 'quote.prepare_mail',
  risk: 'read',
  activityLabel: '見積書を送るメールを用意しています',
  helpText: '見積書を送るメールの宛先と添えるファイルを確かめます。送るのは承認の後です',
  description: '見積書を送るメールの用意。sendTo（送り先のメールアドレス）と quoteId を渡す。送り先が無ければ送らない',
  args: { properties: { quoteId: { type: 'string', description: 'quote.create が返した quoteId' }, sendTo: { type: 'string', description: '送り先のメールアドレス（無ければ空）' } } },
  async invoke(args, ctx: ToolContext) {
    const to = str(args['sendTo']);
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(to)) return { available: false, reason: '送り先のメールアドレスが無いので、見積書は送りません（PDF はできています）' };
    if (ctx.salesDocs) {
      const d = (await ctx.salesDocs.service.get({ tenantId: ctx.tenantId, userId: ctx.userId }, str(args['quoteId'])))?.doc;
      if (!d || d.kind !== 'quote' || d.runId !== ctx.runId || !d.fileId) return { available: false, reason: 'この依頼で作った見積書が見つかりません' };
      return {
        available: true, to, attachments: [d.fileId], number: salesQuoteLabel(d), toName: addressee(d.party.name || d.party.person), total: d.total, validUntil: d.validUntil,
        subjectHint: d.version > 1 ? `御見積書（${d.number}・再見積）のご送付` : `御見積書（${d.number}）のご送付`,
      };
    }
    const q = (await ctx.repo.listQuotes(ctx.tenantId, { limit: 50 })).find((x) => x.id === str(args['quoteId']) && x.runId === ctx.runId);
    if (!q || !q.fileId) return { available: false, reason: 'この依頼で作った見積書が見つかりません' };
    return {
      available: true, to, attachments: [q.fileId], number: q.number, toName: q.toName, total: q.total, validUntil: q.validUntil,
      subjectHint: `御見積書（${q.number}）のご送付`,
    };
  },
};

/** 見積書を書類として作る（販売の書類の処理がある環境）。 */
async function createAsDocument(args: Record<string, unknown>, items: QuoteItem[], ctx: ToolContext) {
  const service = ctx.salesDocs!.service;
  // 単位の書かれていない品目は空のまま渡す（在庫の販売品・前の見積書の単位を使う。無ければ「式」）
  const raw = (Array.isArray(args['items']) ? args['items'] : []).map((x) => (x ?? {}) as Record<string, unknown>).filter((o) => str(o['name']));
  const r = await service.createQuote({ tenantId: ctx.tenantId, userId: ctx.userId }, {
    to: str(args['to']).slice(0, 80), items: items.map((i, k) => ({ ...i, code: str(raw[k]?.['code']).slice(0, 40), unit: str(raw[k]?.['unit']) ? i.unit : '' })),
    ...(num(args['validDays']) !== null ? { validDays: num(args['validDays'])! } : {}),
    ...(str(args['paymentTerms']) ? { paymentTerms: str(args['paymentTerms']) } : {}), terms: str(args['terms']), notes: str(args['notes']),
  }, ctx.runId);
  if ('error' in r) return { created: false, reason: r.error };
  return reportQuote(r, ctx);
}

/** 作った（再見積した）見積書を成果物とドキュメントに残し、結果の形にする。 */
async function reportQuote(r: CreatedQuote, ctx: ToolContext) {
  const d = r.doc;
  const markdown = docMarkdown(d);
  const title = `御見積書 ${salesQuoteLabel(d)}`;
  await ctx.repo.createArtifact({
    id: randomUUID(), runId: ctx.runId, tenantId: ctx.tenantId, kind: 'quote', title: `${title}${d.party.name ? `（${d.party.name}）` : ''}`,
    body: [markdown, ...(r.diff.length ? ['', '前の版からの違い:', ...r.diff.map((x) => `- ${x}`)] : [])].join('\n'), fileId: d.fileId, createdAt: new Date().toISOString(),
  });
  // 本人のドライブに Google ドキュメントとしても残す（共有しない）。できなくても見積書は作れている
  let doc: { url: string | null } | { error: string };
  try {
    const g = await ctx.connector.docs.create({ tenantId: ctx.tenantId, userId: ctx.userId }, { title: `${title}${d.party.name ? ` ${d.party.name}` : ''}`, body: markdown, folderId: null });
    doc = { url: g.url };
  } catch (err) {
    doc = { error: err instanceof Error ? err.message : 'Google ドキュメントに保存できませんでした' };
  }
  const missingPrice = d.items.filter((i) => i.unitPrice === null).map((i) => i.name);
  const judged = r.notes.filter((n) => !n.startsWith('前の') && !n.startsWith('在庫の') && !n.startsWith('単価を'));
  const used = r.notes.filter((n) => n.startsWith('前の') || n.startsWith('在庫の') || n.startsWith('単価を'));
  return {
    created: true, quoteId: d.id, path: `/sales/${encodeURIComponent(d.id)}`, number: salesQuoteLabel(d), fileId: d.fileId, to: addressee(d.party.name || d.party.person),
    subtotal: d.subtotal, tax: d.tax, total: d.total, validUntil: d.validUntil,
    ...(used.length ? { note: used.join('。') } : {}),
    ...(r.warnings.length ? { warning: r.warnings.join('。'), ...(missingPrice.length ? { missingPrice } : {}) } : {}),
    ...(judged.length ? { taxNote: judged.join('。') } : {}),
    ...(r.stock.length ? { stock: r.stock.join('。') } : {}),
    ...(r.diff.length ? { diff: r.diff } : {}),
    ...('error' in doc ? { docError: doc.error } : { docUrl: doc.url }),
  };
}

/**
 * 再見積（値引きの交渉など。第42.14.2節）。同じ見積番号の新しい版を作る（前の版は残す）。
 *
 * @remarks 危険度 `draft`（社外へは出さない）。値引きは頼まれた額だけ。違いはツールが決まった計算で出す
 */
export const quoteRevise: Tool = {
  name: 'quote.revise',
  risk: 'draft',
  activityLabel: '見積書を出し直しています',
  helpText: '前に出した見積書を、同じ見積番号の新しい版（再見積）にします。前の版は残します。社外へは送りません',
  description: [
    '前に出した見積書の再見積をする。quote に見積番号（Q-…）か quoteId（分からなければ quote.search で探す）。',
    '品目を変えるときは items に**新しい版の品目をすべて**渡す（単価を下げた品目・外した品目を反映したもの。変えない品目もそのまま入れる）。品目を変えなければ items は空。',
    '「合計から 5 万円値引き」のような見積全体の値引きは discountTotal（円。税抜の額。0 で値引きを外す）。**値引きを自分で決めない**（頼まれた額だけ）。金額はツールが計算する',
  ].join(''),
  args: {
    properties: {
      quote: { type: 'string', description: '見積番号（Q-…）か quoteId' },
      items: { type: 'array', description: '新しい版の品目（すべて）。{ name, quantity, unit, unitPrice, taxCategory, group, discount }。変えなければ空' },
      discountTotal: { type: 'number', description: '見積全体の値引き（円・税抜。任意）' },
      to: { type: 'string', description: '宛先を変えるとき' },
      validDays: { type: 'number', description: '有効期限（今日から何日。既定は会社の見積書の設定）' },
      paymentTerms: { type: 'string', description: 'お支払い条件を変えるとき' },
      notes: { type: 'string', description: '備考を変えるとき' },
    },
    required: ['quote'],
  },
  async invoke(args, ctx) {
    if (!ctx.salesDocs) return { created: false, reason: '再見積はこの環境では使えません' };
    const items = itemsOf(args['items']);
    const r = await ctx.salesDocs.service.reviseQuote({ tenantId: ctx.tenantId, userId: ctx.userId }, str(args['quote']), {
      ...(items.length ? { items: items.map((i) => ({ ...i, code: '' })) } : {}),
      ...(num(args['discountTotal']) !== null ? { discountTotal: num(args['discountTotal'])! } : {}),
      ...(str(args['to']) ? { to: str(args['to']) } : {}), ...(num(args['validDays']) !== null ? { validDays: num(args['validDays'])! } : {}),
      ...(str(args['paymentTerms']) ? { paymentTerms: str(args['paymentTerms']) } : {}), ...(str(args['notes']) ? { notes: str(args['notes']) } : {}),
    }, ctx.runId);
    if ('error' in r) return { created: false, reason: r.error };
    return reportQuote(r, ctx);
  },
};

/**
 * 見積書を失注にする（「見本商事の見積は流れた」。第42.14.4節）。
 *
 * @remarks 危険度 `write-internal`（会社の記録だけを書く）
 */
export const quoteLost: Tool = {
  name: 'quote.lost',
  risk: 'write-internal',
  activityLabel: '見積書を失注にしています',
  helpText: '見積書を失注にし、理由を残します',
  description: '見積書を失注にする。quote に見積番号（Q-…）か quoteId（分からなければ quote.search で探す）、reason に理由（言われたもの。無ければ空）',
  args: { properties: { quote: { type: 'string', description: '見積番号か quoteId' }, reason: { type: 'string', description: '理由（任意）' } }, required: ['quote'] },
  async invoke(args, ctx) {
    if (!ctx.salesDocs) return { done: false, reason: 'この環境では使えません' };
    const err = await ctx.salesDocs.service.loseQuote({ tenantId: ctx.tenantId, userId: ctx.userId }, str(args['quote']), str(args['reason']));
    return err ? { done: false, reason: err } : { done: true };
  },
};

export const QUOTE_TOOLS: Tool[] = [quoteCreate, quoteSearch, quoteRevise, quoteLost, quotePrepareMail];
