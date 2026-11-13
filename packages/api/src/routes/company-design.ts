/**
 * @file 会社の見た目（`/v1/admin/company-design`。仕様書 第46章）。管理者だけ。見る・見本・作る・取り込む・直す・前の版に戻す・書き出す・サイトに貼る CSS。
 */

import { Hono } from 'hono';
import { COMPANY_DESIGN_LIMITS } from '@m2office/shared';
import type { AppDeps } from '../context.js';
import { requireRole, type AppEnv } from '../middleware/tenant.js';

/**
 * 会社の見た目の口。
 *
 * @remarks テナント境界: どれも本人の会社の分だけを読み書きする（不変則 I-2）。変えるのは管理者だけ（Q-354）
 */
export function companyDesignRoute(deps: AppDeps) {
  const app = new Hono<AppEnv>();
  app.use('*', requireRole('admin'));
  const who = (c: { get(k: 'ctx'): { tenant: { id: string }; user: { id: string } } }) => ({ tenantId: c.get('ctx').tenant.id, userId: c.get('ctx').user.id });
  const s = deps.companyDesign;
  const num = (v: string | undefined) => (v && /^\d{1,6}$/.test(v) ? Number(v) : undefined);

  /** いまの見た目と前の版。 */
  app.get('/', async (c) => {
    const t = c.get('ctx').tenant.id;
    return c.json({ current: await s.current(t), history: await s.history(t) });
  });

  /** 見本の画像（`version` を省けばいま。`compare` を渡すと並べる）。 */
  app.get('/preview.png', async (c) => {
    const png = await s.preview(c.get('ctx').tenant.id, num(c.req.query('version')), num(c.req.query('compare')));
    if (!png) return c.json({ error: 'まだ会社の見た目がありません' }, 404);
    return new Response(Buffer.from(png), { headers: { 'content-type': 'image/png', 'cache-control': 'private, max-age=300', 'x-content-type-options': 'nosniff' } });
  });

  /** DESIGN.md に書き出す。 */
  app.get('/export', async (c) => {
    const r = await s.exportDesignMd(who(c));
    if (!r) return c.json({ error: 'まだ会社の見た目がありません' }, 404);
    return new Response(r.text, { headers: { 'content-type': 'text/markdown; charset=utf-8', 'content-disposition': `attachment; filename="${r.name}"`, 'x-content-type-options': 'nosniff' } });
  });

  /** サイトに貼る CSS と手順（段 2）。 */
  app.get('/site-css', async (c) => {
    const r = await s.siteCss(who(c));
    return 'error' in r ? c.json({ error: r.error }, 400) : c.json(r);
  });

  const body = async (c: { req: { json<T>(): Promise<T> } }) => c.req.json<Record<string, unknown>>().catch(() => ({} as Record<string, unknown>));
  const str = (v: unknown, max: number) => (typeof v === 'string' ? v.slice(0, max) : '');
  const done = (c: { json(v: unknown, s?: 400): Response }, r: Awaited<ReturnType<typeof s.generate>>) => ('error' in r ? c.json({ error: r.error }, 400) : c.json({ design: r.design, notes: r.notes }));

  /** AI がロゴとサイトから作る（作り直す）。 */
  app.post('/generate', async (c) => done(c, await s.generate(who(c), str((await body(c))['request'], COMPANY_DESIGN_LIMITS.requestChars))));

  /** DESIGN.md を取り込む（`text` と `name`、または `url`）。 */
  app.post('/import', async (c) => {
    const b = await body(c);
    const request = str(b['request'], COMPANY_DESIGN_LIMITS.requestChars);
    if (typeof b['url'] === 'string' && b['url']) return done(c, await s.importUrl(who(c), b['url'], request));
    const text = str(b['text'], COMPANY_DESIGN_LIMITS.importChars);
    if (!text.trim()) return c.json({ error: 'DESIGN.md の文か URL を渡してください' }, 400);
    return done(c, await s.importDesignMd(who(c), text, str(b['name'], 200) || 'DESIGN.md', request));
  });

  /** 頼みで直す。 */
  app.post('/edit', async (c) => {
    const request = str((await body(c))['request'], COMPANY_DESIGN_LIMITS.requestChars).trim();
    if (!request) return c.json({ error: '直したいことを書いてください' }, 400);
    return done(c, await s.edit(who(c), request));
  });

  /** 前の版に戻す（`version` を省けば 1 つ前）。 */
  app.post('/restore', async (c) => {
    const v = (await body(c))['version'];
    return done(c, await s.restore(who(c), typeof v === 'number' ? v : undefined));
  });

  return app;
}
