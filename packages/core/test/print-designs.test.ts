/**
 * @file 販促物の作成の段 1 の単体テスト（仕様書 第41.17節）。型と組み版（すべての種類と大きさで組める・パンフレットは 2 面・入りきらない文の印）、
 * 点検（曜日・連絡先）、書き出し（PNG・実寸と入稿用の PDF）、3 案（推論が使えないときも組む・頼みに無い値段を足さない・掲示の期間）、
 * 生成 AI の画像（人や文字が写れば使わない）、会話で直す（新しい版・言葉で直す）、文面を直す、前の版に戻す、作り直す、
 * 削除は作った人と管理者だけ、期間の見張り（1 回だけ・外した物と止めた人には知らせない）、ツール（使えない人には「使えない」）。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PDFDocument } from 'pdf-lib';
import { DEFAULT_TENANT_SETTINGS, PRINT_KIND_SIZES, printStateOf, type PrintKind, type TenantSettings } from '@m2office/shared';
import {
  MemoryFileStore, MemoryPrintDesignStore, PRINT_DESIGN_TOOLS, PrintDesignService, contactChecks, fitText, layout, pagePng, printDesignsAccess, renderCover,
  templatesFor, toPdf, weekdayChecks,
  type LlmProvider, type Repository, type ToolContext,
} from '../src/index.js';

/** 2026-10-06（火）9:00（日本時間） */
const NOW = new Date('2026-10-06T00:00:00Z');
const COMPANY = { name: '見本商店', address: '東京都千代田区1-1', phone: '03-1234-5678', website: 'https://www.example.jp' };
const samplePng = () => renderCover({ title: '見本', background: { kind: 'template', pattern: 'dots', color: '#335577' } });

/** 推論が使えない会社（見本の会社と同じ）。 */
const stubLlm = { name: 'stub', complete: async () => ({ text: '', tokensUsed: 0 }) } as unknown as LlmProvider;

/** 文面・直し・作り直し・点検に決まった答えを返し、画像を描く推論。`checks` は描いた画像の確かめの答え。 */
function fakeLlm(checks: string[] = []): LlmProvider & { drawn: number } {
  const llm = {
    name: 'fake', drawn: 0,
    complete: async (req: { messages: { content: unknown }[] }) => {
      const sys = String(req.messages[0]?.content ?? '');
      if (sys.includes('文面を作り')) {
        return { text: JSON.stringify({ kind: 'flyer', size: 'A4', title: '春の決算セール', headline: '春の決算セール', sub: '全品 10% オフ', body: '駐車場あり', period: '3/1（日）〜3/15（日）', price: '', note: '', postFrom: '2027-03-01', postTo: '2027-03-15', scene: '春の花と空' }), tokensUsed: 1 };
      }
      if (sys.includes('直す頼み')) return { text: JSON.stringify({ copy: { sub: '全品 20% オフ' }, template: '', palette: 2, headlineScale: 1.3, image: 'keep', scene: '' }), tokensUsed: 1 };
      if (sys.includes('前に作った印刷物')) return { text: JSON.stringify({ copy: { period: '3/1（月）〜3/15（月）' }, postFrom: '2027-03-01', postTo: '2027-03-15' }), tokensUsed: 1 };
      if (sys.includes('点検してください')) return { text: JSON.stringify({ items: [{ kind: 'law', message: '「全品」の条件を確かめてください' }, { kind: 'other', message: '捨てる' }] }), tokensUsed: 1 };
      return { text: '{}', tokensUsed: 1 };
    },
    extractFromImage: async () => ({ text: checks.shift() ?? '{"people": false, "text": false, "logo": false, "body": false}', tokensUsed: 1 }),
    generateImage: async () => { llm.drawn += 1; return { bytes: samplePng(), mimeType: 'image/png' }; },
  };
  return llm as never;
}

