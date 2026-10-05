/**
 * @file コラムから作る店頭サイネージ用の画像の単体テスト（仕様書 第32.18.6節）。場面の分け方・画像の組み方・
 * 作る（承認済みのコラムだけ・画面の向き）→ 承認へ → 流す（承認の後に変わったら流さない・向きの合う画面の先頭に順に置く）→ 外す・期間の後に外す。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_TENANT_SETTINGS, type Notification, type TenantSettings, type WebColumnStatus } from '@m2office/shared';
import { createServer, type IncomingMessage } from 'node:http';
import type { AddressInfo } from 'node:net';
import { OpenAiCompatibleProvider } from '../src/llm/gemini.js';
import {
  ColumnSignageService, MemoryColumnSignageStore, MemoryColumnStore, MemoryFileStore, StubLlmProvider,
  planScenes, slideSvg, signageDigest, cleanCaption, videoPrompts, checkVideo, videoCaption,
  type ColumnSignageOutlet, type LlmProvider, type Repository,
} from '../src/index.js';

const fakeLlm = (text: string): LlmProvider => ({ name: 'gemini', complete: async () => ({ text, tokensUsed: 1 }) });

test('場面: 推論が分けた 2〜5 枚を使い、一言は 30 字で切る。推論が使えなければ 1 枚', async () => {
  const many = JSON.stringify({ scenes: Array.from({ length: 7 }, (_, i) => ({ caption: `${i + 1} 枚目の一言です`.repeat(i === 0 ? 5 : 1), picture: '歯ブラシ' })) });
  const s = await planScenes(fakeLlm(many), { title: '歯みがき', description: '毎日の歯みがき', body: '本文', rules: [] });
  assert.equal(s.length, 5, '5 枚まで');
  assert.equal([...s[0]!.caption].length, 30, '一言は 30 字まで');
  const plain = await planScenes(new StubLlmProvider(), { title: '歯みがき', description: '毎日のケアのこつ', body: '本文', rules: [] });
  assert.deepEqual(plain, [{ caption: '毎日のケアのこつ', picture: '歯みがき' }]);
  assert.equal(cleanCaption(' 改行\nを  除く '), '改行 を 除く');
});

test('画像: 字は M2Office が組む。題名は 1 枚目だけ、紙芝居なら何枚目かを出す。型の背景でも作れる', () => {
  const svg = slideSvg({ side: 'landscape', title: '歯みがきのこつ', caption: '1 日 2 回、やさしく', index: 0, total: 3, background: { kind: 'template', color: '#1f5f8b', pattern: 'dots' } });
  assert.match(svg, /width="1920" height="1080"/);
  assert.match(svg, /歯みがきのこつ/);
  assert.match(svg, /1 日 2 回、やさしく/);
  assert.match(svg, /1\/3/);
  const second = slideSvg({ side: 'portrait', title: null, caption: '仕上げはフロス', index: 1, total: 3, background: { kind: 'template', color: '#1f5f8b', pattern: 'dots' } });
  assert.match(second, /width="1080" height="1920"/);
  assert.doesNotMatch(second, /歯みがきのこつ/);
  const single = slideSvg({ side: 'landscape', title: 't', caption: 'c', index: 0, total: 1, background: { kind: 'template', color: '#1f5f8b', pattern: 'dots' } });
  assert.doesNotMatch(single, /1\/1/, '1 枚なら何枚目かを出さない');
});

test('承認の印: 画像・一言・流す画面が変われば変わる', () => {
  const base = { outputs: [{ orientation: 'landscape' as const, index: 0, fileId: 'f1', kind: 'image' as const }], scenes: [{ caption: 'a', picture: 'p' }] };
  assert.equal(signageDigest(base, ['s1', 's2']), signageDigest(base, ['s2', 's1']));
  assert.notEqual(signageDigest(base, ['s1']), signageDigest({ ...base, scenes: [{ caption: 'b', picture: 'p' }] }, ['s1']));
  assert.notEqual(signageDigest(base, ['s1']), signageDigest(base, ['s1', 's2']));
});

/** 偽の店頭サイネージ（画面の向き・素材・流れを覚える）。 */
function fakeOutlet(screens: { id: string; name: string; orientation: 'landscape' | 'portrait' }[]) {
  const assets: string[] = [];
  const captions: string[] = [];
  const flows = new Map<string, { assetId: string; seconds: number | null }[]>(screens.map((s) => [s.id, [{ assetId: 'old', seconds: null }]]));
  let n = 0;
  const outlet: ColumnSignageOutlet = {
    enabled: async () => true,
    screens: async () => screens,
    addImage: async () => { n += 1; const id = `a${n}`; assets.push(id); return { assetId: id }; },
    addVideo: async (_t, _u, _mp4, _name, caption) => { n += 1; const id = `v${n}`; assets.push(id); captions.push(caption); return { assetId: id }; },
    addToFlows: async (_t, _u, ids, screenIds, seconds) => {
      for (const s of screenIds) flows.set(s, [...ids.map((assetId) => ({ assetId, seconds })), ...(flows.get(s) ?? []).filter((e) => !ids.includes(e.assetId))]);
      return screens.filter((s) => screenIds.includes(s.id)).map((s) => s.name);
    },
    removeAssets: async (_t, _u, ids) => {
      for (const id of ids) assets.splice(assets.indexOf(id), 1);
      for (const [k, v] of flows) flows.set(k, v.filter((e) => !ids.includes(e.assetId)));
    },
  };
  return { outlet, assets, flows, captions };
}

