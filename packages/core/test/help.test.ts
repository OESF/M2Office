/**
 * @file ヘルプの単体テスト。業務の説明の自動生成、記事の読み込み、役割による出し分け、検索を確かめる。
 *
 * @see 仕様書 第6.10節 ヘルプと案内
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import {
  OFFICIAL_AGENTS, ToolRegistry, BUILTIN_TOOLS, HelpCatalog, buildAgentHelp, helpConcepts, parseArticle, parseManual,
  resolveOfficialAgent, type HelpContext,
} from '../src/index.js';
import { DEFAULT_TENANT_SETTINGS } from '@m2office/shared';

const registry = new ToolRegistry();
for (const t of BUILTIN_TOOLS) registry.register(t);
const help = (id: string) => buildAgentHelp(resolveOfficialAgent(id, 1)!, registry);

test('すべての公式エージェントがヘルプの概要と実行例を持つ（仕様書 第9.2.5節）', () => {
  for (const a of OFFICIAL_AGENTS) {
    assert.ok(a.help?.summary, `${a.id} に help.summary がない`);
    assert.ok((a.help?.examples ?? []).length > 0, `${a.id} に実行例がない`);
  }
});

test('すべてのツールが「すること」と活動の表示名を持つ', () => {
  for (const t of BUILTIN_TOOLS) {
    assert.ok(t.helpText.length > 0, `${t.name} に helpText がない`);
    assert.ok(t.activityLabel.length > 0, `${t.name} に activityLabel がない`);
  }
});

test('受信箱整理の説明は「送信しない」ことを、危険度から正しく書く', () => {
  const h = help('inbox-triage');
  assert.ok(h.does.some((d) => d.includes('送信はしません')));
  assert.equal((h as { safeguards?: unknown }).safeguards, undefined, 'どの業務にも同じになる決まり文句は並べない（第 0.130.0 版）');
  assert.deepEqual(h.approvals, []);
});

test('議事録の説明は、承認が入る場所と承認者を書く', () => {
  const h = help('minutes');
  assert.deepEqual(h.approvals.map((a) => a.step), ['内容の承認', '共有の承認']);
  assert.ok(h.approvals.every((a) => a.who.includes('管理者')));
  assert.deepEqual(h.flow, ['取得', '作成', '内容の承認', '起票', '共有の承認', '共有']);
});

test('日程調整の承認者は「依頼したあなた」と書く（approver: requester）', () => {
  assert.deepEqual(help('scheduling').approvals, [{ step: '承認', who: '依頼したあなた' }]);
});

test('公式の記事はすべて読み込め、ID が重複しない', () => {
  const dir = new URL('../../../docs/help/', import.meta.url);
  const files = readdirSync(dir).filter((f) => f.endsWith('.md') && f !== 'README.md');
  const ids = files.map((f) => parseArticle(readFileSync(new URL(f, dir), 'utf8')).id);
  assert.ok(ids.length >= 10);
  assert.equal(new Set(ids).size, ids.length);
});

test('記事の属性が足りなければ読み込みを拒む', () => {
  assert.throws(() => parseArticle('本文だけ'));
  assert.throws(() => parseArticle('---\nid: x\ntitle: y\naudience: everyone\ncategory: start\n---\n本文'));
});

const ARTICLES = [
  parseArticle('---\nid: a1\ntitle: 承認のしかた\naudience: all\ncategory: start\n---\n承認トレイで承認します。'),
  parseArticle('---\nid: a2\ntitle: 知識の登録\naudience: admin\ncategory: admin\n---\n管理者が規程を登録します。'),
];
const ctx = (roles: string[], disabled: string[] = []): HelpContext => ({
  roles, disabledAgents: disabled, automation: DEFAULT_TENANT_SETTINGS.automation,
});

test('管理者向けの記事は、一般の利用者には一覧にも検索にも出さない', () => {
  const catalog = new HelpCatalog(ARTICLES, OFFICIAL_AGENTS, registry);
  assert.ok(!catalog.list(ctx(['member'])).some((a) => a.id === 'a2'));
  assert.equal(catalog.get('a2', ctx(['member'])), null);
  assert.ok(catalog.list(ctx(['admin'])).some((a) => a.id === 'a2'));
  assert.ok(!catalog.search('規程を登録', ctx(['member'])).some((h) => h.article.id === 'a2'));
});

test('無効にした業務の記事は出さない', () => {
  const catalog = new HelpCatalog(ARTICLES, OFFICIAL_AGENTS, registry);
  assert.ok(catalog.list(ctx(['member'])).some((a) => a.id === 'agent-scheduling'));
  assert.ok(!catalog.list(ctx(['member'], ['scheduling'])).some((a) => a.id === 'agent-scheduling'));
});

test('題名に当たる記事を先に返す', () => {
  const catalog = new HelpCatalog(ARTICLES, OFFICIAL_AGENTS, registry);
  const hits = catalog.search('承認はどうやるの？', ctx(['member']));
  assert.equal(hits[0]?.article.id, 'a1');
});

/** 公式の記事（`docs/help/`）をすべて読み込んだ目録。 */
function officialCatalog(): HelpCatalog {
  const dir = new URL('../../../docs/help/', import.meta.url);
  const articles = readdirSync(dir).filter((f) => f.endsWith('.md') && f !== 'README.md')
    .map((f) => parseArticle(readFileSync(new URL(f, dir), 'utf8')));
  return new HelpCatalog(articles, OFFICIAL_AGENTS, registry);
}

