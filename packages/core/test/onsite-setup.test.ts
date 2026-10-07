/**
 * @file ローカルの形のセットアップのスクリプトの確かめ（仕様書 第8.6.1節、ADR-0077）。
 *
 * 機械を変えずに確かめられるところ（スクリプトの文法、雛形を埋めた結果）だけを見る。
 * 雛形の名前がすべて埋まること、launchd の設定が正しい形であること、入口の TLS の段（名前の形と IP の形）、
 * 秘密の値が答えのファイル（setup.conf）ではなく環境変数のファイルに入ることを確かめる。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../..', import.meta.url));
const onsite = join(root, 'deploy/onsite');

const ANSWERS = {
  INSTALL_DIR: '/Library/M2Office', REPO_DIR: '/Library/M2Office/app', RELEASE_DIR: '/Library/M2Office/app/dist-release',
  ENV_FILE: '/Library/M2Office/m2office.env', CADDYFILE: '/Library/M2Office/Caddyfile', DATA_DIR: '/Volumes/RAID/M2Office', BACKUP_DIR: '/Volumes/Backup/M2Office',
  API_PORT: '3101', DB_PORT: '5433', HOST: 'office.example.jp', SUBDOMAIN: 'office', ACME_EMAIL: 'admin@example.jp',
  NODE_BIN: '/opt/homebrew/opt/node@22/bin/node', PG_BIN: '/opt/homebrew/opt/postgresql@17/bin', CADDY_BIN: '/opt/homebrew/opt/caddy/bin/caddy',
  LOCAL_LLM_URL: 'http://127.0.0.1:11434/v1', LOCAL_LLM_MODEL: 'gemma3', LOCAL_LLM_EMBED_MODEL: 'embeddinggemma', GEMINI_API_KEY: '',
  GOOGLE_LOGIN_CLIENT_ID: '', GOOGLE_LOGIN_CLIENT_SECRET: '', SECRET_KEY: 'k'.repeat(64), DB_APP_PASSWORD: 'app-pass', DB_OWNER_PASSWORD: 'owner-pass', UPDATE_HOUR: '3',
  HEARTBEAT_URL: 'https://ops.example/heartbeat', HEARTBEAT_TOKEN: 'hb-token', MACHINE_ID: 'm-001',
};

function render(extra: Record<string, string>) {
  const dir = mkdtempSync(join(tmpdir(), 'm2o-onsite-'));
  const answers = join(dir, 'answers');
  writeFileSync(answers, Object.entries({ ...ANSWERS, ...extra }).map(([k, v]) => `${k}=${v}`).join('\n'));
  execFileSync('/bin/bash', [join(onsite, 'setup.sh'), '--render-only', join(dir, 'out'), '--answers', answers], { env: { ...process.env, NODE_BIN: process.execPath } });
  return join(dir, 'out');
}

test('スクリプトの文法', () => {
  for (const f of ['setup.sh', 'update.sh', 'maintenance.sh']) execFileSync('/bin/bash', ['-n', join(onsite, f)]);
});

test('雛形がすべて埋まり、launchd の設定は正しい形', () => {
  const out = render({ TLS_BLOCK: '\\ttls {\\n\\t\\tdns cloudflare tok-123\\n\\t}' });
  const env = readFileSync(join(out, 'm2office.env'), 'utf8');
  assert.doesNotMatch(env, /\{\{/);
  assert.match(env, /^M2O_APP_ROOT=\/Library\/M2Office\/app\/dist-release$/m);
  assert.match(env, /^DATABASE_URL=postgres:\/\/m2office_app:app-pass@127\.0\.0\.1:5433\/m2office$/m);
  assert.match(env, /^GOOGLE_OAUTH_REDIRECT_URI=https:\/\/office\.example\.jp\/v1\/oauth\/google\/callback$/m);
  assert.match(env, /^M2O_PG_BIN=\/opt\/homebrew\/opt\/postgresql@17\/bin$/m);
  const caddy = readFileSync(join(out, 'Caddyfile'), 'utf8');
  assert.match(caddy, /\n\ttls \{\n\t\tdns cloudflare tok-123\n\t\}\n/);
  assert.match(caddy, /root \* \/Library\/M2Office\/app\/dist-release\/web/);
  assert.match(caddy, /import \/Library\/M2Office\/front\.d\/\*\.caddy/);
  const plists = readdirSync(join(out, 'launchd'));
  assert.deepEqual(plists.sort(), ['jp.m2office.api.plist', 'jp.m2office.caddy.plist', 'jp.m2office.maintenance.plist', 'jp.m2office.postgres.plist', 'jp.m2office.update.plist', 'jp.m2office.worker.plist']);
  assert.match(env, /^M2O_HEARTBEAT_URL=https:\/\/ops\.example\/heartbeat$/m);
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
  assert.match(readFileSync(join(out, 'Caddyfile'), 'utf8'), /\n\ttls internal\n/);
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
