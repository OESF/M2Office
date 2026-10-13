/**
 * @file コラムから作るサイネージ用の画像の単体テスト（仕様書 第32.18.6節）。場面の分け方・画像の組み方・
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
  planScenes, slideSvg, signageDigest, cleanCaption, videoPrompts, checkBeforeAfter, scenePrompt, videoCaption,
  type ColumnSignageDeps, type ColumnSignageOutlet, type LlmProvider, type Repository,
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

/** 偽のサイネージ（画面の向き・素材・流れを覚える）。 */
function fakeOutlet(screens: { id: string; name: string; orientation: 'landscape' | 'portrait' }[]) {
  const assets: string[] = [];
  const captions: string[] = [];
  const narrated: string[] = [];
  const flows = new Map<string, { assetId: string; seconds: number | null }[]>(screens.map((s) => [s.id, [{ assetId: 'old', seconds: null }]]));
  let n = 0;
  const outlet: ColumnSignageOutlet = {
    enabled: async () => true,
    screens: async () => screens,
    addImage: async () => { n += 1; const id = `a${n}`; assets.push(id); return { assetId: id }; },
    addVideo: async (_t, _u, _mp4, _name, caption, _poster, narration) => { n += 1; const id = `v${n}`; assets.push(id); captions.push(caption); if (narration) narrated.push(id); return { assetId: id }; },
    removeAssets: async (_t, _u, ids) => {
      for (const id of ids) assets.splice(assets.indexOf(id), 1);
      for (const [k, v] of flows) flows.set(k, v.filter((e) => !ids.includes(e.assetId)));
    },
  };
  return { outlet, assets, flows, captions, narrated };
}