test('使い方の質問には、その記事を最初に返す（公式の記事で確かめる）', () => {
  const catalog = officialCatalog();
  const cases: [string, string, string[]][] = [
    ['承認はどうやるの？', 'start-approvals', ['member']],
    ['定時実行を止めたい', 'start-schedules', ['member']],
    ['勝手にメールが送られることはある？', 'faq-sending', ['member']],
    ['ダミーデータって何？', 'faq-dummy', ['member']],
    ['間違った内容が作られたらどうすればいい？', 'faq-mistakes', ['member']],
    ['誰に何が見られますか', 'faq-privacy', ['member']],
    ['秘書の使い方を教えて', 'start-secretary', ['member']],
    ['個人設定はどこで変える？', 'start-settings', ['member']],
    ['業務を実行するにはどうすればいい？', 'start-agents', ['member']],
    ['議事録の作成・共有は何をする？', 'agent-minutes', ['member']],
    ['画面の見方を教えて', 'start-screen', ['member']],
    ['困ったときの問い合わせ先は？', 'contact', ['member']],
    ['ユーザーを招待するには？', 'admin-users', ['admin']],
    ['規程を登録する方法は？', 'admin-knowledge', ['admin']],
    ['スライドのテンプレートを登録したい', 'admin-slides', ['admin']],
    ['Gemini の鍵はどこで設定する？', 'admin-connectors', ['admin']],
    ['会議室を予約したい', 'start-reservations', ['member']],
    ['社用車の予約を取り消すには？', 'start-reservations', ['member']],
  ];
  for (const [q, want, roles] of cases) {
    assert.equal(catalog.search(q, ctx(roles))[0]?.article.id, want, q);
  }
});

test('社内規程の質問や、ヘルプに無いことには、関係のない記事を返さない', () => {
  const catalog = officialCatalog();
  // 有給の日数は「給与・勤怠」の記事（第30.7.1節）が答えるため、会社の規程だけで決まる休暇（慶弔休暇）で確かめる
  for (const q of ['育休はいつまで取れますか？どうすればいい？', '慶弔休暇は何日もらえますか', '経費はどう申請する？', '宇宙旅行の予約方法は？']) {
    assert.deepEqual(catalog.search(q, ctx(['member'])).map((h) => h.article.id), [], q);
  }
});

