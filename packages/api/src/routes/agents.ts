/**
 * @file 利用できるエージェントの一覧を返す API。画面のメニューと入力フォームの元になる。
 *
 * @see 仕様書 第6.1節 ワークスペースの画面構造
 */

import { Hono } from 'hono';
import { OFFICIAL_AGENTS } from '@m2office/core';
import type { AppDeps } from '../context.js';
import type { AppEnv } from '../middleware/tenant.js';

/**
 * 利用できるエージェントの一覧を返す。
 *
 * 画面のコマンドメニュー（仕様書 第6.1節）は、この応答から
 * カードと入力フォームを組み立てる。
 *
 * @remarks 管理者が無効にした業務は含めない（仕様書 第6.6.5節）。
 */
export function agentsRoute(deps: AppDeps) {
  const app = new Hono<AppEnv>();

  app.get('/', async (c) => {
    const { tenant } = c.get('ctx');
    const { agents: setting } = await deps.repo.getTenantSettings(tenant.id);
    const agents = OFFICIAL_AGENTS.filter((a) => !setting.disabled.includes(a.id)).map((a) => ({
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

  return app;
}