async function setup(opts: { status?: WebColumnStatus; screens?: { id: string; name: string; orientation: 'landscape' | 'portrait' }[]; llm?: LlmProvider; deps?: Partial<ColumnSignageDeps> } = {}) {
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
  const service = new ColumnSignageService({
    store, columns, repo, files: new MemoryFileStore(), llmFor: async () => opts.llm ?? new StubLlmProvider(), signage: sig.outlet,
    ...opts.deps,
  });
  return { service, store, columns, id, sig, notes, audits };
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

test('素材にする: 「素材に登録」で、承認を挟まずに素材に登録する（スケジュールには入れない）。登録は 1 度だけ', async () => {
  const { service, id, sig, audits } = await setup({ llm: fakeLlm(JSON.stringify({ scenes: [{ caption: 'a', picture: 'p' }, { caption: 'b', picture: 'q' }] })) });
  const made = await service.make(who, id, 'slides') as { id: string };
  assert.match(String((await service.register(who, made.id) as { error: string }).error), /できた組だけ/, '作っている途中は登録できない');
  await service.tick();
  const ok = await service.register(who, made.id);
  assert.deepEqual(ok, { assets: 2 });
  assert.match(String((await service.register(who, made.id) as { error: string }).error), /もう素材に登録/);
  assert.deepEqual(sig.assets, ['a1', 'a2'], '紙芝居の画像を素材に登録する');
  assert.deepEqual(sig.flows.get('s1')!.map((e) => e.assetId), ['old'], '表示中のスケジュールには入れない');
  const [pub] = await service.list('t1', id);
  assert.equal(pub!.status, 'published');
  assert.equal(pub!.publishUntil, null, '期限を持たない（管理はサイネージの画面に移す）');
  assert.ok(['column.signage_make', 'column.signage_publish'].every((a) => audits.includes(a)) && !audits.includes('column.signage_submit'), '承認へは進めない');
});

test('素材に登録した後は、コラムから消さない（新しい組を登録しても・時間がたっても・コラムを取り下げても。管理はサイネージの画面に移す）', async () => {
  const { service, columns, id, sig } = await setup();
  const made = await service.make(who, id, 'slides') as { id: string };
  await service.tick();
  await service.register(who, made.id);
  const first = [...sig.assets];
  assert.equal(first.length, 1);
  // 新しい組を作って登録しても、前の素材は残る
  const again = await service.make(who, id, 'slides') as { id: string };
  await service.tick();
  await service.register(who, again.id);
  assert.equal(sig.assets.length, 2);
  assert.ok(first.every((a) => sig.assets.includes(a)), '前に登録した素材を消さない');
  // 見回り（ワーカー）とコラムの取り下げでも消さない
  await columns.update('t1', id, { status: 'withdrawn' });
  await service.tick(new Date('2027-01-01T00:00:00Z'));
  assert.equal(sig.assets.length, 2);
  assert.ok(!('withdraw' in service) && !('sweep' in service), 'コラムから素材を消す操作を持たない');
  // コラムの組を削除しても、素材に登録したものはサイネージの素材に残る
  assert.deepEqual(await service.remove(who, made.id), { ok: true });
  assert.equal(sig.assets.length, 2, '素材は残る');
  assert.equal((await service.list('t1', id)).length, 1, 'コラムの組だけが消える');
  await columns.update('t1', id, { status: 'approved' });
  const making = await service.make(who, id, 'slides') as { id: string };
  assert.match(String((await service.remove(who, making.id) as { error: string }).error), /作っている途中/);
});

test('サイネージに画面が無ければ作れない', async () => {
  const { service, id } = await setup({ screens: [] });
  assert.match(String((await service.make(who, id, 'slides') as { error: string }).error), /画面が登録されていない/);
});

test('場面の画像: 絵だけ・文字だけの層に分けて描ける（ナレーション付きスライドは絵だけを動かし、文字は止める）', () => {
  const base = { side: 'landscape' as const, title: '題名', caption: '一言', index: 0, total: 2, background: { kind: 'template' as const, color: '#336699', pattern: 'dots' as never } };
  const all = slideSvg(base);
  const bg = slideSvg({ ...base, layer: 'background' });
  const text = slideSvg({ ...base, layer: 'text' });
  assert.ok(all.includes('一言') && all.includes('1/2') && all.includes('<rect width='));
  assert.ok(!bg.includes('一言') && !bg.includes('1/2') && bg.includes('<rect width='), '絵だけ');
  assert.ok(text.includes('一言') && text.includes('1/2') && !text.includes('<rect width='), '文字だけ（背景は透明）');
});

test('動画と画像の指示: 選んだ作風（既定はリアル）で描き、禁止は医療・健康の会社の前と後の比較だけ。字幕は題名と一言', async () => {
  const p = await videoPrompts(new StubLlmProvider(), { title: '歯みがき', scenes: [{ caption: '1 日 2 回', picture: '歯ブラシ' }], rules: ['medical'] });
  assert.match(p.first, /Photorealistic/, '既定はリアル');
  assert.match(p.first, /before\/after/);
  assert.doesNotMatch(p.first, /No people|No text/, '人物や文字の禁止は設けない');
  assert.ok(!('extend' in p), '延長の指示は作らない（Veo 3.1 Lite は延長に対応していない）');
  const anime = await videoPrompts(new StubLlmProvider(), { title: '歯みがき', scenes: [{ caption: 'a', picture: 'b' }], rules: [], style: 'anime' });
  assert.match(anime.first, /anime/);
  assert.doesNotMatch(anime.first, /before\/after/, '医療でない会社には付けない');
  const llm = fakeLlm(JSON.stringify({ first: 'A toothbrush on a bright shelf.' }));
  const q = await videoPrompts(llm, { title: '歯みがき', scenes: [{ caption: 'a', picture: 'b' }], rules: [], style: 'fantasy' });
  assert.match(q.first, /^A toothbrush on a bright shelf\. Fantastical/, '推論が作風を落としても足す');
  const img = scenePrompt({ title: '歯みがき', picture: '歯科医と子ども', rules: [], side: 'landscape', style: 'illustration' });
  assert.ok(img.includes('イラスト') && !img.includes('人物を描かない'));
  assert.equal(videoCaption('歯みがき', [{ caption: '1 日 2 回', picture: '' }]), '歯みがき\n1 日 2 回');
});

test('前と後の比較の確かめ: 医療・健康の会社だけ。写っていれば通さない。確かめられなければ通さない', async () => {
  const say = (text: string): LlmProvider => ({ name: 'gemini', complete: async () => ({ text: '', tokensUsed: 0 }), extractFromImage: async () => ({ text, tokensUsed: 0 }) });
  const media = { bytes: new Uint8Array([1]), mimeType: 'video/mp4' };
  assert.deepEqual(await checkBeforeAfter(say('{"beforeAfter": true}'), media, []), { ok: true, reason: '' }, '医療でない会社は確かめない');
  assert.deepEqual(await checkBeforeAfter(say('{"beforeAfter": false}'), media, ['medical']), { ok: true, reason: '' });
  assert.match((await checkBeforeAfter(say('{"beforeAfter": true}'), media, ['medical'])).reason, /前と後の比較/);
  assert.equal((await checkBeforeAfter(say('読めない'), media, ['health-products'])).ok, false);
  assert.equal((await checkBeforeAfter({ name: 'gemini', complete: async () => ({ text: '', tokensUsed: 0 }) }, media, ['medical'])).ok, false);
});

/** 偽の Veo（作業を頼む・見に行く・受け取る）。延長を断らせることもできる。 */
async function fakeVeo(opts: { failExtend?: boolean; reject?: string } = {}) {
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
      if (opts.reject) { res.writeHead(400, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: { code: 400, message: opts.reject, status: 'INVALID_ARGUMENT' } })); return; }
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
    assert.deepEqual(first.body!['parameters'], { aspectRatio: '9:16', resolution: '720p', durationSeconds: 8, personGeneration: 'allow_adult' }, '長さは数で送る（文字列は断られる）');
    assert.deepEqual((first.body!['instances'] as { image?: unknown }[])[0]!.image, { bytesBase64Encoded: 'AQI=', mimeType: 'image/png' }, '始まりの絵は bytesBase64Encoded で添える（inlineData は Veo で断られる）');
    const ext = veo.seen.filter((x) => x.path.endsWith(':predictLongRunning'))[1]!;
    assert.deepEqual(Object.keys((ext.body!['instances'] as { video: Record<string, unknown> }[])[0]!.video).sort(), ['encodedVideo', 'encoding'], '延長の動画は encodedVideo で渡す');
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

