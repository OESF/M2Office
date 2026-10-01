/**
 * @file 公開の前の点検（仕様書 第22.5節、ADR-0060）。公開用のリポジトリへ書き出す前に、出してはならないものが無いかを確かめる。
 *
 * 確かめるもの:
 * 1. 秘密の値（API の鍵・秘密鍵・トークンらしい文字列）と、追跡している `.env`・鍵のファイル
 * 2. メールアドレス（見本のドメイン `example.*` などを除く）
 * 3. 出してはならない言葉（客先・個人の取引先の名前など）。**言葉そのものはどこにも置かない。**
 *    リポジトリの外のファイル（既定は `../M2Office-private/publish-denylist.txt`）に「文字数:SHA-256:FNV」だけを持ち、
 *    ファイルの中の同じ長さの部分を、まず軽い FNV で絞り、当たったものだけ SHA-256 で突き合わせる
 * 4. 本番の依存のライセンス（GPL・AGPL・LGPL・SSPL など、Apache-2.0 で配るのに注意の要るもの・分からないもの）
 *
 * 使い方:
 *   npm run publish:check                       # 点検する（問題があれば 1 で終わる）
 *   node scripts/check-publish.mjs --hash       # 標準入力の言葉 1 行ずつを、出してはならない言葉の行（文字数:SHA-256:FNV）にする
 */

import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