function setup(opts: { llm?: LlmProvider; settings?: Partial<TenantSettings> } = {}) {
  let clock = NOW;
  let settings: TenantSettings = {
    ...DEFAULT_TENANT_SETTINGS,
    company: { ...DEFAULT_TENANT_SETTINGS.company, legalName: '見本商店株式会社', shortName: COMPANY.name, address: COMPANY.address, phone: COMPANY.phone, website: COMPANY.website },
    printDesigns: { enabled: true },
    ...opts.settings,
  };
  const users = [
    { id: 'boss', email: 'boss@alpha.example.jp', displayName: '店長', roles: ['admin'], status: 'active' },
    { id: 'u1', email: 'u1@alpha.example.jp', displayName: '店員', roles: ['member'], status: 'active' },
    { id: 'u2', email: 'u2@alpha.example.jp', displayName: '別の店員', roles: ['member'], status: 'active' },
  ];
  const audits: { action: string; detail: Record<string, unknown> }[] = [];
  const notifications: { userId: string; kind: string; title: string }[] = [];
  const prefs = new Map<string, boolean>();
  const fileMeta = new Map<string, { id: string; ownerUserId: string; kind: string; mime: string; runId: null }>();
  const repo = {
    findUserById: async (_t: string, id: string) => users.find((u) => u.id === id) ?? null,
    getTenantSettings: async () => settings,
    listTenantIds: async () => ['t1'],
    listUserGroupIds: async () => [],
    appendAudit: async (e: { action: string; detail: Record<string, unknown> }) => { audits.push(e); },
    getUserSettings: async (_t: string, id: string) => ({ notifications: { kinds: { print: prefs.get(id) ?? true } } }),
    createNotification: async (n: { userId: string; kind: string; title: string }) => { notifications.push(n); },
    getFile: async (_t: string, id: string) => fileMeta.get(id) ?? null,
    listApprovalsForFileInput: async () => [],
  } as unknown as Repository;
  const files = new MemoryFileStore();
  const store = new MemoryPrintDesignStore();
  const llm = opts.llm ?? stubLlm;
  const service = new PrintDesignService({ store, repo, files, llmFor: async () => llm, now: () => clock });
  /** 本人が上げた写真。 */
  const upload = async (owner: string) => {
    const id = `f-${fileMeta.size + 1}`;
    fileMeta.set(id, { id, ownerUserId: owner, kind: 'png', mime: 'image/png', runId: null });
    await files.put('t1', id, samplePng());
    return id;
  };
  return {
    service, store, files, repo, audits, notifications, prefs, upload,
    setSettings: (s: Partial<TenantSettings>) => { settings = { ...settings, ...s }; },
    setClock: (d: Date) => { clock = d; },
  };
}

const u1 = { tenantId: 't1', userId: 'u1' };
const u2 = { tenantId: 't1', userId: 'u2' };
const boss = { tenantId: 't1', userId: 'boss' };
const isPng = (b: Uint8Array) => b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47;
const isPdf = (b: Uint8Array) => Buffer.from(b.slice(0, 5)).toString('latin1') === '%PDF-';

test('型と組み版: すべての種類と大きさで型があり、組める。パンフレットは 2 面', () => {
  const copy = { headline: '春の決算セール', sub: '全品 10% オフ', body: '駐車場あり\n3/1〜15', period: '3/1（日）〜3/15（日）', price: '10% オフ', note: '一部除く', qrUrl: '' };
  for (const [kind, sizes] of Object.entries(PRINT_KIND_SIZES) as [PrintKind, typeof PRINT_KIND_SIZES[PrintKind]][]) {
    for (const size of sizes) {
      const ts = templatesFor(kind, size);
      assert.ok(ts.length > 0, `${kind} ${size} に型が無い`);
      for (const template of ts) {
        for (const palette of [0, 1, 2]) {
          const pages = layout({ size, template, color: '#1f8a80', palette, headlineScale: 1, copy, image: null, logo: null, qr: null, company: COMPANY });
          assert.equal(pages.length, kind === 'brochure' ? 2 : 1, `${kind} ${size} ${template}`);
          for (const p of pages) assert.match(p.svg, /^<svg[\s\S]*<\/svg>$/);
        }
      }
    }
  }
});