test('Veo: 断られたら、Google が返した理由を知らせに添える', async () => {
  const veo = await fakeVeo({ reject: 'durationSeconds  must be a string' });
  try {
    const p = new OpenAiCompatibleProvider('k', { fast: 'f', standard: 's', advanced: 'a' }, `${veo.base}/openai`, 'gemini', undefined, { pollMs: 1, timeoutMs: 5000 });
    await assert.rejects(p.generateVideo({ model: 'veo', prompt: 'first', aspectRatio: '16:9' }), /動画を作れませんでした \(400: durationSeconds must be a string\)/);
  } finally {
    await veo.close();
  }
});

test('動画の組: 画面の多い向きで作り、確かめを通れば承認へ。承認の後に字幕つきで素材に登録し、月の上限を数える', async () => {
  const asked: { extendPrompt?: string }[] = [];
  const videoLlm: LlmProvider = {
    name: 'gemini',
    complete: async () => ({ text: '{}', tokensUsed: 0 }),
    extractFromImage: async () => ({ text: '{"beforeAfter": false}', tokensUsed: 0 }),
    generateVideo: async (req) => { asked.push(req); return { bytes: new Uint8Array([0, 0, 0, 8]), mimeType: 'video/mp4', extended: false }; },
  };
  const { service, store, id, sig } = await setup({ llm: videoLlm, screens: [{ id: 's1', name: '入口', orientation: 'landscape' }, { id: 's2', name: '待合', orientation: 'portrait' }, { id: 's3', name: '奥', orientation: 'portrait' }] });
  const made = await service.make(who, id, 'video') as { id: string };
  assert.ok(made.id);
  await service.tick();
  const set = (await store.get('t1', made.id))!;
  assert.equal(set.status, 'ready', set.error ?? '');
  assert.equal(set.videoAttempts, 1);
  assert.ok(asked.length === 1 && asked.every((r) => !r.extendPrompt), '延長は頼まない（8 秒の 1 本。Veo 3.1 Lite は延長に対応していない）');
  assert.doesNotMatch(set.note, /延長/);
  assert.deepEqual(set.outputs.map((o) => [o.kind, o.orientation]), [['video', 'portrait'], ['image', 'portrait']], '縦の画面が多いので縦で作り、1 コマ目の画像を添える');
  assert.match(set.note, /横の画面には流しません/);
  await service.register(who, made.id);
  assert.deepEqual(sig.captions, ['毎日の歯みがき\n毎日のケアのこつ']);
  assert.equal(sig.assets.length, 1, '動画を 1 本、素材に登録する');
  assert.deepEqual([...sig.flows.values()].map((f) => f.map((e) => e.assetId)), [['old'], ['old'], ['old']], 'どの画面のスケジュールにも入れない');
  // 月の上限
  for (let i = 0; i < 9; i++) await store.update('t1', await store.create('t1', { columnId: id, kind: 'video', createdBy: 'u1' }), { status: 'failed', videoAttempts: 1 });
  assert.match(String((await service.make(who, id, 'video') as { error: string }).error), /上限（10 本）/);
});

