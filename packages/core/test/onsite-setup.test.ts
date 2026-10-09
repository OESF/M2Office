/**
 * @file ローカルの形のセットアップのスクリプトの確かめ（仕様書 第8.6.1節、ADR-0077）。
 *
 * 機械を変えずに確かめられるところ（スクリプトの文法、雛形を埋めた結果）だけを見る。
 * 雛形の名前がすべて埋まること、launchd の設定が正しい形であること、入口の TLS の段（名前の形と IP の形）、
 * 秘密の値が答えのファイル（setup.conf）ではなく環境変数のファイルに入ることを確かめる。
 * M2Medical と分け合う共通の入口（deploy/front/front.sh。第8.6.9節）は、偽の caddy と launchctl で動きを確かめる。
 *
 * スクリプトは日本語の言語の設定（`LANG=ja_JP.UTF-8`）でも流す。macOS の bash 3.2 は、その設定で `$VAR（` のように
 * 変数のすぐ後ろに全角の文字が続くと、全角の文字の一部まで変数の名前として読み、`set -u` で止まるため（M2Medical からの連絡）。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../..', import.meta.url));
const onsite = join(root, 'deploy/onsite');
const frontSh = join(root, 'deploy/front/front.sh');
/** スクリプトを流す言語の設定。日本語の設定でだけ起きる読み違いがあるため、両方で流す。 */
const LOCALES = ['C', 'ja_JP.UTF-8'] as const;
const localeEnv = (locale: string) => ({ LANG: locale, LC_ALL: locale });

const ANSWERS = {
  INSTALL_DIR: '/Library/M2Office', REPO_DIR: '/Library/M2Office/app', RELEASE_DIR: '/Library/M2Office/app/dist-release',
  ENV_FILE: '/Library/M2Office/m2office.env', FRONT_DIR: '/Library/M2Front', DATA_DIR: '/Volumes/RAID/M2Office', BACKUP_DIR: '/Volumes/Backup/M2Office',
  API_PORT: '3101', DB_PORT: '5433', HOST: 'office.example.jp', SUBDOMAIN: 'office', ACME_EMAIL: 'admin@example.jp',
  NODE_BIN: '/opt/homebrew/opt/node@22/bin/node', PG_BIN: '/opt/homebrew/opt/postgresql@17/bin', CADDY_BIN: '/opt/homebrew/opt/caddy/bin/caddy',
  LOCAL_LLM_URL: 'http://127.0.0.1:11434/v1', LOCAL_LLM_MODEL: 'gemma3', LOCAL_LLM_EMBED_MODEL: 'embeddinggemma', GEMINI_API_KEY: '',
  GOOGLE_LOGIN_CLIENT_ID: '', GOOGLE_LOGIN_CLIENT_SECRET: '', SECRET_KEY: 'k'.repeat(64), DB_APP_PASSWORD: 'app-pass', DB_OWNER_PASSWORD: 'owner-pass', UPDATE_HOUR: '3',
  HEARTBEAT_URL: 'https://ops.example/heartbeat', HEARTBEAT_TOKEN: 'hb-token', MACHINE_ID: 'm-001',
  OFFSITE_REPOSITORY: 's3:https://s3.example/bucket/m2office', OFFSITE_PASSWORD: 'offsite-pass', OFFSITE_ACCESS_KEY_ID: 'AKID', OFFSITE_SECRET_ACCESS_KEY: 'SKEY',
  OFFSITE_REGION: '', RESTIC_BIN: '/opt/homebrew/opt/restic/bin/restic',
};

function render(extra: Record<string, string>, locale = 'C') {
  const dir = mkdtempSync(join(tmpdir(), 'm2o-onsite-'));
  const answers = join(dir, 'answers');
  writeFileSync(answers, Object.entries({ ...ANSWERS, ...extra }).map(([k, v]) => `${k}=${v}`).join('\n'));
  execFileSync('/bin/bash', [join(onsite, 'setup.sh'), '--render-only', join(dir, 'out'), '--answers', answers], { env: { ...process.env, ...localeEnv(locale), NODE_BIN: process.execPath } });
  return join(dir, 'out');
}

