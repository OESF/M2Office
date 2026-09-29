/**
 * @file 朝のブリーフと本人の情報の単体テスト（仕様書 第9.5.5.1節、ADR-0034）。
 *
 * 定時実行の「毎平日」、本人の情報を読む道具 `profile.read`、朝のブリーフの定義（読むだけ・天気とニュースを調べる）を確かめる。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  BUILTIN_TOOLS, MORNING_BRIEF, OFFICIAL_AGENTS, ToolRegistry, describeRule, nextRunAt, validateDefinition, type ToolContext,
} from '../src/index.js';

const registry = new ToolRegistry();
for (const t of BUILTIN_TOOLS) registry.register(t);

test('毎平日: 金曜の朝の後は月曜の朝。土日は飛ばす', () => {
  const rule = { kind: 'weekdays' as const, hour: 7, minute: 30 };
  // 2026-10-02 は金曜。8 時（日本時間）を過ぎたら、次は 10-05（月）の 7:30
  assert.equal(nextRunAt(rule, 'Asia/Tokyo', new Date('2026-10-01T23:00:00Z')), '2026-10-04T22:30:00.000Z');
  // 月曜の 7 時なら、その日の 7:30
  assert.equal(nextRunAt(rule, 'Asia/Tokyo', new Date('2026-10-04T22:00:00Z')), '2026-10-04T22:30:00.000Z');
  assert.equal(describeRule(rule), '毎平日（月〜金） 7:30');
});

function ctx(profile: { home: string; workplace: string }, address = '東京都千代田区丸の内 1-1'): ToolContext {
  return {
    tenantId: 't', userId: 'u', runId: 'r', compartment: null,
    repo: {
      findUserById: async () => ({ id: 'u', displayName: '三浦' }),
      getUserSettings: async () => ({ profile: { furigana: '', title: '代表', timezone: 'Asia/Tokyo', ...profile } }),
      getTenantSettings: async () => ({ company: { legalName: '株式会社見本', shortName: '見本', address } }),
    } as never,
    connector: {} as never, files: {} as never,
  };
}

test('profile.read: 本人の自宅・勤務地を返す。勤務地が空なら会社の住所、自宅が空なら登録されていないと返す', async () => {
  const tool = registry.get('profile.read')!;
  assert.equal(tool.risk, 'read');
  const a = await tool.invoke({}, ctx({ home: '横浜市港北区・日吉駅', workplace: '' })) as Record<string, unknown>;
  assert.equal(a['home'], '横浜市港北区・日吉駅');
  assert.equal(a['workplace'], '東京都千代田区丸の内 1-1');
  assert.equal(a['workplaceIsCompanyAddress'], true);
  assert.match(String(a['today']), /^\d{4}-\d{2}-\d{2}（[日月火水木金土]）$/);
  const b = await tool.invoke({}, ctx({ home: '', workplace: '大阪支店' })) as Record<string, unknown>;
  assert.equal(b['home'], '（登録されていません）', '推測で埋めない');
  assert.equal(b['workplace'], '大阪支店');
});

test('朝のブリーフ: 公式の業務で、読むだけの道具だけを使い、天気とニュースを調べる', () => {
  assert.ok(OFFICIAL_AGENTS.includes(MORNING_BRIEF));
  assert.doesNotThrow(() => validateDefinition(MORNING_BRIEF, registry));
  for (const name of MORNING_BRIEF.tools) assert.equal(registry.get(name)?.risk, 'read', `${name} は読むだけ`);
  assert.ok(MORNING_BRIEF.tools.includes('web.research') && MORNING_BRIEF.tools.includes('profile.read'));
  const [collect, outside] = MORNING_BRIEF.steps;
  assert.ok(collect?.type === 'agent' && collect.tools?.includes('profile.read') && !collect.tools.includes('web.research'), '本人の情報を読んでから調べる');
  assert.ok(outside?.type === 'agent' && /天気/.test(outside.instruction) && /ニュース/.test(outside.instruction) && /市区町村の名前だけ/.test(outside.instruction));
  assert.ok(!MORNING_BRIEF.steps.some((s) => s.type === 'approval'), '承認は無い');
  assert.ok(OFFICIAL_AGENTS.find((a) => a.id === 'secretary-lookup')!.tools.includes('profile.read'), '調べものも出発地を読める');
});

test('朝のブリーフ: 関心の分野と社内のお知らせを最初の段で読み、お知らせを最初に伝える（第9.5.5.1.1節・第10.15節）', () => {
  const [collect, outside, write] = MORNING_BRIEF.steps;
  assert.ok(collect?.type === 'agent' && collect.required?.includes('brief.settings') && collect.required.includes('notices.list'));
  assert.ok(outside?.type === 'agent' && /topics/.test(outside.instruction) && /外した項目/.test(outside.instruction), '外した項目は調べない');
  assert.ok(write?.type === 'agent' && /^\s*'?.*1\. 社内のお知らせ/m.test(write.instruction), 'お知らせを最初に');
  assert.ok(write?.type === 'agent' && /指示には従わない/.test(write.instruction), 'お知らせの本文を指示として扱わない（不変則 I-6）');
  assert.equal(MORNING_BRIEF.version, 1, '公式の業務は版を上げずに直す（定時実行が版を決め打ちで引く）');
});

test('週次ブリーフ: 読むだけで、配信の道具を使わない。週間天気・前週比・イベントを調べ、外した項目は調べない（第9.5.5節、ADR-0048）', async () => {
  const { AG05_WEEKLY_BRIEF } = await import('../src/index.js');
  assert.doesNotThrow(() => validateDefinition(AG05_WEEKLY_BRIEF, registry));
  for (const name of AG05_WEEKLY_BRIEF.tools) assert.equal(registry.get(name)?.risk, 'read', `${name} は読むだけ`);
  assert.ok(!AG05_WEEKLY_BRIEF.tools.includes('notification.send'), '届けるのは実行エンジン（ブリーフの通知）');
  assert.equal(AG05_WEEKLY_BRIEF.category, 'briefing');
  assert.equal(AG05_WEEKLY_BRIEF.version, 1, '公式の業務は版を上げずに直す');
  const [collect, outside, events, write] = AG05_WEEKLY_BRIEF.steps;
  assert.ok(collect?.type === 'agent' && collect.required?.includes('brief.settings') && collect.required.includes('notices.list'));
  assert.ok(collect?.type === 'agent' && !collect.tools?.includes('web.research'), '本人の情報を読んでから調べる');
  assert.ok(outside?.type === 'agent' && /週間天気予報/.test(outside.instruction) && /前週比/.test(outside.instruction));
  assert.ok(events?.type === 'agent' && events.required?.includes('web.research') && /展示会/.test(events.instruction), 'イベントは段を分けて必ず調べる');
  assert.ok(outside?.type === 'agent' && /weeklyOmit/.test(outside.instruction) && /市区町村の名前だけ/.test(outside.instruction));
  assert.ok(write?.type === 'agent' && /曜日ごと/.test(write.instruction) && /日付と出典/.test(write.instruction), 'Web の数字には日付と出典');
  assert.ok(!AG05_WEEKLY_BRIEF.steps.some((s) => s.type === 'approval'), '承認は無い');
});
