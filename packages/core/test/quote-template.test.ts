/**
 * @file 帳票の型と印影（仕様書 第15.2.3節、Q-240、ADR-0104）の単体テスト。
 *
 * 値引きを品目の金額から引いてから消費税を出すこと、罫線の表の見積書に表題・情報の欄・前文・区分の見出し・値引き・合計・備考が出ること、
 * 列を中身で決めること（数量がすべて 1 なら数量の列を出さない）、印影が無ければ薄い「印」の字を出し、あれば字を出さないこと、
 * 見本の見積書から型と文言だけを寄せ、差出人などを写さないことを確かめる。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_QUOTE_STYLE, DEFAULT_TENANT_SETTINGS } from '@m2office/shared';
import { BUILTIN_TOOLS, MemoryFileStore, MockWorkspaceConnector, StubLlmProvider, extractPdfText, quoteTotals, readQuoteSample, type QuoteItem, type QuoteRecord, type Repository, type ToolContext } from '../src/index.js';
import { renderPdf, renderRuledQuote } from '../src/files/pdf-render.js';

const item = (o: Partial<QuoteItem>): QuoteItem => ({ name: 'x', quantity: 1, unit: '式', unitPrice: 0, taxRate: 10, ...o });
/** 1×1 の透明な PNG。 */
const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da6364f8ff0f0000050101005b1c4a1a0000000049454e44ae426082', 'hex');
const pdfText = async (bytes: Uint8Array) => (await extractPdfText(bytes)).pages.map((p) => p.text).join('\n');

test('値引きは品目の金額から引いてから、税率ごとに消費税を出す（金額を超えて引かない）', () => {
  const t = quoteTotals([item({ unitPrice: 1_000_000, discount: 200_000 }), item({ unitPrice: 100_000, discount: 150_000 }), item({ unitPrice: 450_000 })], 'floor');
  assert.equal(t.subtotal, 800_000 + 0 + 450_000);
  assert.equal(t.tax, 125_000);
  assert.equal(t.total, 1_375_000);
});

test('罫線の表: 表題・情報の欄・前文・区分の見出し・値引き・合計・備考を出し、数量がすべて 1 なら数量の列を出さない', async () => {
  const bytes = await renderRuledQuote({
    title: '御見積書', to: '株式会社見本 御中',
    fields: [{ label: '見積書発行日', value: '2026-10-16' }, { label: 'お支払い条件', value: 'お振込' }],
    greeting: '下記の通り、御見積申し上げます。',
    rows: [
      { group: '初期費用', name: '導入の支援', quantity: 1, unit: '式', unitPrice: 1_000_000, discount: 200_000, amount: 800_000 },
      { group: 'その他', name: '機器一式', quantity: 1, unit: '式', unitPrice: 450_000, discount: 0, amount: 450_000 },
    ],
    totals: [{ label: '小計', value: '￥1,250,000' }, { label: '消費税', value: '￥125,000' }, { label: '合計', value: '￥1,375,000' }],
    notes: ['本見積書の有効期限内にご発注ください。'],
    style: { from: ['見本商事株式会社', '〒100-0001 東京都千代田区'], sealBox: true },
  });
  const text = await pdfText(bytes);
  for (const s of ['御見積書', '株式会社見本 御中', '見積書発行日', 'お振込', '下記の通り、御見積申し上げます。', '【初期費用】', '【その他】', '導入の支援', '摘要', '値引き', '-￥200,000', '￥800,000', '小計', '￥1,375,000', '備考', '本見積書の有効期限内にご発注ください。', '見本商事株式会社', '印']) {
    assert.ok(text.includes(s), `${s} が出ていない`);
  }
  assert.equal(text.includes('数量'), false, '数量がすべて 1 なら数量の列を出さない');
  assert.equal((await extractPdfText(bytes)).pages.length, 1, '1 ページに収める');
});

test('罫線の表: 値引きが無ければ値引きの列を出さず、数量があれば数量の列を出す。長い見積は次のページに続ける', async () => {
  const rows = Array.from({ length: 45 }, (_, i) => ({ name: `品目${i + 1}`, quantity: 2, unit: '個', unitPrice: 100, discount: 0, amount: 200 }));
  const bytes = await renderRuledQuote({ title: '御見積書', fields: [], rows, totals: [{ label: '合計', value: '￥9,900' }], notes: [] });
  const pages = (await extractPdfText(bytes)).pages;
  const all = pages.map((p) => p.text).join('\n');
  assert.ok(all.includes('数量') && all.includes('2 個'));
  assert.equal(all.includes('値引き'), false);
  assert.ok(pages.length >= 2 && pages[1]!.text.includes('摘要'), '次のページにも表の見出しを付ける');
  assert.ok(all.includes('品目45') && all.includes('￥9,900'));
});

test('印: 印影が無ければ薄い「印」の字、あれば字を出さない。印を押さない会社には何も出さない', async () => {
  const base = { title: '御見積書', fields: [], rows: [{ name: 'a', quantity: 1, unit: '式', unitPrice: 1, discount: 0, amount: 1 }], totals: [], notes: [] };
  assert.ok((await pdfText(await renderRuledQuote({ ...base, style: { from: ['会社'], sealBox: true } }))).includes('印'));
  assert.equal((await pdfText(await renderRuledQuote({ ...base, style: { from: ['会社'], sealBox: true, seal: { bytes: PNG, kind: 'png' } } }))).includes('印'), false);
  assert.equal((await pdfText(await renderRuledQuote({ ...base, style: { from: ['会社'], sealBox: false } }))).includes('印'), false);
  // シンプルの型でも、会社名に重ねて同じように押す
  const simple = await renderPdf({ title: '御見積書', rows: [{ name: 'a', amount: 1 }], style: { from: ['会社'], sealBox: true, seal: { bytes: PNG, kind: 'png' } } });
  assert.equal((await pdfText(simple)).includes('印'), false);
});