test('動画の組: 15 秒を選ぶと延長できるモデルで 8 秒を作り 7 秒延長する。延長できなければ 8 秒のまま伝える', async () => {
  const asked: { model: string; extendPrompt?: string }[] = [];
  const videoLlm: LlmProvider = {
    name: 'gemini',
    complete: async () => ({ text: '{}', tokensUsed: 0 }),
    extractFromImage: async () => ({ text: '{"beforeAfter": false}', tokensUsed: 0 }),
    generateVideo: async (req) => { asked.push(req); return { bytes: new Uint8Array([0, 0, 0, 8]), mimeType: 'video/mp4', extended: false }; },
  };
  const { service, store, id } = await setup({ llm: videoLlm, screens: [{ id: 's1', name: '入口', orientation: 'landscape' }] });
  const made = await service.make(who, id, 'video', { seconds: 15 }) as { id: string };
  await service.tick();
  const set = (await store.get('t1', made.id))!;
  assert.equal(set.videoSeconds, 15);
  assert.equal(asked[0]!.model, 'veo-3.1-fast-generate-preview', '15 秒は延長できる Fast');
  assert.ok(asked[0]!.extendPrompt && /Photorealistic/.test(asked[0]!.extendPrompt), '延長の指示にも作風を付ける');
  assert.match(set.note, /延長できなかったため、8 秒の動画にしました/);
  const short = await service.make(who, id, 'video') as { id: string };
  await service.tick();
  assert.equal((await store.get('t1', short.id))!.videoSeconds, 8, '既定は 8 秒');
  assert.equal(asked[1]!.model, 'veo-3.1-lite-generate-preview');
  assert.equal(asked[1]!.extendPrompt, undefined);
  const p15 = await videoPrompts(new StubLlmProvider(), { title: '歯みがき', scenes: [{ caption: 'a', picture: 'b' }], rules: [], seconds: 15 });
  assert.match(p15.extend ?? '', /^Continue the same scene/);
});

