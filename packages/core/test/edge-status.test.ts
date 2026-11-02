/**
 * @file 入口の守りと VPN の様子（仕様書 第23.8.7節「ネットワークの様子」）の確かめ。結果のファイルの読み方と、運営の画面の形
 * （止まっている・証明書の期限が近い・端末がつながっている）を見る。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { edgeStatusView, readEdgeStatus, type EdgeStatus } from '../src/index.js';

const at = '2026-11-03T12:00:00.000Z';
const base: EdgeStatus = {
  at, crowdsec: { local: 3, shared: 15000, alerts24h: 12 }, geo: { countries: 'CN,RU,KP', inBlocked: 87, outBlocked: 0, listAt: '2026-11-02T20:00:00.000Z' },
  waf: { engine: 'DetectionOnly', hits24h: 4 }, certs: { count: 5, nearest: '2027-01-20T00:00:00.000Z' },
  vpn: { peers: [{ address: '10.66.0.2', lastHandshake: '2026-11-03T11:58:30.000Z' }, { address: '10.66.0.3', lastHandshake: '2026-11-03T10:00:00.000Z' }, { address: '10.66.0.4', lastHandshake: null }] },
  errors: [],
};

test('結果のファイルを読む。無い・壊れているときは null', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'm2o-edge-'));
  writeFileSync(join(dir, 'ok.json'), JSON.stringify(base));
  writeFileSync(join(dir, 'bad.json'), '{"at": 1}');
  assert.equal((await readEdgeStatus(join(dir, 'ok.json')))?.crowdsec?.local, 3);
  assert.equal(await readEdgeStatus(join(dir, 'bad.json')), null);
  assert.equal(await readEdgeStatus(join(dir, 'none.json')), null);
});

test('運営の画面の形: 15 分より古ければ止まっている、証明書は 30 日を切ったら目立たせ、端末は最後の接続が 3 分以内ならつながっている', () => {
  const now = Date.parse(at) + 60_000;
  const v = edgeStatusView(base, now);
  assert.equal(v.configured, true);
  assert.equal(v.stale, false);
  assert.equal(v.certSoon, false);
  assert.deepEqual(v.peers.map((p) => p.connected), [true, false, false]);
  assert.equal(edgeStatusView(base, Date.parse(at) + 16 * 60_000).stale, true);
  assert.equal(edgeStatusView({ ...base, certs: { count: 5, nearest: '2026-11-20T00:00:00.000Z' } }, now).certSoon, true);
  const none = edgeStatusView(null, now);
  assert.deepEqual([none.configured, none.stale, none.peers.length], [false, false, 0]);
});
