/**
 * @file クラウドの形（Xserver の VPS）のセットアップのスクリプトの確かめ（仕様書 第20.4.6節、ADR-0113）。
 *
 * 機械を変えずに確かめられるところ（スクリプトの文法、雛形を埋めた結果）だけを見る。雛形の名前がすべて埋まること、
 * API が機械の中だけで待ち受けること、会社のサブドメインの証明書を API に尋ねてから取ること、運営の画面を WireGuard の網に限ること、
 * Cloudflare を前に置いたときだけ Cloudflare 以外を断り、利用者のアドレスを CF-Connecting-IP から取ることを確かめる。
 * 手元に Caddy があれば、埋めた設定を Caddy が読めることも確かめる（WAF の部品は手元の Caddy に無いので、その行を除いて読む）。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../..', import.meta.url));
const setup = join(root, 'deploy/vps/setup.sh');

const ANSWERS = {
  BASE_DOMAIN: 'm2office.net', ACME_EMAIL: 'ops@example.jp', OPS_GOOGLE_DOMAIN: 'example.jp,partner.example.co.jp', WG_NETWORK: '10.66.0.0/24', WAF_ENGINE: 'DetectionOnly',
  GEMINI_API_KEY: '', GOOGLE_LOGIN_CLIENT_ID: '', GOOGLE_LOGIN_CLIENT_SECRET: '', SECRET_KEY: 'k'.repeat(64),
  DB_OWNER_PASSWORD: 'owner-pass', DB_APP_PASSWORD: 'app-pass', DB_OPS_PASSWORD: 'ops-pass',
  RELEASE_DIR: '/opt/m2office/app/dist-release', DATA_DIR: '/var/lib/m2office', LOG_DIR: '/var/log/m2office', CADDY_LOG_DIR: '/var/log/caddy',
  SITE_DIR: '/var/www/m2office-site', API_PORT: '3101', OPS_PORT: '3102',
};

/** 雛形を埋めて、出力先を返す。 */
function render(cloudflare: 'yes' | 'no', locale = 'C'): string {
  const dir = mkdtempSync(join(tmpdir(), 'm2o-vps-'));
  const answers = join(dir, 'answers');
  writeFileSync(answers, Object.entries({ ...ANSWERS, CLOUDFLARE_FRONT: cloudflare }).map(([k, v]) => `${k}=${v}`).join('\n'));
  execFileSync(setup, ['--render-only', join(dir, 'out'), '--answers', answers], { env: { ...process.env, LANG: locale, LC_ALL: locale } });
  return join(dir, 'out');
}

const caddy = (() => { try { execFileSync('caddy', ['version']); return true; } catch { return false; } })();

test('スクリプトの文法', () => {
  execFileSync('bash', ['-n', setup]);
});

