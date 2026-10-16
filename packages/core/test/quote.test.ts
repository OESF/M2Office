/**
 * @file AG-07 見積書作成（仕様書 第9.5.8節、ADR-0103）の単体テスト。
 *
 * 金額を決まった計算で出すこと（消費税は税率ごとに 1 回だけ端数を処理）、見積番号の連番、前の見積の単価を引くこと、
 * 書かれていない単価を推測で埋めないこと、送り先が無ければ送らないこと、メールに添えられるのは依頼した本人のファイルだけであること、
 * 添えたメールが multipart になることを確かめる。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_TENANT_SETTINGS } from '@m2office/shared';
import {
  BUILTIN_TOOLS, MemoryFileStore, MockWorkspaceConnector, quoteTotals, type QuoteItem, type QuoteRecord, type Repository, type ToolContext,
} from '../src/index.js';
import { buildRawMessage } from '../src/connectors/google/mime.js';

const tool = (name: string) => BUILTIN_TOOLS.find((t) => t.name === name)!;
const item = (o: Partial<QuoteItem>): QuoteItem => ({ name: 'x', quantity: 1, unit: '式', unitPrice: 0, taxRate: 10, ...o });

test('金額は数量×単価、消費税は税率ごとに 1 回だけ会社の端数の扱いで処理する', () => {
  const items = [item({ quantity: 3, unitPrice: 333 }), item({ quantity: 1, unitPrice: 1001, taxRate: 8 })];
  assert.deepEqual(quoteTotals(items, 'floor'), { subtotal: 2000, tax: 179, total: 2179, byRate: [{ rate: 10, base: 999, tax: 99 }, { rate: 8, base: 1001, tax: 80 }] });
  assert.equal(quoteTotals(items, 'ceil').tax, 181);
  assert.equal(quoteTotals([item({ unitPrice: null })], 'floor').total, 0, '単価の無い品目は 0 円で数える');
});

function ctxWith(past: QuoteRecord[] = []) {
  const quotes: QuoteRecord[] = [...past];
  const files = new MemoryFileStore();
  const fileMeta = new Map<string, { id: string; name: string; mime: string; ownerUserId: string; runId: string | null }>();
  const repo = {
    getTenantSettings: async () => ({ ...DEFAULT_TENANT_SETTINGS, company: { ...DEFAULT_TENANT_SETTINGS.company, legalName: '株式会社テスト', taxRounding: 'floor' }, invoice: { ...(DEFAULT_TENANT_SETTINGS as unknown as { invoice: object }).invoice } }),
    listQuotes: async (_t: string, q: { to?: string } = {}) => quotes.filter((x) => !q.to || x.toName.includes(q.to)).slice().reverse(),
    countQuotesOn: async (_t: string, day: string) => quotes.filter((x) => x.number.startsWith(`Q-${day}-`)).length,
    createQuote: async (q: QuoteRecord) => { quotes.push(q); },
    createFile: async (f: { id: string; name: string; mime: string; ownerUserId: string; runId: string | null }) => { fileMeta.set(f.id, f); },
    getFile: async (_t: string, id: string) => fileMeta.get(id) ?? null,
    createArtifact: async () => undefined,
  } as unknown as Repository;
  const connector = new MockWorkspaceConnector();
  const ctx = { tenantId: 't1', userId: 'u1', runId: 'r1', compartment: null, repo, connector, files } as unknown as ToolContext;
  return { ctx, quotes, connector, files, fileMeta };
}

test('見積書を作る: 連番・前の単価・単価の無い品目・PDF・宛先の敬称', async () => {
  const day = new Date(Date.now() + 9 * 3_600_000).toISOString().slice(0, 10).replace(/-/g, '');
  const { ctx, quotes } = ctxWith([{
    id: 'qt-old', tenantId: 't1', number: `Q-${day}-01`, requestedBy: 'u9', runId: 'r0', toName: '前の会社',
    items: [item({ name: '保守（月額）', unitPrice: 10000 })], subtotal: 10000, tax: 1000, total: 11000, validUntil: null, fileId: null, createdAt: new Date().toISOString(),
  }]);
  const r = await tool('quote.create').invoke({
    to: '株式会社見本商事', validDays: 14,
    items: [{ name: 'デザイン', quantity: 1, unitPrice: 300000 }, { name: '保守 (月額)', quantity: 12, unit: 'か月' }, { name: '撮影', quantity: 1 }],
  }, ctx) as Record<string, unknown>;
  assert.equal(r['created'], true);
  assert.equal(r['number'], `Q-${day}-02`, 'その日の 2 通目');
  assert.deepEqual(r['fromPast'], ['保守 (月額)'], '前の見積の同じ品目の単価を使う（空白や括弧の違いは同じとみなす）');
  assert.deepEqual(r['missingPrice'], ['撮影'], '書かれていない単価は推測しない');
  assert.equal(r['subtotal'], 300000 + 120000);
  assert.equal(r['total'], 420000 + 42000);
  assert.match(String(r['fileName']), /^御見積書_Q-\d{8}-02_株式会社見本商事\.pdf$/);
  assert.equal(quotes.at(-1)?.toName, '株式会社見本商事');
  assert.equal(typeof r['docError'] === 'string' || 'docUrl' in r, true);
});

test('送り先が無ければ送らない（取得できなかった形で返し、送る段へ進ませない）', async () => {
  const { ctx } = ctxWith();
  const made = await tool('quote.create').invoke({ items: [{ name: 'a', unitPrice: 100 }] }, ctx) as Record<string, unknown>;
  const none = await tool('quote.prepare_mail').invoke({ quoteId: made['quoteId'], sendTo: '' }, ctx) as Record<string, unknown>;
  assert.equal(none['available'], false);
  const ok = await tool('quote.prepare_mail').invoke({ quoteId: made['quoteId'], sendTo: 'yamada@example.co.jp' }, ctx) as Record<string, unknown>;
  assert.equal(ok['available'], true);
  assert.deepEqual(ok['attachments'], [made['fileId']]);
});

test('メールに添えられるのは、この実行で作ったファイルか本人のファイルだけ。添えたメールは multipart になる', async () => {
  const { ctx, connector, files, fileMeta } = ctxWith();
  const made = await tool('quote.create').invoke({ items: [{ name: 'a', unitPrice: 100 }] }, ctx) as Record<string, unknown>;
  const sent = await tool('gmail.send').invoke({ to: ['yamada@example.co.jp'], subject: '御見積書', body: 'ご確認ください', attachments: [made['fileId']] }, ctx) as Record<string, unknown>;
  assert.equal(sent['sent'], true);
  assert.deepEqual(sent['attached'], [made['fileName']]);
  const mail = connector.outbox.at(-1)?.body as { attachments?: { name: string; size: number }[] };
  assert.equal(mail.attachments?.[0]?.name, made['fileName']);
  fileMeta.set('f-other', { id: 'f-other', name: '他人.pdf', mime: 'application/pdf', ownerUserId: 'u2', runId: 'r9' });
  await files.put('t1', 'f-other', new Uint8Array([1]));
  const refused = await tool('gmail.send').invoke({ to: ['a@example.co.jp'], subject: 's', body: 'b', attachments: ['f-other'] }, ctx) as Record<string, unknown>;
  assert.equal(refused['sent'], false, '他人のファイルは添えない');
  const raw = Buffer.from(buildRawMessage({ to: ['a@example.jp'], cc: [], subject: '件名', body: '本文', attachments: [{ name: '御見積書.pdf', mime: 'application/pdf', bytes: new Uint8Array([37, 80, 68, 70]) }] }), 'base64url').toString();
  assert.match(raw, /Content-Type: multipart\/mixed; boundary="m2o-/);
  assert.match(raw, /Content-Disposition: attachment; filename\*=UTF-8''%E5%BE%A1%E8%A6%8B%E7%A9%8D%E6%9B%B8\.pdf/);
  assert.match(raw, /JVBERg==/, '中身は base64');
});