async function setup(opts: { status?: WebColumnStatus; screens?: { id: string; name: string; orientation: 'landscape' | 'portrait' }[]; llm?: LlmProvider } = {}) {
  const settings: TenantSettings = { ...DEFAULT_TENANT_SETTINGS, webColumns: { ...DEFAULT_TENANT_SETTINGS.webColumns, enabled: true } };
  const notes: Notification[] = [];
  const audits: string[] = [];
  const files = new Map<string, unknown>();
  const repo = {
    listTenantIds: async () => ['t1'],
    getTenantSettings: async () => settings,
    getUserSettings: async () => ({ notifications: { kinds: { column: true } } }),
    createNotification: async (n: Notification) => { notes.push(n); },
    appendAudit: async (e: { action: string }) => { audits.push(e.action); },
    createFile: async (f: { id: string }) => { files.set(f.id, f); },
  } as unknown as Repository;
  const columns = new MemoryColumnStore();
  const id = await columns.create('t1', { theme: '歯みがき', memo: '', createdBy: 'u1' });
  await columns.addVersion('t1', id, {
    title: '毎日の歯みがき', titles: [], body: '歯みがきは 1 日 2 回。', description: '毎日のケアのこつ', sns: { short: '', long: '' },
    sources: [], review: [], cover: null, origin: 'writer', createdBy: 'u1',
  });
  await columns.update('t1', id, { status: opts.status ?? 'approved', title: '毎日の歯みがき' });
  const sig = fakeOutlet(opts.screens ?? [{ id: 's1', name: '入口', orientation: 'landscape' }]);
  const store = new MemoryColumnSignageStore();
  const submitted: { setId: string; images: string[] }[] = [];
  const service = new ColumnSignageService({
    store, columns, repo, files: new MemoryFileStore(), llmFor: async () => opts.llm ?? new StubLlmProvider(), signage: sig.outlet,
    submitter: async (_t, _u, setId, images) => { submitted.push({ setId, images }); return 'run-1'; },
  });
  return { service, store, columns, id, sig, notes, audits, submitted };
}

const who = { tenantId: 't1', userId: 'u1' };

