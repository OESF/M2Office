/**
 * @file Chat で秘書に頼む受け口の部品の単体テスト（仕様書 第10.16.2節・第10.16.3節、ADR-0138）。
 *
 * 出来事から秘書に向けた発言だけを取り出すこと（個別メッセージ・言及。人以外・ほかの出来事は取らない）、
 * Google の署名（ID トークン）の確かめ（鍵・発行元・期限・送り主・宛先）、重ねて届いた発言を 1 回だけ扱う置き場、
 * Chat の書式の答えを確かめる。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSign, generateKeyPairSync } from 'node:crypto';
import { ChatTokenVerifier, MemoryChatInboxStore, chatHookHash, chatReplyText, parseChatEvent } from '../src/index.js';

const dm = (over: Record<string, unknown> = {}) => ({
  type: 'MESSAGE',
  message: {
    name: 'spaces/AAA/messages/m1', text: '今日の予定は？', argumentText: '今日の予定は？',
    sender: { name: 'users/111', email: 'Sato@A.example.jp', type: 'HUMAN' },
    thread: { name: 'spaces/AAA/threads/t1' },
    space: { name: 'spaces/AAA', spaceType: 'DIRECT_MESSAGE', singleUserBotDm: true },
  },
  space: { name: 'spaces/AAA', spaceType: 'DIRECT_MESSAGE' },
  ...over,
});

test('出来事から、秘書に向けた発言を取り出す', () => {
  assert.deepEqual(parseChatEvent(dm()), {
    messageName: 'spaces/AAA/messages/m1', text: '今日の予定は？', senderEmail: 'sato@a.example.jp', senderName: 'users/111',
    space: 'spaces/AAA', direct: true, thread: 'spaces/AAA/threads/t1',
  });
  // スペースでの言及は、言及の部分を除いた文（argumentText）を使う
  const mention = parseChatEvent({
    type: 'MESSAGE',
    message: {
      name: 'spaces/BBB/messages/m2', text: '@M2Office この件の期限は？', argumentText: ' この件の期限は？',
      sender: { name: 'users/222', email: 'b@a.example.jp', type: 'HUMAN' }, space: { name: 'spaces/BBB', spaceType: 'SPACE' },
    },
  });
  assert.equal(mention?.text, 'この件の期限は？');
  assert.equal(mention?.direct, false);
  assert.equal(mention?.thread, null);
});

test('人の発言でないもの・ほかの出来事・読めないものは取らない', () => {
  assert.equal(parseChatEvent({ type: 'ADDED_TO_SPACE', space: { name: 'spaces/AAA' } }), null);
  assert.equal(parseChatEvent(dm({ message: { ...dm().message, sender: { name: 'users/9', email: 'bot@a.example.jp', type: 'BOT' } } })), null);
  assert.equal(parseChatEvent(dm({ message: { ...dm().message, argumentText: '  ', text: '  ' } })), null);
  assert.equal(parseChatEvent(dm({ message: { ...dm().message, name: '../etc' } })), null);
  assert.equal(parseChatEvent('文字'), null);
});

/** 手元で作った鍵で、Chat の ID トークンを作る。 */
function signer() {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const jwk = { ...publicKey.export({ format: 'jwk' }), kid: 'k1', alg: 'RS256', use: 'sig' };
  const sign = (claims: Record<string, unknown>, kid = 'k1') => {
    const b64 = (v: unknown) => Buffer.from(JSON.stringify(v)).toString('base64url');
    const body = `${b64({ alg: 'RS256', kid, typ: 'JWT' })}.${b64(claims)}`;
    return `Bearer ${body}.${createSign('RSA-SHA256').update(body).sign(privateKey, 'base64url')}`;
  };
  return { jwk, sign };
}

test('署名の確かめ: Google の鍵・発行元・期限・送り主が Chat・宛先がこの受け口', async () => {
  const { jwk, sign } = signer();
  const now = Date.parse('2026-11-11T03:00:00Z');
  const v = new ChatTokenVerifier(async () => ({ keys: [jwk] }), () => now);
  const path = '/v1/hooks/google-chat/abcdefghijklmnopqrstuvwxyz012345';
  const good = {
    iss: 'https://accounts.google.com', aud: `https://a.m2office.example${path}`, email: 'chat@system.gserviceaccount.com', email_verified: true,
    iat: Math.floor(now / 1000) - 10, exp: Math.floor(now / 1000) + 3000,
  };
  assert.equal(await v.check(sign(good), path), null);
  assert.equal(await v.check(undefined, path), 'トークンがありません');
  assert.equal(await v.check(sign({ ...good, email: 'someone@example.com' }), path), '送り主が Chat ではありません');
  assert.equal(await v.check(sign({ ...good, aud: 'https://a.m2office.example/v1/hooks/google-chat/other' }), path), '宛先が違います');
  assert.equal(await v.check(sign({ ...good, exp: Math.floor(now / 1000) - 1 }), path), '期限が切れています');
  assert.equal(await v.check(sign({ ...good, iss: 'https://evil.example' }), path), '発行元が違います');
  assert.equal(await v.check(sign(good, 'unknown'), path), '署名の鍵が見つかりません');
  // ほかの鍵で署名したものは通さない
  const other = signer();
  assert.equal(await v.check(other.sign(good), path), '署名が合いません');
});

test('置き場: 鍵のハッシュから会社を引き、同じ発言は 1 回だけ扱う', async () => {
  const s = new MemoryChatInboxStore();
  await s.setHook('t1', chatHookHash('key-1'));
  assert.equal(await s.hookTenantOf(chatHookHash('key-1')), 't1');
  assert.equal(await s.hookTenantOf(chatHookHash('key-2')), null);
  assert.equal(await s.takeMessage('t1', 'spaces/A/messages/1', '2026-11-11T00:00:00Z'), true);
  assert.equal(await s.takeMessage('t1', 'spaces/A/messages/1', '2026-11-11T00:00:01Z'), false, '重ねて届いた');
  assert.equal(await s.takeMessage('t2', 'spaces/A/messages/1', '2026-11-11T00:00:01Z'), true, '会社が違えば別');
  await s.purge('t1', '2026-11-12T00:00:00Z');
  assert.equal(await s.takeMessage('t1', 'spaces/A/messages/1', '2026-11-12T00:00:01Z'), true, '古い記録は消える');
});

test('答えの文: Chat の書式に直し、画面で開くリンクを添える', () => {
  assert.equal(chatReplyText('## 予定\n**10 時** 定例', 'https://a.m2office.example/runs/r1'), '*予定*\n*10 時* 定例\n<https://a.m2office.example/runs/r1|画面で開く>');
  assert.equal(chatReplyText('はい', null), 'はい');
});