test('字の大きさを枠に合わせ、下限でも入らなければ「入りきらない」にする', () => {
  const short = fitText('春のセール', 100, 30, 20, 6);
  assert.equal(short.overflow, false);
  assert.equal(short.lines.length, 1);
  const long = fitText('あ'.repeat(2000), 40, 10, 12, 6);
  assert.equal(long.overflow, true);
  assert.ok(long.size <= 12 && long.size >= 6);
  const pages = layout({ size: 'card', template: 'card', color: '#1f8a80', palette: 0, headlineScale: 1, copy: { headline: 'カード', sub: '', body: 'あ'.repeat(600), period: '', price: '', note: '', qrUrl: '' }, image: null, logo: null, qr: null, company: COMPANY });
  assert.ok(pages[0]!.overflow.length > 0);
});

test('点検: 日付と曜日の食い違い・暦に無い日付・会社情報と違う電話と URL', () => {
  // 2026-10-06 は火曜日
  assert.deepEqual(weekdayChecks('10/6（火）から', '2026-10-06'), []);
  assert.match(weekdayChecks('10月7日（火）', '2026-10-06')[0]!.message, /「水」/);
  assert.match(weekdayChecks('2/30（月）', '2026-10-06')[0]!.message, /暦に無い/);
  // 年が無く、今日より 2 か月以上前の月は来年（2027-03-01 は月曜日）
  assert.deepEqual(weekdayChecks('3/1（月）', '2026-10-06'), []);
  assert.equal(weekdayChecks('2026年3月1日(月)', '2026-10-06').length, 1);
  const copy = { headline: '', sub: '', body: 'お電話 03-9999-0000\nhttps://other.example.com/x', period: '', price: '', note: 'TEL 03-1234-5678', qrUrl: 'https://www.example.jp/map' };
  const c = contactChecks(copy, COMPANY);
  assert.equal(c.length, 2);
  assert.ok(c.some((x) => x.message.includes('03-9999-0000')));
  assert.ok(c.some((x) => x.message.includes('other.example.com')));
});

test('書き出し: 印刷の解像度の PNG、実寸と入稿用の PDF（入稿用は塗り足しと余白のぶん大きい）', async () => {
  const pages = layout({ size: 'A5', template: 'band', color: '#1f8a80', palette: 0, headlineScale: 1, copy: { headline: '見本', sub: '', body: '', period: '', price: '', note: '', qrUrl: '' }, image: null, logo: null, qr: null, company: COMPANY });
  assert.ok(isPng(pagePng(pages[0]!, 'A5', 400)));
  const trim = await toPdf(pages, 'A5', 'trim');
  const bleed = await toPdf(pages, 'A5', 'bleed');
  assert.ok(isPdf(trim) && isPdf(bleed));
  const box = async (b: Uint8Array) => { const p = (await PDFDocument.load(b)).getPage(0).getSize(); return [p.width, p.height]; };
  const [tw, th] = await box(trim);
  const [bw, bh] = await box(bleed);
  // A5 は 148×210mm（1mm = 72/25.4pt）
  assert.ok(Math.abs(tw! - 148 * 72 / 25.4) < 1 && Math.abs(th! - 210 * 72 / 25.4) < 1);
  assert.ok(Math.abs(bw! - (148 + 26) * 72 / 25.4) < 1 && Math.abs(bh! - (210 + 26) * 72 / 25.4) < 1);
});