test('変数のすぐ後ろに全角の文字を続けない（日本語の言語の設定の bash 3.2 で、全角の文字まで変数の名前として読まれる）', () => {
  const files: string[] = [];
  const walk = (d: string) => { for (const e of readdirSync(d, { withFileTypes: true })) { const f = join(d, e.name); if (e.isDirectory()) walk(f); else if (e.name.endsWith('.sh')) files.push(f); } };
  walk(join(root, 'deploy'));
  assert.ok(files.length >= 4);
  const found: string[] = [];
  for (const f of files) {
    readFileSync(f, 'utf8').split('\n').forEach((line, i) => {
      // `$名前` の直後に ASCII でない文字。`${名前}` と囲めば読み違えない
      if (/\$[A-Za-z_][A-Za-z0-9_]*[^\x00-\x7F]/.test(line)) found.push(`${f.slice(root.length)}:${i + 1}`);
    });
  }
  assert.deepEqual(found, [], `\${…} で囲んでください: ${found.join(', ')}`);
});

test('日本語の言語の設定でも、雛形を埋められる', () => {
  const out = render({ TLS_BLOCK: '\\ttls internal' }, 'ja_JP.UTF-8');
  assert.match(readFileSync(join(out, 'm2office.caddy'), 'utf8'), /\n\ttls internal\n/);
});

test('スクリプトの文法', () => {
  for (const f of ['setup.sh', 'update.sh', 'maintenance.sh']) execFileSync('/bin/bash', ['-n', join(onsite, f)]);
  execFileSync('/bin/bash', ['-n', frontSh]);
});

