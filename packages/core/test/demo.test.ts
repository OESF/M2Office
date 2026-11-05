/**
 * @file 体験版（仕様書 第23.3.2節、ADR-0115）の単体テスト。
 * 体験用の会社の見分け方・入口の名前・ゲスト ID とパスワードの形・止める操作・データベースが断った理由の読み方・
 * 体験を出す入力の確かめと案内の文・見本の会社のデータの入れ方・AI の期間を通した上限・見本の接続口への振り分け。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Notification } from '@m2office/shared';
import {
  AiUsageMeter, AI_LIMIT_TRIAL_MESSAGE, buildConnector, checkNewDemo, demoBlocked, demoRestrictionOf, demoSubdomain, demoWelcomeText,
  isDemoTenantId, isGuestLoginId, newGuestLoginId, newGuestPassword, seedDemoCompany, DEMO_CARDS, DEMO_COMPANY_NAME, DEMO_ITEMS, DEMO_QUOTES, DEMO_RULES,
  demoOfficialPackages, loadExtensions, BUILTIN_EXTENSIONS, BUILTIN_TOOLS, OFFICIAL_AGENTS, ToolRegistry,
  type AiUsageEntry, type AiUsageStore, type DemoSeedDeps, type ExtensionPackage,
} from '../src/index.js';
import { DEFAULT_TENANT_SETTINGS } from '@m2office/shared';

test('体験用の会社は ID が d- で始まる', () => {
  assert.equal(isDemoTenantId('d-abc123'), true);
  assert.equal(isDemoTenantId('t-alpha'), false);
  assert.equal(isDemoTenantId('demo'), false);
});

test('入口の名前は DEMO_SUBDOMAIN。形が違えば使わない', () => {
  assert.equal(demoSubdomain({ DEMO_SUBDOMAIN: 'demo' }), 'demo');
  assert.equal(demoSubdomain({ DEMO_SUBDOMAIN: ' Trial ' }), 'trial');
  assert.equal(demoSubdomain({}), null);
  assert.equal(demoSubdomain({ DEMO_SUBDOMAIN: 'a.b' }), null);
  assert.equal(demoSubdomain({ DEMO_SUBDOMAIN: '-x-' }), null);
});

test('ゲスト ID は guest- と英数字 6 文字、パスワードは英数字 16 文字', () => {
  const ids = new Set<string>();
  for (let i = 0; i < 200; i++) {
    const id = newGuestLoginId();
    assert.ok(isGuestLoginId(id), id);
    assert.doesNotMatch(id.slice(6), /[lo01]/);
    ids.add(id);
    const pw = newGuestPassword();
    assert.match(pw, /^[A-Za-z2-9]{16}$/);
    assert.doesNotMatch(pw, /[IlO01]/);
  }
  assert.ok(ids.size > 190, 'ほとんど重ならない');
  assert.equal(isGuestLoginId('guest-ABCDEF'), false);
  assert.equal(isGuestLoginId('guest-abc'), false);
});

test('体験版で止める操作（会社の接続・本人の接続・拡張機能の取り込み・外部のアプリ・代理アクセス）。閲覧は止めない', () => {
  for (const [m, p] of [
    ['POST', '/v1/admin/connections/mcp'], ['PUT', '/v1/admin/connections/gemini'], ['POST', '/v1/me/google/connect'],
    ['POST', '/v1/me/connections/x/connect'], ['POST', '/v1/me/canva/connect'], ['POST', '/v1/admin/extensions/import'],
    ['POST', '/v1/admin/apps'], ['POST', '/v1/admin/support/requests'],
  ] as const) assert.equal(demoBlocked(m, p), true, `${m} ${p}`);
  for (const [m, p] of [
    ['GET', '/v1/admin/connections'], ['POST', '/v1/secretary/ask'], ['POST', '/v1/admin/extensions/x/install'], ['PUT', '/v1/admin/settings/company'],
  ] as const) assert.equal(demoBlocked(m, p), false, `${m} ${p}`);
});

test('データベースの仕掛けが断った理由を読む', () => {
  assert.equal(demoRestrictionOf(new Error('demo_restricted:users')), 'users');
  assert.equal(demoRestrictionOf(new Error('ERROR: demo_restricted:storage')), 'storage');
  assert.equal(demoRestrictionOf(new Error('demo_restricted:connection')), 'connection');
  assert.equal(demoRestrictionOf(new Error('duplicate key')), null);
  assert.equal(demoRestrictionOf('demo_restricted:users'), null);
});

test('体験を出す入力: 会社名は要る。日数と AI の上限は省けば既定', () => {
  const d = { days: 14, aiCapJpy: 1000 };
  const ok = checkNewDemo({ company: ' 株式会社見本 ', contact: '山田', email: 'Taro@Example.co.jp' }, d);
  assert.deepEqual(ok, { ok: true, value: { company: '株式会社見本', contact: '山田', email: 'taro@example.co.jp', days: 14, aiCapJpy: 1000 } });
  assert.equal(checkNewDemo({ company: '' }, d).ok, false);
  assert.equal(checkNewDemo({ company: 'x', email: 'no-at' }, d).ok, false);
  assert.equal(checkNewDemo({ company: 'x', days: 0 }, d).ok, false);
  assert.equal(checkNewDemo({ company: 'x', days: 61 }, d).ok, false);
  assert.equal(checkNewDemo({ company: 'x', days: 1.5 }, d).ok, false);
  assert.equal(checkNewDemo({ company: 'x', aiCapJpy: 0 }, d).ok, false);
  assert.deepEqual(checkNewDemo({ company: 'x', days: '7', aiCapJpy: '500' }, d), { ok: true, value: { company: 'x', contact: '', email: '', days: 7, aiCapJpy: 500 } });
});

test('案内の文に入口・ID・パスワード・日本時間の期限が入る', () => {
  const t = demoWelcomeText({ company: '株式会社見本', contact: '山田', url: 'https://demo.m2office.net/', loginId: 'guest-abc234', password: 'Pw', expiresAt: '2026-11-12T03:00:00Z' });
  assert.match(t, /株式会社見本 山田 様/);
  assert.match(t, /https:\/\/demo\.m2office\.net\//);
  assert.match(t, /guest-abc234/);
  assert.match(t, /パスワード: Pw/);
  assert.match(t, /2026 年 11 月 12 日 12:00（日本時間）/);
  assert.match(demoWelcomeText({ company: 'A', contact: '', url: 'u', loginId: 'g', password: 'p', expiresAt: '2026-11-12T03:00:00Z' }), /^A ご担当者様/);
});

test('見本の会社のデータは実在の名前を使わず、アドレスは .example', () => {
  assert.match(DEMO_COMPANY_NAME, /見本/);
  for (const row of DEMO_CARDS.slice(1)) {
    assert.match(row[1]!, /見本/);
    assert.match(row[5]!, /\.example(\.jp)?$/);
  }
  assert.ok(DEMO_RULES.length >= 3);
});

test('見本の会社のデータを入れる。1 つの業務の失敗で止めない', async () => {
  const saved: string[] = [];
  const rules: string[] = [];
  let cards = 0;
  const items: string[] = [];
  const quotes: string[] = [];
  const enabled: string[] = [];
  const installed: string[] = [];
  const pkg = (id: string, connectors = 0) => ({ manifest: { id }, connectors: Array.from({ length: connectors }, () => ({})) }) as unknown as ExtensionPackage;
  const deps: DemoSeedDeps = {
    settings: async () => ({ company: DEFAULT_TENANT_SETTINGS.company, onboarding: DEFAULT_TENANT_SETTINGS.onboarding }),
    saveSettings: async (_t: string, section: string, value: unknown) => {
      saved.push(section);
      if (section === 'company') assert.equal((value as { legalName: string }).legalName, DEMO_COMPANY_NAME);
      if (section === 'onboarding') assert.ok((value as { agentsReviewedAt: string | null }).agentsReviewedAt);
    },
    enableBuiltin: async (_t, _u, section) => {
      // 在庫の品目・見積は、拡張機能を入れた後に入れる
      assert.equal(items.length + quotes.length, 0);
      if (section === 'signage') throw new Error('x');
      enabled.push(section);
    },
    officialPackages: () => [pkg('jp.example.a'), pkg('jp.example.with-connector', 1), pkg('jp.example.b')],
    installOfficial: async (_t, _u, p) => { installed.push(p.manifest.id); },
    saveRule: async (_t, _u, r) => { rules.push(r.title); },
    importCards: async (_t, _u, rows) => { cards = rows.length - 1; },
    createItem: async (_t, _u, i) => { if (i.sku === 'GRS-500') throw new Error('x'); items.push(i.sku); },
    createQuote: async (_t, _u, q) => { quotes.push(q.to); },
  };
  const r = await seedDemoCompany(deps, 'd-x', 'u-g');
  assert.deepEqual(saved.sort(), ['company', 'onboarding']);
  // 内蔵の拡張機能はすべて入れる（第23.3.2節「拡張機能」）
  assert.deepEqual(enabled, BUILTIN_EXTENSIONS.map((b) => b.section).filter((s) => s !== 'signage'));
  // 公式の拡張機能は、同梱の接続を持つものを除いて導入する
  assert.deepEqual(installed, ['jp.example.a', 'jp.example.b']);
  assert.equal(rules.length, DEMO_RULES.length);
  assert.equal(cards, DEMO_CARDS.length - 1);
  assert.equal(items.length, DEMO_ITEMS.length - 1);
  assert.equal(quotes.length, DEMO_QUOTES.length);
  assert.deepEqual(r.failed, ['extension:signage', 'inventory-items']);
});

test('体験版に導入する公式の拡張機能は、同梱の接続を持たないもの（DeepWiki の調べものは除く）', () => {
  const official = loadExtensions(new URL('../../../extensions', import.meta.url).pathname, new ToolRegistry(BUILTIN_TOOLS), OFFICIAL_AGENTS.map((a) => a.id)).packages;
  const chosen = demoOfficialPackages(official).map((p) => p.manifest.id);
  assert.ok(chosen.length > 0 && chosen.length < official.length);
  for (const p of official) assert.equal(chosen.includes(p.manifest.id), p.connectors.length === 0, p.manifest.id);
});

function memoryStore() {
  const rows: (AiUsageEntry & { at: Date })[] = [];
  const alerts = new Set<string>();
  let clock = new Date('2026-10-30T03:00:00Z');
  const store: AiUsageStore = {
    insert: async (_t, e) => { rows.push({ ...e, at: clock }); },
    totals: async (_t, since) => {
      const xs = rows.filter((r) => r.at >= since);
      return { costJpy: xs.reduce((a, r) => a + r.costJpy, 0), calls: xs.length, byUser: [], byPurpose: [] };
    },
    daily: async () => [],
    markAlert: async (_t, month, level, userId) => { const k = `${month}/${level}/${userId}`; if (alerts.has(k)) return false; alerts.add(k); return true; },
    prune: async () => 0,
  };
  return { store, setClock: (d: Date) => { clock = d; }, now: () => clock };
}

const entry = (costJpy: number): AiUsageEntry => ({
  userId: 'u-g', purpose: 'secretary', model: 'gemini-3.1-flash-lite', inputTokens: 1, outputTokens: 1, units: 0, costJpy, local: false, runId: null,
});

test('体験版の AI の上限は期間を通して数え、月をまたいでも戻らない。8 割と 10 割で 1 度だけ知らせる', async () => {
  const mem = memoryStore();
  const sent: Notification[] = [];
  const since = new Date('2026-10-29T00:00:00Z');
  const meter = new AiUsageMeter({
    store: mem.store, platformCap: null, now: mem.now,
    limits: { limits: async () => ({ monthlyJpy: null, perUserShare: 1 }), source: async () => 'platform' },
    notify: async (n) => { sent.push(n); },
    admins: async () => ['u-g'],
    trial: async (t) => (t.startsWith('d-') ? { capJpy: 1000, since } : null),
  });
  await meter.record('d-x', entry(500));
  assert.equal((await meter.check('d-x')).blocked, null);
  await meter.record('d-x', entry(350));
  assert.equal(sent.length, 1);
  assert.match(sent[0]!.title, /8 割/);
  // 月をまたぐ（10 月の分も数え続ける）
  mem.setClock(new Date('2026-11-02T03:00:00Z'));
  await meter.record('d-x', entry(200));
  const r = await meter.check('d-x');
  assert.ok(r.blocked);
  assert.equal(r.blocked.message, AI_LIMIT_TRIAL_MESSAGE);
  assert.equal(r.blocked.scope, 'trial');
  assert.equal(sent.length, 2);
  assert.match(sent[1]!.title, /上限に達しました/);
  await meter.record('d-x', entry(10));
  assert.equal(sent.length, 2, '知らせは 1 度だけ');
  // 体験でない会社は、体験の上限を見ない
  await meter.record('t-a', entry(5000));
  assert.equal((await meter.check('t-a')).blocked, null);
});

test('体験用の会社は、本番でも見本の接続口に振り分ける', () => {
  const repo = {} as never;
  const box = { encrypt: (v: string) => v, decrypt: (v: string) => v } as never;
  const c = buildConnector('google', { repo, box, production: true, alwaysMock: isDemoTenantId });
  assert.equal(c.sourceFor('d-abc'), 'mock');
  assert.equal(c.sourceFor('t-alpha'), 'google');
  assert.throws(() => buildConnector('google', { repo, box, production: true, mockTenants: ['t-a'], alwaysMock: isDemoTenantId }), /開発だけ/);
});
