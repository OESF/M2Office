import { Hono } from 'hono';
import { OFFICIAL_AGENTS } from '@m2office/core';
import type { RequestContext } from '@m2office/shared';

/**
 * 利用できるエージェントの一覧を返す。
 *
 * 画面のコマンドメニュー（仕様書 第6.1節）は、この応答から
 * カードと入力フォームを組み立てる。
 */
export const agentsRoute = new Hono<{ Variables: { ctx: RequestContext } }>();

agentsRoute.get('/', (c) => {
  const agents = OFFICIAL_AGENTS.map((a) => ({
    id: a.id,
    version: a.version,
    name: a.name,
    category: a.category,
    description: a.description,
    inputs: a.inputs,
    /** 承認ゲートを持つかどうか。画面での説明に使う。 */
    hasApproval: a.steps.some((s) => s.type === 'approval'),
    stepCount: a.steps.length,
  }));
  return c.json({ agents });
});
