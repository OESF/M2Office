/**
 * @file JAN から商品名を引く — Yahoo!ショッピングの商品検索（仕様書 第29.11.3節、Q-251）の単体テスト。
 *
 * Client ID があるときだけ先に Yahoo!ショッピングで引くこと、JAN が一致する出品だけを使うこと、店の飾りを除いた共通の商品名・
 * いちばん多いブランドと分類を返すこと、見つからなければ次の方法（Gemini の検索）に回すこと、Client ID が無ければ呼ばないことを確かめる。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { JanLookupService } from '../src/index.js';
import { cleanShopName } from '../src/inventory/jan.js';

const CODE = '4901234567894';
const mockResearch = async () => ({ name: 'mock' }) as never;
const stubLlm = async () => ({ name: 'stub' }) as never;

function fakeFetch(hits: unknown[], calls: string[]) {
  return (async (url: string) => {
    calls.push(String(url));
    return new Response(JSON.stringify({ hits }), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as unknown as typeof fetch;
}

test('店の飾り（【送料無料】・まとめ買い・個数）を除く', () => {
  assert.equal(cleanShopName('【送料無料】花王 ビオレ ハンドソープ 250ml ×3個セット'), '花王 ビオレ ハンドソープ 250ml');
  assert.equal(cleanShopName('[あす楽] ポイント10倍 ハンドクリーム 50g'), 'ハンドクリーム 50g');
});

test('Client ID があれば Yahoo!ショッピングで引き、JAN が一致する出品だけから商品名・ブランド・分類を返す', async () => {
  const calls: string[] = [];
  const hits = [
    { name: '【送料無料】ビオレu ハンドソープ 250ml', janCode: CODE, brand: { name: 'ビオレ' }, genreCategory: { name: 'ハンドソープ' } },
    { name: 'ビオレu ハンドソープ 250ml まとめ買い', janCode: CODE, brand: { name: 'ビオレ' }, genreCategory: { name: 'ハンドソープ' } },
    { name: '別の商品 詰め替え', janCode: '4900000000000', brand: { name: '別' }, genreCategory: { name: '別' } },
  ];
  const jan = new JanLookupService({ research: mockResearch, llm: stubLlm, yahooAppId: 'test-id', fetch: fakeFetch(hits, calls) });
  const r = await jan.lookup('t1', CODE);
  assert.deepEqual(r, { found: true, name: 'ビオレu ハンドソープ 250ml', maker: 'ビオレ', category: 'ハンドソープ', source: 'yahoo' });
  assert.equal(calls.length, 1);
  assert.match(calls[0]!, /itemSearch\?appid=test-id&jan_code=4901234567894/);
  assert.equal(await jan.yahooEnabledFor('t1'), true);
});

test('JAN が一致する出品が無ければ次の方法に回し、Client ID が無ければ Yahoo!ショッピングを呼ばない', async () => {
  const calls: string[] = [];
  const miss = new JanLookupService({ research: mockResearch, llm: stubLlm, yahooAppId: 'test-id', fetch: fakeFetch([{ name: 'x', janCode: '4900000000000' }], calls) });
  assert.deepEqual(await miss.lookup('t1', CODE), { found: false });
  const none = new JanLookupService({ research: mockResearch, llm: stubLlm, fetch: fakeFetch([], calls) });
  assert.deepEqual(await none.lookup('t1', CODE), { found: false });
  assert.equal(calls.length, 1, 'Client ID が無いほうは呼ばない');
  assert.equal(await none.yahooEnabledFor('t1'), false);
  // 会社ごとの Client ID（会社の設定 → 運営の環境変数）。無い会社では呼ばない
  const per = new JanLookupService({ research: mockResearch, llm: stubLlm, yahooAppId: async (t) => (t === 't1' ? 'company-id' : undefined), fetch: fakeFetch([], calls) });
  assert.equal(await per.yahooEnabledFor('t1'), true);
  assert.equal(await per.yahooEnabledFor('t2'), false);
  await per.lookup('t2', CODE);
  assert.equal(calls.length, 1, 'Client ID の無い会社では呼ばない');
  await per.lookup('t1', CODE);
  assert.match(calls[1]!, /appid=company-id/);
});