test('動画の組: Google に断られた依頼は月の回数に数えず、理由を残して頼んだ人に動画の題名で知らせる', async () => {
  const rejecting: LlmProvider = {
    name: 'gemini',
    complete: async () => ({ text: '{}', tokensUsed: 0 }),
    generateVideo: async () => { throw new Error('動画を作れませんでした (400: bad request)'); },
  };
  const { service, store, id, notes } = await setup({ llm: rejecting, screens: [{ id: 's1', name: '入口', orientation: 'landscape' }] });
  const made = await service.make(who, id, 'video') as { id: string };
  await service.tick();
  const set = (await store.get('t1', made.id))!;
  assert.equal(set.status, 'failed');
  assert.equal(set.videoAttempts, 0, '費用のかからない断られた依頼は数えない');
  assert.equal(set.error, '動画を作れませんでした (400: bad request)');
  assert.ok(notes.some((n) => n.title === 'サイネージ用の動画を作れませんでした'));
});

/** 読み上げを作る AI の見本（場面ごとに 2 秒の音を返す。読み上げ文を記録する）。 */
function speakingLlm(said: string[]): LlmProvider {
  return {
    name: 'gemini',
    complete: async (req) => {
      const p = String(req.messages.at(-1)?.content ?? '');
      if (p.includes('読み上げ文')) return { text: JSON.stringify({ narrations: ['毎日の歯みがきが大切です。', '夜はとくに丁寧に。'] }), tokensUsed: 1 };
      if (p.includes('場面に分けて')) return { text: JSON.stringify({ scenes: [{ caption: '1 日 2 回', picture: '歯ブラシ' }, { caption: '夜は丁寧に', picture: '洗面所' }] }), tokensUsed: 1 };
      return { text: '{}', tokensUsed: 1 };
    },
    generateSpeech: async (req) => { said.push(`${req.voice}:${req.text}`); return { wav: new Uint8Array([1, 2, 3]), durationMs: 2000 }; },
  };
}

test('ナレーション付きスライド: 場面ごとに読み上げ文と読み上げを作り、選んだ声と BGM で MP4 にまとめ、素材にはナレーション付きの印を付ける', async () => {
  const said: string[] = [];
  const composed: { scenes: number; bgm: string | null; size: string }[] = [];
  const { service, store, id, sig } = await setup({
    llm: speakingLlm(said),
    deps: {
      ffmpeg: async () => ({ path: 'ffmpeg', encoder: 'libx264' }),
      compose: async (input) => { composed.push({ scenes: input.scenes.length, bgm: input.bgm?.format ?? null, size: `${input.size.width}x${input.size.height}` }); return { mp4: new Uint8Array([0, 0, 0, 8]), totalMs: 17_000 }; },
    },
  });
  const made = await service.make(who, id, 'narrated', { voice: 'bright', bgm: 'builtin:calm', style: 'anime' }) as { id: string };
  assert.ok(made.id);
  await service.tick();
  const set = (await store.get('t1', made.id))!;
  assert.equal(set.status, 'ready', set.error ?? '');
  assert.deepEqual([set.voice, set.bgm, set.imageStyle], ['bright', 'builtin:calm', 'anime']);
  assert.deepEqual(set.scenes.map((x) => x.narration), ['毎日の歯みがきが大切です。', '夜はとくに丁寧に。']);
  assert.deepEqual(said, ['Zephyr:毎日の歯みがきが大切です。', 'Zephyr:夜はとくに丁寧に。'], '選んだ声（明るい声 = Zephyr）で場面ごとに読み上げる');
  assert.deepEqual(composed, [{ scenes: 2, bgm: 'wav', size: '1920x1080' }], '組み込みの BGM は合成して WAV で渡す');
  assert.deepEqual(set.outputs.map((o) => o.kind), ['video', 'image', 'image']);
  assert.match(set.note, /17 秒のナレーション付きスライド/);
  await service.register(who, made.id);
  assert.deepEqual(sig.narrated, sig.assets, 'ナレーション付きの印を付けて素材に登録する（スケジュールに足すと音あり）');
  assert.deepEqual(sig.captions, [''], '画像に字を組んであるので字幕は重ねない');
});

