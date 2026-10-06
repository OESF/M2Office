/**
 * @file ダッシュボードの「業務の状態」をまとめる仕事の分野の単体テスト（仕様書 第6.7.4.2.1節、ADR-0075）。
 * 内蔵の拡張と公式の業務の分野がすべてどれかの分野に入ること・1 つの分野にだけ入ること・1 つの囲みに詰め込みすぎないこと・
 * 取り込んだスキルを名前と説明から「調べもの」「資料の作成」に入れ、どちらでもなければまとめないこと。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AGENT_AREAS, AGENT_GROUP_LABELS, agentAreaOf } from '@m2office/shared';
import { BUILTIN_EXTENSIONS, OFFICIAL_AGENTS } from '../src/index.js';

test('分野: 内蔵の拡張と公式の業務の分野は、どれも 1 つの分野にだけ入る', () => {
  const exts = AGENT_AREAS.flatMap((a) => a.extensions);
  const cats = AGENT_AREAS.flatMap((a) => a.categories);
  assert.equal(new Set(exts).size, exts.length);
  assert.equal(new Set(cats).size, cats.length);
  // 内蔵の拡張を足したら、分野に入れ忘れないように
  for (const { pkg } of BUILTIN_EXTENSIONS) assert.ok(exts.includes(pkg.manifest.id), `${pkg.manifest.id} がどの分野にも入っていない`);
  for (const c of Object.keys(AGENT_GROUP_LABELS)) assert.ok(cats.includes(c), `分野 ${c} がどの分野にも入っていない`);
});

test('分野: 1 つの囲みに業務を詰め込みすぎない（内蔵の拡張と公式の業務で 6 業務まで）', () => {
  const count = new Map<string, number>();
  const add = (id: string | undefined) => { if (id) count.set(id, (count.get(id) ?? 0) + 1); };
  for (const { pkg } of BUILTIN_EXTENSIONS) for (const _ of pkg.agents) add(agentAreaOf('sample', pkg.manifest.id)?.id);
  for (const a of OFFICIAL_AGENTS) add(agentAreaOf(a.category, null)?.id);
  for (const [id, n] of count) assert.ok(n <= 6, `${id} に ${n} 業務`);
});

test('分野: 拡張機能はその ID で、公式の業務は分野で決まる。どこにも入らなければ null', () => {
  assert.deepEqual(agentAreaOf('sample', 'inquiries'), { id: 'area:customers', name: '問い合わせと会員' });
  assert.deepEqual(agentAreaOf('sample', 'print-designs'), { id: 'area:promotion', name: 'お知らせと販促' });
  assert.deepEqual(agentAreaOf('sample', 'jp.m2office.legal.contract-review'), { id: 'area:admin', name: '契約と総務' });
  assert.deepEqual(agentAreaOf('briefing', null), { id: 'area:briefing', name: 'ブリーフ' });
  assert.deepEqual(agentAreaOf('meeting', null), { id: 'area:schedule', name: '予定と会議' });
  assert.equal(agentAreaOf('sample', null), null);
  // 取り込んだスキル: 調べるものは「調べもの」、資料を作るものは「資料の作成」。名前を先に見る
  assert.equal(agentAreaOf('skill', 'jp.example.repo', { name: 'リポジトリ調査（DeepWiki）', description: 'リポジトリについて DeepWiki に質問し、答えを資料にまとめる' })?.id, 'area:research');
  assert.equal(agentAreaOf('skill', 'jp.example.evidence', { name: '専門の情報', description: '疑問を専門のサービスに尋ね、論文にもとづく答えを資料に残す' })?.id, 'area:research');
  assert.equal(agentAreaOf('skill', 'jp.example.slides', { name: 'スライドの作成（見本）', description: 'テーマを Web で調べ、スライドにまとめる' })?.id, 'area:documents');
  // どちらでもないスキルは、その拡張機能でまとめる（ADR-0061 のまま）
  assert.equal(agentAreaOf('skill', 'jp.example.hello', { name: 'あいさつ（サンプル）', description: '名前を受け取ってあいさつを返す' }), null);
  assert.equal(agentAreaOf('mail', 'jp.example.skill'), null);
});