test('作る（推論が使えない会社）: 頼みの文から 3 案を組み、種類と大きさを決め、案を選ぶまでは下書き', async () => {
  const s = setup();
  assert.ok('error' in (await s.service.create(u1, { request: ' ' })));
  const r = await s.service.create(u1, { request: '夏祭りのチラシ。8/1（月）開催' });
  assert.ok(!('error' in r));
  assert.equal(r.design.kind, 'flyer');
  assert.equal(r.design.size, 'A4');
  assert.equal(r.versions.length, 3);
  assert.ok(r.versions.every((v) => v.proposal && v.image === 'none' && !v.aiImage));
  assert.equal(new Set(r.versions.map((v) => `${v.template}:${v.palette}`)).size, 3);
  assert.equal(r.design.currentVersionId, null);
  assert.equal(r.state, 'draft');
  // 2026-08-01 は土曜日なので、曜日の印を付ける
  assert.ok(r.versions[0]!.checks.some((c) => c.kind === 'weekday'));
  // 案の小さな画像を置き場に覚える
  assert.ok(isPng((await s.files.get('t1', `print-${r.versions[0]!.id}-preview`))!));
  assert.equal(s.audits.at(-1)?.action, 'print.create');
  // 見出しは 1 文目から「のチラシ」「を A4 で」を外したもの
  const named = await s.service.create(u1, { request: '春の決算セールのチラシを A4 で。3/1〜15' });
  assert.ok(!('error' in named));
  assert.equal(named.design.title, '春の決算セール');
  assert.equal(named.versions[0]!.copy.headline, '春の決算セール');
  // 種類と大きさを指定できる（種類に合わない大きさは使わない）
  const pop = await s.service.create(u1, { request: 'おすすめのケーキ 450 円', kind: 'pop', size: 'A3' });
  assert.ok(!('error' in pop));
  assert.equal(pop.design.kind, 'pop');
  assert.ok(PRINT_KIND_SIZES.pop.includes(pop.design.size));
});

test('作る（推論が使える会社）: 推論の文面と掲示の期間を使い、生成 AI の画像を描き、点検の印を付ける', async () => {
  const llm = fakeLlm();
  const s = setup({ llm });
  const r = await s.service.create(u1, { request: '春の決算セールのチラシを A4 で。3/1〜15、全品 10% オフ、駐車場あり' });
  assert.ok(!('error' in r));
  assert.equal(r.design.title, '春の決算セール');
  assert.equal(r.design.postFrom, '2027-03-01');
  assert.equal(r.design.postTo, '2027-03-15');
  assert.equal(r.state, 'upcoming');
  assert.equal(r.versions[0]!.copy.price, '');
  assert.equal(llm.drawn, 1);
  const withImage = r.versions.filter((v) => v.aiImage);
  assert.ok(withImage.length > 0);
  assert.ok(withImage.every((v) => v.checks.some((c) => c.kind === 'image')));
  // 推論の点検は typo と law だけを使う
  assert.ok(r.versions[0]!.checks.some((c) => c.kind === 'law'));
  assert.ok(!r.versions[0]!.checks.some((c) => (c.kind as string) === 'other'));
  // 「3/1（日）」は 2027 年なら月曜日
  assert.ok(r.versions[0]!.checks.some((c) => c.kind === 'weekday'));
});

test('生成 AI の画像に人や文字が写れば 1 回だけ描き直し、それでもだめなら画像を使わない。写真を渡せば写真を使う', async () => {
  const bad = '{"people": true, "text": false, "logo": false, "body": false}';
  const llm = fakeLlm([bad, bad]);
  const s = setup({ llm });
  const r = await s.service.create(u1, { request: '春のチラシ' });
  assert.ok(!('error' in r));
  assert.equal(llm.drawn, 2);
  assert.ok(r.versions.every((v) => v.image === 'none' && !v.aiImage));

  const photo = await s.upload('u1');
  const p = await s.service.create(u1, { request: '新作のケーキのポップ', photoFileId: photo });
  assert.ok(!('error' in p));
  assert.ok(p.versions.every((v) => v.image === 'photo'));
  // ほかの人の写真は使えない
  assert.ok('error' in (await s.service.create(u2, { request: 'ポップ', photoFileId: photo })));
});

