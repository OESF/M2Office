/**
 * @file 利用できるエージェントの一覧を返す API。画面のメニューと入力フォームの元になる。
 *
 * @see 仕様書 第6.1節 ワークスペースの画面構造
 */

import { Hono } from 'hono';
import { isSchedulable } from '@m2office/core';
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
    // 公式と、この会社が導入した拡張機能の業務エージェント（仕様書 第12.9.3節）
    const view = await deps.tenantView(tenant.id);
    // 本人の利用範囲（第16.7節）の中の業務だけを出す
    const available = await deps.agentsFor(tenant.id, c.get('ctx').user.id);
    const agents = available.filter((a) => !setting.disabled.includes(a.id)).map((a) => ({
      id: a.id,
      version: a.version,
      name: a.name,
      category: a.category,
      description: a.description,
      inputs: a.inputs,
      /** 承認ゲートを持つかどうか。画面での説明に使う。 */
      hasApproval: a.steps.some((s) => s.type === 'approval'),
      stepCount: a.steps.length,
      /** メニューに出すか（スキルの user-invocable: false で出さない。仕様書 第12.12.2節）。 */
      menu: a.menu !== false,
      /** 定時実行に登録できるか（ファイルを受け取る業務と秘書の調べものは登録できない。仕様書 第6.1.7節）。 */
      schedulable: isSchedulable(a),
      /** 拡張機能の業務エージェントなら、その提供者。公式なら `null`。 */
      extension: (() => {
        const ext = view.entryOf(a.id)?.pkg;
        return ext ? { id: ext.manifest.id, name: ext.manifest.name, publisher: ext.manifest.publisher.name } : null;
      })(),
    }));
    return c.json({ agents });
  });

  return app;
}