test('運営者に許すドメイン: 空白を除いて小文字にそろえ、1 つ以上を求め、1 つずつ形を確かめる', () => {
  const body = readFileSync(setup, 'utf8');
  const at = body.indexOf('OPS_GOOGLE_DOMAIN=$(printf');
  assert.ok(at > body.indexOf("ask OPS_GOOGLE_DOMAIN"), '尋ねた後にそろえる');
  assert.match(body, /\[ -n "\$OPS_GOOGLE_DOMAIN" \] \|\| die/);
  assert.match(body, /for d in "\$\{ops_domains\[@\]\}"; do \[\[ "\$d" =~/);
  // そろえる処理だけを取り出して、実際に動かす
  const normalize = body.slice(at, body.indexOf('\n', at)).replace(/^OPS_GOOGLE_DOMAIN=\$\(|\)$/g, '');
  const out = execFileSync('bash', ['-c', `OPS_GOOGLE_DOMAIN=$1; ${normalize}`, '_', ' OPS.example.co.jp , Partner.example.co.jp,, '], { encoding: 'utf8' });
  assert.equal(out, 'ops.example.co.jp,partner.example.co.jp');
});

test('雛形がすべて埋まり、API は機械の中だけで待ち受ける（日本語の言語の設定でも）', () => {
  for (const locale of ['C', 'ja_JP.UTF-8']) {
    const out = render('no', locale);
    const files = ['m2office.env', 'Caddyfile', 'acquis-m2office.yaml', ...readdirSync(join(out, 'systemd')).map((f) => `systemd/${f}`)];
    for (const f of files) assert.ok(!readFileSync(join(out, f), 'utf8').includes('{{'), `${f} に埋まっていない名前がある`);
    const env = readFileSync(join(out, 'm2office.env'), 'utf8');
    assert.match(env, /^M2O_LISTEN_HOST=127\.0\.0\.1$/m);
    assert.match(env, /^M2O_DEPLOYMENT=cloud$/m);
    assert.match(env, /^OPS_DATABASE_URL=postgres:\/\/m2office_ops:ops-pass@127\.0\.0\.1:5432\/m2office$/m);
    assert.match(env, /^GOOGLE_LOGIN_REDIRECT_URI=https:\/\/m2office\.net\/v1\/oauth\/google\/login-callback$/m);
    // 運営者に許すドメインは、提携会社のものもカンマで並べたまま設定に入る（第23.8.9節「提携会社の運営者」）
    assert.match(env, /^OPS_GOOGLE_DOMAIN=example\.jp,partner\.example\.co\.jp$/m);
    const api = readFileSync(join(out, 'systemd/m2office-api.service'), 'utf8');
    assert.match(api, /--max-old-space-size=768 \/opt\/m2office\/app\/dist-release\/server\/api\.js/);
    assert.match(api, /^ProtectSystem=strict$/m);
  }
});

test('入口: 会社のサブドメインは API に尋ねてから証明書を取り、運営の画面は WireGuard の網に限る', () => {
  const file = readFileSync(join(render('no'), 'Caddyfile'), 'utf8');
  assert.match(file, /ask http:\/\/127\.0\.0\.1:3101\/internal\/tls-allowed/);
  assert.match(file, /\(on_demand_cert\) \{\n\ttls \{\n\t\ton_demand/);
  // 決まった名前も初めて開かれたときに取る（ワイルドカードと重なる名前を Caddy が起動のときに取らないため）
  for (const site of ['*.m2office.net', 'ops.m2office.net', 'm2office.net, www.m2office.net']) {
    assert.ok(file.includes(`${site} {\n\timport on_demand_cert\n`), `${site} の証明書は初めて開かれたときに取る`);
  }
  // 断る段は handle で書き、ほかの handle より前に置く（Caddy は respond より handle を先に動かすので、respond では素通りする）
  const ops = file.slice(file.indexOf('ops.m2office.net {'));
  assert.match(ops, /@outside not remote_ip 10\.66\.0\.0\/24\n\thandle @outside \{\n\t\trespond 404/);
  assert.ok(ops.indexOf('handle @outside') < ops.indexOf('handle /v1/ops/*'), '網の外を断る段は、運営の API の段より前');
  assert.match(file, /handle @internal \{\n\t\trespond 404/);
  assert.ok(!/^\s*respond @/m.test(file), 'respond で断る段を書かない');
  // 探り（/.env・*.sql・/wp-admin/ など）は index.html を返す前に 404。会社の画面と運営の画面の段で、ほかの handle より前に置く
  assert.match(file, /\(no_probe\) \{\n\t@probe \{\n\t\tnot path \/v1\/\* \/\.well-known\/\*/);
  for (const site of ['*.m2office.net {', 'ops.m2office.net {']) {
    const body = file.slice(file.indexOf(site));
    assert.ok(body.includes('import no_probe') && body.indexOf('import no_probe') < body.indexOf('\thandle /'), `${site} は探りを先に断る`);
  }
  assert.match(file, /SecRuleEngine DetectionOnly/);
  assert.ok(!file.includes('client_ip_headers'), 'Cloudflare を前に置かないときは、見出しから利用者のアドレスを取らない');
});

test('Cloudflare を前に置くときだけ、Cloudflare 以外を断り、利用者のアドレスを CF-Connecting-IP から取る', () => {
  const off = readFileSync(join(render('no'), 'Caddyfile'), 'utf8');
  const on = readFileSync(join(render('yes'), 'Caddyfile'), 'utf8');
  assert.match(off, /\(cloudflare_only\) \{\n\tvars cloudflare_front no\n\}/);
  assert.match(on, /handle @not_cloudflare \{\n\t\trespond 403/);
  assert.ok(!/^\s*respond @/m.test(on), 'respond で断る段を書かない');
  assert.match(on, /client_ip_headers CF-Connecting-IP/);
});

test('手元に Caddy があれば、埋めた設定を読める（WAF の行を除く）', { skip: !caddy && 'Caddy が無い' }, () => {
  for (const cf of ['no', 'yes'] as const) {
    const out = render(cf);
    const file = join(out, 'Caddyfile.nowaf');
    writeFileSync(file, readFileSync(join(out, 'Caddyfile'), 'utf8').split('\n').filter((l) => !/order coraza_waf first|import waf/.test(l)).join('\n'));
    execFileSync('caddy', ['adapt', '--config', file, '--adapter', 'caddyfile'], { stdio: 'pipe' });
  }
});

test('更新（update.sh）: 文法が通り、控えを取ってから止め、署名の無いタグは --allow-unsigned のときだけ入れる', () => {
  const update = join(root, 'deploy/vps/update.sh');
  execFileSync('bash', ['-n', update]);
  const body = readFileSync(update, 'utf8');
  assert.ok(body.indexOf('pg_dump') < body.indexOf('\nstop_app\n'), '控えを取る前に止めない');
  assert.match(body, /elif \[ "\$ALLOW_UNSIGNED" = 0 \]; then\n\s+log '署名を確かめる鍵が入っていません/);
  assert.match(body, /healthy \|\| rollback/);
  // 控えのための umask 077 を、組み立ての前に戻す（戻さないと m2office がプログラムを読めない）
  const dumpAt = body.indexOf('umask 077');
  assert.ok(dumpAt > 0 && body.indexOf('umask 022', dumpAt) > dumpAt && body.indexOf('umask 022', dumpAt) < body.indexOf('\nstop_app\n'), 'umask を戻してから止めて組み立てる');
  assert.match(body, /as_owner bash -c 'umask 022 && cd "\$1" && git checkout/);
  assert.match(body, /as_owner chmod -R go\+rX "\$REPO_DIR"/);
  assert.match(body, /PGPASSWORD="\$OWNER_PASS" "\$PG_BIN\/pg_dump"/, 'パスワードを命令の引数に出さない');
});
