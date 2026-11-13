/**
 * @file 会社の見た目（仕様書 第46.5節）を成果物に使う試験。サイネージの背景色、お知らせのサイネージの 1 枚の色、
 * 挿絵の雰囲気と文の調子の頼み、お知らせの下書きに文の調子を添えること。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_TENANT_SETTINGS, SIGNAGE_DEFAULT_COLOR, type TenantSettings } from '@m2office/shared';
import {
  DEFAULT_DESIGN, SignageService, designImageHint, designVoiceLine, screenCardOf, screenSvg, writeDraft,
  type LlmProvider, type LlmRequest, type Repository,
} from '../src/index.js';

const tokens = { ...DEFAULT_DESIGN, colors: { ...DEFAULT_DESIGN.colors, primary: '#2e6b4f', accent: '#c08a2e', background: '#f7f5f0', text: '#22261f', muted: '#5a6052' }, voice: 'やわらかく、ていねいな調子', imagery: '自然光の写真' };

test('サイネージの背景色: 管理者が決めた色 → 会社の見た目の主の色 → 濃い青', async () => {
  let color: string | null = null;
  let design: typeof tokens | null = tokens;
  const service = new SignageService({
    store: {} as never, files: {} as never,
    repo: { getTenantSettings: async () => ({ ...DEFAULT_TENANT_SETTINGS, signage: { ...DEFAULT_TENANT_SETTINGS.signage, color } }) as TenantSettings } as unknown as Repository,
    design: async () => design,
  });
  assert.equal(await service.bandColor('t1'), '#2e6b4f', '決めていなければ会社の主の色');
  color = '#aa3300';
  assert.equal(await service.bandColor('t1'), '#aa3300', '管理者が決めた色が先');
  assert.equal(await service.bandColor('t1', null), '#2e6b4f', '設定を渡されたらそれを使う');
  color = null;
  design = null;
  assert.equal(await service.bandColor('t1'), SIGNAGE_DEFAULT_COLOR, '会社の見た目も無ければ濃い青');
});

test('お知らせのサイネージの 1 枚: 帯の色は選んだ色 → 背景色 → 会社の主の色。地と文字は会社の見た目。明るい帯には濃い字', () => {
  const a = { title: '臨時休業', startDate: '2026-12-28', endDate: null, texts: { signage: { headline: '', period: '', detail: '', note: '', color: '' } } } as never;
  assert.equal(screenCardOf(a, null, {}, tokens).color, '#2e6b4f');
  assert.equal(screenCardOf(a, '#aa3300', {}, tokens).color, '#aa3300');
  assert.equal(screenCardOf(a, null, { color: 'red' }, tokens).color, '#a63a3a');
  const card = screenCardOf(a, null, {}, tokens);
  const svg = screenSvg(card);
  assert.ok(svg.includes('fill="#f7f5f0"') && svg.includes('fill="#22261f"'), '地と文字の色');
  assert.ok(svg.includes('>お知らせ</text>') && /fill="#ffffff">お知らせ/.test(svg), '濃い帯には白い字');
  const pale = screenSvg({ ...card, color: '#ffd84a' });
  assert.ok(/fill="#1d2733">お知らせ/.test(pale), '明るい帯には濃い字');
  const plain = screenSvg(screenCardOf(a, null));
  assert.ok(plain.includes('fill="#fbfaf6"'), '会社の見た目が無ければ今までの地');
});

test('頼みに添える文: 挿絵は雰囲気と色の調子、文はデータとして調子を渡し、自社の書き方を先にする。見た目が無ければ空', () => {
  assert.match(designImageHint(tokens), /自然光の写真.*#2e6b4f.*#c08a2e/);
  assert.match(designVoiceLine(tokens), /データ.*やわらかく、ていねいな調子.*自社の書き方と食い違うときは自社の書き方に従う/);
  assert.equal(designImageHint(null), '');
  assert.equal(designVoiceLine(null), '');
});

test('お知らせの下書き: 会社の見た目の文の調子を頼みに添える', async () => {
  const asked: string[] = [];
  const llm = {
    name: 'fake',
    async complete(req: LlmRequest) { asked.push(String(req.messages[0]!.content)); return { text: '{"title":"臨時休業のお知らせ","body":"本文"}', tokensUsed: 1 }; },
  } as unknown as LlmProvider;
  await writeDraft(llm, { request: '12/28 は臨時休業', today: '2026-12-01', company: { name: '見本の会社', phone: '', hours: '' }, selfReference: '当社', available: ['web'], voice: designVoiceLine(tokens) });
  assert.ok(asked[0]!.includes('やわらかく、ていねいな調子'));
});