test('作る: 承認済みのコラムだけ。ワーカーが場面に分けて画面の向きの画像を作り、頼んだ人に知らせる', async () => {
  const draft = await setup({ status: 'draft' });
  assert.match(String((await draft.service.make(who, draft.id, 'slides') as { error: string }).error), /承認済み/);
  const { service, id, notes } = await setup({
    screens: [{ id: 's1', name: '入口', orientation: 'landscape' }, { id: 's2', name: '待合', orientation: 'portrait' }],
    llm: fakeLlm(JSON.stringify({ scenes: [{ caption: '1 日 2 回', picture: '歯ブラシ' }, { caption: '仕上げはフロス', picture: '糸' }] })),
  });
  const r = await service.make(who, id, 'slides');
  assert.ok('id' in r);
  assert.match(String((await service.make(who, id, 'slides') as { error: string }).error), /いま作っています/, '作っているあいだは重ねて作らない');
  assert.equal(await service.tick(), 1);
  const [set] = await service.list('t1', id);
  assert.equal(set!.status, 'ready');
  assert.equal(set!.scenes.length, 2);
  assert.equal(set!.outputs.length, 4, '2 枚 × 横と縦');
  assert.match(set!.note, /型の背景/, '絵を描けない AI では型の背景にする');
  assert.ok(notes.some((n) => n.title === 'サイネージ用の画像ができました' && n.userId === 'u1'));
  assert.match(String((await service.make(who, id, 'video') as { error: string }).error), /動画を作れません/, '動画を作れない AI では作らない');
});