test('選ぶ・会話で直す（推論が使えないときは言葉で）・文面を直す・前の版に戻す', async () => {
  const s = setup();
  const r = await s.service.create(u1, { request: '夏祭りのチラシ' });
  assert.ok(!('error' in r));
  const second = r.versions[1]!;
  assert.match((await s.service.choose(u1, r.design.id, 'prv-none'))!, /見つかりません/);
  assert.equal(await s.service.choose(u1, r.design.id, second.id), null);

  const bigger = await s.service.revise(u1, r.design.id, '見出しをもっと大きく');
  assert.ok(!('error' in bigger));
  const v4 = bigger.versions.at(-1)!;
  assert.equal(v4.proposal, false);
  assert.equal(v4.headlineScale, 1.2);
  assert.equal(v4.template, second.template);
  assert.equal(bigger.design.currentVersionId, v4.id);

  const color = await s.service.revise(u1, r.design.id, 'もう少し落ち着いた色で');
  assert.ok(!('error' in color));
  assert.equal(color.versions.at(-1)!.palette, (second.palette + 1) % 3);
  assert.ok('error' in (await s.service.revise(u1, r.design.id, 'いい感じにして')));
  assert.ok('error' in (await s.service.revise(u1, r.design.id, '')));

  const edited = await s.service.editCopy(u1, r.design.id, { price: '入場無料', headline: '夏祭り 2026' });
  assert.ok(!('error' in edited));
  const last = edited.versions.at(-1)!;
  assert.equal(last.copy.price, '入場無料');
  assert.equal(last.copy.headline, '夏祭り 2026');
  assert.equal(last.headlineScale, 1.2);

  assert.equal(await s.service.restore(u1, r.design.id, v4.id), null);
  assert.equal((await s.service.get(u1, r.design.id))!.design.currentVersionId, v4.id);
});

test('会話で直す（推論が使える会社）: 変える所だけを直し、見出しの倍率は幅に収める', async () => {
  const s = setup({ llm: fakeLlm() });
  const r = await s.service.create(u1, { request: '春の決算セールのチラシ' });
  assert.ok(!('error' in r));
  await s.service.choose(u1, r.design.id, r.versions[0]!.id);
  const d = await s.service.revise(u1, r.design.id, '割引を 20% にして、濃い色で');
  assert.ok(!('error' in d));
  const v = d.versions.at(-1)!;
  assert.equal(v.copy.sub, '全品 20% オフ');
  assert.equal(v.copy.headline, '春の決算セール');
  assert.equal(v.palette, 2);
  assert.equal(v.headlineScale, 1.3);
  assert.equal(v.instruction, '割引を 20% にして、濃い色で');
});

test('書き出し（処理）: 案の画像・PNG・実寸と入稿用の PDF。別の物の版は書き出さない。書き出しを記録に残す', async () => {
  const s = setup();
  const a = await s.service.create(u1, { request: 'お知らせ。臨時休業' });
  const b = await s.service.create(u1, { request: 'パンフレット。店の紹介', kind: 'brochure' });
  assert.ok(!('error' in a) && !('error' in b));
  const v = a.versions[0]!;
  assert.ok(isPng((await s.service.export(u1, a.design.id, v.id, 'preview'))!.bytes));
  const png = (await s.service.export(u1, a.design.id, v.id, 'png'))!;
  assert.ok(isPng(png.bytes));
  assert.match(png.name, /\.png$/);
  const pdf = (await s.service.export(u1, a.design.id, v.id, 'pdf'))!;
  assert.ok(isPdf(pdf.bytes));
  assert.match((await s.service.export(u1, a.design.id, v.id, 'bleed'))!.name, /入稿用\.pdf$/);
  assert.equal(await s.service.export(u1, b.design.id, v.id, 'pdf'), null);
  // パンフレットは 2 面（内側の面の画像も出せる）
  assert.ok(isPng((await s.service.export(u1, b.design.id, b.versions[0]!.id, 'preview', 1))!.bytes));
  assert.ok(s.audits.some((x) => x.action === 'print.export' && x.detail['kind'] === 'pdf'));
  assert.ok(isPng((await s.service.thumb(u1, a.design.id))!.bytes));
});

