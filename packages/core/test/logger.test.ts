/**
 * @file ロガーの単体テスト。レベルによる絞り込み、JSON の形、伏せ字、例外の記録を確かめる。
 *
 * @see 開発規約 第7章 ログ
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createLogger, createLoggerFromEnv, type LogLevel } from '../src/index.js';

/** 書き出しを配列に集めるロガーを作る。 */
function capture(level: LogLevel) {
  const lines: { line: string; level: LogLevel }[] = [];
  const log = createLogger({
    service: 'test', level, format: 'json',
    write: (line, lv) => lines.push({ line, level: lv }),
    now: () => new Date('2026-09-22T00:00:00Z'),
  });
  return { log, lines, records: () => lines.map((l) => JSON.parse(l.line) as Record<string, unknown>) };
}

test('指定したレベルより詳しいものは出力しない', () => {
  const { log, records } = capture('info');
  log.debug('出ない');
  log.info('出る');
  log.warn('出る');
  log.error('出る');
  assert.deepEqual(records().map((r) => r['level']), ['info', 'warn', 'error']);
  assert.equal(log.enabled('debug'), false);
  assert.equal(log.enabled('warn'), true);
});

test('1 行 1 件の JSON で、必須の項目を持つ', () => {
  const { log, records } = capture('debug');
  log.info('要求', { requestId: 'r-1', status: 200 });
  assert.deepEqual(records()[0], {
    time: '2026-09-22T00:00:00.000Z', level: 'info', service: 'test', msg: '要求', requestId: 'r-1', status: 200,
  });
});

test('子のロガーは固定した項目を毎回添える', () => {
  const { log, records } = capture('debug');
  const run = log.child({ runId: 'run-1', tenantId: 't-a' });
  run.info('実行を開始');
  run.child({ stepId: 's1' }).debug('ステップを開始');
  assert.equal(records()[0]!['runId'], 'run-1');
  assert.equal(records()[1]!['stepId'], 's1');
  assert.equal(records()[1]!['tenantId'], 't-a');
});

test('認証情報と中身らしい項目は伏せ字にし、長い文字列は切り詰める', () => {
  const { log, records } = capture('debug');
  log.info('確認', {
    password: 'p@ss', token: 'abc', Authorization: 'Bearer x', transcript: '会議の全文',
    nested: { cookie: 'm2o_session=zzz', ok: 'そのまま' },
    long: 'あ'.repeat(500),
  });
  const r = records()[0]!;
  for (const k of ['password', 'token', 'Authorization', 'transcript']) assert.equal(r[k], '[伏せ字]', k);
  assert.deepEqual(r['nested'], { cookie: '[伏せ字]', ok: 'そのまま' });
  assert.ok(String(r['long']).length < 260, '長い文字列は切り詰める');
});

test('例外は名前とメッセージを残し、呼び出し履歴は error のときだけ残す', () => {
  const { log, records } = capture('debug');
  const err = new TypeError('壊れた');
  log.warn('注意', { err });
  log.error('失敗', { err });
  const [w, e] = records() as { err: Record<string, unknown> }[];
  assert.equal(w!.err['name'], 'TypeError');
  assert.equal(w!.err['stack'], undefined);
  assert.ok(String(e!.err['stack']).includes('TypeError'));
});

test('error と warn は標準エラー、それ以外は標準出力に分ける前提でレベルを渡す', () => {
  const { log, lines } = capture('debug');
  log.error('e'); log.info('i');
  assert.deepEqual(lines.map((l) => l.level), ['error', 'info']);
});

test('環境変数が無ければ、開発は debug・pretty、本番は info・json', () => {
  const dev = createLoggerFromEnv('api', {});
  assert.equal(dev.enabled('debug'), true);
  const prod = createLoggerFromEnv('api', { NODE_ENV: 'production' });
  assert.equal(prod.enabled('debug'), false);
  assert.equal(prod.enabled('info'), true);
  const custom = createLoggerFromEnv('api', { LOG_LEVEL: 'warn' });
  assert.equal(custom.enabled('info'), false);
});
