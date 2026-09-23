/**
 * @file 秘書への依頼を受け付ける API。どの層（直接応答・取次・対話）で答えたかも返す。
 *
 * 手元のファイルを 1 つ添えられる（`fileId`。仕様書 第10.10節）。
 *
 * @see 仕様書 第10.9節 応答の経路、第10.10節 秘書にファイルを渡す
 */

import { Hono } from 'hono';
import type { RequestContext } from '@m2office/shared';
import type { AppDeps } from '../context.js';

/**
 * 秘書への依頼を受け付ける。
 *
 * 応答は 3 層に振り分けられ、どの層で答えたかを返す（仕様書 第10.9節）。
 * 層 1 は LLM を介さないため、費用も遅延も発生しない。
 */
export function secretaryRoute(deps: AppDeps) {
  const app = new Hono<{ Variables: { ctx: RequestContext } }>();

  app.post('/', async (c) => {
    const ctx = c.get('ctx');
    const { message, fileId } = await c.req.json<{ message: string; fileId?: string }>();
    if (!message?.trim()) {
      return c.json({ error: '依頼の内容を入力してください' }, 400);
    }
    const started = Date.now();
    // ファイルは本人が上げたものだけを読む。他人の ID を書いても読まない（仕様書 第10.10.2節）
    const reply = await deps.secretary.respond(ctx.tenant.id, ctx.user.id, message, fileId?.trim() || undefined);
    return c.json({ ...reply, elapsedMs: Date.now() - started });
  });

  return app;
}
