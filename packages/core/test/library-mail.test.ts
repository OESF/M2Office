/**
 * @file 資料のメールの添付の取り込み（第44.4節。段 2）のテスト。決まりで除くもの・Gmail の添付の一覧の作り方・過去の 1 年を見て入れること・
 * 配信のメールを入れないこと・同じ中身を 1 つにまとめること・1 日の通数・1 年ずつ広げること・削除したものを取り込み直さないこと・
 * 新しいメール・切ったら止まること・Gmail を読めないとき・送り主を整理の手がかりにすること・目録を消すと取り込みも止まること。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_TENANT_SETTINGS, LIBRARY_MAIL_LIMITS } from '@m2office/shared';
import {
  ConnectorUnavailableError, LibraryMailWatch, LibraryService, MemoryFileStore, MemoryLibraryStore, MockWorkspaceConnector, libraryMailSkipOf, silentLogger,
  type LlmProvider, type MailAttachmentList, type MailConnector, type Repository,
} from '../src/index.js';
import { mailAttachmentListOf } from '../src/connectors/google/mime.js';

const A = { tenantId: 't1', userId: 'u1' };
const NOW = new Date('2026-11-07T03:00:00Z');
const b64url = (s: string) => Buffer.from(s).toString('base64url');

function setup(opts: { mail?: MailConnector; llm?: LlmProvider; access?: boolean; now?: () => Date } = {}) {
  let now = opts.now ?? (() => NOW);
  const connector = new MockWorkspaceConnector(() => now());
  const store = new MemoryLibraryStore();
  const audit: { action: string; detail: unknown; targetType: string }[] = [];
  const repo = {
    appendAudit: async (a: { action: string; detail: unknown; targetType: string }) => { audit.push(a); },
    getTenantSettings: async () => ({ ...DEFAULT_TENANT_SETTINGS, library: { enabled: true } }),
    listUserGroupIds: async () => [],
  } as unknown as Repository;
  const llm = opts.llm ?? { name: 'stub', complete: async () => ({ text: '', tokensUsed: 0 }) } as unknown as LlmProvider;
  const service = new LibraryService({
    store, repo, files: new MemoryFileStore(), drive: connector.drive as never, logger: silentLogger, llmFor: async () => llm, readerState: async () => 'ok',
    costPerItemJpy: async () => 0.5, now: () => now(),
  });
  const watch = new LibraryMailWatch({
    service, store, mail: opts.mail ?? (connector.mail as unknown as MailConnector), repo, access: async () => opts.access ?? true, logger: silentLogger, now: () => now(),
  });
  return { connector, store, service, watch, audit, setNow: (f: () => Date) => { now = f; } };
}

const names = async (store: MemoryLibraryStore) => [...store.rows.values()].map((r) => r.originalName).sort();

// ───────── 決まりで除くもの ─────────

test('本文に埋め込まれた画像・予定の招待・小さい画像・実行ファイルは除き、ほかは入れる（推論を呼ばない）', () => {
  assert.equal(libraryMailSkipOf({ name: 'logo.png', mime: 'image/png', size: 50_000, embedded: true }), 'embedded');
  assert.equal(libraryMailSkipOf({ name: 'invite.ics', mime: 'text/calendar', size: 800, embedded: false }), 'calendar');
  assert.equal(libraryMailSkipOf({ name: '予定.ics', mime: 'application/octet-stream', size: 800, embedded: false }), 'calendar', '形が違っても名前で除く');
  assert.equal(libraryMailSkipOf({ name: 'icon.gif', mime: 'image/gif', size: 2_000, embedded: false }), 'small_image');
  assert.equal(libraryMailSkipOf({ name: 'setup.exe', mime: 'application/octet-stream', size: 90_000, embedded: false }), 'refused');
  assert.equal(libraryMailSkipOf({ name: '現場の写真.jpg', mime: 'image/jpeg', size: LIBRARY_MAIL_LIMITS.smallImageBytes, embedded: false }), null, '小さくない画像は入れる');
  assert.equal(libraryMailSkipOf({ name: '見積書.pdf', mime: 'application/pdf', size: 3_000, embedded: false }), null, '小さくても書類は入れる');
  assert.equal(libraryMailSkipOf({ name: '図面.pdf', mime: 'application/pdf', size: 3_000, embedded: true }), null, '画像でなければ埋め込みの印があっても入れる');
});

test('Gmail の添付の一覧: 本文の HTML から cid: で指される画像に印を付け、配信のメールを見分ける。中身は読まない', () => {
  const m = {
    id: 'm1', internalDate: String(Date.parse('2026-10-01T00:00:00Z')),
    payload: {
      mimeType: 'multipart/mixed',
      headers: [{ name: 'From', value: '=?UTF-8?B?5L2Q6Jek?= <sato@customer.example.jp>' }, { name: 'Subject', value: '見積の送付' }],
      parts: [
        { mimeType: 'multipart/related', parts: [
          { mimeType: 'text/html', body: { data: b64url('<p>本文</p><img src="cid:logo01@x">') } },
          { mimeType: 'image/png', filename: 'logo.png', headers: [{ name: 'Content-ID', value: '<logo01@x>' }], body: { attachmentId: 'att-logo', size: 30_000 } },
        ] },
        { mimeType: 'application/pdf', filename: '見積書.pdf', body: { attachmentId: 'att-pdf', size: 120_000 } },
        { mimeType: 'image/jpeg', filename: '写真.jpg', headers: [{ name: 'Content-ID', value: '<photo@x>' }], body: { attachmentId: 'att-photo', size: 900_000 } },
      ],
    },
  };
  const list = mailAttachmentListOf(m);
  assert.equal(list.from, '佐藤 <sato@customer.example.jp>');
  assert.equal(list.subject, '見積の送付');
  assert.equal(list.receivedAt, '2026-10-01T00:00:00.000Z');
  assert.equal(list.bulk, false);
  assert.deepEqual(list.parts.map((p) => [p.name, p.embedded]), [['logo.png', true], ['見積書.pdf', false], ['写真.jpg', false]], '本文から指されない画像は添付として扱う');

  const header = (name: string, value: string) => mailAttachmentListOf({ id: 'm2', payload: { headers: [{ name, value }] } }).bulk;
  assert.equal(header('List-Unsubscribe', '<https://news.example/unsub>'), true);
  assert.equal(header('List-Id', 'news.example'), true);
  assert.equal(header('Precedence', 'bulk'), true);
  assert.equal(header('Precedence', 'first-class'), false);
  assert.equal(mailAttachmentListOf({ id: 'm3', labelIds: ['CATEGORY_PROMOTIONS'], payload: {} }).bulk, true, 'プロモーションに振り分けられたもの');
});

// ───────── 取り込みの流れ（見本の接続口） ─────────

test('入れると直近 1 年を見て添付を入れる。配信のメール・埋め込みの画像・招待・小さい画像は入れず、同じ中身は 1 つにまとめて届いたメールを足す', async () => {
  const { watch, store, audit } = setup();
  assert.equal((await watch.state(A)).enabled, false, '一度も入れていなければ切り');
  const on = await watch.setEnabled(A, true);
  assert.equal(on.enabled, true);
  assert.equal(on.backFrom, '2025-11-07T03:00:00.000Z', '直近 1 年');
  assert.equal(audit.at(-1)!.action, 'library.mail.on');
  assert.equal(JSON.stringify(audit.at(-1)), JSON.stringify(audit.at(-1)).replace(/sato|見積/g, ''), '記録に送り主も件名も残さない');

  const imported = await watch.runFor(A);
  assert.equal(imported, 2);
  assert.deepEqual(await names(store), ['見積明細.csv', '議事録_定例.txt']);
  const estimate = [...store.rows.values()].find((r) => r.originalName === '見積明細.csv')!;
  assert.equal(estimate.entry, 'mail');
  assert.equal(estimate.placed, true, 'M2Office が置いたファイル（削除ではごみ箱へ移す）');
  assert.equal(estimate.receivedAt, new Date(NOW.getTime() - 86_400_000).toISOString(), '受け取った日はメールの日時');
  const detail = await store.get(A, estimate.id);
  assert.deepEqual(detail!.origins.map((o) => o.subject), ['お見積りの送付（サーバー保守）', 'Re: お見積りの送付'], '同じ中身の 2 通目は手がかりを足すだけ');
  assert.ok(detail!.origins.every((o) => o.sender.includes('sato@customer.example.jp')));

  const s = await watch.state(A);
  assert.equal(s.backDone, true, '範囲の中を見終えた');
  assert.equal(s.scanned, 4, '1 年より前のメールは見ない');
  assert.equal(s.imported, 2);

  // 二度目は何も足さない（一度見たメールは読み直さない）
  assert.equal(await watch.runFor(A), 0);
  assert.equal(store.rows.size, 2);
});

test('さらに 1 年さかのぼれるのは見終えた後だけで、広げた範囲の古いメールも入れる', async () => {
  const { watch, store, audit } = setup();
  await watch.setEnabled(A, true);
  assert.deepEqual(await watch.extend(A), { refused: 'いまの範囲のメールを見ている途中です' });
  await watch.runFor(A);
  const wider = await watch.extend(A);
  assert.ok(!('refused' in wider));
  assert.equal(wider.backFrom, '2024-11-07T03:00:00.000Z');
  assert.equal(wider.backUntil, '2025-11-07T03:00:00.000Z', '前の範囲の初めまで');
  assert.equal(audit.at(-1)!.action, 'library.mail.extend');
  assert.equal(await watch.runFor(A), 1);
  assert.ok((await names(store)).includes('旧規程.txt'));
});

test('削除した資料は、メールから取り込み直さない', async () => {
  const { watch, store, service } = setup();
  await watch.setEnabled(A, true);
  await watch.runFor(A);
  const minutes = [...store.rows.values()].find((r) => r.originalName === '議事録_定例.txt')!;
  await service.remove(A, minutes.id);
  // 範囲を初めから見直しても（入れ直しなど）、削除したものは戻らない
  const w = (await store.mailWatch(A))!;
  await store.saveMailWatch(A, { ...w, backDone: false, backToken: null });
  await watch.runFor(A);
  assert.deepEqual(await names(store), ['見積明細.csv']);
});

test('切ったらすぐ止まり、会社が資料を切った・利用範囲の外の人の受信箱は見ない。目録を消すと取り込みも止まる', async () => {
  const { watch, store, audit } = setup();
  await watch.setEnabled(A, true);
  const off = await watch.setEnabled(A, false);
  assert.equal(off.enabled, false);
  assert.equal(audit.at(-1)!.action, 'library.mail.off');
  assert.equal(await watch.runFor(A), 0);
  assert.equal(store.rows.size, 0);
  assert.deepEqual(await watch.tick(['t1']), 0);

  const outside = setup({ access: false });
  await outside.watch.setEnabled(A, true);
  assert.equal(await outside.watch.runFor(A), 0);
  assert.equal(outside.store.rows.size, 0);

  const purge = setup();
  await purge.watch.setEnabled(A, true);
  await purge.service.purgeOwner('t1', 'u1');
  assert.equal((await purge.watch.state(A)).enabled, false, '連携の解除・退職で目録を消すと、取り込みも止まる');
  assert.deepEqual(await purge.store.mailWatchers('t1'), []);
});

test('入れる前の費用の目安: 添付のあるメールが 500 通を超えるときだけ確かめる', async () => {
  const { watch } = setup();
  const few = await watch.estimate(A, 'start');
  assert.equal(few.messages, 4);
  assert.equal(few.confirm, false);
  const many = setup({ mail: fakeMail({ count: 800 }) });
  const est = await many.watch.estimate(A, 'start');
  assert.equal(est.messages, 800);
  assert.equal(est.costJpy, 400);
  assert.equal(est.confirm, true);
});

// ───────── 偽の受信箱 ─────────

/** 添付のあるメールを、決まった数だけ持つ偽の受信箱。 */
function fakeMail(opts: { count?: number; fail?: boolean; at?: (i: number) => string; newer?: () => string[] } = {}): MailConnector & { calls: number } {
  const count = opts.count ?? 0;
  const ids = Array.from({ length: count }, (_, i) => `f${i}`);
  const at = opts.at ?? ((i: number) => new Date(NOW.getTime() - (i + 1) * 3_600_000).toISOString());
  const fake = {
    calls: 0,
    attachmentPage: async (_p: unknown, q: { after?: number; before?: number; pageToken?: string; limit?: number }) => {
      fake.calls += 1;
      if (opts.fail) throw new ConnectorUnavailableError('unauthorized', 'Gmail を読む許可が外されています');
      const all = [...(opts.newer?.() ?? []), ...ids].filter((id) => {
        const t = Date.parse(id.startsWith('n') ? NOW.toISOString() : at(Number(id.slice(1)))) / 1000;
        return (q.after === undefined || t > q.after) && (q.before === undefined || t < q.before);
      });
      const start = Number(q.pageToken ?? 0);
      const limit = q.limit ?? 25;
      return { ids: all.slice(start, start + limit), next: start + limit < all.length ? String(start + limit) : null };
    },
    attachmentCount: async () => count,
    attachmentParts: async (_p: unknown, id: string): Promise<MailAttachmentList> => ({
      id, from: '山田 <yamada@vendor.example.jp>', subject: `請求書 ${id}`, receivedAt: id.startsWith('n') ? NOW.toISOString() : at(Number(id.slice(1))), bulk: false,
      parts: [{ attachmentId: 'a', name: `${id}.txt`, mime: 'text/plain', size: 10, embedded: false }],
    }),
    attachmentBytes: async (_p: unknown, id: string) => new TextEncoder().encode(`請求書 ${id}`),
  };
  return fake as unknown as MailConnector & { calls: number };
}

