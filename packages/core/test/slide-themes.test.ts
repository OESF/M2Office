/**
 * @file Google スライドのテーマ（読み取り・組み立て・登録・使う見た目の決め方）と、PowerPoint の取り出しの単体テスト。
 *
 * @see 仕様書 第9.4.2節「Google スライドのテーマを使う・PowerPoint の取り出し」、Q-265、ADR-0109
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  BUILTIN_TOOLS, InMemorySlideDeckStore, InMemorySlideThemeStore, MockWorkspaceConnector, SlideDeckService, SlideThemeService,
  SlideThemeUnavailableError, ToolRegistry, readTheme, slideDeckLinks, type ToolContext,
} from '../src/index.js';
import { slideRequests } from '../src/connectors/google/slides.js';

const registry = new ToolRegistry();
for (const t of BUILTIN_TOOLS) registry.register(t);

const EMU = 914_400;
const ph = (type: string, box?: { x: number; y: number; w: number; h: number }) => ({
  objectId: `ph-${type}`, shape: { placeholder: { type, index: 0 } },
  ...(box ? { size: { width: { magnitude: box.w * EMU }, height: { magnitude: box.h * EMU } }, transform: { scaleX: 1, scaleY: 1, translateX: box.x * EMU, translateY: box.y * EMU } } : {}),
});

/** ギャラリーから作ったファイルに似たテーマ（暗い背景・レイアウトの名前を付け替えたものを含む）。 */
const DARK = {
  pageSize: { width: { magnitude: 9_144_000 }, height: { magnitude: 5_143_500 } },
  masters: [{
    objectId: 'm1',
    pageProperties: {
      colorScheme: { colors: [
        { type: 'DARK1', color: { red: 0.05, green: 0.05, blue: 0.1 } }, { type: 'LIGHT1', color: { red: 1, green: 1, blue: 1 } },
        { type: 'ACCENT1', color: { red: 0.08, green: 0.08, blue: 0.14 } }, { type: 'ACCENT2', color: { red: 1, green: 0.6, blue: 0.1 } },
      ] },
      pageBackgroundFill: { solidFill: { color: { themeColor: 'DARK1' } } },
    },
    pageElements: [
      { shape: { placeholder: { type: 'TITLE' }, text: { textElements: [{ textRun: { style: { fontFamily: 'Montserrat' } } }] } } },
      { shape: { placeholder: { type: 'BODY' }, text: { textElements: [{ textRun: { style: { fontFamily: 'Lato' } } }] } } },
    ],
  }],
  layouts: [
    { objectId: 'L-title', layoutProperties: { name: 'TITLE', displayName: 'Title slide' }, pageElements: [ph('CENTERED_TITLE'), ph('SUBTITLE'), ph('SLIDE_NUMBER')] },
    { objectId: 'L-sec', layoutProperties: { name: 'CUSTOM_3', displayName: 'Section header' }, pageElements: [ph('TITLE'), ph('BODY')] },
    { objectId: 'L-only', layoutProperties: { name: 'CUSTOM_7', displayName: 'Title only' }, pageElements: [ph('TITLE', { x: 0.4, y: 0.3, w: 9, h: 1.2 }), ph('SLIDE_NUMBER')] },
    { objectId: 'L-blank', layoutProperties: { name: 'BLANK', displayName: 'Blank' }, pageElements: [ph('SLIDE_NUMBER')] },
  ],
};

test('テーマの読み取り: レイアウトを名前と枠の種類から選び、背景と見分けられる文字と強調の色、テーマの字体を使う', () => {
  const t = readTheme(DARK, '暗いテーマ');
  assert.equal(t.layouts.title?.objectId, 'L-title');
  assert.equal(t.layouts.section?.objectId, 'L-sec', '表示名から区切りを選ぶ');
  assert.equal(t.layouts.titleOnly?.objectId, 'L-only', '題名の枠だけのレイアウト');
  assert.equal(t.layouts.blank?.objectId, 'L-blank');
  assert.deepEqual(t.design.background, { red: 0.05, green: 0.05, blue: 0.1 });
  assert.deepEqual(t.design.text, { red: 1, green: 1, blue: 1 }, '暗い背景では明るい文字');
  assert.deepEqual(t.design.accent, { red: 1, green: 0.6, blue: 0.1 }, '背景に溶けるアクセントは飛ばす');
  assert.deepEqual(t.design.font, { heading: 'Montserrat', body: 'Lato' });
  assert.equal(t.design.name, '暗いテーマ');
  assert.ok(Math.abs(t.contentTop - 1.62) < 0.01, '図は題名の枠の下から');
  // 何も読めないテーマでも組み立てられる
  const empty = readTheme({}, '空');
  assert.deepEqual(empty.layouts, {});
  assert.equal(empty.design.font.heading, 'Noto Sans JP');
});

