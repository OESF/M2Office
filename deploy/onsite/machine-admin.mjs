/**
 * @file ローカルの形の「機械の管理者」の合言葉と確認コードの種を作る（仕様書 第8.6.3節、Q-154）。setup.sh から呼ぶ。
 *
 * 使い方: node machine-admin.mjs <ID>
 *
 * 出すもの（`KEY=値` の行）: `ID`・`PASSWORD`（紙に書き写して渡す。どこにも残さない）・`PASSWORD_HASH`（m2office.env に置く控え）・
 * `TOTP`（認証アプリに入れる種。m2office.env にも置く）・`URI`（認証アプリに読ませる otpauth の URI）。
 * 控えの形は M2Office の `packages/core/src/machine/machine-admin.ts` と同じ（scrypt。値に `$` を使わず、環境変数のファイルにそのまま書ける）。
 * 依存のパッケージを使わない（入れる前の機械でも動くように）。
 */

import { randomBytes, randomInt, scryptSync } from 'node:crypto';

const id = (process.argv[2] ?? 'machine').trim();
if (!/^[a-z][a-z0-9_-]{2,31}$/.test(id)) {
  console.error('ID は英小文字で始まる 3〜32 文字（英小文字・数字・ハイフン・下線）にしてください');
  process.exit(2);
}

// 読み違えやすい字（0 と O、1 と l など）を除いた字で、5 字ずつ 4 組（約 98 ビット）
const ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789';
const password = Array.from({ length: 4 }, () => Array.from({ length: 5 }, () => ALPHABET[randomInt(ALPHABET.length)]).join('')).join('-');

const [N, r, p] = [16384, 8, 1];
const salt = randomBytes(16);
const hash = scryptSync(password.normalize('NFKC'), salt, 32, { N, r, p });
const passwordHash = `scrypt:${N}:${r}:${p}:${salt.toString('base64url')}:${hash.toString('base64url')}`;

const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
let bits = 0;
let value = 0;
let totp = '';
for (const b of randomBytes(20)) {
  value = (value << 8) | b;
  bits += 8;
  while (bits >= 5) { totp += B32[(value >>> (bits - 5)) & 31]; bits -= 5; }
}
if (bits > 0) totp += B32[(value << (5 - bits)) & 31];

const uri = `otpauth://totp/${encodeURIComponent(`M2Office:${id}`)}?secret=${totp}&issuer=M2Office&algorithm=SHA1&digits=6&period=30`;
process.stdout.write(`ID=${id}\nPASSWORD=${password}\nPASSWORD_HASH=${passwordHash}\nTOTP=${totp}\nURI=${uri}\n`);
