/**
 * @file 要求ごとの記録の単体テスト（開発規約 第7.2節）。画面が数秒ごとに読み直す要求は、成功して速いものを書かず、
 * 失敗・遅い応答・そのほかの要求は書く。受け口の鍵は伏せる。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { logPath, quietPoll } from '../src/middleware/logging.js';

test('画面の読み直しは、成功して 1 秒より速いものだけを書かない（LOG_POLLS=true なら書く）', () => {
  for (const p of ['/v1/notifications', '/v1/approvals', '/v1/jobs', '/v1/agents', '/v1/secretary/lookups', '/v1/secretary/lookups/claim']) {
    assert.equal(quietPoll('GET', p, 200, 40, false), true, p);
  }
  assert.equal(quietPoll('GET', '/v1/jobs', 200, 40, true), false);
  assert.equal(quietPoll('GET', '/v1/jobs', 500, 40, false), false);
  assert.equal(quietPoll('GET', '/v1/jobs', 401, 40, false), false);
  assert.equal(quietPoll('GET', '/v1/jobs', 200, 1500, false), false);
  assert.equal(quietPoll('POST', '/v1/jobs', 201, 40, false), false);
  assert.equal(quietPoll('GET', '/v1/jobs/abc', 200, 40, false), false);
  assert.equal(quietPoll('GET', '/v1/reservations', 200, 40, false), false);
});

test('受け口の鍵は記録に残さない', () => {
  assert.equal(logPath('/v1/hooks/signage/abcdef'), '/v1/hooks/signage/***');
  assert.equal(logPath('/v1/jobs'), '/v1/jobs');
});