const root = resolve(dirname(new URL(import.meta.url).pathname), '..');
const sha = (s) => createHash('sha256').update(s, 'utf8').digest('hex');
/** 文字の並びの FNV-1a（32 ビット）。絞り込みにだけ使う。 */
const fnv = (chars, from, n) => {
  let h = 0x811c9dc5;
  for (let i = from; i < from + n; i++) {
    const c = chars[i].codePointAt(0);
    h ^= c & 0xffff; h = Math.imul(h, 0x01000193) >>> 0;
    h ^= c >>> 16; h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h;
};

if (process.argv.includes('--hash')) {
  const words = readFileSync(0, 'utf8').split('\n').map((l) => l.trim()).filter(Boolean);
  for (const w of words) { const c = [...w]; console.log(`${c.length}:${sha(w)}:${fnv(c, 0, c.length)}`); }
  process.exit(0);
}

const problems = [];
const files = execFileSync('git', ['ls-files'], { cwd: root, encoding: 'utf8' }).split('\n').filter(Boolean);
const TEXT = /\.(md|ts|tsx|mjs|js|cjs|json|sql|ya?ml|txt|html|css|sh|py|env\.example|example)$|^[^.]+$/i;

// 1. 鍵のファイル
for (const f of files) {
  if (/(^|\/)\.env$|\.pem$|\.key$|\.p12$|id_rsa/.test(f)) problems.push(`秘密のファイルを追跡しています: ${f}`);
}

// 3 のための、出してはならない言葉（文字数ごとの SHA-256 の集まり）
const denyPath = resolve(process.env['M2O_PUBLISH_DENYLIST'] ?? join(root, '..', 'M2Office-private', 'publish-denylist.txt'));
const deny = new Map();
if (existsSync(denyPath)) {
  for (const line of readFileSync(denyPath, 'utf8').split('\n')) {
    const m = /^(\d+):([0-9a-f]{64}):(\d+)$/.exec(line.trim());
    if (!m) continue;
    const n = Number(m[1]);
    if (!deny.has(n)) deny.set(n, { sha: new Set(), fnv: new Set() });
    deny.get(n).sha.add(m[2]);
    deny.get(n).fnv.add(Number(m[3]));
  }
} else {
  console.warn(`（出してはならない言葉の一覧がありません: ${denyPath}。言葉の点検は飛ばします）`);
}

const SECRET = [
  [/AIza[0-9A-Za-z_-]{35}/, 'Google の API キーらしい文字列'],
  [/\bsk-[A-Za-z0-9]{20,}/, 'API キーらしい文字列'],
  [/xox[abpr]-[0-9A-Za-z-]{10,}/, 'Slack のトークンらしい文字列'],
  [/-----BEGIN (RSA |EC |OPENSSH )?PRIVATE KEY-----/, '秘密鍵'],
  [/\bghp_[A-Za-z0-9]{30,}/, 'GitHub のトークンらしい文字列'],
];
// 見本として書いてよいメールアドレスのドメイン（RFC 2606・6761 で予約された名前と、example.* とその下）
const OK_MAIL = /@(([a-z0-9-]+\.)*(example|test|invalid|localhost)|([a-z0-9-]+\.)*example\.(com|net|org|jp|co\.jp)|users\.noreply\.github\.com)$/i;
// 公開されている決まった宛先（共著者の行・依存の説明文・個人向けの Google アカウントの例・URL の利用者名の例）
const OK_ADDRESS = new Set(['noreply@anthropic.com', 'i@izs.me', 'someone@gmail.com', 'pass@lh3.googleusercontent.com']);

for (const f of files) {
  if (!TEXT.test(f) || f.startsWith('node_modules/')) continue;
  let text;
  try { text = readFileSync(join(root, f), 'utf8'); } catch { continue; }
  if (text.includes('\u0000')) continue;
  for (const [re, what] of SECRET) if (re.test(text)) problems.push(`${what}: ${f}`);
  // 2. メールアドレス
  for (const m of text.matchAll(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g)) {
    if (!OK_MAIL.test(m[0]) && !OK_ADDRESS.has(m[0].toLowerCase()) && !/@(types|m2office|zxing|anthropic-ai|google)\//.test(m[0])) problems.push(`メールアドレス: ${f}（${m[0].replace(/^(.).*@/, '$1…@')}）`);
  }
  // 3. 出してはならない言葉（言葉そのものは表示しない）
  if (deny.size > 0) {
    const chars = [...text];
    let hit = false;
    for (const [n, set] of deny) {
      for (let i = 0; i + n <= chars.length && !hit; i++) {
        if (set.fnv.has(fnv(chars, i, n)) && set.sha.has(sha(chars.slice(i, i + n).join('')))) hit = true;
      }
      if (hit) break;
    }
    if (hit) problems.push(`出してはならない言葉が含まれています: ${f}`);
  }
}

// 4. 本番の依存のライセンス
const CAUTION = /\b(A?GPL|LGPL|SSPL|BUSL|CC-BY-NC|Commons-Clause)/i;
try {
  const out = execFileSync('npm', ['ls', '--all', '--omit=dev', '--parseable'], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  const seen = new Set();
  for (const dir of out.split('\n').filter((d) => d.includes('node_modules'))) {
    const pj = join(dir, 'package.json');
    if (seen.has(pj) || !existsSync(pj)) continue;
    seen.add(pj);
    const p = JSON.parse(readFileSync(pj, 'utf8'));
    const lic = typeof p.license === 'string' ? p.license : Array.isArray(p.licenses) ? p.licenses.map((l) => l.type ?? l).join(' OR ') : (p.license?.type ?? '');
    if (!lic) problems.push(`ライセンスが分からない依存: ${p.name}@${p.version}`);
    else if (CAUTION.test(lic) && !/\bOR\b.*\b(MIT|Apache|BSD|ISC)/i.test(lic) && !/\b(MIT|Apache|BSD|ISC)\b.*\bOR\b/i.test(lic)) {
      problems.push(`注意の要るライセンスの依存: ${p.name}@${p.version}（${lic}）`);
    }
  }
} catch (err) {
  problems.push(`依存の一覧を取れませんでした: ${err instanceof Error ? err.message : String(err)}`);
}

if (problems.length > 0) {
  console.error(`公開の前の点検で ${problems.length} 件の問題が見つかりました:`);
  for (const p of [...new Set(problems)]) console.error(`  - ${p}`);
  process.exit(1);
}
console.log(`公開の前の点検: 問題はありません（ファイル ${files.length} 件・出してはならない言葉 ${[...deny.values()].reduce((n, s) => n + s.sha.size, 0)} 件）`);
