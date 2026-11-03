/**
 * @file 入口の守りと VPN の様子（仕様書 第23.8.7節「ネットワークの様子」）の確かめ。結果のファイルの読み方と、運営の画面の形
 * （止まっている・証明書の期限が近い・端末がつながっている）と、セキュリティの状態（第23.8.7節「セキュリティの状態」）・種類のまとめ方を見る。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { alertKindLabel, edgeStatusView, edgeSurge, readEdgeStatus, wafKindLabel, type EdgeStatus } from '../src/index.js';

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

test('セキュリティの状態（第23.8.7節「セキュリティの状態」）: 理由が無ければ平常、急な増え・証明書・中央・読めなかった部分は注意、出ていく通信・期限切れ・止まった仕組みは警戒', () => {
  const now = Date.parse(at) + 60_000;
  const calm: EdgeStatus = { ...base, crowdsec: { local: 3, shared: 15000, alerts24h: 12, alerts7d: 80 }, waf: { engine: 'DetectionOnly', hits24h: 400, hits7d: 2800 }, geo: { ...base.geo!, out24h: 0 } };
  assert.deepEqual([edgeStatusView(calm, now).level, edgeStatusView(calm, now).reasons], ['normal', []]);
  // ふだん（前の 6 日の平均）の 3 倍以上で、下限（攻撃 20 件・WAF 100 件）を超えたら注意
  const surge = edgeStatusView({ ...calm, crowdsec: { ...calm.crowdsec!, alerts24h: 60, alerts7d: 120 } }, now);
  assert.equal(surge.level, 'caution');
  assert.match(surge.reasons[0], /攻撃が急に増えました（直近 24 時間 60 件・ふだん 10 件）/);
  assert.equal(edgeSurge(15, 15, 20), null, '下限より少なければ注意にしない');
  assert.equal(edgeSurge(300, 2400, 100), null, 'ふだんの 3 倍に届かなければ注意にしない');
  assert.equal(edgeStatusView({ ...calm, crowdsec: { ...calm.crowdsec!, shared: 0 } }, now).level, 'caution');
  assert.equal(edgeStatusView({ ...calm, errors: ['WAF: 記録がありません'] }, now).level, 'caution');
  assert.equal(edgeStatusView({ ...calm, certs: { count: 5, nearest: '2026-11-20T00:00:00.000Z' } }, now).level, 'caution');
  // 警戒は注意より先に並べる
  const out = edgeStatusView({ ...calm, geo: { ...calm.geo!, out24h: 3 }, crowdsec: { ...calm.crowdsec!, shared: 0 } }, now);
  assert.equal(out.level, 'alert');
  assert.deepEqual(out.reasons, ['出ていく通信を国の遮断で止めました（直近 24 時間 3 件）', 'CrowdSec が中央とつながっていません']);
  assert.equal(edgeStatusView({ ...calm, certs: { count: 5, nearest: '2026-11-01T00:00:00.000Z' } }, now).reasons[0], '証明書の期限が切れています');
  assert.equal(edgeStatusView(calm, Date.parse(at) + 16 * 60_000).level, 'alert');
  assert.equal(edgeStatusView(null, now).level, null);
  // 前の版の結果（7 日の数が無い）は、急な増えを判断しない
  assert.equal(edgeStatusView(base, now).level, 'normal');
});

test('何が来ているか: 見張りの名前と WAF の分類を種類にまとめ、多い順に 5 つまで。分からない名前は元のまま', () => {
  assert.equal(alertKindLabel('crowdsecurity/http-probing'), '存在しないページの探り');
  assert.equal(alertKindLabel('crowdsecurity/http-sqli-probing'), 'SQL インジェクション');
  assert.equal(alertKindLabel('crowdsecurity/http-admin-interface-probing'), '管理画面・秘密のファイルの探り');
  assert.equal(alertKindLabel('crowdsecurity/http-cve-2021-41773'), '既知の弱点を突く要求');
  assert.equal(alertKindLabel('crowdsecurity/ssh-slow-bf'), 'SSH のログインの総当たり');
  assert.equal(alertKindLabel('crowdsecurity/http-bf-wordpress_bf'), 'ログインの総当たり');
  assert.equal(alertKindLabel('someone/strange-thing'), 'someone/strange-thing');
  assert.equal(wafKindLabel('attack-protocol'), '決まりに反する要求');
  assert.equal(wafKindLabel('attack-new-kind'), 'attack-new-kind');
  const v = edgeStatusView({
    ...base,
    crowdsec: { ...base.crowdsec!, scenarios24h: [
      { key: 'crowdsecurity/http-probing', count: 8 }, { key: 'crowdsecurity/http-sensitive-files', count: 3 }, { key: 'crowdsecurity/http-backdoors-attempts', count: 2 },
      { key: 'crowdsecurity/http-crawl-non_statics', count: 2 }, { key: 'crowdsecurity/http-bad-user-agent', count: 1 }, { key: 'crowdsecurity/http-cve-probing', count: 1 }, { key: 'a/b', count: 1 },
    ], countries24h: [{ key: 'US', count: 6 }, { key: 'NL', count: 3 }, { key: 'DE', count: 2 }, { key: 'FR', count: 1 }, { key: '', count: 1 }, { key: 'JP', count: 1 }] },
    waf: { ...base.waf!, kinds24h: [{ key: 'attack-protocol', count: 300 }, { key: '', count: 80 }, { key: 'attack-multipart-header', count: 20 }] },
  }, Date.parse(at));
  assert.deepEqual(v.top.kinds.slice(0, 2), [{ label: '存在しないページの探り', count: 8 }, { label: '管理画面・秘密のファイルの探り', count: 5 }]);
  assert.equal(v.top.kinds.length, 5);
  assert.deepEqual(v.top.countries.map((c) => c.key), ['US', 'NL', 'DE', 'FR', '']);
  assert.deepEqual(v.top.waf, [{ label: '決まりに反する要求', count: 320 }, { label: '分類なし', count: 80 }]);
});
