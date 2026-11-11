/**
 * @file 会社の Chat アプリの受け口（仕様書 第10.16.3節「受け口」、ADR-0138）。Google Chat が、ログインの無いまま呼ぶ。
 *
 * 会社の判定とログインより前に置き、URL の鍵（M2Office はハッシュだけを持つ）から会社を引き、
 * **Google が付ける署名（ID トークン）を確かめる**（送り主が Chat であること・宛先がこの受け口であること）。合わないものは捨てる。
 * 確かめたらすぐに空の答えを返し、秘書への受け渡しは後ろで行う（答えは後から Chat の API で送る）。
 * 見本の会社（開発）では、Google の署名の代わりに決まった印（`Bearer mock-chat`）を受ける。
 * 本文は 256 KB まで。記録には文を残さない。
 */

import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { ChatTokenVerifier, chatHookHash } from '@m2office/core';
import type { AppDeps } from '../context.js';
import { isOperational } from '../middleware/tenant.js';
import type { ChatSecretaryBridge } from '../chat/bridge.js';

/** 鍵の形（base64url の 32 字）。 */
export const CHAT_HOOK_KEY = /^[A-Za-z0-9_-]{32}$/;
/** 受け口の道の頭。 */
export const CHAT_HOOK_PATH = '/v1/hooks/google-chat';
const MAX_BYTES = 256 * 1024;
/** 見本の会社で、署名の代わりに受ける印。 */
export const MOCK_CHAT_TOKEN = 'Bearer mock-chat';

/**
 * Chat の受け口の API（`POST /v1/hooks/google-chat/:key`）。
 *
 * @remarks 知らない鍵・止めた会社は 404、署名が違えば 401
 */
export function chatHooksRoute(deps: AppDeps, bridge: ChatSecretaryBridge, verifier: ChatTokenVerifier = new ChatTokenVerifier()) {
  const app = new Hono();
  app.use('*', bodyLimit({ maxSize: MAX_BYTES, onError: (c) => c.json({}, 413) }));

  app.post('/:key', async (c) => {
    const key = c.req.param('key');
    if (!CHAT_HOOK_KEY.test(key)) return c.json({}, 404);
    const tenantId = await deps.chatInbox.hookTenantOf(chatHookHash(key)).catch(() => null);
    if (!tenantId) return c.json({}, 404);
    // 会社の判定より前に受けるため、会社の状態（停止・緊急停止・解約）をここで確かめる（第23.8.6節）
    const tenant = await deps.repo.findTenantById(tenantId);
    if (!tenant || !isOperational(tenant)) return c.json({}, 404);
    const auth = c.req.header('authorization');
    const mock = deps.connector.sourceFor(tenantId) === 'mock';
    const problem = mock && auth === MOCK_CHAT_TOKEN ? null : await verifier.check(auth, `${CHAT_HOOK_PATH}/${key}`);
    if (problem) {
      deps.log.warn('Chat の受け口で署名を確かめられませんでした', { tenantId, reason: problem });
      return c.json({}, 401);
    }
    let payload: unknown;
    try {
      payload = await c.req.json();
    } catch {
      return c.json({}, 400);
    }
    // すぐに返し、秘書への受け渡しは後ろで行う（答えは Chat の API で送る）
    void bridge.handle(tenantId, payload).catch((err: unknown) => deps.log.warn('Chat の依頼を扱えませんでした', { tenantId, error: String(err) }));
    return c.json({});
  });

  return app;
}
