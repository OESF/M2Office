/**
 * @file PostgreSQL の接続の置き場（`pg.Pool`）を作る共通の関数。切れた接続でプロセスが落ちないようにする。
 *
 * node-postgres は、使っていない接続がデータベース側で切られると、置き場に `'error'` を出す。
 * 受け止める先が無いと Node.js はこれを捕まえられない例外として扱い、API とワーカーのプロセスごと落ちる
 * （データベースのコンテナを起動し直したときに起きた）。ここで受け止めて警告を残し、置き場はそのまま使い続ける。
 * 切れた接続は node-postgres が置き場から外すので、次の問い合わせで新しくつなぎ直す。
 *
 * @see 開発規約 第7章 ログ
 */

import pg from 'pg';
import { silentLogger, type Logger } from '../log/logger.js';

/** 置き場を作るときの指定。 */
export interface PoolOptions {
  /** 同時に持つ接続の数の上限。 */
  max: number;
  /** ログに出す置き場の名前（例: `inquiries`）。どの置き場の接続が切れたかを見分けるため。 */
  name: string;
  /** 警告の書き先。省略すると {@link installPoolLogger} で置いたロガーを使う。 */
  logger?: Logger;
}

let defaultLogger: Logger = silentLogger;

/**
 * このプロセスの置き場が使うロガーを置く（外すときは `null`）。
 *
 * @remarks
 * API とワーカーの起動のときに、置き場を作る前に 1 度だけ呼ぶ。置き場は数が多く、
 * 作る場所ごとにロガーを渡すと受け渡しが広がるため、プロセスに 1 つ置く形にした。
 * 置いていないとき（自動テストや道具）は何も書かない。
 */
export function installPoolLogger(logger: Logger | null): void {
  defaultLogger = logger ?? silentLogger;
}

/**
 * 接続の置き場を作り、切れた接続の `'error'` を受け止める見張りを付ける。
 *
 * @param connectionString 接続文字列。ログには残さない
 * @param opts 接続の数の上限・置き場の名前・ロガー
 * @returns 見張りの付いた置き場
 *
 * @remarks
 * `new pg.Pool(...)` を直接書かず、必ずこの関数を通す。見張りの無い置き場は、
 * データベースの起動し直しでプロセスを落とす。
 *
 * @example
 * ```ts
 * this.pool = createPool(connectionString, { max: 4, name: 'inquiries' });
 * ```
 */
export function createPool(connectionString: string, opts: PoolOptions): pg.Pool {
  const pool = new pg.Pool({ connectionString, max: opts.max });
  watchPool(pool, opts.name, opts.logger);
  return pool;
}

/**
 * 既にある置き場に、切れた接続の見張りを付ける。
 *
 * @param pool 見張る置き場
 * @param name ログに出す置き場の名前
 * @param logger 警告の書き先。省略すると {@link installPoolLogger} で置いたロガー
 *
 * @remarks
 * 2 か所で受け止める。
 * - 置き場の `'error'`: 使っていない接続が切れたとき。node-postgres はその接続を置き場から外したうえで出すので、
 *   警告を残すだけでよい。
 * - 接続ごとの `'error'`: `pool.connect()` で借りている間（トランザクションの途中など）に切れたとき。
 *   借りている間は置き場の見張りが外れるため、接続にも受け止める先を付ける。実行中の問い合わせは失敗として
 *   呼び出し側に返り、返した接続は使えないものとして置き場から外れる。
 *
 * ログには置き場の名前・失敗の種類（`code`）・短い理由だけを残し、接続文字列や秘密の値は残さない。
 */
export function watchPool(pool: pg.Pool, name: string, logger?: Logger): void {
  const log = () => logger ?? defaultLogger;
  pool.on('error', (err) => {
    log().warn('データベースの接続が切れました。次の問い合わせでつなぎ直します', { pool: name, ...describePoolError(err) });
  });
  pool.on('connect', (client) => {
    client.on('error', (err) => {
      // 借りている間でも使っていない間でも届く。使っていない接続なら置き場の 'error' でも警告を残すので、ここは詳しいログだけにする
      log().debug('接続が切れました', { pool: name, ...describePoolError(err) });
    });
  });
}

/**
 * 接続の失敗を、ログに残してよい形にする。
 *
 * @remarks 理由の文に接続文字列（`postgres://…`）が混ざっていても伏せる。呼び出し履歴は残さない（調査に要らないため）
 */
export function describePoolError(err: unknown): { code?: string; reason: string } {
  const code = err && typeof err === 'object' && typeof (err as { code?: unknown }).code === 'string'
    ? (err as { code: string }).code
    : undefined;
  const raw = err instanceof Error ? err.message : String(err);
  const reason = raw.replace(/postgres(?:ql)?:\/\/\S+/gi, '[接続文字列]').slice(0, 200);
  return code ? { code, reason } : { reason };
}
