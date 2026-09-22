/**
 * @file ヘルプの単体テスト。業務の説明の自動生成、記事の読み込み、役割による出し分け、検索を確かめる。
 *
 * @see 仕様書 第6.10節 ヘルプと案内
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import {
  OFFICIAL_AGENTS, ToolRegistry, BUILTIN_TOOLS, HelpCatalog, buildAgentHelp, parseArticle,
  resolveOfficialAgent, type HelpContext,
} from '../src/index.js';
import { DEFAULT_TENANT_SETTINGS } from '@m2office/shared';

const registry = new ToolRegistry();
for (const t of BUILTIN_TOOLS) registry.register(t);
const help = (id: string, writeInternalNeedsApproval = true) =>
  buildAgentHelp(resolveOfficialAgent(id, 1)!, registry, { writeInternalNeedsApproval });

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
  assert.ok(h.safeguards.some((d) => d.includes('送ることはありません')));
  assert.ok(h.safeguards.some((d) => d.includes('指示には従いません')), 'メール本文の指示に従わない');
  assert.deepEqual(h.approvals, []);
});

test('議事録の説明は、送る前に承認を求めることと承認者を書く', () => {
  const h = help('minutes');
  assert.ok(h.safeguards.some((d) => d.startsWith('送る前に、必ず承認を求めます')));
  assert.deepEqual(h.approvals.map((a) => a.step), ['内容の承認', '共有の承認']);
  assert.ok(h.approvals.every((a) => a.who.includes('管理者')));
  assert.deepEqual(h.flow, ['取得', '作成', '内容の承認', '起票', '共有の承認', '共有']);
});

test('承認が 2 回あっても、同じ役割を繰り返して書かない', () => {
  const h = help('minutes');
  assert.ok(h.safeguards.includes('送る前に、必ず承認を求めます（管理者・承認者）'), h.safeguards.join(' / '));
});

test('日程調整の承認者は「依頼したあなた」と書く（approver: requester）', () => {
  assert.deepEqual(help('scheduling').approvals, [{ step: '承認', who: '依頼したあなた' }]);
});

test('社内への書き込みの確認は、会社の設定に合わせて書き分ける', () => {
  assert.ok(help('minutes', true).safeguards.some((d) => d.includes('確認を求めます')));
  assert.ok(help('minutes', false).safeguards.some((d) => d.includes('確認なしで')));
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
