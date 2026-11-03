/**
 * @file 警戒のときの知らせ（仕様書 第23.8.7節「警戒のときの知らせ」）の確かめ。送るとき（警戒になった・増えた・6 時間ごと・回復）と
 * 送らないとき（注意だけ・変わらない）、送れなかったときに次の回で試し直すこと、文と受け口への送り方を見る。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { HEALTH_ALERT_REMIND_MS, HealthAlerter, healthAlertText, postHealthAlert, type OpsHealthItem, type OpsHealthView } from '../src/index.js';

const item = (level: 'alert' | 'caution', title: string): OpsHealthItem => ({ area: 'jobs', level, title, detail: '最終応答 11/4 9:00', action: '技術者に連絡する', guide: '07-server' });
const view = (...items: OpsHealthItem[]): OpsHealthView => ({
  level: items.some((i) => i.level === 'alert') ? 'alert' : items.length ? 'caution' : 'normal', items, areas: [],
});

test('警戒になったら送り、変わらなければ送らず、6 時間たったら送り直し、増えたらすぐ送り、戻ったら回復を送る。注意だけでは送らない', async () => {
  const sent: string[] = [];
  const a = new HealthAlerter(async (_t, kind) => { sent.push(kind); }, '稼働状況');
  const t0 = Date.parse('2026-11-04T00:00:00Z');
  assert.equal(await a.check(view(item('caution', 'ディスクの使用量が 80% を超えました')), t0), null, '注意だけでは送らない');
  assert.equal(await a.check(view(item('alert', 'ワーカーが応答しません')), t0), 'alert');
  assert.equal(await a.check(view(item('alert', 'ワーカーが応答しません')), t0 + 5 * 60_000), null);
  assert.equal(await a.check(view(item('alert', 'ワーカーが応答しません'), item('alert', 'ディスクがいっぱいに近づいています')), t0 + 10 * 60_000), 'alert', '新しい警戒が増えたらすぐ送る');
  assert.equal(await a.check(view(item('alert', 'ワーカーが応答しません')), t0 + 15 * 60_000), null, '減っただけでは送らない');
  assert.equal(await a.check(view(item('alert', 'ワーカーが応答しません')), t0 + 10 * 60_000 + HEALTH_ALERT_REMIND_MS), 'remind');
  assert.equal(await a.check(view(item('caution', 'ディスクの使用量が 80% を超えました')), t0 + 7 * 3_600_000), 'recover');
  assert.equal(await a.check(view(), t0 + 8 * 3_600_000), null, '回復の後は、平常に戻っても送らない');
  assert.deepEqual(sent, ['alert', 'alert', 'remind', 'recover']);
});

test('送れなかったら状態を変えず、次の回で試し直す', async () => {
  let fail = true;
  const sent: string[] = [];
  const a = new HealthAlerter(async (_t, kind) => { if (fail) throw new Error('受け口が 500 を返しました'); sent.push(kind); }, '稼働状況');
  await assert.rejects(a.check(view(item('alert', 'ワーカーが応答しません')), 0), /500/);
  fail = false;
  assert.equal(await a.check(view(item('alert', 'ワーカーが応答しません')), 5 * 60_000), 'alert');
  assert.deepEqual(sent, ['alert']);
});

test('文は警戒の見出しとすることだけ（注意は数えない）。回復は残った注意の件数', () => {
  const v = view(item('alert', 'ワーカーが応答しません'), item('caution', '遅れている定時実行があります'));
  const t = healthAlertText('alert', v, 'マスター管理画面の「稼働状況」');
  assert.equal(t.title, '【警戒】M2Office で対応が要るものが 1 件あります');
  assert.match(t.body, /・ワーカーが応答しません（最終応答 11\/4 9:00）\n　すること: 技術者に連絡する/);
  assert.doesNotMatch(t.body, /定時実行/);
  assert.match(healthAlertText('remind', v, '稼働状況').title, /^【警戒が続いています】/);
  assert.equal(healthAlertText('recover', view(item('caution', '遅れている定時実行があります')), '稼働状況').body, '注意が 1 件残っています。稼働状況で確かめてください。');
});

test('受け口へは {"text": …} を POST し、2xx でなければ投げる', async () => {
  const calls: { url: string; init: RequestInit }[] = [];
  const ok = (async (url: string, init: RequestInit) => { calls.push({ url, init }); return new Response('{}', { status: 200 }); }) as unknown as typeof fetch;
  await postHealthAlert('https://chat.googleapis.com/v1/spaces/x/messages?key=k', '本文', ok);
  assert.equal(calls[0]!.init.method, 'POST');
  assert.deepEqual(JSON.parse(String(calls[0]!.init.body)), { text: '本文' });
  const bad = (async () => new Response('no', { status: 404 })) as unknown as typeof fetch;
  await assert.rejects(postHealthAlert('https://hooks.slack.example/x', '本文', bad), /404/);
});
