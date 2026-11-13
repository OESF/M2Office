/**
 * @file サイトの更新の段 3（仕様書 第45.18.5節）の試験。プラグイン・テーマ・本体の版を WordPress.org と比べ、サイトヘルスの注意を読み、
 * 週に 1 回、前と違う問題だけを管理者に知らせる。WordPress.org にはサイトの名前や URL を渡さない。
 */

import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_TENANT_SETTINGS, type TenantSettings } from '@m2office/shared';
import { SiteUpdateService, MemorySiteEditStore, MemoryWordPressUserStore, newerVersion, readSiteHealth, healthProblems, type LlmProvider, type Repository } from '../src/index.js';

const SITE = 'https://www.example.jp';

test('版を比べる: 数のところを左から比べる', () => {
  assert.equal(newerVersion('6.10', '6.9.2'), true);
  assert.equal(newerVersion('5.3', '5.3'), false);
  assert.equal(newerVersion('5.3', '5.3.1'), false);
  assert.equal(newerVersion('2.0.0', '1.9'), true);
});

function fakeWp(t: TestContext, state = { akismet: '5.3', health: 'critical' }) {
  const org: string[] = [];
  t.mock.method(globalThis, 'fetch', async (input: string | URL) => {
    const u = new URL(String(input));
    if (u.host === 'api.wordpress.org') {
      org.push(String(input));
      if (u.pathname.startsWith('/plugins/info')) {
        const slug = u.searchParams.get('request[slug]');
        return Response.json(slug === 'akismet' ? { version: state.akismet } : { error: 'Plugin not found.' });
      }
      if (u.pathname.startsWith('/themes/info')) return Response.json({ version: '1.4' });
      if (u.pathname.startsWith('/core/version-check')) return Response.json({ offers: [{ version: '6.8.1' }] });
      return new Response('', { status: 404 });
    }
    const p = u.pathname;
    if (p === '/wp-json/wp/v2/plugins') return Response.json([
      { plugin: 'akismet/akismet', name: 'Akismet', version: '5.0', status: 'active', auto_update: false },
      { plugin: 'paid-forms/paid-forms', name: '有料のフォーム', version: '2.1', status: 'inactive', auto_update: false },
    ]);
    if (p === '/wp-json/wp/v2/themes') return Response.json([{ stylesheet: 'twentytwentyfour', name: { raw: 'Twenty Twenty-Four' }, version: '1.2', status: 'active' }]);
    if (p === '/') return new Response('<html><head><meta name="generator" content="WordPress 6.7.1" /></head></html>');
    if (p === '/wp-json/wp-site-health/v1/tests/https-status') return Response.json({ label: 'サイトが HTTPS を使っていません', status: state.health });
    if (p.startsWith('/wp-json/wp-site-health/v1/tests/')) return Response.json({ label: 'よい', status: 'good' });
    return new Response('', { status: 404 });
  });
  return { org };
}

test('状態: プラグイン・テーマ・本体の新しい版とサイトヘルスの注意を読む。WordPress.org に無いものは分からないとし、サイトの URL は渡さない', async (t) => {
  const { org } = fakeWp(t);
  const h = await readSiteHealth({ siteUrl: SITE, username: 'admin', password: 'x' });
  assert.ok(!('error' in h));
  assert.deepEqual(h.plugins.map((p) => [p.name, p.version, p.latest, p.active, p.needsUpdate]), [['Akismet', '5.0', '5.3', true, true], ['有料のフォーム', '2.1', null, false, false]]);
  assert.deepEqual(h.themes.map((x) => [x.name, x.needsUpdate]), [['Twenty Twenty-Four', true]]);
  assert.deepEqual(h.core, { version: '6.7.1', latest: '6.8.1', needsUpdate: true });
  assert.deepEqual(h.checks, [{ label: 'サイトが HTTPS を使っていません', status: 'critical' }]);
  assert.ok(org.length > 0 && org.every((x) => !x.includes('example.jp')), 'WordPress.org にサイトの名前や URL を渡さない');
  assert.deepEqual(healthProblems(h), [
    'WordPress 本体 6.7.1 → 6.8.1', 'プラグイン「Akismet」5.0 → 5.3', 'テーマ「Twenty Twenty-Four」1.2 → 1.4（使っている）', 'サイトヘルスの重い注意: サイトが HTTPS を使っていません',
  ]);
});

test('見回り: 週に 1 回、前と違う問題があるときだけ有効な管理者に知らせる', async (t) => {
  const state = { akismet: '5.3', health: 'critical' };
  fakeWp(t, state);
  const settings: TenantSettings = { ...DEFAULT_TENANT_SETTINGS, siteUpdates: { enabled: true, adminApproval: false }, webColumns: { ...DEFAULT_TENANT_SETTINGS.webColumns, wordpress: { siteUrl: SITE, username: 'admin' } } };
  const notes: { userId: string; title: string; body: string }[] = [];
  const repo = {
    getTenantSettings: async () => settings,
    getTenantCredential: async () => ({ tenantId: 't1', kind: 'wordpress', secretEnc: 'enc:x', meta: {}, updatedBy: 'b', updatedAt: '' }),
    listUsers: async () => [{ id: 'boss', roles: ['admin'], status: 'active' }, { id: 'staff', roles: ['member'], status: 'active' }],
    createNotification: async (n: { userId: string; title: string; body: string }) => { notes.push(n); },
  } as unknown as Repository;
  let now = new Date('2026-11-16T00:00:00Z');
  const service = new SiteUpdateService({
    store: new MemorySiteEditStore(), users: new MemoryWordPressUserStore(), repo, box: { encrypt: (v: string) => v, decrypt: (v: string) => v.slice(4) } as never,
    llmFor: async () => ({ name: 'fake' }) as LlmProvider, now: () => now,
  });
  assert.equal(await service.watchHealth('t1'), 4);
  assert.deepEqual(notes.map((n) => [n.userId, n.title]), [['boss', 'サイトに更新が要るものが 4 件あります']]);
  assert.ok(notes[0]!.body.includes('- プラグイン「Akismet」5.0 → 5.3') && notes[0]!.body.includes('M2Office は読むだけです'));
  now = new Date('2026-11-17T00:00:00Z');
  assert.equal(await service.watchHealth('t1'), 0, '週に 1 回');
  now = new Date('2026-11-23T01:00:00Z');
  assert.equal(await service.watchHealth('t1'), 0, '前と同じ問題は知らせない');
  state.akismet = '5.4';
  now = new Date('2026-11-30T02:00:00Z');
  assert.equal(await service.watchHealth('t1'), 4, '問題が変われば知らせる');
  assert.equal(notes.length, 2);
});