function quoteCtx(quote: Partial<typeof DEFAULT_QUOTE_STYLE>, sealed: boolean) {
  const quotes: QuoteRecord[] = [];
  const files = new MemoryFileStore();
  const fileMeta = new Map<string, unknown>();
  const invoice = { ...DEFAULT_TENANT_SETTINGS.invoice, sealFileId: sealed ? 'seal-1' : null, sealKind: sealed ? 'png' as const : null, quote: { ...DEFAULT_QUOTE_STYLE, ...quote } };
  const repo = {
    getTenantSettings: async () => ({ ...DEFAULT_TENANT_SETTINGS, company: { ...DEFAULT_TENANT_SETTINGS.company, legalName: '株式会社テスト', taxRounding: 'floor' }, invoice }),
    listQuotes: async () => quotes.slice().reverse(),
    countQuotesOn: async () => quotes.length,
    createQuote: async (q: QuoteRecord) => { quotes.push(q); },
    createFile: async (f: { id: string }) => { fileMeta.set(f.id, f); },
    getFile: async (_t: string, id: string) => fileMeta.get(id) ?? null,
    createArtifact: async () => undefined,
  } as unknown as Repository;
  const ctx = { tenantId: 't1', userId: 'u1', runId: 'r1', compartment: null, repo, connector: new MockWorkspaceConnector(), files } as unknown as ToolContext;
  return { ctx, files, quotes };
}

test('見積書を作る: 会社の型と文言を使い、区分と値引きを記録し、印影を押す', async () => {
  const { ctx, files, quotes } = quoteCtx({ title: '御見積書', paymentTerms: 'お振込', labels: { ...DEFAULT_QUOTE_STYLE.labels, issued: '見積書発行日' }, notes: '定型の断り書き', validDays: 14 }, true);
  await files.put('t1', 'seal-1', PNG);
  const r = await BUILTIN_TOOLS.find((t) => t.name === 'quote.create')!.invoke({
    to: '見本商事', items: [{ name: '導入の支援', unitPrice: 1_000_000, discount: 200_000, group: '【初期費用】' }, { name: '保守', unitPrice: 30_000, group: '月額費用' }],
  }, ctx) as Record<string, unknown>;
  assert.equal(r['subtotal'], 830_000);
  assert.equal(quotes[0]?.items[0]?.group, '初期費用', '区分の括弧は外して持つ');
  assert.equal(quotes[0]?.items[0]?.discount, 200_000);
  const text = await pdfText((await files.get('t1', String(r['fileId'])))!);
  for (const s of ['見積書発行日', 'お振込', '【初期費用】', '【月額費用】', '-￥200,000', '定型の断り書き', '見本商事 御中']) assert.ok(text.includes(s), `${s} が出ていない`);
  assert.equal(text.includes('印'), false, '印影があれば「印」の字は出さない');
  const valid = new Date(Date.now() + 9 * 3_600_000 + 14 * 86_400_000).toISOString().slice(0, 10);
  assert.equal(r['validUntil'], valid, '有効期限の既定は会社の設定');

  const simple = quoteCtx({ template: 'simple' }, false);
  const r2 = await BUILTIN_TOOLS.find((t) => t.name === 'quote.create')!.invoke({ items: [{ name: 'a', unitPrice: 100 }] }, simple.ctx) as Record<string, unknown>;
  const t2 = await pdfText((await simple.files.get('t1', String(r2['fileId'])))!);
  assert.ok(t2.includes('印') && !t2.includes('摘要'), 'シンプルの型。印影が無ければ薄い「印」の字');
});

test('見本から寄せる: 型と文言だけを入れ、読めない項目はいまの値のまま', async () => {
  const sample = Buffer.from(`fake-image M2O-QUOTE-SAMPLE:${JSON.stringify({ template: 'ruled', title: '御見積書', greeting: '', labels: { issued: '見積書発行日', validUntil: '見積書有効期限' }, paymentTerms: 'お振込', validDays: 30, notes: '現地での作業は別途ご相談ください。' })}\n`, 'utf8');
  const r = await readQuoteSample(new StubLlmProvider(), sample, 'png', { ...DEFAULT_QUOTE_STYLE, greeting: 'いまの前文' });
  assert.ok('quote' in r);
  if (!('quote' in r)) return;
  assert.equal(r.quote.labels.issued, '見積書発行日');
  assert.equal(r.quote.labels.number, '見積番号', '読めない言い方はいまの値');
  assert.equal(r.quote.greeting, 'いまの前文', '空の項目はいまの値');
  assert.equal(r.quote.paymentTerms, 'お振込');
  assert.equal(r.quote.notes, '現地での作業は別途ご相談ください。');
  assert.deepEqual(Object.keys(r.quote).sort(), Object.keys(DEFAULT_QUOTE_STYLE).sort(), '差出人などの項目は持たない');
  assert.ok('error' in await readQuoteSample(null, sample, 'png'), 'AI が使えなければ読めないと返す');
});
