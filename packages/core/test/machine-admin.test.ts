/**
 * @file ローカルの形の「機械の管理者」（仕様書 第8.6.3節、Q-154）の単体テスト。
 *
 * 合言葉の控え・確認コード（RFC 6238 の試験の値）・同じ確認コードを 2 回使わせないこと・ログイン状態の署名と期限・
 * 合言葉を作り直すと前のログイン状態が使えなくなること・間違いが続いたら受け付けないことを確かめる。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  base32Decode, base32Encode, hashMachinePassword, issueMachineSession, machineAdminFromEnv, machineCsrf, machineSessionKey, MachineLoginThrottle,
  MACHINE_ADMIN_LOCK_MS, MACHINE_ADMIN_MAX_FAILURES, MACHINE_ADMIN_SESSION_MS, totpCode, totpUri, verifyMachinePassword, verifyMachineSession, verifyTotp,
} from '../src/index.js';

test('合言葉の控えは塩つきの scrypt で、同じ合言葉でも毎回違う控えになる', () => {
  const a = hashMachinePassword('abcde-fghjk-mnpqr-stuvw');
  const b = hashMachinePassword('abcde-fghjk-mnpqr-stuvw');
  assert.notEqual(a, b);
  assert.match(a, /^scrypt:16384:8:1:[\w-]+:[\w-]+$/);
  assert.equal(verifyMachinePassword('abcde-fghjk-mnpqr-stuvw', a), true);
  assert.equal(verifyMachinePassword('abcde-fghjk-mnpqr-stuvx', a), false);
  assert.equal(verifyMachinePassword('x', 'plain-text'), false, '読めない控えは合わない');
  assert.equal(verifyMachinePassword('x', 'scrypt:99999999:8:1:c2FsdHNhbHQ:aGFzaGhhc2hoYXNoaGFzaA'), false, '重すぎる設定の控えは読まない');
});

test('確認コードは RFC 6238 の試験の値と同じになる（SHA-1・6 桁・30 秒）', () => {
  // RFC 6238 付録 B の種（"12345678901234567890"）。8 桁の値の下 6 桁
  const secret = base32Encode(Buffer.from('12345678901234567890'));
  assert.equal(base32Decode(secret).toString(), '12345678901234567890');
  assert.equal(totpCode(secret, Math.floor(59 / 30)), '287082');
  assert.equal(totpCode(secret, Math.floor(1111111109 / 30)), '081804');
  assert.equal(totpCode(secret, Math.floor(1234567890 / 30)), '005924');
  assert.equal(totpCode(secret, Math.floor(2000000000 / 30)), '279037');
  assert.match(totpUri(secret, 'machine'), /^otpauth:\/\/totp\/M2Office%3Amachine\?secret=/);
});

test('確認コードは前後 30 秒まで受け、同じ刻みのコードを 2 回使わせない', () => {
  const secret = base32Encode(Buffer.from('12345678901234567890'));
  const now = new Date(1_234_567_890_000);
  const step = Math.floor(now.getTime() / 30_000);
  assert.equal(verifyTotp(secret, totpCode(secret, step), now), step);
  assert.equal(verifyTotp(secret, totpCode(secret, step - 1), now), step - 1, '30 秒前のコードも受ける（時計のずれ）');
  assert.equal(verifyTotp(secret, totpCode(secret, step - 2), now), null, '60 秒前のコードは受けない');
  assert.equal(verifyTotp(secret, totpCode(secret, step), now, step), null, '使った刻みのコードはもう受けない');
  assert.equal(verifyTotp(secret, '12345', now), null);
  assert.equal(verifyTotp(secret, `${totpCode(secret, step).slice(0, 3)} ${totpCode(secret, step).slice(3)}`, now), step, '間の空白は無視する');
});

test('ログイン状態は署名と期限で確かめ、合言葉か種を作り直すと前のものは使えない', () => {
  const cfg = { id: 'machine', passwordHash: hashMachinePassword('p'), totpSecret: 'JBSWY3DPEHPK3PXP' };
  const key = machineSessionKey('server-secret', cfg);
  const now = new Date('2026-10-16T00:00:00Z');
  const s = issueMachineSession(key, now);
  assert.equal(verifyMachineSession(key, s.token, now), s.expiresAt);
  assert.equal(verifyMachineSession(key, s.token, new Date(now.getTime() + MACHINE_ADMIN_SESSION_MS + 1)), null, '8 時間で切れる');
  assert.equal(verifyMachineSession(key, s.token.replace(/.$/, (c) => (c === 'A' ? 'B' : 'A')), now), null, '書き換えたら使えない');
  const [, nonce, sig] = s.token.split('.');
  assert.equal(verifyMachineSession(key, `${now.getTime() + 99 * MACHINE_ADMIN_SESSION_MS}.${nonce}.${sig}`, now), null, '期限を延ばせない');
  const renewed = machineSessionKey('server-secret', { ...cfg, passwordHash: hashMachinePassword('p') });
  assert.equal(verifyMachineSession(renewed, s.token, now), null, '合言葉を作り直したら、前のログイン状態は使えない');
  assert.notEqual(machineCsrf(key, s.token), machineCsrf(key, issueMachineSession(key, now).token), 'CSRF の印はログイン状態ごと');
});

test('続けて 5 回間違えると 15 分受け付けず、送り元を変えても全体で 20 回までにする', () => {
  const t = new MachineLoginThrottle();
  const now = 1_000_000;
  for (let i = 0; i < MACHINE_ADMIN_MAX_FAILURES - 1; i++) t.fail('10.0.0.5', now);
  assert.equal(t.lockedFor('10.0.0.5', now), 0);
  t.fail('10.0.0.5', now);
  assert.equal(t.lockedFor('10.0.0.5', now), MACHINE_ADMIN_LOCK_MS / 1000);
  assert.equal(t.lockedFor('10.0.0.6', now), 0, 'ほかの送り元はまだ受け付ける');
  assert.equal(t.lockedFor('10.0.0.5', now + MACHINE_ADMIN_LOCK_MS), 0, '15 分たてば受け付ける');
  const g = new MachineLoginThrottle();
  for (let i = 0; i < MACHINE_ADMIN_MAX_FAILURES * 4; i++) g.fail(`10.0.1.${i}`, now);
  assert.ok(g.lockedFor('10.0.9.9', now) > 0, '送り元を変えた総当たりは全体で止める');
});

test('3 つの値がそろわない・形が違う設定では、機械の管理者を使わない', () => {
  const ok = { M2O_MACHINE_ADMIN_ID: 'machine', M2O_MACHINE_ADMIN_PASSWORD_HASH: hashMachinePassword('p'), M2O_MACHINE_ADMIN_TOTP: 'JBSW Y3DP EHPK 3PXP' };
  assert.equal(machineAdminFromEnv(ok)?.totpSecret, 'JBSWY3DPEHPK3PXP');
  assert.equal(machineAdminFromEnv({ ...ok, M2O_MACHINE_ADMIN_ID: '' }), null);
  assert.equal(machineAdminFromEnv({ ...ok, M2O_MACHINE_ADMIN_PASSWORD_HASH: 'plain' }), null);
  assert.equal(machineAdminFromEnv({ ...ok, M2O_MACHINE_ADMIN_TOTP: 'ABC' }), null, '短すぎる種は使わない');
});
