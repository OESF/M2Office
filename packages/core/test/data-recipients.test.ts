/**
 * @file データの渡し先（委託先）の一覧（仕様書 第16.11.3節 G-3）の単体テスト。
 *
 * インフラ事業者が未設定なら推測で埋めず「設定していない」と出すこと、ローカルの形では社外の置き場を出さないこと、
 * 外部の AI に渡さない決まりでは推論の渡し先を「使っていない」にすること、会社が登録したコネクタを並べることを確かめる。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildDataRecipients, type DataRecipientFacts } from '../src/index.js';

const base: DataRecipientFacts = {
  deployment: 'cloud', hosting: { provider: null, location: null },
  ai: { policy: 'cloud', geminiSource: 'platform', localConfigured: false },
  credentials: new Set(), extensions: { webReview: false, printDesigns: false, competitors: false, columns: false, inquiries: false },
  canvaAvailable: false, connectors: [],
};
const byId = (f: DataRecipientFacts) => new Map(buildDataRecipients(f).map((x) => [x.id, x]));

test('インフラ事業者が未設定なら「設定していない」と出し、設定されていればその名前と場所', () => {
  assert.match(byId(base).get('hosting')!.name, /運営が設定していません/);
  const set = byId({ ...base, hosting: { provider: '見本クラウド', location: '日本（東京）' } }).get('hosting')!;
  assert.equal(set.name, '見本クラウド');
  assert.equal(set.location, '日本（東京）');
  assert.equal(set.contract, 'operator');
});

test('ローカルの形は会社の中の機械に置き、外部の AI に渡さない決まりでは推論の渡し先を使わない', () => {
  const m = byId({ ...base, deployment: 'onsite', ai: { policy: 'local-only', geminiSource: 'platform', localConfigured: true } });
  assert.equal(m.get('hosting')!.contract, 'machine');
  assert.equal(m.get('gemini')!.active, false);
  assert.equal(m.get('local-ai')!.active, true);
  assert.equal(byId({ ...base, ai: { policy: 'cloud', geminiSource: 'tenant', localConfigured: false } }).get('gemini')!.contract, 'company', '自社の鍵なら会社の契約');
});

test('使っている機能のつなぎと、会社が登録したコネクタを並べる', () => {
  const m = byId({
    ...base, credentials: new Set(['line', 'wordpress']), extensions: { ...base.extensions, inquiries: true },
    connectors: [{ id: 'c1', name: '見本の販売管理', url: 'https://mcp.example.jp/x' }],
  });
  assert.equal(m.get('line')!.active, true);
  assert.equal(m.get('wordpress')!.active, false, 'コラムを入れていなければ使っていない');
  assert.match(m.get('connector:c1')!.name, /見本の販売管理（コネクタ。mcp\.example\.jp）/);
  assert.equal(m.has('canva'), false, 'Canva のつなぎが無ければ出さない');
});
