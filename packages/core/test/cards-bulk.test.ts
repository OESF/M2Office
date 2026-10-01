/**
 * @file 名刺の相手へのまとめてのメールの単体テスト（仕様書 第27.9.1節、ADR-0058）。
 *
 * 宛名の差し込み、宣伝のメールの末尾の表示、宣伝かの判断（推論が使えなければ宣伝とみなす）、
 * 秘書への依頼の見分け、配信の停止の見出し（`List-Unsubscribe`）を確かめる。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { adFooter, judgeAdvertising, renderBulk } from '../src/index.js';
import { bulkMailRequest, contactRequest } from '../src/secretary/contacts.js';
import { buildRawMessage } from '../src/connectors/google/mime.js';
import type { LlmProvider } from '../src/llm/provider.js';

test('宛名の差し込み: {会社名}・{氏名} を人ごとに入れる（何度出てきても）', () => {
  assert.equal(renderBulk('{会社名}\n{氏名} 様\n{氏名} 様へのお礼', { company: '株式会社サンプル', name: '佐藤 花子' }),
    '株式会社サンプル\n佐藤 花子 様\n佐藤 花子 様へのお礼');
});

test('末尾の表示: 会社の正式名称・住所・問い合わせ先・配信の停止の方法を入れる', () => {
  const f = adFooter({ legalName: '株式会社アルファ商事', postalCode: '100-0001', address: '東京都千代田区1-1' }, 'sales@alpha.example.jp', 'https://a.example.jp/v1/unsubscribe/x');
  for (const s of ['株式会社アルファ商事', '〒100-0001 東京都千代田区1-1', 'お問い合わせ: sales@alpha.example.jp', 'https://a.example.jp/v1/unsubscribe/x', '配信停止']) {
    assert.ok(f.includes(s), s);
  }
});

test('宣伝かの判断: 推論が使えない・答えが読めなければ宣伝とみなす（迷えば宣伝）。お礼だけと答えれば宣伝ではない', async () => {
  assert.equal(await judgeAdvertising(null, 'お礼', '本日はありがとうございました'), true);
  const llm = (text: string): LlmProvider => ({ name: 'test', complete: async () => ({ text, tokensUsed: 1 }) });
  assert.equal(await judgeAdvertising(llm('{"advertising": false}'), 'お礼', '本日はありがとうございました'), false);
  assert.equal(await judgeAdvertising(llm('{"advertising": true}'), 'ご案内', '新製品の説明会を開きます'), true);
  assert.equal(await judgeAdvertising(llm('分かりません'), 'お礼', '…'), true);
  assert.equal(await judgeAdvertising({ name: 'stub', complete: async () => ({ text: '{"advertising": false}', tokensUsed: 1 }) }, 'お礼', '…'), true);
});

test('秘書への依頼: 名刺の相手へのまとめてのメールを見分け、1 人へのメールや名刺の問いとは分ける', () => {
  assert.equal(bulkMailRequest('9 月 25 日の発表会で名刺交換した人にお礼のメールを送って'), true);
  assert.equal(bulkMailRequest('発表会に参加してくださった方にお礼をまとめて送りたい'), true);
  assert.equal(bulkMailRequest('株式会社サンプルの方々に新製品の案内を一斉に送って'), true);
  assert.equal(bulkMailRequest('田中さんにお礼のメールを送って'), false);
  assert.equal(bulkMailRequest('先週名刺交換した人を教えて'), false);
  assert.equal(contactRequest('先週名刺交換した人を教えて'), 'ask');
});

test('配信の停止の見出し: 宣伝のメールに List-Unsubscribe と、押すだけで止まる List-Unsubscribe-Post を付ける', () => {
  const raw = Buffer.from(buildRawMessage({ to: ['a@example.jp'], cc: [], subject: '件名', body: '本文', listUnsubscribe: 'https://a.example.jp/v1/unsubscribe/abc' }), 'base64url').toString('utf8');
  assert.match(raw, /^List-Unsubscribe: <https:\/\/a\.example\.jp\/v1\/unsubscribe\/abc>\r$/m);
  assert.match(raw, /^List-Unsubscribe-Post: List-Unsubscribe=One-Click\r$/m);
  // 改行を混ぜた値で見出しを足させない
  const bad = Buffer.from(buildRawMessage({ to: ['a@example.jp'], cc: [], subject: '件名', body: '本文', listUnsubscribe: 'https://x\r\nBcc: evil@example.jp' }), 'base64url').toString('utf8');
  assert.doesNotMatch(bad, /Bcc:/);
  const none = Buffer.from(buildRawMessage({ to: ['a@example.jp'], cc: [], subject: '件名', body: '本文' }), 'base64url').toString('utf8');
  assert.doesNotMatch(none, /List-Unsubscribe/);
});