test('雛形がすべて埋まり、launchd の設定は正しい形', () => {
  const out = render({ TLS_BLOCK: '\\ttls admin@example.jp {\\n\\t\\tdns cloudflare tok-123\\n\\t}' });
  const env = readFileSync(join(out, 'm2office.env'), 'utf8');
  assert.doesNotMatch(env, /\{\{/);
  assert.match(env, /^M2O_APP_ROOT=\/Library\/M2Office\/app\/dist-release$/m);
  assert.match(env, /^DATABASE_URL=postgres:\/\/m2office_app:app-pass@127\.0\.0\.1:5433\/m2office$/m);
  assert.match(env, /^GOOGLE_OAUTH_REDIRECT_URI=https:\/\/office\.example\.jp\/v1\/oauth\/google\/callback$/m);
  assert.match(env, /^M2O_PG_BIN=\/opt\/homebrew\/opt\/postgresql@17\/bin$/m);
  const caddy = readFileSync(join(out, 'm2office.caddy'), 'utf8');
  assert.match(caddy, /\n\ttls admin@example\.jp \{\n\t\tdns cloudflare tok-123\n\t\}\n/);
  assert.match(caddy, /root \* \/Library\/M2Office\/app\/dist-release\/web/);
  // 共通の入口に置く名前の設定なので、全体の設定の段は持たない（M2Medical と分け合うため。第8.6.9節）
  assert.match(caddy, /^office\.example\.jp \{$/m);
  assert.doesNotMatch(caddy, /^\{/m);
  assert.doesNotMatch(caddy, /import/);
  assert.match(env, /^M2O_FRONT_DIR=\/Library\/M2Front$/m);
  const plists = readdirSync(join(out, 'launchd'));
  assert.deepEqual(plists.sort(), ['jp.m2office.api.plist', 'jp.m2office.maintenance.plist', 'jp.m2office.postgres.plist', 'jp.m2office.update.plist', 'jp.m2office.worker.plist']);
  assert.match(env, /^M2O_HEARTBEAT_URL=https:\/\/ops\.example\/heartbeat$/m);
  assert.match(env, /^M2O_OFFSITE_REPOSITORY=s3:https:\/\/s3\.example\/bucket\/m2office$/m);
  assert.match(env, /^M2O_OFFSITE_PASSWORD=offsite-pass$/m);
  for (const p of plists) {
    const xml = readFileSync(join(out, 'launchd', p), 'utf8');
    assert.doesNotMatch(xml, /\{\{/, p);
    if (process.platform === 'darwin') execFileSync('plutil', ['-lint', join(out, 'launchd', p)]);
  }
  const api = readFileSync(join(out, 'launchd', 'jp.m2office.api.plist'), 'utf8');
  assert.match(api, /<string>\/opt\/homebrew\/opt\/node@22\/bin\/node<\/string>/);
  assert.match(api, /<string>--env-file=\/Library\/M2Office\/m2office\.env<\/string>/);
  assert.match(api, /<string>_m2office<\/string>/);
  assert.match(readFileSync(join(out, 'launchd', 'jp.m2office.update.plist'), 'utf8'), /<string>--auto<\/string>[\s\S]*<integer>3<\/integer>/);
});

test('IP の形は、機械の認証局で証明書を出す。埋められない名前が残れば書かない', () => {
  const out = render({ TLS_BLOCK: '\\ttls internal' });
  assert.match(readFileSync(join(out, 'm2office.caddy'), 'utf8'), /\n\ttls internal\n/);
  const dir = mkdtempSync(join(tmpdir(), 'm2o-onsite-'));
  const answers = join(dir, 'answers');
  writeFileSync(answers, 'HOST=x');
  assert.throws(() => execFileSync('/bin/bash', [join(onsite, 'setup.sh'), '--render-only', join(dir, 'out'), '--answers', answers], { env: { ...process.env, NODE_BIN: process.execPath }, stdio: 'pipe' }));
});

test('遠隔の保守: 会社の管理者の印の期限まで開け、切れたら閉じ、話した相手を回ごとに残す', () => {
  const dir = mkdtempSync(join(tmpdir(), 'm2o-maint-'));
  const status = join(dir, 'ts.json');
  const run = (running: 0 | 1, nowMs: number) => execFileSync(process.execPath, [join(onsite, 'maintenance-state.mjs'), dir, String(running), status], { env: { ...process.env, M2O_NOW_MS: String(nowMs) } }).toString();
  const t0 = Date.parse('2026-10-08T01:00:00Z');
  writeFileSync(status, '{}');
  assert.equal(run(0, t0), 'none');
  writeFileSync(join(dir, 'maintenance-request.json'), JSON.stringify({ until: '2026-10-08T05:00:00Z', by: 'u-admin' }));
  assert.equal(run(0, t0), 'up');
  writeFileSync(status, JSON.stringify({ BackendState: 'Running', Peer: { a: { HostName: 'ops-laptop', Active: true }, b: { HostName: 'idle', Active: false } } }));
  assert.equal(run(1, t0 + 60_000), 'none');
  assert.equal(run(1, Date.parse('2026-10-08T05:00:01Z')), 'down');
  const st = JSON.parse(readFileSync(join(dir, 'maintenance.json'), 'utf8'));
  assert.equal(st.open, false);
  assert.equal(st.sessions.length, 1);
  assert.equal(st.sessions[0].by, 'u-admin');
  assert.deepEqual(st.sessions[0].peers, ['ops-laptop']);
  assert.ok(st.sessions[0].closedAt);
  assert.equal(run(0, Date.parse('2026-10-08T06:00:00Z')), 'none');
});

test('遠隔の保守: 同じ機械の M2Medical が持つときは、印があってもトンネルに触れない（第8.6.9節）', () => {
  const dir = mkdtempSync(join(tmpdir(), 'm2o-maint-'));
  const status = join(dir, 'ts.json');
  writeFileSync(status, JSON.stringify({ BackendState: 'Running', Peer: {} }));
  const run = (running: 0 | 1) => execFileSync(process.execPath, [join(onsite, 'maintenance-state.mjs'), dir, String(running), status], {
    env: { ...process.env, M2O_NOW_MS: String(Date.parse('2026-10-09T01:00:00Z')), M2O_MAINT_FOREIGN: '1' },
  }).toString();
  writeFileSync(join(dir, 'maintenance-request.json'), JSON.stringify({ until: '2026-10-09T05:00:00Z', by: 'u-admin' }));
  // M2Medical が開けたトンネル（動いている）を閉じない。M2Office の印でも開けない
  assert.equal(run(1), 'none');
  assert.equal(run(0), 'none');
  assert.equal(JSON.parse(readFileSync(join(dir, 'maintenance.json'), 'utf8')).open, false);
});

/** 共通の入口を、偽の caddy と launchctl で動かす。 */
function frontRig(locale = 'C') {
  const dir = mkdtempSync(join(tmpdir(), 'm2-front-'));
  const log = join(dir, 'calls.log');
  const caddy = join(dir, 'caddy');
  // 設定の中に BROKEN があれば、確かめに失敗する
  writeFileSync(caddy, `#!/bin/bash\necho "caddy $*" >> ${log}\nif [ "$1" = validate ]; then ! grep -rq BROKEN "$(dirname "$3")/sites"; fi\n`);
  const launchctl = join(dir, 'launchctl');
  // 起動したかどうかを印のファイルで覚える
  writeFileSync(launchctl, `#!/bin/bash\necho "launchctl $*" >> ${log}\ncase "$1" in print) [ -f ${dir}/loaded ] ;; bootstrap) touch ${dir}/loaded ;; bootout) rm -f ${dir}/loaded ;; esac\n`);
  chmodSync(caddy, 0o755); chmodSync(launchctl, 0o755);
  const front = join(dir, 'front');
  const env = { ...process.env, ...localeEnv(locale), M2_FRONT_DIR: front, M2_FRONT_PLIST_DIR: join(dir, 'plist'), M2_FRONT_LAUNCHCTL: launchctl };
  const site = (name: string, body: string) => { const f = join(dir, `${name}.in`); writeFileSync(f, body); return f; };
  const run = (...args: string[]) => execFileSync('/bin/bash', [frontSh, ...args, ...(args[0] === 'owner' ? [] : ['--caddy', caddy])], { env, stdio: 'pipe' }).toString();
  const calls = () => (existsSync(log) ? readFileSync(log, 'utf8') : '');
  return { dir, front, site, run, calls, plist: join(dir, 'plist', 'jp.m2front.caddy.plist') };
}

for (const locale of LOCALES) test(`共通の入口: 先に入れた製品が作り、後の製品は名前の設定を置いて読み直すだけ。片方を外してももう片方は残る（第8.6.9節。${locale}）`, () => {
  const r = frontRig(locale);
  r.run('put-site', 'm2office', r.site('o', 'office.example.jp {\n\trespond "o"\n}\n'));
  assert.equal(readFileSync(join(r.front, 'Caddyfile'), 'utf8').match(/^import sites\/\*\.caddy$/m)?.[0], 'import sites/*.caddy');
  assert.equal(readFileSync(join(r.front, 'CONTRACT'), 'utf8').trim(), '1');
  assert.equal(statSync(join(r.front, 'sites', 'm2office.caddy')).mode & 0o777, 0o600);
  assert.match(r.calls(), /launchctl bootstrap system .*jp\.m2front\.caddy\.plist/);
  if (process.platform === 'darwin') execFileSync('plutil', ['-lint', r.plist]);
  assert.match(readFileSync(r.plist, 'utf8'), /<string>jp\.m2front\.caddy<\/string>/);

  // 後から入れた製品は、読み直すだけ（入口を作り直さない）
  r.run('put-site', 'm2medical', r.site('m', 'medical.example.jp {\n\trespond "m"\n}\n'));
  assert.match(r.calls(), /caddy reload --config .*front\/Caddyfile/);
  assert.deepEqual(readdirSync(join(r.front, 'sites')).sort(), ['m2medical.caddy', 'm2office.caddy']);

  // 誤った設定は確かめで止め、前の設定に戻す（もう片方の入口を止めない）
  assert.throws(() => r.run('put-site', 'm2medical', r.site('bad', 'BROKEN {\n}\n')));
  assert.match(readFileSync(join(r.front, 'sites', 'm2medical.caddy'), 'utf8'), /medical\.example\.jp/);

  // 片方を外しても、もう片方は残り、入口は動き続ける
  r.run('remove-site', 'm2office');
  assert.deepEqual(readdirSync(join(r.front, 'sites')), ['m2medical.caddy']);
  assert.ok(existsSync(join(r.dir, 'loaded')));
  // 受ける名前が無くなれば止める
  r.run('remove-site', 'm2medical');
  assert.ok(!existsSync(join(r.dir, 'loaded')));
});

for (const locale of LOCALES) test(`共通の入口: より新しい取り決めで作られた共通の設定は置き換えない。遠隔の保守を持つ製品の名前を読む（${locale}）`, () => {
  const r = frontRig(locale);
  r.run('put-site', 'm2office', r.site('o', 'office.example.jp {\n}\n'));
  writeFileSync(join(r.front, 'CONTRACT'), '9\n');
  writeFileSync(join(r.front, 'Caddyfile'), '# 新しい写しが書いた\nimport sites/*.caddy\n');
  r.run('put-site', 'm2office', r.site('o2', 'office.example.jp {\n\trespond "2"\n}\n'));
  assert.match(readFileSync(join(r.front, 'Caddyfile'), 'utf8'), /新しい写しが書いた/);
  assert.equal(r.run('owner'), '');
  writeFileSync(join(r.front, 'maintenance-owner'), 'M2Medical\n');
  assert.equal(r.run('owner'), 'M2Medical');
  assert.throws(() => r.run('put-site', 'Bad Name', r.site('x', 'x {\n}\n')));
});
