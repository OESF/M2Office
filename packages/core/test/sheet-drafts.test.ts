/**
 * @file 業務「表の作成」の作った表の扱い（作る・同じファイルで書き直す・テンプレート・一覧・共有・Excel と PDF）と、表の見た目の単体テスト。
 *
 * @see 仕様書 第9.5.5.2節「表の作成の扱いとテンプレート」、Q-268、ADR-0111
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  BUILTIN_TOOLS, InMemorySlideDeckStore, InMemorySlideThemeStore, MockWorkspaceConnector, SlideDeckService, SlideThemeService, SlideThemeUnavailableError, ToolRegistry, type ToolContext,
} from '../src/index.js';
import { lookRequests, readLook } from '../src/connectors/google/sheet-look.js';

const registry = new ToolRegistry();
for (const t of BUILTIN_TOOLS) registry.register(t);

test('表の見た目: テンプレートの見出しの行（値が 2 つ以上の最初の行）と本文の行の書式を読む。見つからなければ標準', () => {
  const cell = (v: string, fmt: object = {}) => ({ formattedValue: v, effectiveFormat: fmt });
  const look = readLook([
    { values: [cell('家計簿')] },
    { values: [cell('日付', { backgroundColor: { red: 0.2, green: 0.4, blue: 0.8 }, textFormat: { bold: true, foregroundColor: { red: 1, green: 1, blue: 1 }, fontFamily: 'Lexend', fontSize: 11 } }), cell('金額')] },
    { values: [cell('10/1', { textFormat: { fontFamily: 'Lexend', fontSize: 10 } }), cell('500')] },
  ]);
  assert.deepEqual(look?.header, { background: { red: 0.2, green: 0.4, blue: 0.8 }, foreground: { red: 1, green: 1, blue: 1 }, bold: true, font: 'Lexend', size: 11 });
  assert.deepEqual(look?.body, { font: 'Lexend', size: 10 });
  assert.ok(look!.band.blue > look!.band.red, '1 行おきの塗りは見出しの色を薄めたもの');
  assert.equal(readLook([{ values: [cell('題名だけ')] }]), null);
  const std = lookRequests(7, { columns: 3, rows: 1 }, null);
  assert.deepEqual(std.map((r) => Object.keys(r)[0]), ['repeatCell', 'updateSheetProperties', 'autoResizeDimensions'], '本文が無ければ 1 行おきの塗りは付けない');
});

function setup() {
  const calls = { created: [] as string[], rewritten: [] as string[], fromTemplate: [] as string[] };
  const state = new Map<string, { modifiedTime: string; trashed: boolean }>();
  const trashed: string[] = [];
  let n = 0;
  const connector = new MockWorkspaceConnector();
  const file = (id: string, name: string) => ({ id, name, kind: 'spreadsheet' as const, modifiedAt: new Date().toISOString(), url: null });
  const sheets = connector.sheets as unknown as Record<string, unknown>;
  sheets['create'] = async (_p: unknown, s: { title: string }) => { const id = `SHEET${++n}`; calls.created.push(id); state.set(id, { modifiedTime: new Date().toISOString(), trashed: false }); return file(id, s.title); };
  sheets['rewrite'] = async (_p: unknown, s: { spreadsheetId: string; title: string }) => { calls.rewritten.push(s.spreadsheetId); state.set(s.spreadsheetId, { modifiedTime: new Date().toISOString(), trashed: false }); return file(s.spreadsheetId, s.title); };
  sheets['createFromTemplate'] = async (_p: unknown, s: { templateId: string; templateName: string; title: string }) => {
    if (s.templateId === 'GONESHEETTPL') throw new SlideThemeUnavailableError(`テンプレート「${s.templateName}」のファイルが見つかりませんでした`);
    const id = `SHEET${++n}`; calls.fromTemplate.push(`${s.templateId}>${id}`); state.set(id, { modifiedTime: new Date().toISOString(), trashed: false }); return file(id, s.title);
  };
  sheets['inspectTemplate'] = async (_p: unknown, id: string) => (id.endsWith('SHEETTPL') ? { name: id === 'BUDGETSHEETTPL' ? '予算' : '消えた', thumbnail: null } : null);
  sheets['export'] = async (_p: unknown, id: string, format: string) => (id === 'SHEET2' ? 'too-large' as const : new TextEncoder().encode(format));
  const slides = connector.slides as unknown as Record<string, unknown>;
  slides['fileState'] = async (_p: unknown, id: string) => state.get(id) ?? null;
  slides['share'] = async () => true;
  slides['trash'] = async (_p: unknown, id: string) => { trashed.push(id); return true; };
  (connector as unknown as { sourceFor: () => string }).sourceFor = () => 'google';
  const artifacts: { kind: string; body: string; slideDeckId?: string | null }[] = [];
  const repo = {
    createArtifact: async (a: { kind: string; body: string; slideDeckId?: string | null }) => { artifacts.push(a); },
    findTenantById: async () => ({ id: 't', workspaceDomain: 'example.co.jp' }),
    findUserById: async (_t: string, id: string) => ({ id, email: `${id}@example.co.jp`, displayName: id }),
    getTenantSettings: async () => ({ slides: { templates: [], defaultSheetTemplate: null } }),
  };
  const decks = new SlideDeckService({ store: new InMemorySlideDeckStore(), repo: repo as never, connector });
  const themes = new SlideThemeService({ store: new InMemorySlideThemeStore(), connector });
  const ctx = (userId = 'u'): ToolContext => ({ tenantId: 't', userId, runId: 'r', compartment: null, repo: repo as never, connector, files: {} as never, slideDecks: decks, slideThemes: themes });
  return { calls, state, trashed, decks, themes, ctx, artifacts };
}
const draft = (c: ToolContext, args: Record<string, unknown>) => registry.get('sheets.draft')!.invoke(args, c) as Promise<Record<string, any>>;

test('sheets.draft: 表を作って種類 sheet で覚え、成果物は表そのもの。直すときは同じファイルを書き直す', async () => {
  const s = setup();
  const out = await draft(s.ctx(), { title: '見積', columns: ['会社', '金額'], rows: [['A 社', 300000], ['B 社', '250000']], request: '見積の表' });
  const d = (await s.decks.store.get('t', out['draftId']))!;
  assert.equal(d.kind, 'sheet');
  assert.deepEqual(d.table, { columns: ['会社', '金額'], rows: [['A 社', '300000'], ['B 社', '250000']] });
  assert.match(s.artifacts[0]!.body, /^\| 会社 \| 金額 \|/);
  assert.equal(out['url'], 'https://docs.google.com/spreadsheets/d/SHEET1/edit');
  await draft(s.ctx(), { title: '見積', columns: ['会社', '金額'], rows: [['A 社', '300000']], draftId: out['draftId'], request: 'B 社を消して' });
  assert.deepEqual(s.calls.rewritten, ['SHEET1']);
  assert.equal((await s.decks.list({ tenantId: 't', userId: 'u' }, 'sheet')).mine[0]!.downloads.join(), 'xlsx,pdf');
  assert.equal((await s.decks.list({ tenantId: 't', userId: 'u' }, 'doc')).mine.length, 0, '文書の一覧には出ない');
  assert.match(String((await draft(s.ctx('v'), { title: 'x', columns: ['a'], draftId: out['draftId'] }))['error']), /作った人だけ/);
});

test('sheets.draft: テンプレートから作り、テンプレートを変えたら新しいファイル。開けなければ標準', async () => {
  const s = setup();
  const t = await s.themes.add({ tenantId: 't', userId: 'u' }, { fileId: 'BUDGETSHEETTPL', kind: 'sheet' });
  assert.ok(!('error' in t) && t.kind === 'sheet');
  const made = await draft(s.ctx(), { title: '予算', columns: ['項目', '金額'], rows: [['広告', '100']], template: '予算' });
  assert.deepEqual(s.calls.fromTemplate, ['BUDGETSHEETTPL>SHEET1']);
  assert.equal(made['template'], '予算');
  const std = await draft(s.ctx(), { title: '予算', columns: ['項目', '金額'], rows: [], draftId: made['draftId'], template: '標準' });
  assert.equal(std['draftId'], made['draftId']);
  assert.deepEqual(s.calls.created, ['SHEET2']);
  assert.deepEqual(s.trashed, ['SHEET1']);
  const gone = await s.themes.add({ tenantId: 't', userId: 'u' }, { fileId: 'GONESHEETTPL', kind: 'sheet' });
  assert.ok(!('error' in gone));
  const fb = await draft(s.ctx(), { title: 'x', columns: ['a'], template: `theme:${gone.id}` });
  assert.equal(fb['template'], '標準');
  assert.ok((fb['warnings'] as string[]).some((w) => w.includes('標準の見た目')));
});

test('sheets.list・sheets.get・sheets.share と、Excel・PDF の取り出し', async () => {
  const s = setup();
  const a = await draft(s.ctx(), { title: '在庫', columns: ['品名', '数'], rows: [['ペン', '3']] });
  const got = await registry.get('sheets.get')!.invoke({ draftId: a['draftId'] }, s.ctx()) as Record<string, unknown>;
  assert.deepEqual([got['columns'], got['rows']], [['品名', '数'], [['ペン', '3']]]);
  assert.equal(registry.get('sheets.share')!.risk, 'write-internal');
  const shared = await registry.get('sheets.share')!.invoke({ draftId: a['draftId'], sharing: '会社で共有' }, s.ctx()) as Record<string, unknown>;
  assert.equal(shared['sharing'], '会社で共有');
  const xlsx = await s.decks.exportAs({ tenantId: 't', userId: 'u' }, a['draftId'], 'xlsx');
  assert.ok('bytes' in xlsx && xlsx.filename === '在庫.xlsx' && xlsx.mimeType.includes('spreadsheetml'));
  assert.ok('error' in await s.decks.exportAs({ tenantId: 't', userId: 'u' }, a['draftId'], 'docx'));
  const b = await draft(s.ctx(), { title: '大きい', columns: ['a'] });
  assert.ok('fallback' in await s.decks.exportAs({ tenantId: 't', userId: 'u' }, b['draftId'], 'pdf'));
});
