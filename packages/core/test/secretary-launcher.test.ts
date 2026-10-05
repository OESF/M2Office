/**
 * @file 秘書がアプリの一覧を変える処理の単体テスト（仕様書 第6.1.1.2節）。入れる（言われた URL・確かめた公式サイト）・消す・
 * Google のサービスを出す・出さない・尋ねる・アプリの一覧の話でなければ回さない。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_USER_SETTINGS, type UserSettings } from '@m2office/shared';
import { StubLlmProvider, type LlmProvider, type Repository } from '../src/index.js';
import { answerLauncher } from '../src/secretary/launcher.js';

function setup(launcher: UserSettings['launcher'] = { hidden: [], links: [] }) {
  let settings: UserSettings = { ...DEFAULT_USER_SETTINGS, launcher };
  const audits: string[] = [];
  const repo = {
    getUserSettings: async () => settings,
    saveUserSettings: async (_t: string, _u: string, section: keyof UserSettings, value: unknown) => { settings = { ...settings, [section]: value }; },
    appendAudit: async (e: { action: string }) => { audits.push(e.action); },
  } as unknown as Pick<Repository, 'getUserSettings' | 'saveUserSettings' | 'appendAudit'>;
  return { repo, audits, launcher: () => settings.launcher };
}
const says = (o: Record<string, unknown>): LlmProvider => ({ name: 'gemini', complete: async () => ({ text: JSON.stringify(o), tokensUsed: 1 }) });

test('アプリの一覧の話でなければ回さない', async () => {
  const { repo } = setup();
  assert.equal(await answerLauncher({ repo, llm: says({ action: 'add' }) }, 't', 'u', '明日の予定は？'), null);
  assert.equal(await answerLauncher({ repo, llm: says({ action: 'none' }) }, 't', 'u', 'アプリの一覧って何？の説明をして'), null);
});

test('入れる: 言われた URL はそのまま入れる。推論が使えなくても URL があれば入れる', async () => {
  const { repo, audits, launcher } = setup();
  const r = await answerLauncher({ repo, llm: new StubLlmProvider() }, 't', 'u', 'https://www.example.co.jp/order をアプリの一覧に入れて');
  assert.equal(r?.action, 'add');
  assert.deepEqual(launcher().links.map((l) => [l.label, l.url]), [['www.example.co.jp', 'https://www.example.co.jp/order']]);
  assert.ok(audits.includes('me.settings.update'));
  const dup = await answerLauncher({ repo, llm: new StubLlmProvider() }, 't', 'u', 'https://www.example.co.jp/order をアプリの一覧に入れて');
  assert.match(dup!.text, /もう/);
});

test('入れる: URL が無ければ推論が挙げた公式サイトを、開けると確かめてから入れる。確かめられなければ URL を尋ねる', async () => {
  const llm = says({ action: 'add', label: 'アスクル', url: '', officialUrl: 'https://www.askul.co.jp/' });
  const ok = setup();
  const r = await answerLauncher({ repo: ok.repo, llm, reachable: async () => true }, 't', 'u', 'アスクルをアプリの一覧に入れて');
  assert.match(r!.text, /アスクル.*https:\/\/www\.askul\.co\.jp\/.*違っていたら/);
  assert.equal(ok.launcher().links[0]!.label, 'アスクル');
  const ng = setup();
  const r2 = await answerLauncher({ repo: ng.repo, llm, reachable: async () => false }, 't', 'u', 'アスクルをアプリの一覧に入れて');
  assert.equal(r2!.action, 'ask');
  assert.equal(ng.launcher().links.length, 0, '確かめられない URL は入れない');
  const none = setup();
  assert.equal((await answerLauncher({ repo: none.repo, llm }, 't', 'u', 'アスクルをアプリの一覧に入れて'))!.action, 'ask', '確かめる口が無ければ入れない');
});

test('消す・Google のサービスを出さない／出す・尋ねる', async () => {
  const s = setup({ hidden: [], links: [{ id: 'l1', label: '問屋の受発注', url: 'https://b2b.example.com/' }] });
  const rm = await answerLauncher({ repo: s.repo, llm: says({ action: 'remove', label: '問屋' }) }, 't', 'u', '問屋のリンクをアプリの一覧から消して');
  assert.equal(rm!.action, 'remove');
  assert.equal(s.launcher().links.length, 0);
  await answerLauncher({ repo: s.repo, llm: says({ action: 'hide', services: ['chat', 'meet', 'unknown'] }) }, 't', 'u', 'アプリの一覧の Chat と Meet は出さないで');
  assert.deepEqual(s.launcher().hidden, ['chat', 'meet']);
  await answerLauncher({ repo: s.repo, llm: says({ action: 'show', services: ['chat'] }) }, 't', 'u', 'アプリの一覧に Chat を戻して');
  assert.deepEqual(s.launcher().hidden, ['meet']);
  const list = await answerLauncher({ repo: s.repo, llm: says({ action: 'list' }) }, 't', 'u', 'アプリの一覧に何がある？');
  assert.match(list!.text, /Gmail/);
  assert.doesNotMatch(list!.text.split('\n')[0]!, /Meet/);
});

test('登録は 20 件まで', async () => {
  const links = Array.from({ length: 20 }, (_, i) => ({ id: `l${i}`, label: `${i}`, url: `https://x${i}.example.com/` }));
  const s = setup({ hidden: [], links });
  const r = await answerLauncher({ repo: s.repo, llm: new StubLlmProvider() }, 't', 'u', 'https://new.example.com/ をアプリの一覧に入れて');
  assert.match(r!.text, /20 件まで/);
});