test('テーマの組み立て: テーマのレイアウトでページを作り、背景を塗らず会社名を置かない。使わない枠は消す', () => {
  const theme = readTheme(DARK, '暗いテーマ');
  const plan = {
    title: '新しい道具の導入', subtitle: '',
    slides: [
      { layout: 'SECTION' as const, number: '01', title: 'いまの課題', notes: 'n' },
      { layout: 'KPI' as const, title: '効果は数字に出る', stats: [{ value: '50', unit: '%', label: '手間' }, { value: '2', unit: '倍', label: '速さ' }], notes: 'n' },
      { layout: 'STATEMENT' as const, title: '', message: '手間を半分に', notes: 'n' },
    ],
  };
  const { requests } = slideRequests(plan, { width: 9_144_000, height: 5_143_500 }, 'first', { design: theme.design, theme, footer: '株式会社見本' });
  const slidesMade = requests.filter((r) => r['createSlide']).map((r) => (r['createSlide'] as Record<string, any>));
  assert.deepEqual(slidesMade.map((s) => s.slideLayoutReference.layoutId), ['L-title', 'L-sec', 'L-only', 'L-blank']);
  assert.ok(!requests.some((r) => r['updatePageProperties']), '背景はテーマのまま');
  assert.ok(!JSON.stringify(requests).includes('株式会社見本'), '会社名はテーマのフッターに任せる');
  // 表紙: 題名を入れ、空の副題の枠は消す。ページ番号の枠は触らない
  const cover = slidesMade[0]!;
  assert.deepEqual(cover.placeholderIdMappings.map((m: Record<string, any>) => m.layoutPlaceholder.type), ['CENTERED_TITLE', 'SUBTITLE']);
  assert.ok(requests.some((r) => (r['insertText'] as Record<string, any> | undefined)?.objectId === 'm2cover_centered_title0'));
  assert.ok(requests.some((r) => (r['deleteObject'] as Record<string, any> | undefined)?.objectId === 'm2cover_subtitle0'));
  // 区切り: 番号と章の名前を題名の枠に
  assert.ok(requests.some((r) => (r['insertText'] as Record<string, any> | undefined)?.text === '01　いまの課題'));
  // 図はテーマの強調の色で
  assert.ok(JSON.stringify(requests).includes('"red":1,"green":0.6,"blue":0.1'));
});

