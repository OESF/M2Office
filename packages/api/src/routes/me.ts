/**
 * @file 個人設定の API。本人の設定・表示名・ログイン中の端末・利用状況を扱う。
 *
 * @see 仕様書 第6.5節 個人設定
 */

import { randomUUID } from 'node:crypto';
import { Hono } from 'hono';
import type { UserSettings } from '@m2office/shared';
import { OFFICIAL_AGENTS } from '@m2office/core';
import type { AppDeps } from '../context.js';
import type { AppEnv } from '../middleware/tenant.js';

/**
 * 個人設定（仕様書 第6.5節）。本人の分だけを読み書きする。
 *
 * @remarks
 * 管理者であっても、ここから他人の設定には触れない。
 * メールアドレスは Google 側で管理するため変更できない（第6.5.1節）。
 */
export function meRoute(deps: AppDeps) {
  const app = new Hono<AppEnv>();

  app.get('/settings', async (c) => {
    const { tenant, user } = c.get('ctx');
    return c.json(await deps.repo.getUserSettings(tenant.id, user.id));
  });

  app.put('/settings/:section', async (c) => {
    const { tenant, user } = c.get('ctx');
    const checked = validate(c.req.param('section'), await c.req.json<unknown>());
    if ('error' in checked) return c.json({ error: checked.error }, 400);
    await deps.repo.saveUserSettings(tenant.id, user.id, checked.section, checked.value as never);
    await audit(deps, tenant.id, user.id, 'me.settings.update', checked.section);
    return c.json({ ok: true });
  });

  /** 表示名の変更。画面と成果物に出る名前（第6.5.1節）。 */
  app.patch('/profile', async (c) => {
    const { tenant, user } = c.get('ctx');
    const { displayName } = await c.req.json<{ displayName?: string }>();
    const name = (displayName ?? '').trim();
    if (!name || name.length > 50) return c.json({ error: '表示名は 1〜50 文字で入力してください' }, 400);
    await deps.repo.updateUser({ ...user, displayName: name });
    await audit(deps, tenant.id, user.id, 'me.profile.update', 'displayName');
    return c.json({ ok: true });
  });

  /** ログイン中の端末（第6.5.8節）。いま使っているものに印を付ける。 */
  app.get('/sessions', async (c) => {
    const { tenant, user } = c.get('ctx');
    const auth = c.get('auth');
    const current = auth.method === 'session' ? auth.sessionId : null;
    const items = (await deps.repo.listSessions(tenant.id, user.id, new Date())).map((s) => ({
      id: s.id, provider: s.provider, userAgent: s.userAgent, createdAt: s.createdAt,
      lastSeenAt: s.lastSeenAt, current: s.id === current,
    }));
    return c.json({ items });
  });

  /** 端末を個別にログアウトさせる。本人のログイン状態だけが対象。 */
  app.delete('/sessions/:id', async (c) => {
    const { tenant, user } = c.get('ctx');
    const target = (await deps.repo.listSessions(tenant.id, user.id, new Date()))
      .find((s) => s.id === c.req.param('id'));
    if (!target) return c.json({ error: 'ログイン状態が見つかりません' }, 404);
    await deps.repo.revokeSession(tenant.id, target.id, new Date());
    await audit(deps, tenant.id, user.id, 'auth.revoke', target.id.slice(0, 16));
    return c.json({ ok: true });
  });

  /** 利用状況とライセンス（第6.5.7節）。「自分は何が使えて、どれだけ使ったか」。 */
  app.get('/usage', async (c) => {
    const { tenant, user } = c.get('ctx');
    const monthStart = new Date(
      new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Tokyo' }).format(new Date()).slice(0, 8) +
        '01T00:00:00+09:00',
    ).toISOString();
    const [usage, settings, compartments] = await Promise.all([
      deps.repo.usageForUser(tenant.id, user.id, monthStart),
      deps.repo.getTenantSettings(tenant.id),
      deps.repo.listUserCompartments(tenant.id, user.id),
    ]);
    return c.json({
      seat: user.roles.includes('admin') ? '管理者' : user.roles.includes('external') ? '外部協力者' : '一般',
      thisMonth: { runs: usage.runs, costJpy: Math.round(usage.costJpy * 100) / 100 },
      availableAgents: OFFICIAL_AGENTS.filter((a) => !settings.agents.disabled.includes(a.id)).length,
      compartments,
      // プランと標準利用量は課金の実装とあわせて出す（第21章）
      plan: null,
    });
  });

  return app;
}

type Section = keyof UserSettings;

function validate(section: string, body: unknown): { section: Section; value: unknown } | { error: string } {
  const o = (body ?? {}) as Record<string, unknown>;
  const str = (v: unknown, max: number) => String(v ?? '').trim().slice(0, max);
  switch (section) {
    case 'profile': {
      const timezone = str(o['timezone'], 64) || 'Asia/Tokyo';
      try {
        new Intl.DateTimeFormat('ja-JP', { timeZone: timezone });
      } catch {
        return { error: `タイムゾーンが正しくありません: ${timezone}` };
      }
      return { section, value: { furigana: str(o['furigana'], 100), title: str(o['title'], 100), timezone } };
    }
    case 'secretary': {
      const style = o['style'] === 'concise' ? 'concise' : 'polite';
      const p = o['proactivity'];
      const proactivity = p === 'low' || p === 'high' ? p : 'normal';
      return { section, value: { name: str(o['name'], 30), callMe: str(o['callMe'], 30), style, proactivity } };
    }
    case 'notifications': {
      const k = (o['kinds'] ?? {}) as Record<string, unknown>;
      const kinds = {
        brief: k['brief'] !== false, run: k['run'] !== false,
        approval: k['approval'] !== false, failure: k['failure'] !== false,
      };
      const q = o['quietHours'] as { from?: string; to?: string } | null | undefined;
      const hhmm = /^([01]\d|2[0-3]):[0-5]\d$/;
      if (q && (!hhmm.test(q.from ?? '') || !hhmm.test(q.to ?? ''))) {
        return { error: '通知しない時間帯は 00:00 の形式で入力してください' };
      }
      return { section, value: { kinds, quietHours: q ? { from: q.from, to: q.to } : null } };
    }
    case 'menu': {
      const ids = OFFICIAL_AGENTS.map((a) => a.id);
      const list = (v: unknown) => (Array.isArray(v) ? v.map(String).filter((x) => ids.includes(x)) : []);
      return { section, value: { hidden: [...new Set(list(o['hidden']))], order: [...new Set(list(o['order']))] } };
    }
    default:
      return { error: `不明な設定の区分です: ${section}` };
  }
}

async function audit(deps: AppDeps, tenantId: string, userId: string, action: string, target: string) {
  await deps.repo.appendAudit({
    id: randomUUID(), tenantId, actorType: 'user', actorId: userId, action,
    targetType: 'user', targetId: target, detail: {}, occurredAt: new Date().toISOString(),
  });
}