test('長い言葉に含まれる短い言葉は、長い言葉とまとめて 1 つに数える', () => {
  const c = helpConcepts('定時実行を止めたい');
  assert.equal(c.length, 2, '「定時」「実行」を別の言葉として数えない');
  assert.equal(c[0]!.term, '定時実行');
  assert.ok(c[0]!.alternatives.includes('実行'));
  assert.ok(c[1]!.alternatives.includes('止め'), '「止めたい」から「止める」にも当たる語幹を持つ');
  assert.ok(helpConcepts('誰に見られますか').some((x) => x.term === '見られ'), '漢字 1 文字の動詞の語幹を拾う');
  assert.ok(!helpConcepts('承認はどうやるの？').some((x) => x.term.endsWith('は')), '助詞で始まる送り仮名は拾わない');
});

test('更新情報は、使い方の質問で案内の記事に勝たない（仕様書 第6.10.7.1節）', () => {
  const catalog = officialCatalog();
  const ctx = { roles: ['member'], disabledAgents: [], automation: DEFAULT_TENANT_SETTINGS.automation };

  // 版を重ねるたび、題名に業務の言葉を含む更新情報が増える。
  // 「秘書と会話できるようになりました」が「秘書に頼む」に勝ってはいけない
  assert.equal(catalog.search('秘書の使い方を教えて', ctx)[0]?.article.id, 'start-secretary');
  assert.equal(catalog.search('画面の見方を教えて', ctx)[0]?.article.id, 'start-screen');

  // 下げるだけで、消しはしない。更新情報の中身を探せば出る
  const hits = catalog.search('会話できるようになりました', ctx).map((h) => h.article.id);
  assert.ok(hits.some((id) => id.startsWith('updates-')), `更新情報が出ない: ${hits.join('、')}`);
});

test('業務のマニュアル: README と番号の章を順に記事にし、章の題を最初の見出しから取る（第6.10.7.3節）', () => {
  const chapters = parseManual('inventory', { title: '在庫管理', extension: 'inventory' }, [
    { name: '02-items.md', text: '# 第 2 章 品目と場所\n\n## 品目を足す\n本文' },
    { name: 'README.md', text: '# 在庫管理 ユーザーマニュアル\n\nこの手引きは…' },
    { name: '01-setup.md', text: '# 第 1 章 導入\n本文' },
    { name: 'manual.json', text: '{}' },
  ]);
  assert.deepEqual(chapters.map((c) => [c.id, c.title]), [
    ['manual-inventory-00', 'はじめに'], ['manual-inventory-01', '第 1 章 導入'], ['manual-inventory-02', '第 2 章 品目と場所'],
  ]);
  assert.ok(!chapters[2]!.body.startsWith('# '), '章の題の見出しは本文から除く');
  assert.ok(chapters.every((c) => c.category === 'manual' && c.business === 'inventory' && c.extension === 'inventory'));
});