test('掲示の期間と置き場所・外した・状態', async () => {
  const s = setup();
  const r = await s.service.create(u1, { request: '入口のポスター', kind: 'poster' });
  assert.ok(!('error' in r));
  assert.match((await s.service.setPost(u1, r.design.id, { postFrom: '2026/10/1' }))!, /YYYY-MM-DD/);
  assert.match((await s.service.setPost(u1, r.design.id, { postFrom: '2026-10-10', postTo: '2026-10-01' }))!, /後に/);
  assert.equal(await s.service.setPost(u1, r.design.id, { postFrom: '2026-10-01', postTo: '2026-10-31', place: '入口', title: '秋のポスター' }), null);
  let list = await s.service.list(u1);
  assert.equal(list[0]!.state, 'posted');
  assert.equal(list[0]!.place, '入口');
  assert.equal(list[0]!.title, '秋のポスター');
  assert.equal(await s.service.markRemoved(u1, r.design.id), null);
  list = await s.service.list(u1);
  assert.equal(list[0]!.state, 'removed');
  // 期間を直すと「外した」を外す
  await s.service.setPost(u1, r.design.id, { postTo: '2026-11-30' });
  assert.equal((await s.service.list(u1))[0]!.state, 'posted');
  assert.equal(printStateOf({ postFrom: '2026-11-01', postTo: null, removedAt: null }, '2026-10-06'), 'upcoming');
  assert.equal(printStateOf({ postFrom: null, postTo: '2026-10-05', removedAt: null }, '2026-10-06'), 'ended');
});

test('作り直す: 前の物の選んだ版を元に新しい物を作る（題名に「作り直し」を重ねない）', async () => {
  const s = setup({ llm: fakeLlm() });
  const r = await s.service.create(u1, { request: '春の決算セールのチラシ' });
  assert.ok(!('error' in r));
  await s.service.choose(u1, r.design.id, r.versions[2]!.id);
  const n = await s.service.remake(u1, r.design.id, '来年の日付で');
  assert.ok(!('error' in n));
  assert.notEqual(n.design.id, r.design.id);
  assert.equal(n.design.remadeFrom, r.design.id);
  assert.equal(n.design.title, '春の決算セール（作り直し）');
  assert.equal(n.versions.length, 1);
  assert.equal(n.versions[0]!.template, r.versions[2]!.template);
  assert.equal(n.versions[0]!.copy.period, '3/1（月）〜3/15（月）');
  assert.equal(n.design.postTo, '2027-03-15');
  assert.equal(n.design.currentVersionId, n.versions[0]!.id);
  const again = await s.service.remake(u1, n.design.id, '');
  assert.ok(!('error' in again));
  assert.equal(again.design.title, '春の決算セール（作り直し）');
});

test('削除は作った人と管理者だけ。画像も消す', async () => {
  const s = setup();
  const r = await s.service.create(u1, { request: 'ポップ' });
  assert.ok(!('error' in r));
  assert.match((await s.service.remove(u2, r.design.id))!, /作った人と管理者だけ/);
  assert.equal(await s.service.remove(boss, r.design.id), null);
  assert.equal(await s.service.get(u1, r.design.id), null);
  assert.equal(await s.files.get('t1', `print-${r.versions[0]!.id}-preview`), null);
  assert.equal(s.audits.at(-1)?.action, 'print.delete');
});