test('過去のメールは 1 人 1 日 500 通まで。次の日（日本時間）に続きを見る', async () => {
  let now = NOW;
  const { watch, store, setNow } = setup({ mail: fakeMail({ count: 600 }) });
  setNow(() => now);
  await watch.setEnabled(A, true);
  for (let i = 0; i < 30; i++) await watch.runFor(A);
  let s = await watch.state(A);
  assert.equal(s.scanned, LIBRARY_MAIL_LIMITS.backfillPerDay);
  assert.equal(s.backDone, false);
  assert.equal(store.rows.size, 500);
  now = new Date(NOW.getTime() + 86_400_000);
  for (let i = 0; i < 10; i++) await watch.runFor(A);
  s = await watch.state(A);
  assert.equal(s.backDone, true);
  assert.equal(store.rows.size, 600);
});

test('新しいメールは 15 分ごとに見る（入れた後に届いたもの）', async () => {
  let now = NOW;
  let newer: string[] = [];
  const mail = fakeMail({ count: 0, newer: () => newer });
  const { watch, store, setNow } = setup({ mail });
  setNow(() => now);
  await watch.setEnabled(A, true);
  await watch.runFor(A);
  newer = ['n1'];
  now = new Date(NOW.getTime() + 5 * 60_000);
  await watch.runFor(A);
  assert.equal(store.rows.size, 0, '15 分たつまでは見ない');
  now = new Date(NOW.getTime() + 16 * 60_000);
  assert.equal(await watch.runFor(A), 1);
  assert.deepEqual(await names(store), ['n1.txt']);
});

