/**
 * @file API の要求ごとのログと、想定外のエラーの共通処理。
 *
 * 要求ごとに ID を振り、応答の `X-Request-Id` と同じ値でログに残す。
 * 利用者から「エラーになった」と言われたとき、この ID でログを引けるようにするため。
 * 要求の本文と URL の問い合わせ文字列は記録しない（開発規約 第7.5節）。
 *
 * @see 開発規約 第7章 ログ
 */

import { randomUUID } from 'node:crypto';
import type { Context, Next } from 'hono';
import type { Logger } from '@m2office/core';
import type { AppEnv } from './tenant.js';

/** 要求の ID として受け付ける形。外から渡された値をそのまま信じず、形を確かめる。 */
const REQUEST_ID = /^[A-Za-z0-9-]{8,64}$/;

/**
 * 要求ごとに 1 行のログを書くミドルウェア。
 *
 * @remarks
 * レベルは状態コードで決める。500 以上は `error`、それ以外は `info`。
 * 生存確認（`/health`）は量が多く調査に要らないため `debug` とする。
 */
export function requestLogger(log: Logger) {
  return async (c: Context<AppEnv>, next: Next) => {
    const given = c.req.header('x-request-id');
    const requestId = given && REQUEST_ID.test(given) ? given : randomUUID();
    c.set('requestId', requestId);
    c.set('log', log.child({ requestId }));
    c.header('X-Request-Id', requestId);

    const startedAt = Date.now();
    await next();

    const status = c.res.status;
    const ctx = c.get('ctx');
    const fields = {
      requestId,
      method: c.req.method,
      path: logPath(c.req.path), // 問い合わせ文字列は含めない。受け口の鍵は伏せる
      status,
      ms: Date.now() - startedAt,
      tenantId: ctx?.tenant.id ?? c.get('tenant')?.id,
      userId: ctx?.user.id,
    };
    if (c.req.path === '/health') log.debug('要求', fields);
    else if (status >= 500) log.error('要求', fields);
    else log.info('要求', fields);
  };
}

/**
 * 記録に残す要求のパス。受け口（予約・サイネージ）の URL の鍵は伏せる（仕様書 第31.8.2節・第29.13.1節）。
 *
 * @example logPath('/v1/hooks/signage/abc…') // → '/v1/hooks/signage/***'
 */
export function logPath(path: string): string {
  return path.replace(/^(\/v1\/hooks\/[a-z-]+)\/[^/]+/, '$1/***');
}

/**
 * 想定外のエラーを記録し、利用者には中身を見せずに 500 を返す。
 *
 * @remarks
 * 例外のメッセージには内部の事情が含まれうるため、応答には出さない。
 * 代わりに要求の ID を返し、問い合わせのときにログと突き合わせられるようにする。
 */
export function onUnexpectedError(log: Logger) {
  return (err: Error, c: Context<AppEnv>) => {
    const requestId = c.get('requestId');
    // 本文が JSON として読めないのは利用者側の誤りであり、error にしない（開発規約 第7.2節）
    if (err instanceof SyntaxError) {
      return c.json({ error: '要求の形式が正しくありません（JSON として読めません）', requestId }, 400);
    }
    (c.get('log') ?? log).error('想定外のエラー', { requestId, method: c.req.method, path: logPath(c.req.path), err });
    return c.json({ error: '内部エラーが発生しました。時間をおいて、もう一度お試しください。', requestId }, 500);
  };
}
