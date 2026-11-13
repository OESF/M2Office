/**
 * @file メールのやり取りを資料にする（第44.18節。段 6）のテスト。決まりで除くもの・引用を外すこと・AI の答えの受け取り方・
 * 残すものだけを要約して資料にすること・同じやり取りを読み直さないこと・新しいメールで書き直すこと・添付と「同じやり取り」でつなぐこと・
 * 共有しないこと・中身を Gmail から読むこと・外したものを取り込み直さないこと・頼まれたら残すこと・前から使っている人へのお知らせと費用の確かめ・
 * AI で読めない会社では読まないこと。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_TENANT_SETTINGS, LIBRARY_THREAD_DOC_TYPE } from '@m2office/shared';
import {
  LibraryMailWatch, LibraryService, MemoryFileStore, MemoryLibraryStore, MockWorkspaceConnector, libraryLinks, libraryStripQuoted, libraryThreadSkipOf, libraryThreadText,
  parseThreadFields, silentLogger,
  type LibraryLinkInput, type LlmProvider, type LlmRequest, type MailConnector, type MailHead, type MailMessage, type Repository,
} from '../src/index.js';

const A = { tenantId: 't1', userId: 'u1' };
const NOW = new Date('2026-11-13T03:00:00Z');
const hoursAgo = (h: number) => new Date(NOW.getTime() - h * 3_600_000).toISOString();

type Msg = MailMessage & { threadId: string; bulk?: boolean };

/** 偽の Gmail（やり取りだけ）。スレッドごとのメールを古い順に持つ。 */
function fakeMail(threads: Map<string, Msg[]>, total?: number): MailConnector & { reads: string[] } {
  const reads: string[] = [];
  const lastAt = (id: string) => Math.max(...threads.get(id)!.map((m) => Date.parse(m.receivedAt))) / 1000;
  const fake = {
    reads,
    threadPage: async (_p: unknown, q: { after?: number; before?: number; pageToken?: string; limit?: number }) => {
      const ids = [...threads.keys()].filter((id) => (q.after === undefined || lastAt(id) > q.after) && (q.before === undefined || lastAt(id) < q.before))
        .sort((a, b) => lastAt(b) - lastAt(a));
      const start = Number(q.pageToken ?? 0);
      const limit = q.limit ?? 25;
      return { ids: ids.slice(start, start + limit), next: start + limit < ids.length ? String(start + limit) : null };
    },
    threadCount: async () => total ?? threads.size,
    threadHeads: async (_p: unknown, id: string): Promise<MailHead[]> => (threads.get(id) ?? []).map((m) => ({
      id: m.id, threadId: id, from: m.from, to: [], cc: [], subject: m.subject, snippet: m.snippet, receivedAt: m.receivedAt, labels: m.labels, bulk: !!m.bulk,
    })),
    thread: async (_p: unknown, id: string) => { reads.push(id); return threads.get(id) ?? []; },
    get: async (_p: unknown, id: string) => [...threads.values()].flat().find((m) => m.id === id) ?? null,
  };
  return fake as unknown as MailConnector & { reads: string[] };
}

const msg = (threadId: string, n: number, from: string, subject: string, body: string, at: string, extra: Partial<Msg> = {}): Msg => ({
  id: `${threadId}-${n}`, threadId, from, subject, snippet: body.slice(0, 40), body, receivedAt: at, unread: false, labels: ['INBOX'], ...extra,
});

/** AI の見本。支払いの話は残し、日程だけの話は残さない。 */
function fakeLlm(): LlmProvider & { asked: string[] } {
  const asked: string[] = [];
  const llm = {
    name: 'fake', asked,
    async complete(req: LlmRequest) {
      const text = String(req.messages.at(-1)!.content);
      asked.push(text);
      if (text.includes('支払い')) {
        return { text: JSON.stringify({ keep: true, title: 'サンプル商事 新店舗の内装 支払い条件の取り決め', counterparty: 'サンプル商事', summary: '支払いは月末締め翌月末払い、内装は 12 月 10 日までに終える。こちらは図面を 11 月 20 日までに送る。', keywords: ['支払い条件', '内装'], tags: ['新店舗の内装'] }), tokensUsed: 1 };
      }
      return { text: '{"keep":false,"title":"","counterparty":"","summary":"","keywords":[],"tags":[]}', tokensUsed: 1 };
    },
  };
  return llm as unknown as LlmProvider & { asked: string[] };
}

