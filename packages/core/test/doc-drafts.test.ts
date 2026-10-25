/**
 * @file 業務「文書の作成」の作った文書の扱い（作る・同じファイルで作り直す・一覧・共有・Word と PDF の取り出し）の単体テスト。
 *
 * @see 仕様書 第9.5.5.2節「文書の作成の扱い」、Q-266
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BUILTIN_TOOLS, InMemorySlideDeckStore, MockWorkspaceConnector, SlideDeckService, ToolRegistry, type ToolContext } from '../src/index.js';

const registry = new ToolRegistry();
for (const t of BUILTIN_TOOLS) registry.register(t);

/** 記録する見本のドキュメントの接続口。 */
function setup() {
  const calls = { created: [] as string[], replaced: [] as string[] };
  const state = new Map<string, { modifiedTime: string; trashed: boolean }>();
  let n = 0;
  const connector = new MockWorkspaceConnector();
  const file = (id: string, name: string) => ({ id, name, kind: 'document' as const, modifiedAt: new Date().toISOString(), url: null });
  (connector as unknown as { docs: unknown }).docs = {
    create: async (_p: unknown, d: { title: string }) => { const id = `DOC${++n}`; calls.created.push(id); state.set(id, { modifiedTime: new Date().toISOString(), trashed: false }); return file(id, d.title); },
    append: async () => null,
    replace: async (_p: unknown, d: { documentId: string; title: string }) => {
      if (!state.has(d.documentId)) return null;
      calls.replaced.push(d.documentId);
      state.set(d.documentId, { modifiedTime: new Date().toISOString(), trashed: false });
      return file(d.documentId, d.title);
    },
    export: async (_p: unknown, id: string, format: string) => (id === 'DOC2' ? 'too-large' as const : new TextEncoder().encode(format)),
  };
  const slides = connector.slides as unknown as Record<string, unknown>;
  slides['fileState'] = async (_p: unknown, id: string) => state.get(id) ?? null;
  slides['share'] = async () => true;
  slides['trash'] = async () => true;
  (connector as unknown as { sourceFor: () => string }).sourceFor = () => 'google';
  const artifacts: { kind: string; body: string; slideDeckId?: string | null }[] = [];
  const repo = {
    createArtifact: async (a: { kind: string; body: string; slideDeckId?: string | null }) => { artifacts.push(a); },
    findTenantById: async () => ({ id: 't', workspaceDomain: 'example.co.jp' }),
    findUserById: async (_t: string, id: string) => ({ id, email: `${id}@example.co.jp`, displayName: id }),
  };
  const decks = new SlideDeckService({ store: new InMemorySlideDeckStore(), repo: repo as never, connector });
  const ctx = (userId = 'u'): ToolContext => ({ tenantId: 't', userId, runId: 'r', compartment: null, repo: repo as never, connector, files: {} as never, slideDecks: decks });
  return { calls, state, decks, ctx, artifacts };
}
const draft = (c: ToolContext, args: Record<string, unknown>) => registry.get('docs.draft')!.invoke(args, c) as Promise<Record<string, any>>;

