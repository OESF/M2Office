/**
 * @file 販売の書類と受注の単体テスト（仕様書 第42章）。支払期限と締めの決まった計算・注文書の決まった言い方での読み取り・
 * 受注の取り込み（計算の食い違い・見積との違い・二重の取り込み）・受注から納品書（残りの数と状態）・
 * 納品書をまとめた請求書（下書き → 発行で番号・請求済み・重ねない）・取り消しで未請求に戻る・訂正版（前の版を残し、請求書に知らせ）・
 * 領収書（全額と一部の入金）・発行のツールの承認の前の確かめ・使えない会社では使えないこと・会社の境界。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_TENANT_SETTINGS, type TenantSettings } from '@m2office/shared';
import {
  MemoryFileStore, MemorySalesDocStore, SALES_DOC_TOOLS, SalesDocService, closingCutoff, closingDayFrom, dueDateFrom, readOrderByRule, saveFile, salesToday,
  type QuoteRecord, type Repository, type ToolContext,
} from '../src/index.js';

const ORDER = [
  '注文書',
  '株式会社アルファ商事 御中',
  '株式会社見本商事',
  '注文番号: PO-7788',
  '注文日: 2026年10月20日',
  '納期: 2026年11月5日',
  '支払条件: 20日締め翌月末払い',
  'ケーブル3m 10 本 1,200 12,000',
  'ルーター 2 台 15,000 30,000',
  '合計 46,300',
].join('\n');

function setup(opts: { quotes?: QuoteRecord[] } = {}) {
  let settings: TenantSettings = {
    ...DEFAULT_TENANT_SETTINGS,
    company: { ...DEFAULT_TENANT_SETTINGS.company, legalName: '株式会社アルファ商事', invoiceRegistrationNumber: 'T1234567890123' },
    invoice: { ...DEFAULT_TENANT_SETTINGS.invoice, paymentDue: '翌月末' },
    salesDocs: { enabled: true },
  };
  const users = [
    { id: 'boss', email: 'boss@alpha.example.jp', displayName: '責任者', roles: ['admin'], status: 'active' },
    { id: 'u1', email: 'u1@alpha.example.jp', displayName: '営業', roles: ['member'], status: 'active' },
    { id: 'u2', email: 'u2@alpha.example.jp', displayName: '経理', roles: ['member'], status: 'active' },
  ];
  const audits: { action: string; targetId: string }[] = [];
  const notes: { userId: string; title: string }[] = [];
  const files: Record<string, unknown>[] = [];
  const artifacts: { kind: string; title: string }[] = [];
  const repo = {
    listUsers: async () => users,
    findUserById: async (_t: string, id: string) => users.find((u) => u.id === id) ?? null,
    getTenantSettings: async () => settings,
    listUserGroupIds: async () => [],
    createNotification: async (n: { userId: string; title: string }) => { notes.push(n); },
    appendAudit: async (e: { action: string; targetId: string }) => { audits.push(e); },
    createFile: async (f: Record<string, unknown>) => { files.push(f); },
    getFile: async (_t: string, id: string) => files.find((f) => f['id'] === id) ?? null,
    replaceFileMeta: async (_t: string, id: string, meta: Record<string, unknown>) => { Object.assign(files.find((f) => f['id'] === id) ?? {}, meta); },
    deleteFile: async (_t: string, id: string) => { const i = files.findIndex((f) => f['id'] === id); if (i >= 0) files.splice(i, 1); },
    listApprovalsForFileInput: async () => [],
    listQuotes: async () => opts.quotes ?? [],
    createArtifact: async (a: { kind: string; title: string }) => { artifacts.push(a); },
  } as unknown as Repository;
  const store = new MemorySalesDocStore();
  const fileStore = new MemoryFileStore();
  const service = new SalesDocService({ store, repo, files: fileStore, llmFor: async () => null });
  const who = { tenantId: 't1', userId: 'u1' };
  const upload = async (text: string) =>
    (await saveFile(repo, fileStore, { tenantId: 't1', ownerUserId: 'u1', name: '注文書.txt', kind: 'txt', bytes: new TextEncoder().encode(text), origin: 'upload', runId: null })).id;
  const ctx = (userId = 'u1'): ToolContext => ({
    tenantId: 't1', userId, runId: 'run-1', compartment: null, repo, files: fileStore, connector: {} as ToolContext['connector'],
    salesDocs: { service, access: async () => (settings.salesDocs.enabled ? settings.salesDocs : null) },
  });
  return { service, store, repo, who, upload, ctx, audits, notes, files, fileStore, artifacts, set: (s: Partial<TenantSettings>) => { settings = { ...settings, ...s }; } };
}

const tool = (name: string) => SALES_DOC_TOOLS.find((t) => t.name === name)!;

test('支払い条件の言い方から支払期限を決まった計算で出す（読めなければ null）', () => {
  assert.equal(dueDateFrom('翌月末', '2026-10-26'), '2026-11-30');
  assert.equal(dueDateFrom('20日締め翌月末払い', '2026-01-31'), '2026-02-28');
  assert.equal(dueDateFrom('翌々月10日', '2026-10-26'), '2026-12-10');
  assert.equal(dueDateFrom('当月末', '2026-10-05'), '2026-10-31');
  assert.equal(dueDateFrom('30日以内', '2026-10-26'), '2026-11-25');
  assert.equal(dueDateFrom('都度相談', '2026-10-26'), null);
  assert.equal(closingDayFrom('20日締め翌月末払い'), 20);
  assert.equal(closingDayFrom('月末締め'), 0);
  assert.equal(closingDayFrom('翌月末払い'), null);
  assert.equal(closingCutoff('2026-10-26', 20), '2026-10-20');
  assert.equal(closingCutoff('2026-10-15', 20), '2026-09-20');
  assert.equal(closingCutoff('2026-10-26', 0), '2026-10-26');
});

test('注文書を決まった言い方で読む（自社を注文した会社と取り違えない・品目・日付・相手の合計）', () => {
  const r = readOrderByRule(ORDER, '株式会社アルファ商事');
  assert.equal(r.party.name, '株式会社見本商事');
  assert.equal(r.customerRef, 'PO-7788');
  assert.equal(r.orderedOn, '2026-10-20');
  assert.equal(r.dueOn, '2026-11-05');
  assert.equal(r.items.length, 2);
  assert.deepEqual(r.items.map((i) => [i.name, i.quantity, i.unitPrice]), [['ケーブル3m', 10, 1200], ['ルーター', 2, 15000]]);
  assert.equal(r.statedTotal, 46300);
  assert.deepEqual(r.unread, []);
});

test('注文書を受注にする: 計算の食い違いと見積との違いに印を付け、同じ注文は二重に取り込まない。支払い条件を覚える', async () => {
  const quote: QuoteRecord = {
    id: 'qt-1', tenantId: 't1', number: 'Q-20261001-01', requestedBy: 'u1', runId: null, toName: '株式会社見本商事 御中',
    items: [{ name: 'ルーター', quantity: 2, unit: '台', unitPrice: 14000, taxRate: 10 }], subtotal: 28000, tax: 2800, total: 30800, validUntil: null, fileId: null, createdAt: '',
  };
  const { service, who, upload } = setup({ quotes: [quote] });
  const r = await service.importOrder(who, await upload(ORDER));
  assert.ok(!('error' in r) && !r.duplicate);
  const o = r.order;
  assert.match(o.number, /^S-\d{8}-001$/);
  assert.equal(o.total, 46200); // 42,000 + 消費税 4,200
  assert.equal(o.status, 'open');
  assert.ok(o.flags.some((f) => f.kind === 'calc' && f.text.includes('46,300')), '相手の合計との食い違い');
  assert.ok(o.flags.some((f) => f.kind === 'quote' && f.text.includes('Q-20261001-01')), '見積との違い');
  assert.equal(o.quoteNumber, 'Q-20261001-01');
  const again = await service.importOrder(who, await upload(ORDER));
  assert.ok(!('error' in again) && again.duplicate && again.order.id === o.id);
  assert.equal((await service.party(who, '見本商事'))?.closingDay, 20);
});

test('受注から納品書: 残りの数で作り、作ったら発行済み。一部納品・納品済みは書類から決まる', async () => {
  const { service, who, upload } = setup();
  const r = await service.importOrder(who, await upload(ORDER));
  assert.ok(!('error' in r));
  const part = await service.createDocument(who, { kind: 'delivery', orderId: r.order.id, items: [{ name: 'ケーブル3m', code: '', quantity: 4, unit: '本', unitPrice: 1200, taxRate: 10 }] }, null);
  assert.ok(!('error' in part));
  assert.equal(part.doc.status, 'issued');
  assert.match(part.doc.number!, /^D-\d{8}-001$/);
  assert.equal((await service.getOrder(who, r.order.id))!.order.status, 'partial');
  const rest = await service.createDocument(who, { kind: 'delivery', orderId: r.order.id }, null);
  assert.ok(!('error' in rest));
  assert.deepEqual(rest.doc.items.map((i) => [i.name, i.quantity]), [['ケーブル3m', 6], ['ルーター', 2]]);
  assert.match(rest.doc.number!, /-002$/);
  const view = (await service.getOrder(who, r.order.id))!.order;
  assert.equal(view.status, 'delivered');
  assert.deepEqual(view.delivered, [10, 2]);
  const none = await service.createDocument(who, { kind: 'delivery', orderId: r.order.id }, null);
  assert.ok('error' in none && none.error.includes('すべて納品済み'));
});

test('納品書をまとめて請求書: 下書きは番号なし、発行で番号と請求済み。同じ納品書は 2 つの請求書に入らない。取り消すと未請求に戻る', async () => {
  const { service, who, upload, files } = setup();
  const r = await service.importOrder(who, await upload(ORDER));
  assert.ok(!('error' in r));
  const d1 = await service.createDocument(who, { kind: 'delivery', orderId: r.order.id }, null);
  assert.ok(!('error' in d1));
  // 取引先の締め日（注文書から覚えた 20 日締め）より後の納品は、今月分にまとめない
  const early = await service.createDocument(who, { kind: 'invoice', collectFor: '見本商事' }, null);
  if (salesToday() > `${salesToday().slice(0, 8)}20`) assert.ok('error' in early && early.error.includes('までの分'));
  const inv = await service.createDocument(who, { kind: 'invoice', deliveryIds: [d1.doc.id] }, 'run-a');
  assert.ok(!('error' in inv), 'error' in inv ? inv.error : '');
  assert.equal(inv.doc.status, 'draft');
  assert.equal(inv.doc.number, null);
  assert.deepEqual(inv.doc.deliveryIds, [d1.doc.id]);
  assert.equal(inv.doc.total, 46200);
  assert.ok(inv.doc.items.every((i) => i.group?.includes(d1.doc.number!)), '明細に納品書の見出し');
  assert.ok(inv.doc.dueOn, '支払期限（取引先の支払い条件から）');
  // 2 つ目の下書きにも同じ納品書を入れられるが、先に発行したほうが勝つ
  const inv2 = await service.createDocument(who, { kind: 'invoice', deliveryIds: [d1.doc.id] }, null);
  assert.ok(!('error' in inv2));
  const fileBefore = inv.doc.fileId;
  const issued = await service.issue(who, inv.doc.id);
  assert.ok(!('error' in issued));
  assert.match(issued.number!, /^I-\d{8}-001$/);
  assert.equal(issued.fileId, fileBefore, '同じファイルを描き直す（承認の前に組み立てた添付がそのまま使える）');
  assert.ok(files.some((f) => f['id'] === fileBefore && f['name'] === `御請求書_${issued.number}_株式会社見本商事.pdf`));
  assert.equal((await service.get(who, d1.doc.id))!.doc.invoiceId, inv.doc.id);
  assert.equal((await service.getOrder(who, r.order.id))!.order.status, 'invoiced');
  const conflict = await service.issue(who, inv2.doc.id);
  assert.ok('error' in conflict && conflict.error.includes('ほかの請求書'));
  const excluded = await service.createDocument(who, { kind: 'invoice', deliveryIds: [d1.doc.id] }, null);
  assert.ok('error' in excluded);
  // 取り消しは理由が要り、作った人と管理者だけ
  assert.equal(await service.cancel({ tenantId: 't1', userId: 'u2' }, inv.doc.id, '金額の誤り'), '取り消せるのは、作った人と管理者だけです');
  assert.equal(await service.cancel(who, inv.doc.id, ''), '取り消しの理由を書いてください');
  assert.equal(await service.cancel(who, inv.doc.id, '金額の誤り'), null);
  assert.equal((await service.get(who, d1.doc.id))!.doc.invoiceId, null, '未請求に戻る');
  assert.equal((await service.get(who, inv.doc.id))!.doc.status, 'cancelled');
});

test('訂正版: 同じ番号の新しい版を作り、前の版は残す。請求済みの納品書の訂正は請求書に知らせる', async () => {
  const { service, who, notes } = setup();
  const dl = await service.createDocument(who, { kind: 'delivery', party: { name: '株式会社見本商事' }, items: [{ name: '保守', code: '', quantity: 1, unit: '式', unitPrice: 30000, taxRate: 10 }] }, null);
  assert.ok(!('error' in dl));
  const inv = await service.createDocument(who, { kind: 'invoice', deliveryIds: [dl.doc.id] }, null);
  assert.ok(!('error' in inv));
  assert.ok(!('error' in await service.issue(who, inv.doc.id)));
  const rev = await service.revise(who, dl.doc.id, { items: [{ name: '保守', code: '', quantity: 1, unit: '式', unitPrice: 33000, taxRate: 10 }] }, null);
  assert.ok(!('error' in rev));
  assert.equal(rev.doc.number, dl.doc.number);
  assert.equal(rev.doc.version, 2);
  assert.equal(rev.doc.status, 'issued');
  assert.equal(rev.doc.invoiceId, inv.doc.id, '請求済みのまま');
  const old = (await service.get(who, dl.doc.id))!;
  assert.equal(old.doc.superseded, true);
  assert.equal(old.versions.length, 2);
  const invNow = (await service.get(who, inv.doc.id))!.doc;
  assert.ok(invNow.notices.some((n) => n.includes(dl.doc.number!)));
  assert.equal(invNow.total, 33000, '請求書は自動では直さない');
  assert.ok(notes.some((n) => n.userId === 'u1'));
  // 発行した書類は書き換えられない（下書きの書き換えは断る）
  const bad = await service.createDocument(who, { kind: 'invoice', documentId: inv.doc.id, items: [] }, null);
  assert.ok('error' in bad);
  // 請求書の訂正版は下書きで、発行すると前の版を置き換え、納品書を引き継ぐ
  const invRev = await service.revise(who, inv.doc.id, { items: [{ name: '保守', code: '', quantity: 1, unit: '式', unitPrice: 33000, taxRate: 10 }] }, null);
  assert.ok(!('error' in invRev));
  assert.equal(invRev.doc.status, 'draft');
  const issued2 = await service.issue(who, invRev.doc.id);
  assert.ok(!('error' in issued2), 'error' in issued2 ? issued2.error : '');
  assert.equal((await service.get(who, inv.doc.id))!.doc.superseded, true);
});

test('領収書: 請求書の全額と、一部の入金（受け取った額にそろう税抜の額を決まった計算で探す）', async () => {
  const { service, who } = setup();
  const inv = await service.createDocument(who, { kind: 'invoice', party: { name: '株式会社見本商事' }, items: [{ name: '制作', code: '', quantity: 1, unit: '式', unitPrice: 100000, taxRate: 10 }] }, null);
  assert.ok(!('error' in inv));
  const notYet = await service.createDocument(who, { kind: 'receipt', invoiceId: inv.doc.id }, null);
  assert.ok('error' in notYet && notYet.error.includes('発行していない'));
  assert.ok(!('error' in await service.issue(who, inv.doc.id)));
  const full = await service.createDocument(who, { kind: 'receipt', invoiceId: inv.doc.id }, null);
  assert.ok(!('error' in full));
  assert.equal(full.doc.total, 110000);
  assert.equal(full.doc.status, 'draft');
  const part = await service.createDocument(who, { kind: 'receipt', invoiceId: inv.doc.id, amount: 50000 }, null);
  assert.ok(!('error' in part));
  assert.equal(part.doc.total, 50000);
  assert.equal(part.doc.subtotal + part.doc.tax, 50000);
  const over = await service.createDocument(who, { kind: 'receipt', invoiceId: inv.doc.id, amount: 200000 }, null);
  assert.ok('error' in over);
});

test('ツール: 発行は承認の前に下書きかを確かめ、承認の画面に宛先と合計を出す。使えない会社では使えない', async () => {
  const { service, who, ctx, set, artifacts } = setup();
  const created = await tool('sales.create_document').invoke({
    kind: 'invoice', to: '株式会社見本商事 御中', items: [{ name: '保守', quantity: 1, unit: '式', unitPrice: '3万', taxRate: 10 }],
  }, ctx()) as { created: boolean; warning?: string };
  // 数に読めない単価は推測せず、単価なしとして示す
  assert.equal(created.created, true);
  assert.match(created.warning ?? '', /単価が入っていない品目/);
  const ok = await tool('sales.create_document').invoke({
    kind: 'invoice', to: '株式会社見本商事 御中', items: [{ name: '保守', quantity: 1, unit: '式', unitPrice: 30000, taxRate: 10 }],
  }, ctx()) as { created: boolean; documentId: string; total: number };
  assert.equal(ok.created, true);
  assert.equal(ok.total, 33000);
  assert.ok(artifacts.some((a) => a.kind === 'sales-invoice'));
  const prepared = await tool('sales.issue').prepare!({ documentId: ok.documentId }, ctx());
  assert.equal(prepared.kind, 'ready');
  assert.ok(prepared.kind === 'ready' && prepared.shown?.includes('株式会社見本商事') && prepared.shown.includes('33,000'));
  await service.issue(who, ok.documentId);
  const again = await tool('sales.issue').prepare!({ documentId: ok.documentId }, ctx());
  assert.equal(again.kind, 'problem');
  const mail = await tool('sales.prepare_mail').invoke({ documentId: ok.documentId, sendTo: 'yamada@example.co.jp' }, ctx()) as { available: boolean; attachments: string[] };
  assert.equal(mail.available, true);
  assert.equal(mail.attachments.length, 1);
  set({ salesDocs: { enabled: false } });
  const off = await tool('sales.documents').invoke({}, ctx()) as { available: boolean };
  assert.equal(off.available, false);
});

test('会社の境界: ほかの会社の書類と受注は見えない', async () => {
  const { service, who, store } = setup();
  const d = await service.createDocument(who, { kind: 'delivery', party: { name: '株式会社見本商事' }, items: [{ name: '保守', code: '', quantity: 1, unit: '式', unitPrice: 1000, taxRate: 10 }] }, null);
  assert.ok(!('error' in d));
  assert.equal(await store.getDoc('t2', d.doc.id), null);
  assert.deepEqual(await store.listDocs('t2'), []);
  assert.equal(salesToday().length, 10);
});

test('手で入れる: 略した取引先を正式な名前に寄せ、「いつもの」を前の注文でいちばん多い品目と読み、足りない項目に印を付ける（第42.5.1.1節）', async () => {
  const { service, who, upload } = setup();
  const first = await service.importOrder(who, await upload(ORDER));
  assert.ok(!('error' in first));
  // 前の注文: ケーブルが 2 回（注文書と手で入れた 1 回）、ルーターが 1 回
  const again = await service.recordOrder(who, { party: '見本商事', items: [{ name: 'ケーブル3m', code: '', quantity: 5, unit: '', unitPrice: null, taxRate: 10 }], dueOn: '2026-11-10' }, 'manual');
  assert.ok(!('error' in again) && !again.duplicate);
  assert.equal(again.order.party.name, '株式会社見本商事', '正式な名前に寄せる');
  assert.equal(again.order.items[0]!.unitPrice, 1200, '前の単価を補う');
  assert.equal(again.order.source, 'manual');
  assert.ok(again.order.flags.some((f) => f.kind === 'guess' && f.text.includes('前の単価')));
  const usual = await service.recordOrder(who, { party: '見本商事', items: [{ name: 'いつものあれ', code: '', quantity: 10, unit: '', unitPrice: null, taxRate: 10 }] }, 'secretary');
  assert.ok(!('error' in usual) && !usual.duplicate);
  assert.equal(usual.order.items[0]!.name, 'ケーブル3m');
  assert.equal(usual.order.items[0]!.quantity, 10);
  assert.equal(usual.order.items[0]!.unit, '本');
  assert.ok(usual.order.flags.some((f) => f.kind === 'guess' && f.text.includes('「いつものあれ」を ケーブル3m と読みました')));
  assert.ok(usual.order.flags.some((f) => f.kind === 'unread' && f.text === '納期が入っていません'));
  // 前の注文が無い取引先の「いつもの」は読まない
  const unknown = await service.recordOrder(who, { party: '株式会社初めて商店', items: [{ name: 'いつもの', code: '', quantity: 1, unit: '', unitPrice: null, taxRate: 10 }] }, 'manual');
  assert.ok(!('error' in unknown) && unknown.order.items.length === 0 && unknown.order.flags.some((f) => f.text.startsWith('品名')));
  // 品目を直すと「いつもの」の印は外れる
  assert.equal(await service.updateOrder(who, usual.order.id, { items: [{ name: 'ルーター', quantity: 1, unit: '台', unitPrice: 15000 }] }), null);
  assert.ok(!(await service.getOrder(who, usual.order.id))!.order.flags.some((f) => f.kind === 'guess'));
  const empty = await service.recordOrder(who, { party: '', items: [] }, 'manual');
  assert.ok('error' in empty);
});

test('電話で受けた注文の注文書が後から届いたら、新しく作らずに元の受注につなぐ', async () => {
  const { service, who, upload } = setup();
  const phone = await service.recordOrder(who, {
    party: '株式会社見本商事', items: [
      { name: 'ケーブル3m', code: '', quantity: 10, unit: '本', unitPrice: 1200, taxRate: 10 },
      { name: 'ルーター', code: '', quantity: 2, unit: '台', unitPrice: 15000, taxRate: 10 },
    ], dueOn: '2026-11-05', orderedOn: '2026-10-19',
  }, 'manual');
  assert.ok(!('error' in phone) && !phone.duplicate);
  const paper = await service.importOrder(who, await upload(ORDER));
  assert.ok(!('error' in paper) && paper.duplicate && paper.linked);
  assert.equal(paper.order.id, phone.order.id);
  assert.equal(paper.order.customerRef, 'PO-7788');
  assert.ok(paper.order.sourceFileId);
  assert.ok(paper.order.flags.some((f) => f.kind === 'calc'), '届いた注文書の合計との食い違い');
  assert.equal((await service.listOrders(who)).length, 1);
  const sug = await service.suggestions(who, '見本商事');
  assert.deepEqual(sug.items.slice(0, 2).map((x) => x.name).sort(), ['ケーブル3m', 'ルーター']);
  assert.ok(sug.parties.includes('株式会社見本商事'));
});

test('「いつもの」は受注と納品書だけから読み、見積書だけの品目は数えない', async () => {
  const quote: QuoteRecord = {
    id: 'qt-9', tenantId: 't1', number: 'Q-20261001-09', requestedBy: 'u1', runId: null, toName: '株式会社見本商事 御中',
    items: [{ name: '見積だけの品', quantity: 1, unit: '式', unitPrice: 9999, taxRate: 10 }], subtotal: 9999, tax: 999, total: 10998, validUntil: null, fileId: null, createdAt: '',
  };
  const { service, who } = setup({ quotes: [quote, quote, quote] });
  await service.recordOrder(who, { party: '株式会社見本商事', items: [{ name: '特製パン', code: '', quantity: 5, unit: '個', unitPrice: 180, taxRate: 10 }], dueOn: '2026-11-01' }, 'manual');
  const r = await service.recordOrder(who, { party: '見本商事', items: [{ name: 'いつもの', code: '', quantity: 8, unit: '', unitPrice: null, taxRate: 10 }] }, 'manual');
  assert.ok(!('error' in r));
  assert.equal(r.order.items[0]!.name, '特製パン');
  // 画面の候補には見積書の品目も出す
  assert.ok((await service.suggestions(who, '見本商事')).items.some((x) => x.name === '見積だけの品'));
});