function setup(threads: Map<string, Msg[]>, opts: { total?: number; reader?: 'ok' | 'none' } = {}) {
  let now = NOW;
  const store = new MemoryLibraryStore();
  const notices: { title: string; body: string }[] = [];
  const audit: string[] = [];
  const repo = {
    appendAudit: async (a: { action: string }) => { audit.push(a.action); },
    getTenantSettings: async () => ({ ...DEFAULT_TENANT_SETTINGS, library: { enabled: true } }),
    listUserGroupIds: async () => [],
    listGroups: async () => [],
    createNotification: async (n: { title: string; body: string }) => { notices.push(n); },
    findUserById: async () => ({ id: 'u1', status: 'active', roles: [] }),
    getUserSettings: async () => ({ notifications: { kinds: {} } }),
  } as unknown as Repository;
  const llm = fakeLlm();
  const mail = fakeMail(threads, opts.total);
  const connector = new MockWorkspaceConnector(() => now);
  const service = new LibraryService({
    store, repo, files: new MemoryFileStore(), drive: connector.drive as never, logger: silentLogger, llmFor: async () => llm, readerState: async () => opts.reader ?? 'ok',
    costPerItemJpy: async () => 0.5, now: () => now, mail,
  });
  const watch = new LibraryMailWatch({ service, store, mail, repo, access: async () => true, logger: silentLogger, now: () => now });
  return { store, service, watch, llm, mail, notices, audit, tick: (ms: number) => { now = new Date(now.getTime() + ms); } };
}

const items = (store: MemoryLibraryStore) => [...store.rows.values()].filter((r) => r.format === 'mail');

// ───────── 決まりと形 ─────────

test('決まりで載せない: 配信だけ・自動の送り主だけ・送っただけ・予定の招待・機微な件名。相手のある仕事のやり取りは AI に回す', () => {
  const h = (from: string, subject: string, extra: Partial<MailHead> = {}) => ({ from, subject, labels: ['INBOX'], bulk: false, ...extra });
  assert.equal(libraryThreadSkipOf([h('news <info@shop.example>', 'セールのお知らせ', { bulk: true })]), 'bulk');
  assert.equal(libraryThreadSkipOf([h('通知 <no-reply@service.example>', 'ログインがありました')]), 'auto');
  assert.equal(libraryThreadSkipOf([h('本人 <me@example.jp>', '見積のお願い', { labels: ['SENT'] })]), 'sent_only');
  assert.equal(libraryThreadSkipOf([h('山田 <yamada@example.jp>', '招待: 定例会議 @ 11月20日')]), 'invite');
  assert.equal(libraryThreadSkipOf([h('人事 <hr@example.jp>', '給与明細の送付')]), 'sensitive');
  assert.equal(libraryThreadSkipOf([h('本人 <me@example.jp>', '支払い条件のご相談', { labels: ['SENT'] }), h('田中 <tanaka@sample.example.jp>', 'Re: 支払い条件のご相談')]), null);
});

test('引用を外す: 「>」の行と「On … wrote:」「差出人:」「2026年… <…>:」から後ろを読まない', () => {
  const body = ['承知しました。月末締めでお願いします。', '', '2026年11月12日(木) 10:00 田中 <tanaka@example.jp>:', '> 支払い条件はいかがでしょうか', '> 前のメール'].join('\n');
  assert.equal(libraryStripQuoted(body), '承知しました。月末締めでお願いします。');
  assert.equal(libraryStripQuoted('了解です\nOn Thu, Nov 12, 2026 at 10:00 Tanaka wrote:\n> old'), '了解です');
  assert.equal(libraryStripQuoted('よろしくお願いします\n\n差出人: 田中\n件名: 見積'), 'よろしくお願いします');
  const text = libraryThreadText([
    { from: '田中 <tanaka@example.jp>', receivedAt: hoursAgo(5), labels: ['INBOX'], body: '支払い条件はいかがでしょうか' },
    { from: '本人 <me@example.jp>', receivedAt: hoursAgo(4), labels: ['SENT'], body: '月末締めでお願いします\n> 支払い条件はいかがでしょうか' },
  ]);
  assert.match(text, /【.+ 田中 <tanaka@example.jp>】\n支払い条件はいかがでしょうか/);
  assert.match(text, /【.+ こちら】\n月末締めでお願いします$/, '自分の返事は「こちら」。引用は外す');
});

test('AI の答え: 決めた項目だけを受け取る。keep が無い・読めない答えは null、要約の無い「残す」は残さない', () => {
  assert.equal(parseThreadFields('わかりません'), null);
  assert.equal(parseThreadFields('{"title":"x"}'), null);
  assert.equal(parseThreadFields('{"keep":true,"title":"x","summary":""}')!.keep, false);
  const f = parseThreadFields('前置き {"keep":true,"title":"A","summary":"決まった","keywords":["a","a"],"tags":["#新店舗"],"extra":"無視"}')!;
  assert.deepEqual(f, { keep: true, title: 'A', counterparty: '', summary: '決まった', keywords: ['a'], tags: ['新店舗'] });
});