test('docs.draft: 文書を作って種類 doc で覚え、成果物は本文そのもの（リンクを書かない）', async () => {
  const s = setup();
  const out = await draft(s.ctx(), { title: '全社会議の案内', body: '# 全社会議\n10/15 15 時', request: '全社会議の案内文' });
  const d = (await s.decks.store.get('t', out['draftId']))!;
  assert.equal(d.kind, 'doc');
  assert.equal(d.body, '# 全社会議\n10/15 15 時');
  assert.equal(d.plan, null);
  assert.equal(out['url'], 'https://docs.google.com/document/d/DOC1/edit');
  assert.equal(s.artifacts[0]!.slideDeckId, d.id);
  assert.match(s.artifacts[0]!.body, /^# 全社会議/);
  assert.doesNotMatch(s.artifacts[0]!.body, /https?:\/\//);
  // スライドの一覧には出ない
  assert.equal((await s.decks.list({ tenantId: 't', userId: 'u' })).mine.length, 0);
  const docs = (await s.decks.list({ tenantId: 't', userId: 'u' }, 'doc')).mine;
  assert.deepEqual(docs.map((x) => [x.kind, x.downloads]), [['doc', ['docx', 'pdf']]]);
});

test('docs.draft: 直すときは同じファイルの本文を入れ替え、人が手を入れた後なら新しいファイル。ほかの人の文書は直せない', async () => {
  const s = setup();
  const first = await draft(s.ctx(), { title: '案内', body: '本文 1', request: '案内文' });
  const again = await draft(s.ctx(), { title: '案内', body: '本文 2', draftId: first['draftId'], request: '日時を変えて' });
  assert.equal(again['draftId'], first['draftId']);
  assert.equal(again['rebuilt'], true);
  assert.deepEqual(s.calls.replaced, ['DOC1']);
  const d = (await s.decks.store.get('t', first['draftId']))!;
  assert.equal(d.body, '本文 2');
  assert.equal(d.request, '案内文\n直す頼み: 日時を変えて');
  s.state.get('DOC1')!.modifiedTime = new Date(Date.now() + 10 * 60_000).toISOString();
  const edited = await draft(s.ctx(), { title: '案内', body: '本文 3', draftId: first['draftId'] });
  assert.notEqual(edited['draftId'], first['draftId']);
  assert.ok((edited['warnings'] as string[]).some((w) => w.includes('手で直した跡')));
  assert.match(String((await draft(s.ctx('v'), { title: 'x', body: 'y', draftId: first['draftId'] }))['error']), /作った人だけ/);
  // スライドの ID では直せない
  await s.decks.store.save({ ...d, id: 'deck-slides', kind: 'slides', plan: { title: 'x', slides: [] }, body: null });
  assert.match(String((await draft(s.ctx(), { title: 'x', body: 'y', draftId: 'deck-slides' }))['error']), /見つかりません/);
});

test('docs.list・docs.get・docs.share: 一覧と前の本文を読み、会社で共有に切り替える（write-internal）', async () => {
  const s = setup();
  const made = await draft(s.ctx(), { title: '社内通知', body: '本文', request: '通知' });
  assert.deepEqual((await registry.get('docs.list')!.invoke({}, s.ctx()) as { mine: { title: string }[] }).mine.map((x) => x.title), ['社内通知']);
  const got = await registry.get('docs.get')!.invoke({ draftId: made['draftId'] }, s.ctx()) as Record<string, unknown>;
  assert.equal(got['body'], '本文');
  assert.equal(registry.get('docs.share')!.risk, 'write-internal');
  const shared = await registry.get('docs.share')!.invoke({ draftId: made['draftId'], sharing: '会社で共有' }, s.ctx()) as Record<string, unknown>;
  assert.equal(shared['sharing'], '会社で共有');
  assert.deepEqual((await s.decks.list({ tenantId: 't', userId: 'v' }, 'doc')).shared.map((x) => x.title), ['社内通知']);
});

test('文書の取り出し: Word と PDF は M2Office が受け取る。大きすぎるもの・ほかの人のもの・文書に無い形は受け取らない', async () => {
  const s = setup();
  const a = await draft(s.ctx(), { title: '報告書/10月', body: '本文' });
  const docx = await s.decks.exportAs({ tenantId: 't', userId: 'u' }, a['draftId'], 'docx');
  assert.ok('bytes' in docx && docx.filename === '報告書 10月.docx' && docx.mimeType.includes('wordprocessingml'));
  const pdf = await s.decks.exportAs({ tenantId: 't', userId: 'u' }, a['draftId'], 'pdf');
  assert.ok('bytes' in pdf && pdf.filename.endsWith('.pdf'));
  assert.ok('error' in await s.decks.exportAs({ tenantId: 't', userId: 'u' }, a['draftId'], 'pptx'));
  const b = await draft(s.ctx(), { title: '大きい', body: '本文' });
  const big = await s.decks.exportAs({ tenantId: 't', userId: 'u' }, b['draftId'], 'docx');
  assert.ok('fallback' in big && big.fallback.endsWith('/DOC2/export?format=docx'));
  await s.decks.share({ tenantId: 't', userId: 'u' }, a['draftId'], 'company');
  assert.ok('fallback' in await s.decks.exportAs({ tenantId: 't', userId: 'v' }, a['draftId'], 'pdf'));
});