test('ナレーション付きスライド: 読み上げを作れない AI・ffmpeg の無い機械・知らない BGM では作らない。会社の曲は形と大きさを確かめる', async () => {
  const noSpeech = await setup({ deps: { ffmpeg: async () => ({ path: 'ffmpeg', encoder: 'libx264' }) } });
  assert.match(String((await noSpeech.service.make(who, noSpeech.id, 'narrated') as { error: string }).error), /読み上げを作れません/);
  const noFfmpeg = await setup({ llm: speakingLlm([]), deps: { ffmpeg: async () => null } });
  assert.match(String((await noFfmpeg.service.make(who, noFfmpeg.id, 'narrated') as { error: string }).error), /ffmpeg が要ります/);
  const ok = await setup({ llm: speakingLlm([]), deps: { ffmpeg: async () => ({ path: 'ffmpeg', encoder: 'libx264' }) } });
  assert.match(String((await ok.service.make(who, ok.id, 'narrated', { bgm: 'bgm-none' }) as { error: string }).error), /BGM が見つかりません/);
  // 会社の曲
  const wav = new Uint8Array(44); wav.set([0x52, 0x49, 0x46, 0x46], 0); wav.set([0x57, 0x41, 0x56, 0x45], 8);
  assert.match(String((await ok.service.addBgm(who, '曲', new Uint8Array([1, 2, 3]), 1000) as { error: string }).error), /MP3 か WAV/);
  assert.match(String((await ok.service.addBgm(who, '曲', wav, 6 * 60_000) as { error: string }).error), /5 分まで/);
  const added = await ok.service.addBgm(who, '店の曲', wav, 30_000) as { track: { id: string } };
  assert.ok(added.track.id);
  const made = await ok.service.make(who, ok.id, 'narrated', { bgm: added.track.id });
  assert.ok('id' in made, '会社の曲を選べる');
  assert.equal(await ok.service.deleteBgm(who, added.track.id), true);
  assert.ok(ok.audits.includes('column.bgm_add') && ok.audits.includes('column.bgm_remove'));
});

test('読み上げ: 声を選んで音だけを返させ、返った PCM（audio/L16）を WAV に包む。断られたら理由を添える', async () => {
  const seen: Record<string, unknown>[] = [];
  const pcm = Buffer.alloc(48_000); // 24 kHz の 1 秒
  const server = createServer(async (req, res) => {
    let b = ''; for await (const c of req) b += c;
    const body = JSON.parse(b) as Record<string, unknown>;
    seen.push(body);
    if (String((body['contents'] as { parts: { text: string }[] }[])[0]!.parts[0]!.text) === 'だめ') {
      res.writeHead(400, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: { message: 'voice not found' } })); return;
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ candidates: [{ content: { parts: [{ inlineData: { mimeType: 'audio/L16;codec=pcm;rate=24000', data: pcm.toString('base64') } }] } }] }));
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  try {
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const p = new OpenAiCompatibleProvider('k', { fast: 'f', standard: 's', advanced: 'a' }, `${base}/openai`, 'gemini');
    const r = await p.generateSpeech({ model: 'gemini-3.8-flash-tts', text: 'こんにちは', voice: 'Charon' });
    assert.equal(r!.durationMs, 1000);
    assert.equal(Buffer.from(r!.wav.subarray(0, 4)).toString(), 'RIFF');
    assert.deepEqual((seen[0]!['generationConfig'] as Record<string, unknown>)['responseModalities'], ['AUDIO']);
    assert.equal(JSON.stringify(seen[0]!['generationConfig']).includes('"voiceName":"Charon"'), true);
    await assert.rejects(p.generateSpeech({ model: 'm', text: 'だめ', voice: 'x' }), /読み上げを作れませんでした \(400: voice not found\)/);
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }
});