// ───────── 取り込み ─────────

function conversation(): Map<string, Msg[]> {
  return new Map<string, Msg[]>([
    ['t-pay', [
      msg('t-pay', 1, '田中 <tanaka@sample.example.jp>', '新店舗の件', '支払い条件のご相談です。月末締め翌月末払いでいかがでしょうか。', hoursAgo(30)),
      msg('t-pay', 2, '本人 <me@example.jp>', 'Re: 新店舗の件', '承知しました。図面は 11 月 20 日までに送ります。', hoursAgo(29), { labels: ['SENT'] }),
    ]],
    ['t-date', [msg('t-date', 1, '佐藤 <sato@other.example.jp>', '打ち合わせの日程', '来週の火曜はいかがでしょうか。', hoursAgo(20))]],
    ['t-news', [msg('t-news', 1, 'お店 <info@shop.example>', 'セール', '今だけ半額', hoursAgo(10), { bulk: true })]],
    ['t-sent', [msg('t-sent', 1, '本人 <me@example.jp>', '見積のお願い', '見積をお願いします', hoursAgo(8), { labels: ['SENT'] })]],
  ]);
}

test('入れると直近 1 年のやり取りを見て、仕事のやり取りだけを要約して資料にする（本文は持たない）。決まりで除くものは AI に読ませない', async () => {
  const threads = conversation();
  const { store, watch, llm, mail, service, audit } = setup(threads);
  await watch.setEnabled(A, true);
  await watch.runFor(A);
  const kept = items(store);
  assert.equal(kept.length, 1, '支払いの取り決めだけを残す');
  const item = kept[0]!;
  assert.equal(item.title, 'サンプル商事 新店舗の内装 支払い条件の取り決め');
  assert.equal(item.docType, LIBRARY_THREAD_DOC_TYPE);
  assert.equal(item.entry, 'mail');
  assert.equal(item.readState, 'done');
  assert.equal(item.driveFileId, null, 'ドライブには置かない');
  assert.match(item.driveUrl!, /^https:\/\/mail\.google\.com\/mail\/u\/0\/#all\/t-pay$/);
  assert.equal(item.receivedAt, hoursAgo(29), '受け取った日は最後のメール');
  assert.ok(item.tags.includes('新店舗の内装') && item.tags.includes('サンプル商事') && item.tags.includes(LIBRARY_THREAD_DOC_TYPE));
  assert.ok(!item.summary.includes('月末締め翌月末払いでいかがでしょうか'), '本文をそのまま持たない（AI の要約だけ）');
  assert.deepEqual(mail.reads.sort(), ['t-date', 't-pay'], '配信と送っただけのやり取りは、本文を読まない');
  assert.equal(llm.asked.length, 2);
  assert.ok(llm.asked[0]!.includes('やり取り（データ）'), 'メールの文はデータとして渡す');
  const state = await watch.state(A);
  assert.equal(state.threads!.kept, 1);
  assert.equal(state.threads!.waiting, null, '初めて入れた人は、入れる前に費用を確かめているので待たない');
  assert.ok(audit.includes('library.threads'));

  // 1 件の画面: 相手・期間・通数。共有はできない
  const page = (await service.page(A, item.id))!;
  assert.deepEqual(page.thread, { threadId: 't-pay', messages: 2, firstAt: hoursAgo(30), lastAt: hoursAgo(29), people: ['田中 <tanaka@sample.example.jp>'] });
  const shared = await service.share(A, item.id, { scope: 'company' });
  assert.ok('error' in shared && shared.error.includes('自分だけ'));
  // 中身を聞かれたら、そのとき Gmail から読む（引用を外す）
  const read = await service.readContent(A, item.id);
  assert.ok(!('error' in read) && read.text.includes('図面は 11 月 20 日までに送ります'));

  // 変わっていなければ読み直さない
  const before = llm.asked.length;
  await watch.runFor(A);
  assert.equal(llm.asked.length, before, '最後のメールが同じやり取りは読み直さない');
});

test('新しいメールが届いたら、同じ資料の要約を書き直す（新しい資料を作らない）。添付と「同じやり取り」でつながる', async () => {
  const threads = conversation();
  const { store, watch, llm, tick } = setup(threads);
  await watch.setEnabled(A, true);
  await watch.runFor(A);
  const id = items(store)[0]!.id;
  tick(20 * 60_000);
  const at = new Date(NOW.getTime() + 10 * 60_000).toISOString();
  threads.get('t-pay')!.push(msg('t-pay', 3, '田中 <tanaka@sample.example.jp>', 'Re: 新店舗の件', '支払い条件、了解しました。', at));
  const asked = llm.asked.length;
  await watch.runFor(A);
  assert.equal(llm.asked.length, asked + 1);
  assert.equal(items(store).length, 1);
  assert.equal(items(store)[0]!.id, id);
  assert.equal(items(store)[0]!.receivedAt, at);
  // 同じメールで届いた添付の資料とは「同じやり取り」でつながる
  const thread = store.rows.get(id)!;
  const input = (x: typeof thread, messageIds: string[]): LibraryLinkInput => ({ ...x, messageIds, folders: [] });
  const attachment = { ...thread, id: 'lib-att', format: 'pdf' as const, keywords: [], tags: [] };
  const links = libraryLinks([input(thread, thread.origins.map((o) => o.messageId!).filter(Boolean)), input(attachment, ['t-pay-1'])]);
  assert.equal(links.get(id)![0]!.kind, 'thread');
});

test('外したやり取りは、新しいメールが届いても取り込み直さない。頼まれたら AI の判断で除いたものも残す', async () => {
  const threads = conversation();
  const { store, watch, service, tick } = setup(threads);
  await watch.setEnabled(A, true);
  await watch.runFor(A);
  const id = items(store)[0]!.id;
  const forgot = await service.forgetThread(A, id);
  assert.deepEqual(forgot, { removed: true });
  assert.equal(items(store).length, 0);
  tick(20 * 60_000);
  threads.get('t-pay')!.push(msg('t-pay', 3, '田中 <tanaka@sample.example.jp>', 'Re: 新店舗の件', '支払いの件、追加です。', new Date(NOW.getTime() + 10 * 60_000).toISOString()));
  await watch.runFor(A);
  assert.equal(items(store).length, 0, '外したやり取りは入れ直さない');
  // ファイルの資料は秘書から外せない
  const file = await store.insert(A, { driveFileId: 'd1', driveUrl: null, placed: true, fileId: null, originalName: '見積.pdf', format: 'pdf', mime: 'application/pdf', sizeBytes: 1, sha256: 'x', entry: 'pc' });
  assert.ok('error' in (await service.forgetThread(A, file.item.id)));
  // 「日程のメールも残して」（メールの ID で頼まれても、そのスレッドを残す）
  const kept = await service.threads!.keep(A, 't-date-1');
  assert.ok('itemId' in kept);
  assert.equal(store.rows.get(kept.itemId)!.format, 'mail');
});

test('前から添付を集めていた人: やり取りも集め始めたことを 1 度だけ知らせ、過去の分が多ければ費用を確かめるまで待つ', async () => {
  const threads = conversation();
  const { store, watch, notices, llm } = setup(threads, { total: 900 });
  // 前の版で入れていた（やり取りの進み具合がまだ無い）
  await store.saveMailWatch(A, { enabled: true, checkedAt: NOW.toISOString(), backFrom: hoursAgo(24 * 365), backUntil: NOW.toISOString(), backToken: null, backDone: true, backDay: null, backCount: 0, scanned: 0, imported: 0, error: '' });
  await watch.runFor(A);
  assert.equal(notices.length, 1);
  assert.match(notices[0]!.title, /やり取りもナレッジに残す/);
  assert.match(notices[0]!.body, /約 900 件/);
  const s = await watch.state(A);
  assert.deepEqual(s.threads!.waiting, { threads: 900, costJpy: 450 });
  // 新しいやり取り（入れた後に届いたもの）は見るが、過去の分はまだ読まない
  assert.equal(llm.asked.length, 0);
  await watch.runFor(A);
  assert.equal(notices.length, 1, '知らせは 1 度だけ');
  const started = await watch.startThreads(A);
  assert.equal(started.threads!.waiting, null);
  await watch.runFor(A);
  assert.equal(items(store).length, 1, '確かめた後に過去の分を読む');
});

test('AI で読めない会社（AI の設定が無い・運営の鍵）では、やり取りを読まず、見た印も付けない', async () => {
  const threads = conversation();
  const { store, watch, llm } = setup(threads, { reader: 'none' });
  await watch.setEnabled(A, true);
  await watch.runFor(A);
  assert.equal(items(store).length, 0);
  assert.equal(llm.asked.length, 0);
  assert.equal(await store.mailThread(A, 't-pay'), null, 'あとで読めるようになったら読む');
});
