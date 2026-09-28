/**
 * @file 会社の接続（コネクタ。MCP）の単体テスト（仕様書 第12.11.0節、ADR-0037）。
 *
 * コネクタは拡張機能の一部ではなく、会社の資源として管理する。秘書・公式の業務・拡張機能のどれからでも使い、
 * 会社に接続が無い道具を使う業務は使えないこと、SKILL.md の組み立てで同梱していない接続の道具を扱えることを確かめる。
 */

import { DEFAULT_TENANT_SETTINGS } from '@m2office/shared';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  BUILTIN_TOOLS, ExtensionHub, OFFICIAL_AGENTS, ToolRegistry, consentSnapshot, isConnectionToolName, loadExtensionFiles,
  type InstalledExtension, type Repository, type TenantConnection,
} from '../src/index.js';

const registry = new ToolRegistry();
for (const t of BUILTIN_TOOLS) registry.register(t);
const enc = (v: string) => new TextEncoder().encode(v);

/** freee の見積もりを探す業務（同梱していない会社の接続「freee」の道具を使う）。 */
const SKILL = [
  '---', 'name: deals', 'description: freee の商談を探して要点をまとめる',
  'allowed-tools: freee.list_deals freee.create_invoice knowledge.search',
  'metadata:', '  m2office-id: jp.example.freee-deals', '---', '', '# 商談の要点', '', '$ARGUMENTS の商談を探して要点をまとめる。', '',
].join('\n');

const freee = (tenantId: string, risk: 'read' | 'external-send' = 'read'): TenantConnection => ({
  tenantId, id: 'freee', name: 'freee', description: '', transport: 'http', url: 'https://mcp.freee.example/mcp', auth: { type: 'none' },
  tools: [
    { name: 'list_deals', description: '商談を探す', risk: 'read' },
    { name: 'create_invoice', description: '請求書を作る', risk },
  ],
  origin: 'manual', createdBy: 'u', createdAt: '', updatedAt: '',
});

test('SKILL.md の同梱していない接続の道具は、会社の接続の道具として組み立てる（作業の段と送る段の両方に置く）', () => {
  const { pkg, problems, notices } = loadExtensionFiles(new Map([['SKILL.md', enc(SKILL)]]), registry);
  assert.deepEqual(problems, []);
  const def = pkg!.agents[0]!;
  assert.deepEqual(pkg!.manifest.permissions.connections, ['freee.list_deals', 'freee.create_invoice']);
  // 危険度が分からない会社の接続の道具は送る道具として数え、同意の画面に「読むだけ」と出さない（第12.11.2節）
  assert.equal(pkg!.manifest.permissions.max_risk_level, 'external-send');
  const [work, gate, send] = def.steps;
  assert.ok(work?.type === 'agent' && work.tools?.includes('freee.list_deals') && work.tools.includes('knowledge.search'), '読むだけなら作業の段で使える');
  assert.equal(gate?.type, 'approval', '危険度が分からないため、承認の段を入れる（社外に出なければ自動で通る）');
  assert.ok(send?.type === 'agent' && send.tools?.includes('freee.create_invoice') && !send.required, '送る・書き込む道具は承認の後の段でも使える');
  assert.ok((notices ?? []).some((n) => n.includes('会社の接続（freee）')), (notices ?? []).join('\n'));
  assert.equal(isConnectionToolName('gmail.send', new Set(['gmail'])), false, '内蔵の道具は接続の道具ではない');
});

function world() {
  const installed: InstalledExtension[] = [];
  const connections: TenantConnection[] = [];
  const repo = {
    listInstalledExtensions: async (t: string) => installed.filter((i) => i.tenantId === t),
    listDisabledConnectorTools: async () => [],
    // 名刺管理（内蔵の拡張）の入り切りを読む（第12.13節）
    getTenantSettings: async () => DEFAULT_TENANT_SETTINGS,
    listPrivateExtensions: async () => [],
    listConnections: async (t: string) => connections.filter((c) => c.tenantId === t),
    saveConnection: async (c: TenantConnection) => { connections.push(c); },
  } as unknown as Repository;
  const { pkg } = loadExtensionFiles(new Map([['SKILL.md', enc(SKILL)]]), registry);
  const hub = new ExtensionHub({ repo, registry, official: OFFICIAL_AGENTS, packages: [pkg!] });
  installed.push({
    tenantId: 'a', extensionId: 'jp.example.freee-deals', version: '1.0.0', consentedPermissions: consentSnapshot(pkg!),
    installedBy: 'u', installedAt: '', enabled: true,
  });
  return { hub, connections };
}

test('会社に接続が無い道具を使う業務は使えず、接続を登録すると使える。危険度は会社の接続のもの', async () => {
  const { hub, connections } = world();
  const id = 'jp.example.freee-deals:deals';
  let view = await hub.forTenant('a');
  assert.equal(view.isAvailable(id), false, '接続が無ければ使えない（接続が要ります）');
  assert.deepEqual(view.missingToolsOf(view.resolve(id, 1)!), ['freee.list_deals', 'freee.create_invoice']);
  connections.push(freee('a', 'external-send'));
  view = await hub.forTenant('a');
  assert.equal(view.isAvailable(id), true);
  assert.equal(view.registry.get('freee.create_invoice')?.risk, 'external-send', '実行のときは会社が決めた危険度');
  assert.equal((await hub.forTenant('b')).registry.get('freee.list_deals'), undefined, 'ほかの会社には無い');
});

test('秘書の調べものは、会社の接続の読むだけの道具を使える（書き込みの道具は使わない）', async () => {
  const { hub, connections } = world();
  connections.push(freee('a', 'external-send'));
  const view = await hub.forTenant('a');
  const lookup = view.agents.find((a) => a.id === 'secretary-lookup')!;
  assert.ok(lookup.tools.includes('freee.list_deals'));
  assert.ok(!lookup.tools.includes('freee.create_invoice'));
  assert.ok(view.resolve('secretary-lookup', 1)!.tools.includes('freee.list_deals'), '実行のときの定義にも入る');
  assert.ok(!OFFICIAL_AGENTS.find((a) => a.id === 'secretary-lookup')!.tools.includes('freee.list_deals'), '公式の定義そのものは変えない');
});
