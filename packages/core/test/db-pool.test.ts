/**
 * @file 接続の置き場（`createPool`・`watchPool`）の単体テスト。
 * データベースの起動し直しで接続が切れても、プロセスが例外で落ちず、警告を残し、次の問い合わせでつなぎ直すことを確かめる。
 * 本物のデータベースは使わず、node-postgres の置き場に見本の接続を差し込む。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import pg from 'pg';
import { createLogger, createPool, describePoolError, installPoolLogger, watchPool, type Logger } from '../src/index.js';

/** 書いたログの行を手元に貯めるロガー。 */
function capture(): { log: Logger; lines: string[] } {
  const lines: string[] = [];
  const log = createLogger({ service: 'test', level: 'debug', format: 'json', write: (line) => lines.push(line) });
  return { log, lines };
}

/** データベースの起動し直しで切られたときと同じ形の失敗。 */
function terminated(): Error {
  return Object.assign(new Error('terminating connection due to administrator command'), { code: '57P01' });
}

/** node-postgres の接続の見本。つなぐ・問い合わせる・閉じるだけを行い、作った数を数える。 */
function fakeClientClass() {
  const made: FakeClient[] = [];
  class FakeClient extends EventEmitter {
    readonly id = made.length + 1;
    _queryable = true;
    _ending = false;
    constructor() {
      super();
      made.push(this);
    }
    connect(cb: (err?: Error) => void): void {
      setImmediate(() => cb());
    }
    query(_text: string, _values: unknown, cb: (err: Error | undefined, res: { rows: { id: number }[] }) => void): void {
      setImmediate(() => cb(undefined, { rows: [{ id: this.id }] }));
    }
    end(cb?: () => void): Promise<void> | void {
      this._ending = true;
      if (cb) return void setImmediate(cb);
      return Promise.resolve();
    }
    ref(): void {}
    unref(): void {}
    /** データベース側で接続が切られたことにする（node-postgres の接続と同じく、使えなくしてから 'error' を出す）。 */
    drop(): void {
      this._queryable = false;
      this.emit('error', terminated());
    }
  }
  return { FakeClient, made };
}

test('見張りの無い置き場は、切れた接続の error で例外を投げる（直す前の落ち方）', () => {
  const pool = new pg.Pool({ connectionString: 'postgres://u:p@localhost:1/x' });
  assert.throws(() => pool.emit('error', terminated()), /administrator command/);
});

test('createPool の置き場は、error を出しても例外を投げず、名前と種類を警告に残す', async () => {
  const { log, lines } = capture();
  const pool = createPool('postgres://m2office_app:s3cret@localhost:3105/m2office', { max: 2, name: 'inquiries', logger: log });
  assert.doesNotThrow(() => pool.emit('error', terminated()));
  assert.equal(lines.length, 1);
  const rec = JSON.parse(lines[0]!) as Record<string, unknown>;
  assert.equal(rec['level'], 'warn');
  assert.equal(rec['pool'], 'inquiries');
  assert.equal(rec['code'], '57P01');
  assert.ok(!lines[0]!.includes('s3cret'));
  assert.ok(!lines[0]!.includes('postgres://'));
  await pool.end();
});

test('使っていない接続が切れたら置き場から外れ、次の問い合わせで新しい接続につなぎ直す', async () => {
  const { log, lines } = capture();
  const { FakeClient, made } = fakeClientClass();
  const pool = new pg.Pool({ Client: FakeClient as unknown as typeof pg.Client, max: 1 });
  watchPool(pool, 'repository', log);

  const first = await pool.query<{ id: number }>('select 1');
  assert.equal(first.rows[0]?.id, 1);
  assert.equal(pool.idleCount, 1);

  assert.doesNotThrow(() => made[0]!.drop());
  assert.equal(pool.totalCount, 0);
  assert.ok(lines.some((l) => l.includes('"level":"warn"') && l.includes('"pool":"repository"')));

  const second = await pool.query<{ id: number }>('select 1');
  assert.equal(second.rows[0]?.id, 2);
  assert.equal(made.length, 2);
  await pool.end();
});

test('借りている間（トランザクションの途中）に切れても例外を投げず、返した接続は外れる', async () => {
  const { log } = capture();
  const { FakeClient, made } = fakeClientClass();
  const pool = new pg.Pool({ Client: FakeClient as unknown as typeof pg.Client, max: 1 });
  watchPool(pool, 'cards', log);

  const client = await pool.connect();
  assert.doesNotThrow(() => made[0]!.drop());
  client.release();
  assert.equal(pool.totalCount, 0);

  const again = await pool.query<{ id: number }>('select 1');
  assert.equal(again.rows[0]?.id, 2);
  await pool.end();
});

test('ロガーを渡さなければ、installPoolLogger で置いたロガーに書く', async () => {
  const { log, lines } = capture();
  installPoolLogger(log);
  try {
    const pool = createPool('postgres://u:p@localhost:1/x', { max: 1, name: 'notices' });
    pool.emit('error', terminated());
    assert.equal(lines.length, 1);
    assert.ok(lines[0]!.includes('"pool":"notices"'));
    await pool.end();
  } finally {
    installPoolLogger(null);
  }
});

test('describePoolError は理由の文に混ざった接続文字列を伏せる', () => {
  const d = describePoolError(new Error('could not connect to postgres://admin:hunter2@db:5432/m2office'));
  assert.equal(d.code, undefined);
  assert.ok(!d.reason.includes('hunter2'));
  assert.ok(d.reason.includes('[接続文字列]'));
  assert.deepEqual(describePoolError('切れた'), { reason: '切れた' });
});