test('Gmail を読めなければ理由を残して止まり、入り切りは変えない。読めるようになれば理由を消す', async () => {
  const broken = setup({ mail: fakeMail({ fail: true }) });
  await broken.watch.setEnabled(A, true);
  assert.equal(await broken.watch.runFor(A), 0);
  const s = await broken.watch.state(A);
  assert.equal(s.enabled, true);
  assert.equal(s.error, 'Gmail を読む許可が外されています');
  // 入れ直すと理由を消す
  assert.equal((await broken.watch.setEnabled(A, true)).error, '');
});

test('メールから来た資料は、送り主と件名をデータとして整理の手がかりに渡す', async () => {
  const prompts: string[] = [];
  const llm = {
    name: 'fake',
    complete: async (req: { messages: { content: unknown }[] }) => {
      prompts.push(req.messages.map((m) => String(m.content)).join('\n'));
      return { text: JSON.stringify({ title: '請求書', docType: '請求書', counterparty: '山田商店', docDate: null, summary: '', keywords: [] }), tokensUsed: 1 };
    },
  } as unknown as LlmProvider;
  const { watch, service, store } = setup({ mail: fakeMail({ count: 1 }), llm });
  await watch.setEnabled(A, true);
  await watch.runFor(A);
  await service.tick(['t1']);
  assert.match(prompts[0]!, /届いたメール（データ）: 送り主 "山田 <yamada@vendor\.example\.jp>"・件名 "請求書 f0"/);
  assert.equal([...store.rows.values()][0]!.counterparty, '山田商店');
});
