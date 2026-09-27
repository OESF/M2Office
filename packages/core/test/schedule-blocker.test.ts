/**
 * @file 定時実行が次の回に動かない理由の判定（起動役と管理者の一覧で共有する）の単体テスト。
 *
 * @see 仕様書 第6.6.8.2節 定時実行の一覧
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { AgentDefinition, User } from '@m2office/shared';
import { DEFAULT_TENANT_SETTINGS } from '@m2office/shared';
import { scheduleBlocker, type Repository, type ScheduleChecks } from '../src/index.js';

const def = { id: 'daily', version: 1, name: '毎日の業務', tools: ['slack.slack_search_public'], compartment: undefined } as unknown as AgentDefinition;
const schedule = { tenantId: 't', userId: 'u1', agentId: 'daily', agentVersion: 1 };

/** 判定に要るものを、上書きしたいところだけ変えて作る。 */
function checks(over: {
  user?: Partial<User> | null; disabled?: string[]; tool?: string | null; connection?: string | null;
  google?: boolean; available?: boolean; resolve?: AgentDefinition | undefined;
} = {}): ScheduleChecks {
  const settings = structuredClone(DEFAULT_TENANT_SETTINGS);
  settings.agents.disabled = over.disabled ?? [];
  const repo = {
    findUserById: async () => (over.user === null ? null : { id: 'u1', status: 'active', ...over.user }),
    getTenantSettings: async () => settings,
    listUserGroupIds: async () => [],
    listUserCompartments: async () => [],
  } as unknown as Repository;
  return {
    repo,
    resolveDefinition: () => ('resolve' in over ? over.resolve : def),
    isAvailable: async () => over.available ?? true,
    disabledToolOf: async () => over.tool ?? null,
    missingGoogleConnection: async () => over.google ?? false,
    missingConnection: async () => over.connection ?? null,
  };
}

test('何も妨げが無ければ動く', async () => {
  const r = await scheduleBlocker(checks(), schedule);
  assert.equal(r.def?.id, 'daily');
  assert.equal(r.block, null);
});

test('理由ごとに種類と、画面の言葉を返す', async () => {
  const cases: [Parameters<typeof checks>[0], string, RegExp][] = [
    [{ resolve: undefined }, 'definition', /定義が見つかりません/],
    [{ user: { status: 'suspended' } as Partial<User> }, 'user', /利用できません/],
    [{ user: null }, 'user', /利用できません/],
    [{ disabled: ['daily'] }, 'agent-disabled', /無効/],
    [{ tool: 'slack.slack_send_message' }, 'tool-disabled', /ツール（slack\.slack_send_message）/],
    [{ available: false }, 'not-installed', /導入されていません/],
    [{ google: true }, 'google', /Google と接続していません/],
    [{ connection: 'Slack' }, 'connection', /「Slack」と接続していません/],
  ];
  for (const [over, kind, label] of cases) {
    const { block } = await scheduleBlocker(checks(over), schedule);
    assert.equal(block?.kind, kind, kind);
    assert.match(block!.label, label, kind);
  }
});

test('監査に残す理由は種類ごとに決まった文で、名前は別に持つ', async () => {
  const { block } = await scheduleBlocker(checks({ connection: 'Slack' }), schedule);
  assert.equal(block?.reason, '対象者が業務の使うサービスと接続していません');
  assert.equal(block?.connection, 'Slack');
  const t = await scheduleBlocker(checks({ tool: 'x.y' }), schedule);
  assert.equal(t.block?.reason, '管理者がこの業務の使うツールを止めています');
  assert.equal(t.block?.tool, 'x.y');
});

test('止めたツールは拡張機能の未導入より先に見る（起動役のこれまでの順）', async () => {
  const { block } = await scheduleBlocker(checks({ tool: 'x.y', available: false }), schedule);
  assert.equal(block?.kind, 'tool-disabled');
});
