/**
 * @file 従業員の顔写真を見る API（仕様書 第30.5.4節、ADR-0055）。
 *
 * 顔写真は**社内の全員が見られる**（人事区画に入っていなくてよい）。人事・給与を切っている会社では出さない。
 * 入れる・外す・まとめて取り込むのは人事区画の人だけ（`/v1/hr`）。
 */

import { Hono } from 'hono';
import type { AppDeps } from '../context.js';
import type { AppEnv } from '../middleware/tenant.js';

/**
 * 顔写真を見る API（`/v1/hr-photos`）。
 *
 * @remarks テナント境界: 置き場が会社ごとに絞る（不変則 I-2）。種類を推測させず（`nosniff`）、何も読み込ませない
 */
export function hrPhotosRoute(deps: AppDeps) {
  const app = new Hono<AppEnv>();

  /** 従業員の顔写真。取り込み直すと画面の URL の `v=` が変わる。 */
  app.get('/:employeeId', async (c) => {
    const { tenant } = c.get('ctx');
    const photo = await deps.hr.service.photo(tenant.id, c.req.param('employeeId'));
    if (!photo) return c.json({ error: '写真はありません' }, 404);
    return new Response(Buffer.from(photo.bytes), {
      headers: {
        'content-type': photo.mime,
        'x-content-type-options': 'nosniff',
        'content-security-policy': "default-src 'none'; sandbox",
        // 個人の画像であり、共有の置き場に残させない
        'cache-control': 'private, max-age=86400',
      },
    });
  });

  return app;
}
