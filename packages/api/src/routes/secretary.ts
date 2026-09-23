/**
 * @file 秘書への依頼を受け付ける API。どの層（直接応答・取次・対話）で答えたかも返す。
 *
 * 手元のファイルを 1 つ添えられる（`fileId`。仕様書 第10.10節）。
 *
 * @see 仕様書 第10.9節 応答の経路、第10.10節 秘書にファイルを渡す
 */

import { Hono } from 'hono';
import type { RequestContext } from '@m2office/shared';
import { claimUntold, listLookups } from '../secretary/lookups.js';
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

  /**
   * 後ろへ回した調べものの状態（仕様書 第10.11.6・10.11.7節）。
   *
   * @remarks
   * 画面はこれを定期的に読み、**動いているものを処理中として見せる**。
   * 秘書が黙り込んだように見えることを防ぐ、いちばん効く手当てである。
   *
   * 画面を開き直したときも同じものが返る。進み具合は変化したときにしか
   * 変わらないため、送り直しが無いと、途中から見た人には何も動いていないように見える。
   */
  app.get('/lookups', async (c) => {
    const ctx = c.get('ctx');
    const items = await listLookups(deps.repo, ctx.tenant.id, ctx.user.id);
    return c.json({ items });
  });

  /**
   * まだ伝えていない調べものを受け取る（仕様書 第10.11.7節「持ち越し」）。
   *
   * @remarks
   * **読むだけの口ではない。** 返したものは「伝えた」として記録される。
   * 画面はこれを定期的に呼び、返ってきたものを秘書の応答として出す。
   * 記録を先に取るため、音声の側と二重に伝えることはない。
   */
  app.post('/lookups/claim', async (c) => {
    const ctx = c.get('ctx');
    const items = await claimUntold(deps.repo, ctx.tenant.id, ctx.user.id);
    return c.json({ items });
  });

  return app;
}
