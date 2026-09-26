/**
 * @file 利用できるエージェントの一覧を返す API。画面のメニューと入力フォームの元になる。
 *
 * @see 仕様書 第6.1節 ワークスペースの画面構造
 */

import { Hono } from 'hono';
import { pickFrequent } from '@m2office/core';
import type { AppDeps } from '../context.js';
import type { AppEnv } from '../middleware/tenant.js';

/**
 * 利用できるエージェントの一覧を返す。
 *
 * 画面のコマンドメニュー（仕様書 第6.1節）は、この応答から
 * カードと入力フォームを組み立てる。
 *
 * @remarks 管理者が無効にした業務は含めない（仕様書 第6.6.5節）。`frequent` はよく使う業務の ID（第6.1.1節）。
 */
/** よく使う業務を数えるときに見る実行の件数（新しいものから）。 */
const FREQUENT_SCAN = 300;

/** よく使う業務を使い回す時間。 */
const FREQUENT_TTL_MS = 10 * 60_000;

/** よく使う業務の使い回し（会社と利用者ごと。プロセスのメモリにだけ持つ）。 */
const frequentCache = new Map<string, { at: number; candidates: string; frequent: string[] }>();

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
      /** 拡張機能の業務エージェントなら、その提供者。公式なら `null`。 */
      extension: (() => {
        const ext = view.entryOf(a.id)?.pkg;
        return ext ? { id: ext.manifest.id, name: ext.manifest.name, publisher: ext.manifest.publisher.name } : null;
      })(),
    }));
    // よく使う業務（仕様書 第6.1.1節）。本人の 30 日の利用 → 会社の利用 → 標準の組の順に決める
    // 画面は一覧を 2 秒ごとに取り直すため、数えた結果を 10 分だけ使い回す（使える業務が変われば数え直す）
    const userId = c.get('ctx').user.id;
    const candidates = agents.filter((a) => a.menu).map((a) => a.id);
    const key = `${tenant.id}:${userId}`;
    const hit = frequentCache.get(key);
    let frequent = hit && Date.now() - hit.at < FREQUENT_TTL_MS && hit.candidates === candidates.join(',') ? hit.frequent : null;
    if (!frequent) {
      const [mine, all] = await Promise.all([
        deps.repo.listRunsWithJobs(tenant.id, { limit: FREQUENT_SCAN, requestedBy: userId }),
        deps.repo.listRunsWithJobs(tenant.id, { limit: FREQUENT_SCAN }),
      ]);
      const rows = (xs: typeof mine) => xs.map(({ run, job }) => ({ agentId: job.agentId, startedAt: run.startedAt }));
      frequent = pickFrequent(rows(mine), rows(all), candidates);
      frequentCache.set(key, { at: Date.now(), candidates: candidates.join(','), frequent });
    }
    return c.json({ agents, frequent });
  });

  return app;
}