test('期間の見張り: 終わった物を作った人に 1 回だけ知らせる。外した物・止めた人・切った会社には知らせない', async () => {
  const s = setup();
  const a = await s.service.create(u1, { request: '夏祭りのポスター', kind: 'poster' });
  const b = await s.service.create(u1, { request: 'レジ横のポップ', kind: 'pop' });
  const c = await s.service.create(u2, { request: '求人のチラシ' });
  assert.ok(!('error' in a) && !('error' in b) && !('error' in c));
  await s.service.setPost(u1, a.design.id, { postTo: '2026-10-05', place: '入口' });
  await s.service.setPost(u1, b.design.id, { postTo: '2026-10-05' });
  await s.service.markRemoved(u1, b.design.id);
  await s.service.setPost(u2, c.design.id, { postTo: '2026-10-05' });
  s.prefs.set('u2', false);
  // 終わりの日の当日は、まだ知らせない
  s.setClock(new Date('2026-10-04T23:00:00Z'));
  assert.equal(await s.service.tick(), 0);
  s.setClock(NOW);
  assert.equal(await s.service.tick(), 1);
  assert.equal(s.notifications.length, 1);
  assert.equal(s.notifications[0]!.userId, 'u1');
  assert.equal(s.notifications[0]!.kind, 'print');
  assert.match(s.notifications[0]!.title, /掲示の期間が終わりました/);
  assert.equal(await s.service.tick(), 0);
  // 終わりの日を直せば、また知らせる
  await s.service.setPost(u1, a.design.id, { postTo: '2026-10-05' });
  assert.equal(await s.service.tick(), 1);
  s.setSettings({ printDesigns: { enabled: false } });
  await s.service.setPost(u1, a.design.id, { postTo: '2026-10-05' });
  assert.equal(await s.service.tick(), 0);
});

test('ツール: 使えない会社では「使えない」。作る・直す・探す（状態と言葉）・作り直す', async () => {
  const s = setup();
  const access = printDesignsAccess(s.repo);
  const ctx = (userId: string) => ({ tenantId: 't1', userId, printDesigns: { service: s.service, access: () => access('t1', userId) } }) as unknown as ToolContext;
  const tool = (name: string) => PRINT_DESIGN_TOOLS.find((t) => t.name === name)!;
  const made = await tool('print.create').invoke({ request: '秋のセールのチラシ。10/10（土）から' }, ctx('u1')) as { available: boolean; created: { path: string; proposals: number; checks: string[] } };
  assert.equal(made.available, true);
  assert.equal(made.created.proposals, 3);
  assert.match(made.created.path, /^\/print-designs\/prd-/);
  const revised = await tool('print.revise').invoke({ instruction: '見出しをもっと大きく' }, ctx('u1')) as { available: boolean };
  assert.equal(revised.available, true);
  const id = made.created.path.split('/').pop()!;
  await s.service.setPost(u1, id, { postFrom: '2026-10-01', postTo: '2026-10-31', place: '入口' });
  const found = await tool('print.find').invoke({ query: '入口', state: 'posted' }, ctx('u1')) as { count: number; items: { place: string }[] };
  assert.equal(found.count, 1);
  assert.equal(found.items[0]!.place, '入口');
  assert.equal((await tool('print.find').invoke({ state: 'ended' }, ctx('u1')) as { count: number }).count, 0);
  const remade = await tool('print.remake').invoke({ query: '秋', instruction: '来年の日付で' }, ctx('u1')) as { available: boolean; from: string };
  assert.equal(remade.available, true);
  assert.equal((await tool('print.remake').invoke({ query: '存在しない' }, ctx('u1')) as { available: boolean }).available, false);
  s.setSettings({ printDesigns: { enabled: false } });
  assert.equal((await tool('print.find').invoke({}, ctx('u1')) as { available: boolean }).available, false);
  assert.equal(await access('t1', 'u1'), null);
});
