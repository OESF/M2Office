/**
 * @file 開発者向けのヘルプの API の定義のページの確かめ（仕様書 第6.10.7.4節）。
 *
 * 定義を読み込めること、ページが切り離した枠で動く決まり（CSP の sandbox・外へ送らない・SRI）を持つこと、
 * 定義の中の文字でスクリプトから抜け出せないことを見る。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { API_DOCS_CSP, apiDocsPage, loadApiDocs } from '../src/api-docs-page.js';

const silent = { warn: () => undefined };

test('リポジトリの定義を読み、題を info.title から取る', () => {
  const docs = loadApiDocs(fileURLToPath(new URL('../../../docs/api', import.meta.url)), silent);
  const apps = docs.get('m2office-apps');
  assert.ok(apps);
  assert.equal(apps.title, 'M2Office — 外部のアプリの API');
  assert.match(apps.text, /\/v1\/inventory\/sales-events/);
});

test('名前の形に合わないファイルは読まない。置き場が無くても止まらない', () => {
  const dir = mkdtempSync(join(tmpdir(), 'm2o-apidocs-'));
  writeFileSync(join(dir, 'ok-1.openapi.yaml'), 'openapi: 3.1.0\ninfo:\n  version: 1\n  title: 試し\n');
  writeFileSync(join(dir, 'Bad Name.openapi.yaml'), 'x');
  writeFileSync(join(dir, 'notes.md'), 'x');
  assert.deepEqual([...loadApiDocs(dir, silent).keys()], ['ok-1']);
  assert.equal(loadApiDocs(dir, silent).get('ok-1')?.title, '試し');
  assert.equal(loadApiDocs(join(dir, 'none'), silent).size, 0);
});

test('ページは切り離した枠で動き、外へ送らず、版を固定した部品をハッシュで確かめて読む', () => {
  assert.match(API_DOCS_CSP, /sandbox allow-scripts/);
  assert.doesNotMatch(API_DOCS_CSP, /allow-same-origin/);
  assert.match(API_DOCS_CSP, /connect-src 'none'/);
  assert.match(API_DOCS_CSP, /frame-ancestors 'self'/);
  const html = apiDocsPage('題 <b>', 'openapi: 3.1.0\n');
  assert.match(html, /swagger-ui-dist@\d+\.\d+\.\d+\/swagger-ui-bundle\.js" integrity="sha384-[A-Za-z0-9+/=]+" crossorigin="anonymous"/);
  assert.match(html, /<title>題 &lt;b&gt;<\/title>/);
  assert.match(html, /supportedSubmitMethods: \[\]/);
});

test('定義の中の文字で、スクリプトの外へ抜け出せない', () => {
  const html = apiDocsPage('x', 'description: "</script><script>alert(1)</script>"\n');
  const script = html.slice(html.lastIndexOf('<script>'));
  assert.equal((script.match(/<\/script>/g) ?? []).length, 1);
  assert.match(script, /\\u003c\/script>\\u003cscript>alert\(1\)\\u003c\/script>/);
});

test('外部のアプリの定義が、実装の機能・道・状態・結果・上限と食い違わない（第13.4.1節・第29.20.1節）', async () => {
  const { readFileSync } = await import('node:fs');
  const core = await import('@m2office/core');
  const shared = await import('@m2office/shared');
  const yaml = readFileSync(fileURLToPath(new URL('../../../docs/api/m2office-apps.openapi.yaml', import.meta.url)), 'utf8');
  const route = readFileSync(fileURLToPath(new URL('../src/routes/app-functions.ts', import.meta.url)), 'utf8');
  // 実装した機能は、定義に道があり、認証の段がその機能の道として通し、口がある
  for (const f of shared.APP_FUNCTIONS) {
    for (const r of f.routes) {
      const [method, path] = r.split(' ') as [string, string];
      assert.match(yaml, new RegExp(`^ {2}${path.replace(/\//g, '\\/')}:$`, 'm'), `定義に ${path}`);
      assert.equal(core.appFunctionFor(method, path), f.id, `${r} は ${f.id} の道`);
      assert.match(route, new RegExp(`app\\.${method.toLowerCase()}\\('${path.replace('/v1', '').replace(/\//g, '\\/')}'`), `口が ${r}`);
    }
    assert.ok(yaml.includes(`（\`${f.id}\`）`), `定義の機能の表に ${f.id}`);
  }
  // 一覧の絞り込みの名前（定義にあるものを、口が読む）
  for (const p of ['updatedSince', 'categories', 'ids', 'codes', 'barcodes', 'limit', 'cursor']) {
    assert.match(yaml, new RegExp(`- name: ${p}\\n`), `定義に ${p}`);
    assert.match(route, new RegExp(`'${p}'`), `口が ${p} を読む`);
  }
  // 状態と行の結果
  assert.match(yaml, /enum: \[ordered, sold, cancelled, returned\]/);
  assert.match(yaml, /enum: \[held, used, released, returned, unmatched, ignored\]/);
  // 上限と鍵の形
  assert.match(yaml, new RegExp(`maxItems: ${core.SALES_LINES_MAX}\\b`));
  assert.match(yaml, new RegExp(`1 分 ${core.APP_RATE_PER_MINUTE} 回`));
  assert.match(yaml, /64 KB/);
  assert.equal(core.SALES_PAYLOAD_MAX_BYTES, 64 * 1024);
  assert.match(yaml, /`m2oa_` で始まる/);
  assert.equal(core.APP_KEY_PREFIX, 'm2oa_');
});