test('流す: 承認へ進め、承認の後に向きの合う画面の先頭に順に置く。承認の後に変わったら流さない。外すと流れから外れる', async () => {
  const { service, id, sig, audits, submitted } = await setup({ llm: fakeLlm(JSON.stringify({ scenes: [{ caption: 'a', picture: 'p' }, { caption: 'b', picture: 'q' }] })) });
  const made = await service.make(who, id, 'slides') as { id: string };
  await service.tick();
  const sub = await service.submit(who, made.id);
  assert.deepEqual(sub, { runId: 'run-1' });
  assert.equal(submitted[0]!.images.length, 2, '承認する人が画像を開けるよう、画像の ID を業務の入力に入れる');
  const p = await service.preview('t1', made.id);
  assert.ok('shown' in p && /流す画面: 入口/.test(p.shown) && /\/v1\/files\//.test(p.shown));
  assert.match(String((await service.publish(who, made.id, 'wrong') as { error: string }).error), /変わった/);
  const ok = await service.publish(who, made.id, (p as { digest: string }).digest);
  assert.deepEqual(ok, { screens: ['入口'] });
  assert.deepEqual(sig.flows.get('s1')!.map((e) => e.assetId), ['a1', 'a2', 'old'], '紙芝居は順に先頭へ');
  assert.equal(sig.flows.get('s1')![0]!.seconds, 8);
  const [pub] = await service.list('t1', id);
  assert.equal(pub!.status, 'published');
  assert.ok(pub!.publishUntil);
  await service.withdraw(who, made.id);
  assert.deepEqual(sig.flows.get('s1')!.map((e) => e.assetId), ['old']);
  assert.deepEqual(sig.assets, []);
  assert.ok(['column.signage_make', 'column.signage_submit', 'column.signage_publish', 'column.signage_withdraw'].every((a) => audits.includes(a)));
});

test('期間の後と、元のコラムを取り下げたときは流れから外す', async () => {
  const { service, store, columns, id, sig } = await setup();
  const made = await service.make(who, id, 'slides') as { id: string };
  await service.tick();
  await service.submit(who, made.id);
  const p = await service.preview('t1', made.id) as { digest: string };
  await service.publish(who, made.id, p.digest, new Date('2026-10-05T00:00:00Z'));
  assert.equal(await service.sweep('t1', new Date('2026-10-20T00:00:00Z')), 0, '30 日のあいだは流す');
  assert.equal(await service.sweep('t1', new Date('2026-11-05T00:00:01Z')), 1);
  assert.equal((await store.get('t1', made.id))!.status, 'withdrawn');
  assert.deepEqual(sig.flows.get('s1')!.map((e) => e.assetId), ['old']);
  // 取り下げ
  const again = await service.make(who, id, 'slides') as { id: string };
  await service.tick();
  await service.submit(who, again.id);
  await service.publish(who, again.id, (await service.preview('t1', again.id) as { digest: string }).digest);
  await columns.update('t1', id, { status: 'withdrawn' });
  assert.equal(await service.sweep('t1'), 1);
});

test('店頭サイネージに画面が無ければ作れない', async () => {
  const { service, id } = await setup({ screens: [] });
  assert.match(String((await service.make(who, id, 'slides') as { error: string }).error), /画面が登録されていない/);
});

test('動画の指示: 英語で、人物・文字・ロゴを出さない決まりを必ず付ける。字幕は題名と一言', async () => {
  const p = await videoPrompts(new StubLlmProvider(), { title: '歯みがき', scenes: [{ caption: '1 日 2 回', picture: '歯ブラシ' }], rules: ['medical'] });
  assert.match(p.first, /No people/);
  assert.match(p.first, /No text/);
  assert.match(p.extend, /No body parts/);
  const llm = fakeLlm(JSON.stringify({ first: 'A toothbrush on a bright shelf.', extend: 'The camera slowly pans.' }));
  const q = await videoPrompts(llm, { title: '歯みがき', scenes: [{ caption: 'a', picture: 'b' }], rules: [] });
  assert.match(q.first, /^A toothbrush on a bright shelf\. No people/, '推論が決まりを落としても足す');
  assert.equal(videoCaption('歯みがき', [{ caption: '1 日 2 回', picture: '' }]), '歯みがき\n1 日 2 回');
});

test('動画の確かめ: 人物や文字が映っていれば通さない。確かめられなければ通さない', async () => {
  const say = (text: string): LlmProvider => ({ name: 'gemini', complete: async () => ({ text: '', tokensUsed: 0 }), extractFromImage: async () => ({ text, tokensUsed: 0 }) });
  assert.deepEqual(await checkVideo(say('{"people":false,"text":false,"logo":false,"body":false}'), new Uint8Array([1]), []), { ok: true, reason: '' });
  assert.match((await checkVideo(say('{"people":true,"text":false,"logo":false,"body":false}'), new Uint8Array([1]), [])).reason, /人物/);
  assert.equal((await checkVideo(say('読めない'), new Uint8Array([1]), [])).ok, false);
  assert.equal((await checkVideo({ name: 'gemini', complete: async () => ({ text: '', tokensUsed: 0 }) }, new Uint8Array([1]), [])).ok, false);
});

/** 偽の Veo（作業を頼む・見に行く・受け取る）。延長を断らせることもできる。 */
async function fakeVeo(opts: { failExtend?: boolean } = {}) {
  const seen: { path: string; body: Record<string, unknown> | null; key: string }[] = [];
  const read = (req: IncomingMessage) => new Promise<string>((r) => { let b = ''; req.on('data', (c) => { b += c; }); req.on('end', () => r(b)); });
  let ops = 0;
  const server = createServer(async (req, res) => {
    const raw = await read(req);
    const body = raw ? JSON.parse(raw) as Record<string, unknown> : null;
    const path = req.url ?? '';
    seen.push({ path, body, key: String(req.headers['x-goog-api-key'] ?? '') });
    if (path.endsWith(':predictLongRunning')) {
      const extend = !!((body?.['instances'] as { video?: unknown }[])?.[0]?.video);
      if (extend && opts.failExtend) { res.writeHead(400); res.end('{}'); return; }
      ops += 1;
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ name: `models/veo/operations/op${ops}` }));
      return;
    }
    if (path.includes('/operations/')) {
      const n = /op(\d+)$/.exec(path)?.[1] ?? '0';
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ done: true, response: { generateVideoResponse: { generatedSamples: [{ video: { uri: `${base}/files/v${n}:download` } }] } } }));
      return;
    }
    if (path.startsWith('/files/')) {
      res.writeHead(200, { 'content-type': 'video/mp4' });
      res.end(Buffer.from(path.includes('v2') ? 'LONG-VIDEO' : 'SHORT-VIDEO'));
      return;
    }
    res.writeHead(404); res.end();
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { base, seen, close: () => new Promise<void>((r) => server.close(() => r())) };
}