test('ヘルプの出す所: ワークスペースは管理者向けを出さず、管理者ページは管理者向けだけ。マニュアルは使える人だけ（第6.10.7節）', () => {
  const art = (id: string, category: string, audience = 'all') => parseArticle(`---\nid: ${id}\ntitle: ${id}\naudience: ${audience}\ncategory: ${category}\n---\n本文`);
  const manual = parseManual('hr-payroll', { title: '人事・給与', extension: 'hr' }, [{ name: '01-setup.md', text: '# 第 1 章 導入\n給与の設定' }]);
  const catalog = new HelpCatalog([
    art('start-screen', 'start'), art('admin-users', 'admin', 'admin'), art('updates-v0-1-0', 'updates'), art('updates-v0-1-0-admin', 'updates', 'admin'),
    art('glossary', 'glossary'), art('contact', 'contact'), ...manual,
  ], [], registry);
  const admin: HelpContext = { roles: ['admin'], disabledAgents: [], automation: DEFAULT_TENANT_SETTINGS.automation, agents: [] };
  const ids = (list: { id: string }[]) => list.map((a) => a.id).sort();
  assert.deepEqual(ids(catalog.list(admin, 'workspace')), ['contact', 'glossary', 'start-screen', 'updates-v0-1-0']);
  assert.deepEqual(ids(catalog.list(admin, 'admin')), ['admin-users', 'contact', 'glossary', 'updates-v0-1-0-admin']);
  assert.ok(!catalog.list({ ...admin, extensions: [] }, 'workspace').some((a) => a.category === 'manual'), '業務を使えない人にはマニュアルを出さない');
  assert.ok(catalog.list({ ...admin, extensions: ['hr'] }, 'workspace').some((a) => a.id === 'manual-hr-payroll-01'), '使える人には出す');
  assert.equal(catalog.search('給与の設定', admin, 3).length, 0, '使える業務を渡さない検索（秘書の答え）にはマニュアルを入れない');
  assert.ok(catalog.get('admin-users', admin), '画面の「？」は出す所に関わらず、役割で見られる記事を開ける');
  const guide = parseArticle('---\nid: start-hr\ntitle: 人事・給与\naudience: all\ncategory: start\nbusiness: hr-payroll\nextension: hr\n---\n本文');
  const withGuide = new HelpCatalog([guide], [], registry);
  assert.equal(withGuide.list({ ...admin, extensions: [] }).length, 0, '使えない業務の要点の記事は出さない');
  assert.equal(withGuide.list({ ...admin, extensions: ['hr'] }).length, 1);
  assert.equal(withGuide.list(admin).length, 1, '使える業務を渡さない秘書の答えの材料には、要点の記事を残す');
});

test('業務の記事の置き場: 内蔵の拡張の付属の業務はその拡張の要点の記事と同じ区分、公式の業務は分野のまとまり（第6.10.7節）', () => {
  const guide = parseArticle('---\nid: start-web-columns\ntitle: コラムの作成\naudience: all\ncategory: start\nbusiness: web-columns\nextension: web-columns\n---\n本文');
  const columnAgent = { ...resolveOfficialAgent('scheduling', 1)!, id: 'web-columns:draft', name: 'コラムの下書き' };
  const catalog = new HelpCatalog([guide], [...OFFICIAL_AGENTS, columnAgent], registry);
  const groupOf = (id: string) => (id.startsWith('web-columns:') ? { id: 'ext:web-columns', name: 'コラムの作成' }
    : id === 'scheduling' ? { id: 'cat:calendar', name: '予定' } : { id: `agent:${id}`, name: id });
  const list = catalog.list({ ...ctx(['member']), groupOf, extensions: ['web-columns'] });
  const col = list.find((a) => a.id === 'agent-web-columns:draft');
  assert.deepEqual([col?.business, col?.extension, col?.group], ['web-columns', 'web-columns', undefined]);
  assert.equal(list.find((a) => a.id === 'agent-scheduling')?.group, '予定');
  // 使えない拡張の付属の業務は、要点の記事と一緒に出さない
  assert.ok(!catalog.list({ ...ctx(['member']), groupOf, extensions: [] }).some((a) => a.id === 'agent-web-columns:draft'));
});

test('秘書の会話の例を聞くと、秘書にできること（会話の例）を返す（第6.1.3節）', () => {
  const catalog = officialCatalog();
  for (const q of ['秘書の会話の例', '会話の例']) {
    const ids = catalog.search(q, ctx(['member'])).map((h) => h.article.id);
    assert.equal(ids[0], 'start-secretary-examples', `${q}: ${ids.join(', ')}`);
  }
  // 「秘書」だけの問いでは秘書の記事が並ぶ。「秘書の使い方」から会話の例へ案内する
  assert.match(catalog.get('start-secretary', ctx(['member']))!.body, /秘書にできること（会話の例）/);
});
