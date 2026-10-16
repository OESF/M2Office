/**
 * @file システムログの保管・閲覧・証拠保全の単体テスト（仕様書 第16.10節、ADR-0098）。
 *
 * ロガーからデータベースへ書く口（info から上・伏せ字の後・まとめて書く・書けなければ捨てる）、絞り方の読み取り、CSV、
 * 日ごとの値の鎖、証拠保全の ZIP（ファイルごとの SHA-256 と、会社の管理者への知らせ）を確かめる。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import JSZip from 'jszip';
import {
  attachLogSink, createLogger, SystemLogSink, logRow, parseLogFilter, logLinesCsv, chainOf, EvidenceBuilder, operatorCan,
  type EvidencePackage, type LogFields, type Repository, type SecurityStore, type SystemLogLine,
} from '../src/index.js';

test('ロガーの記録は、info から上だけを伏せ字の後でデータベースの口に渡す', () => {
  const got: LogFields[] = [];
  const detach = attachLogSink((r) => { got.push(r); });
  const log = createLogger({ service: 'api', level: 'debug', write: () => undefined });
  log.debug('細かい');
  log.info('要求', { tenantId: 't-a', password: 'secret', requestId: 'r1' });
  log.error('失敗');
  detach();
  log.info('外した後');
  assert.deepEqual(got.map((r) => r['msg']), ['要求', '失敗']);
  assert.equal(got[0]!['password'], '[伏せ字]');
  const row = logRow(got[0]!);
  assert.equal(row.tenant_id, 't-a');
  assert.equal(row.request_id, 'r1');
  assert.equal((row.fields as Record<string, unknown>)['password'], '[伏せ字]');
  assert.equal('tenantId' in row.fields, false, '列に分けた項目は fields に入れない');
});

test('まとめて書き、書けなければ捨ててアプリを止めない', async () => {
  const sent: unknown[][] = [];
  let fail = false;
  const sink = new SystemLogSink(async (_sql, params) => { if (fail) throw new Error('down'); sent.push(params); return []; }, () => 0);
  for (let i = 0; i < 3; i++) sink.accept({ time: new Date().toISOString(), level: 'info', service: 'api', msg: `m${i}` }, 'info');
  await sink.flush();
  assert.equal(sent.length, 1, '3 件を 1 回で書く');
  assert.equal((JSON.parse(String(sent[0]![0])) as unknown[]).length, 3);
  fail = true;
  const err = process.stderr.write;
  process.stderr.write = (() => true) as typeof process.stderr.write;
  try {
    sink.accept({ time: new Date().toISOString(), level: 'warn', service: 'api', msg: 'x' }, 'warn');
    await sink.flush();
  } finally {
    process.stderr.write = err;
  }
});

test('絞り方: 既定は直近 1 時間。上限の日数を超えたら縮め、知らないレベルは捨てる', () => {
  const now = new Date('2026-10-16T12:00:00Z');
  const f = parseLogFilter({}, { limit: 200, maxDays: 28, now });
  assert.equal(f.from, '2026-10-16T11:00:00.000Z');
  const wide = parseLogFilter({ from: '2026-01-01T00:00:00Z', to: now.toISOString(), levels: 'error,debug,warn', service: 'evil' }, { limit: 200, maxDays: 1, now });
  assert.equal(wide.from, '2026-10-15T12:00:00.000Z');
  assert.deepEqual(wide.levels, ['error', 'warn']);
  assert.equal(wide.service, null);
  assert.equal(parseLogFilter({ before: 'x', beforeId: '1' }, { limit: 1, maxDays: 1, now }).before, null);
});

test('CSV は式として読ませない', () => {
  const line: SystemLogLine = { id: '1', at: '2026-10-16T00:00:00Z', level: 'info', service: 'api', msg: '=HYPERLINK("x")', tenantId: null, userId: null, requestId: null, runId: null, fields: {} };
  assert.match(logLinesCsv([line]), /'=HYPERLINK/);
});

test('日ごとの値は前の日の値とつなげる（どこかを書き換えると後ろがすべて変わる）', () => {
  const a = chainOf(null, 'aaa');
  const b = chainOf(a, 'bbb');
  assert.equal(a, createHash('sha256').update('aaa').digest('hex'));
  assert.notEqual(chainOf(chainOf(null, 'AAA'), 'bbb'), b);
});

test('証拠保全: システムログ・監査ログ・不正の兆し・端末・機械のログを ZIP にし、ファイルごとの SHA-256 を残して管理者に知らせる', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'm2o-ev-'));
  await writeFile(join(dir, 'caddy.log'), '{"remote_ip":"203.0.113.9"}\n');
  await writeFile(join(dir, 'secret.txt'), 'x');
  const pkg: EvidencePackage = {
    id: 'ev-1', scope: 'machine', tenantId: 't-a', reason: '不審なログイン', createdKind: 'user', createdBy: 'u1',
    rangeFrom: '2026-10-01T00:00:00.000Z', rangeTo: '2026-10-16T00:00:00.000Z', status: 'building', size: null, sha256: null, failure: null, createdAt: '', readyAt: null, deletedAt: null,
  };
  let stored: { zip: Uint8Array; sha: string } | null = null;
  const notes: string[] = [];
  const builder = new EvidenceBuilder({
    store: {
      claimEvidence: async () => pkg,
      evidenceLogs: async (p) => (p.tenantId === 't-a' ? [{ id: '1', at: '2026-10-02T00:00:00Z', level: 'warn', service: 'api', msg: 'ログインの拒否', tenantId: 't-a', userId: null, requestId: null, runId: null, fields: {} }] : []),
      putEvidence: async (_id, zip, sha) => { stored = { zip, sha }; },
      failEvidence: async () => undefined,
      digests: async () => [{ day: '2026-10-02', rows: 1, sha256: 'x', chain: 'y' }],
    },
    repo: {
      listTenantIds: async () => ['t-a', 't-b'],
      searchAudit: async () => [{ id: 'a1', action: 'login.deny' }],
      listUsers: async () => [{ id: 'u-admin', status: 'active', roles: ['admin'] }, { id: 'u-m', status: 'active', roles: ['member'] }],
      createNotification: async (n: { userId: string; title: string }) => { notes.push(`${n.userId}:${n.title}`); },
    } as unknown as Repository,
    security: { recentSignals: async () => [], liveSessions: async () => [] } as unknown as SecurityStore,
    machineLogDir: dir,
  });
  assert.equal(await builder.tick(), 'ev-1');
  assert.ok(stored);
  const { zip, sha } = stored as { zip: Uint8Array; sha: string };
  assert.equal(sha, createHash('sha256').update(zip).digest('hex'));
  const z = await JSZip.loadAsync(zip);
  const manifest = JSON.parse(await z.file('manifest.json')!.async('string')) as { files: { path: string; sha256: string }[] };
  const paths = manifest.files.map((f) => f.path);
  assert.ok(paths.includes('system-logs.jsonl') && paths.includes('audit/t-a.jsonl') && paths.includes('machine-logs/caddy.log'));
  assert.equal(paths.includes('audit/t-b.jsonl'), false, 'ほかの会社の記録は入れない');
  assert.equal(paths.some((p) => p.includes('secret.txt')), false, 'ログでないファイルは入れない');
  for (const f of manifest.files) {
    const body = await z.file(f.path)!.async('uint8array');
    assert.equal(createHash('sha256').update(body).digest('hex'), f.sha256, `${f.path} の SHA-256 が合う`);
  }
  assert.deepEqual(notes.map((n) => n.split(':')[0]), ['u-admin'], '管理者だけに知らせる');
});

test('証拠保全を始めるのは運営者なら誰でも、消すのは運営管理者だけ', () => {
  assert.equal(operatorCan('monitor', 'evidence.create'), true);
  assert.equal(operatorCan('support', 'evidence.delete'), false);
  assert.equal(operatorCan('admin', 'evidence.delete'), true);
});