/** 記録する見本のスライドの接続口（テーマを受け取る）。 */
function setup(o: { themeBroken?: boolean } = {}) {
  const calls: { theme?: { presentationId: string; name: string } | null; rebuild?: string; images: string[] }[] = [];
  const trashed: string[] = [];
  const state = new Map<string, { modifiedTime: string; trashed: boolean }>();
  let n = 0;
  const slides = {
    readTemplate: async () => null,
    createPresentation: async (_p: unknown, input: { theme?: { presentationId: string; name: string } | null; rebuild?: string; images?: Record<string, unknown> }) => {
      calls.push({ ...(input.theme !== undefined ? { theme: input.theme } : {}), ...(input.rebuild ? { rebuild: input.rebuild } : {}), images: Object.keys(input.images ?? {}) });
      if (input.theme && o.themeBroken) throw new SlideThemeUnavailableError(`テーマ「${input.theme.name}」のファイルを開けませんでした`);
      const id = input.rebuild ?? `DECK${++n}`;
      state.set(id, { modifiedTime: new Date().toISOString(), trashed: false });
      return { presentationId: id, ...slideDeckLinks(id), templateApplied: false, pages: 3, warnings: [] };
    },
    fileState: async (_p: unknown, id: string) => state.get(id) ?? null,
    share: async () => true,
    trash: async (_p: unknown, id: string) => { trashed.push(id); return true; },
    inspectTheme: async (_p: unknown, id: string) => (id === 'GALLERY0001' ? { name: 'ギャラリーの青', layouts: 11, thumbnail: { bytes: new Uint8Array([1, 2]), mimeType: 'image/png' } } : null),
    exportPptx: async (_p: unknown, id: string) => (id === 'DECK2' ? 'too-large' as const : new Uint8Array([80, 75])),
  };
  const connector = new MockWorkspaceConnector();
  (connector as unknown as { slides: unknown }).slides = slides;
  (connector as unknown as { sourceFor: () => string }).sourceFor = () => 'google';
  const repo = {
    createArtifact: async () => undefined,
    getTenantSettings: async () => ({ slides: { templates: [], defaultDesign: null }, company: { legalName: '株式会社見本', shortName: '見本' } }),
    findTenantById: async () => ({ id: 't', workspaceDomain: 'example.co.jp' }),
    findUserById: async (_t: string, id: string) => ({ id, email: `${id}@example.co.jp`, displayName: id }),
    getGoogleConnection: async () => null,
  };
  const themes = new SlideThemeService({ store: new InMemorySlideThemeStore(), connector });
  const decks = new SlideDeckService({ store: new InMemorySlideDeckStore(), repo: repo as never, connector });
  const generated: string[] = [];
  const ctx = (userId = 'u'): ToolContext => ({
    tenantId: 't', userId, runId: 'r', compartment: null, repo: repo as never, connector, files: {} as never, slideDecks: decks, slideThemes: themes,
    slideImages: { generate: async (prompt) => { generated.push(prompt); return { bytes: new Uint8Array([1]), mimeType: 'image/png' }; } },
  });
  return { calls, trashed, themes, decks, ctx, generated };
}

const PLAN = {
  title: '導入の提案', imagePrompt: '朝の机', notes: '表紙',
  slides: [
    { layout: 'SECTION', number: '01', title: '課題', imagePrompt: '書類の山', notes: 'n' },
    { layout: 'IMAGE', title: '現場の様子', imagePrompt: '整った作業台', caption: '作業台', notes: 'n' },
    { layout: 'STATEMENT', title: '', message: 'まとめ', notes: 'n' },
  ],
};
const create = (c: ToolContext, args: Record<string, unknown>) => registry.get('slides.create')!.invoke({ ...structuredClone(PLAN), ...args }, c) as Promise<Record<string, any>>;

test('テーマの登録: 本人のテーマと会社のテーマ（管理者だけ）。同じファイルは重ねない。開けないファイルは断る', async () => {
  const s = setup();
  const u = { tenantId: 't', userId: 'u' };
  const mine = await s.themes.add(u, { fileId: 'GALLERY0001' });
  assert.ok(!('error' in mine) && mine.name === 'ギャラリーの青' && mine.company === false && mine.removable && mine.thumbnail);
  const again = await s.themes.add(u, { fileId: 'GALLERY0001' });
  assert.ok(!('error' in again) && again.id === mine.id, '同じファイルは重ねない');
  assert.match((await s.themes.add(u, { fileId: 'GALLERY0001', company: true }) as { error: string }).error, /管理者だけ/);
  assert.match((await s.themes.add(u, { fileId: 'NOTSLIDES01' }) as { error: string }).error, /開けませんでした/);
  const company = await s.themes.add({ ...u, userId: 'boss', admin: true }, { fileId: 'GALLERY0001', company: true });
  assert.ok(!('error' in company) && company.company);
  // ほかの人には会社のテーマだけが見え、削除できない
  const other = await s.themes.list({ tenantId: 't', userId: 'v' });
  assert.deepEqual(other.map((t) => [t.company, t.removable]), [[true, false]]);
  assert.match(String(await s.themes.remove({ tenantId: 't', userId: 'v' }, company.id)), /管理者だけ/);
  assert.equal(await s.themes.remove({ tenantId: 't', userId: 'v' }, mine.id), 'テーマが見つかりません');
  assert.equal(await s.themes.find({ tenantId: 't', userId: 'v' }, `theme:${mine.id}`), null, 'ほかの人のテーマは使えない');
  assert.ok(await s.themes.find({ tenantId: 't', userId: 'v' }, 'ギャラリーの青'), '会社のテーマは名前でも引ける');
  // 会社をまたいで見えない
  assert.deepEqual(await s.themes.list({ tenantId: 'other', userId: 'u' }), []);
});