test('Veo: 作業を頼み、できるまで見に行き、鍵を付けて受け取り、7 秒延長する。延長に失敗したら 8 秒を返す', async () => {
  const veo = await fakeVeo();
  try {
    const p = new OpenAiCompatibleProvider('key-v', { fast: 'f', standard: 's', advanced: 'a' }, `${veo.base}/openai`, 'gemini', undefined, { pollMs: 1, timeoutMs: 5000 });
    const r = await p.generateVideo({ model: 'veo-3.1-lite-generate-preview', prompt: 'first', extendPrompt: 'more', aspectRatio: '9:16', image: { bytes: new Uint8Array([1, 2]), mimeType: 'image/png' } });
    assert.equal(Buffer.from(r!.bytes).toString(), 'LONG-VIDEO');
    assert.equal(r!.extended, true);
    const first = veo.seen.find((x) => x.path.endsWith(':predictLongRunning'))!;
    assert.match(first.path, /\/models\/veo-3\.1-lite-generate-preview:predictLongRunning$/);
    assert.deepEqual(first.body!['parameters'], { aspectRatio: '9:16', resolution: '720p', durationSeconds: 8, personGeneration: 'allow_adult' });
    assert.ok((first.body!['instances'] as { image?: { inlineData?: unknown } }[])[0]!.image?.inlineData, '始まりの絵を添える');
    assert.ok(veo.seen.every((x) => x.key === 'key-v'), '作業の確かめと受け取りにも鍵を付ける');
  } finally {
    await veo.close();
  }
  const broken = await fakeVeo({ failExtend: true });
  try {
    const p = new OpenAiCompatibleProvider('k', { fast: 'f', standard: 's', advanced: 'a' }, `${broken.base}/openai`, 'gemini', undefined, { pollMs: 1, timeoutMs: 5000 });
    const r = await p.generateVideo({ model: 'veo', prompt: 'first', extendPrompt: 'more', aspectRatio: '16:9' });
    assert.equal(Buffer.from(r!.bytes).toString(), 'SHORT-VIDEO');
    assert.equal(r!.extended, false);
    assert.equal((broken.seen.find((x) => x.path.endsWith(':predictLongRunning'))!.body!['parameters'] as { personGeneration: string }).personGeneration, 'allow_all', '始まりの絵が無ければ allow_all');
  } finally {
    await broken.close();
  }
});

test('動画の組: 画面の多い向きで作り、確かめを通れば承認へ。流すと字幕つきで素材に足し、月の上限を数える', async () => {
  const videoLlm: LlmProvider = {
    name: 'gemini',
    complete: async () => ({ text: '{}', tokensUsed: 0 }),
    extractFromImage: async () => ({ text: '{"people":false,"text":false,"logo":false,"body":false}', tokensUsed: 0 }),
    generateVideo: async () => ({ bytes: new Uint8Array([0, 0, 0, 8]), mimeType: 'video/mp4', extended: true }),
  };
  const { service, store, id, sig } = await setup({ llm: videoLlm, screens: [{ id: 's1', name: '入口', orientation: 'landscape' }, { id: 's2', name: '待合', orientation: 'portrait' }, { id: 's3', name: '奥', orientation: 'portrait' }] });
  const made = await service.make(who, id, 'video') as { id: string };
  assert.ok(made.id);
  await service.tick();
  const set = (await store.get('t1', made.id))!;
  assert.equal(set.status, 'ready', set.error ?? '');
  assert.equal(set.videoAttempts, 1);
  assert.deepEqual(set.outputs.map((o) => [o.kind, o.orientation]), [['video', 'portrait'], ['image', 'portrait']], '縦の画面が多いので縦で作り、1 コマ目の画像を添える');
  assert.match(set.note, /横の画面には流しません/);
  await service.submit(who, made.id);
  const p = await service.preview('t1', made.id) as { shown: string; digest: string };
  assert.match(p.shown, /動画（字幕: 毎日の歯みがき/);
  assert.match(p.shown, /流す画面: 待合、奥/);
  await service.publish(who, made.id, p.digest);
  assert.deepEqual(sig.captions, ['毎日の歯みがき\n毎日のケアのこつ']);
  assert.equal(sig.flows.get('s2')![0]!.seconds, null, '動画は最後まで流す');
  assert.deepEqual(sig.flows.get('s1')!.map((e) => e.assetId), ['old'], '横の画面には流さない');
  // 月の上限
  for (let i = 0; i < 9; i++) await store.update('t1', await store.create('t1', { columnId: id, kind: 'video', createdBy: 'u1' }), { status: 'failed', videoAttempts: 1 });
  assert.match(String((await service.make(who, id, 'video') as { error: string }).error), /上限（10 本）/);
});
