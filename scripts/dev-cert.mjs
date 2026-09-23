/**
 * @file 開発用の TLS 証明書を作る（仕様書 第20.4.1節）。
 *
 * ブラウザは、**安全な文脈（HTTPS か `localhost`）でしかマイクを使わせない**。
 * 音声（第10.5節）を `<サブドメイン>.lvh.me` で試すには、開発でも HTTPS が要る。
 *
 * mkcert があればそれを使う（ブラウザが信頼するため警告が出ない）。
 * 無ければ openssl で自己署名の証明書を作る（警告を 1 度だけ手で通す）。
 *
 * 使い方:
 *   npm run dev:cert
 *   WEB_HTTPS=true npm run dev
 */

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const dir = fileURLToPath(new URL('../.data/certs', import.meta.url));
const key = `${dir}/dev-key.pem`;
const cert = `${dir}/dev-cert.pem`;

/** 証明書に載せる名前。ワイルドカードは 1 段しか効かないため、素のドメインも入れる。 */
const NAMES = ['localhost', '127.0.0.1', 'lvh.me', '*.lvh.me'];

/** その道具が使えるか。 */
function has(cmd) {
  try {
    execFileSync('which', [cmd], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

if (existsSync(key) && existsSync(cert)) {
  console.log(`すでにあります: ${cert}`);
  console.log('作り直すときは .data/certs を消してから、もう一度実行してください。');
  process.exit(0);
}

mkdirSync(dir, { recursive: true });

if (has('mkcert')) {
  console.log('mkcert で作ります（ブラウザが信頼するため、警告は出ません）。');
  execFileSync('mkcert', ['-key-file', key, '-cert-file', cert, ...NAMES], { stdio: 'inherit' });
} else {
  console.log('mkcert が見つからないため、openssl で自己署名の証明書を作ります。');
  console.log('ブラウザに警告が出ます。1 度だけ「詳細設定」→「アクセスする」で通してください。');
  console.log('警告を出したくなければ、mkcert を入れてから作り直してください（brew install mkcert && mkcert -install）。');
  execFileSync('openssl', [
    'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '825',
    '-keyout', key, '-out', cert,
    '-subj', '/CN=lvh.me',
    '-addext', `subjectAltName=${NAMES.map((n) => (/^[\d.]+$/.test(n) ? `IP:${n}` : `DNS:${n}`)).join(',')}`,
  ], { stdio: 'inherit' });
}

console.log('');
console.log(`作りました: ${cert}`);
console.log('');
console.log('使い方:');
console.log('  WEB_HTTPS=true npm run dev');
console.log('  そのあと https://<サブドメイン>.lvh.me:3100 で開いてください。');