test('slides.create: テーマを選ぶとテーマを渡し、表紙と区切りの画像は作らない。作り直しは同じテーマで同じファイル', async () => {
  const s = setup();
  const t = await s.themes.add({ tenantId: 't', userId: 'u' }, { fileId: 'GALLERY0001' });
  assert.ok(!('error' in t));
  const out = await create(s.ctx(), { design: `theme:${t.id}` });
  assert.deepEqual(s.calls[0]!.theme, { presentationId: 'GALLERY0001', name: 'ギャラリーの青' });
  assert.deepEqual(s.calls[0]!.images, ['m2slide2'], '画像は画像のページだけ');
  assert.equal(out['design'], 'ギャラリーの青');
  const deck = (await s.decks.store.get('t', out['deckId']))!;
  assert.equal(deck.theme, t.id);
  // 直す（デザインの指定なし）→ 同じテーマで同じファイルを作り直す
  await create(s.ctx(), { deckId: out['deckId'], request: '短く' });
  assert.equal(s.calls[1]!.rebuild, 'DECK1');
  assert.deepEqual(s.calls[1]!.theme, { presentationId: 'GALLERY0001', name: 'ギャラリーの青' });
  // デザインを組み込みに変えて直す → テーマはファイルに入っているため新しいファイルにし、前のファイルはごみ箱へ
  const changed = await create(s.ctx(), { deckId: out['deckId'], design: 'ナチュラル' });
  assert.equal(s.calls[2]!.rebuild, undefined);
  assert.equal(changed['presentationId'], 'DECK2');
  assert.deepEqual(s.trashed, ['DECK1']);
});

test('slides.create: テーマのファイルを開けなければ標準のデザインで作り、理由を残す', async () => {
  const s = setup({ themeBroken: true });
  const t = await s.themes.add({ tenantId: 't', userId: 'u' }, { fileId: 'GALLERY0001' });
  assert.ok(!('error' in t));
  const out = await create(s.ctx(), { design: 'ギャラリーの青' });
  assert.equal(s.calls.length, 2);
  assert.equal(s.calls[1]!.theme, undefined);
  assert.ok((out['warnings'] as string[]).some((w) => w.includes('開けませんでした') && w.includes('標準のデザインで作りました')));
  assert.equal(out['design'], 'ビジネス');
});

test('PowerPoint: 本人のものは M2Office が受け取って名前を付ける。大きすぎるもの・ほかの人のものは Google の書き出しの道', async () => {
  const s = setup();
  const a = await create(s.ctx(), { title: '提案/2026' });
  const got = await s.decks.exportPptx({ tenantId: 't', userId: 'u' }, a['deckId']);
  assert.ok('bytes' in got && got.filename === '提案 2026.pptx');
  const b = await create(s.ctx(), {});
  const big = await s.decks.exportPptx({ tenantId: 't', userId: 'u' }, b['deckId']);
  assert.ok('fallback' in big && big.fallback.endsWith('/DECK2/export/pptx'));
  await s.decks.share({ tenantId: 't', userId: 'u' }, a['deckId'], 'company');
  const other = await s.decks.exportPptx({ tenantId: 't', userId: 'v' }, a['deckId']);
  assert.ok('fallback' in other, 'ほかの人の権限では読めないため、作った人の権限は借りない');
  const hidden = await s.decks.exportPptx({ tenantId: 't', userId: 'v' }, b['deckId']);
  assert.ok('error' in hidden, '自分だけのものは見えない');
});
