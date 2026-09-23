/**
 * @file 個人設定の API。本人の設定・表示名・ログイン中の端末・利用状況を扱う。
 *
 * @see 仕様書 第6.5節 個人設定
 */

import { randomUUID } from 'node:crypto';
import { Hono } from 'hono';
import { VOICE_CHOICES, VOICE_STYLE_MAX, isValidAvatar, type UserSettings } from '@m2office/shared';
import { buildPresence, loadFile, proposePromotion, submitPromotion, withdrawPromotion } from '@m2office/core';
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

  /**
   * 本人が登録した秘書のアバターを、画面に埋め込める形で返す（仕様書 第6.1.3節）。
   *
   * @remarks
   * ファイルの取り出し（`/v1/files/:id/content`）は、中身を画面の権限で実行させないため
   * **必ず保存させる**（`attachment`）。アバターは画面に出す必要があるため、ここだけ別に置く。
   *
   * 狭くするために、次を守る。
   * - **本人が個人設定に登録したファイルだけ**を返す（ID を渡して任意のファイルを出させない）
   * - **画像（PNG・JPEG）だけ**を返す
   * - 種類を推測させず（`nosniff`）、何も読み込ませない（`Content-Security-Policy`）
   */
  app.get('/avatar', async (c) => {
    const { tenant, user } = c.get('ctx');
    const prefs = await deps.repo.getUserSettings(tenant.id, user.id);
    const avatar = prefs.secretary.avatar ?? '';
    if (!avatar.startsWith('file:')) return c.json({ error: 'アバターは登録されていません' }, 404);
    const f = await loadFile(deps.repo, deps.files, tenant.id, avatar.slice('file:'.length), user);
    if (!f || (f.meta.kind !== 'png' && f.meta.kind !== 'jpeg')) {
      return c.json({ error: 'アバターは登録されていません' }, 404);
    }
    return new Response(Buffer.from(f.bytes), {
      headers: {
        'content-type': f.meta.mime,
        'x-content-type-options': 'nosniff',
        'content-security-policy': "default-src 'none'; sandbox",
        // 本人だけのものであり、共有の置き場に残させない
        'cache-control': 'private, max-age=60',
      },
    });
  });

  app.get('/settings', async (c) => {
    const { tenant, user } = c.get('ctx');
    return c.json(await deps.repo.getUserSettings(tenant.id, user.id));
  });

  app.put('/settings/:section', async (c) => {
    const { tenant, user } = c.get('ctx');
    const { allAgents } = await deps.tenantView(tenant.id);
    const checked = validate(c.req.param('section'), await c.req.json<unknown>(), allAgents.map((a) => a.id));
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

  /**
   * 会話ログ（仕様書 第11.9.4.1節）。本人のやり取りだけを、新しい順に返す。
   *
   * @remarks 管理者も運営も見られない（不変則 I-10）。`q` で語句を絞り込める。
   */
  app.get('/conversations', async (c) => {
    const { tenant, user } = c.get('ctx');
    const items = await deps.repo.listConversations(tenant.id, user.id, {
      query: c.req.query('q') ?? '', limit: 50,
    });
    return c.json({ items });
  });

  /** 会話ログを 1 件消す。 */
  app.delete('/conversations/:id', async (c) => {
    const { tenant, user } = c.get('ctx');
    const ok = await deps.repo.deleteConversation(tenant.id, user.id, c.req.param('id'));
    if (!ok) return c.json({ error: '会話が見つかりません' }, 404);
    // 消した中身は監査ログに入れない（第11.9.4.1節）
    await audit(deps, tenant.id, user.id, 'conversation.delete', c.req.param('id'));
    return c.json({ ok: true });
  });

  /** 会話ログをすべて消す。 */
  app.delete('/conversations', async (c) => {
    const { tenant, user } = c.get('ctx');
    const removed = await deps.repo.clearConversations(tenant.id, user.id);
    await audit(deps, tenant.id, user.id, 'conversation.clear', String(removed));
    return c.json({ ok: true, removed });
  });

  /**
   * 記憶とデータ（第6.5.4節）。秘書が自分について覚えていることの一覧。
   *
   * @remarks 本人のものだけを返す。管理者であっても他人の記憶は見られない（不変則 I-10、第11.1節）。
   */
  app.get('/memories', async (c) => {
    const { tenant, user } = c.get('ctx');
    const items = await deps.repo.listMemories(tenant.id, user.id);
    return c.json({ items });
  });

  /**
   * 記憶を会社の知識にする提案（昇華。仕様書 第11.3.1節）。
   *
   * @remarks 本人が出し、管理者または承認者の役割を持つ人が判断する（二重の承認）。
   */
  app.post('/memories/:id/promote', async (c) => {
    const { tenant, user } = c.get('ctx');
    const promotion = await proposePromotion(
      { repo: deps.repo, notify: (t, u, title, body) => notify(deps, t, u, title, body) },
      tenant.id, user, c.req.param('id'), new Date(),
    );
    if (!promotion) return c.json({ error: '記憶が見つかりません' }, 404);
    return c.json({ id: promotion.id, status: promotion.status });
  });

  /** 秘書が作った候補を、組織の承認へ出す（第11.3.1節の本人の承認）。 */
  app.post('/promotions/:id/submit', async (c) => {
    const { tenant, user } = c.get('ctx');
    const submitted = await submitPromotion(
      { repo: deps.repo, notify: (t, u, title, body) => notify(deps, t, u, title, body) },
      tenant.id, user, c.req.param('id'), new Date(),
    );
    if (!submitted) return c.json({ error: 'この提案は出せません' }, 404);
    return c.json({ status: submitted.status });
  });

  /** 秘書が作った候補を、本人がやめる。記憶は残る。 */
  app.post('/promotions/:id/withdraw', async (c) => {
    const { tenant, user } = c.get('ctx');
    const withdrawn = await withdrawPromotion(
      { repo: deps.repo, notify: (t, u, title, body) => notify(deps, t, u, title, body) },
      tenant.id, user, c.req.param('id'), new Date(),
    );
    if (!withdrawn) return c.json({ error: 'この提案はやめられません' }, 404);
    return c.json({ status: withdrawn.status });
  });

  /** 自分の昇華の履歴（第6.5.4節「昇華の履歴」）。 */
  app.get('/promotions', async (c) => {
    const { tenant, user } = c.get('ctx');
    const items = await deps.repo.listPromotions(tenant.id, { userId: user.id });
    return c.json({ items });
  });

  /**
   * 記憶の候補（仕様書 第11.5.2節）。対話から作った候補を、本人が採るか捨てるか決める。
   */
  app.get('/memory-candidates', async (c) => {
    const { tenant, user } = c.get('ctx');
    const items = await deps.repo.listMemoryCandidates(tenant.id, user.id, 'pending');
    return c.json({ items });
  });

  /** 候補を採る。個人記憶になる。 */
  app.post('/memory-candidates/:id/accept', async (c) => {
    const { tenant, user } = c.get('ctx');
    const candidate = await deps.repo.deleteMemoryCandidate(tenant.id, user.id, c.req.param('id'));
    if (!candidate) return c.json({ error: '候補が見つかりません' }, 404);
    const id = randomUUID();
    await deps.repo.createMemory({
      id, tenantId: tenant.id, userId: user.id, text: candidate.text, source: 'conversation',
      createdAt: new Date().toISOString(),
    });
    // 覚えた中身は監査ログに入れない（第11.5.1節）
    await audit(deps, tenant.id, user.id, 'memory.create', id);
    return c.json({ ok: true, memoryId: id });
  });

  /** 候補を捨てる。同じ文は再び候補にしない（第11.5.2節）。 */
  app.post('/memory-candidates/:id/dismiss', async (c) => {
    const { tenant, user } = c.get('ctx');
    const ok = await deps.repo.updateMemoryCandidate(tenant.id, user.id, c.req.param('id'), 'dismissed');
    if (!ok) return c.json({ error: '候補が見つかりません' }, 404);
    await audit(deps, tenant.id, user.id, 'memory.candidate.dismiss', c.req.param('id'));
    return c.json({ ok: true });
  });

  /** 会話の要約（第11.9.6節）。逐語が消えた後も残る。 */
  app.get('/conversation-digests', async (c) => {
    const { tenant, user } = c.get('ctx');
    const items = await deps.repo.listConversationDigests(tenant.id, user.id, 30);
    return c.json({ items });
  });

  /** 記憶を 1 件消す。 */
  app.delete('/memories/:id', async (c) => {
    const { tenant, user } = c.get('ctx');
    const ok = await deps.repo.deleteMemory(tenant.id, user.id, c.req.param('id'));
    if (!ok) return c.json({ error: '記憶が見つかりません' }, 404);
    // 消した中身は監査ログに入れない（第11.5.1節）
    await audit(deps, tenant.id, user.id, 'memory.delete', c.req.param('id'));
    return c.json({ ok: true });
  });

  /** 記憶をすべて消す（第11.5節「全削除」）。 */
  app.delete('/memories', async (c) => {
    const { tenant, user } = c.get('ctx');
    const removed = await deps.repo.clearMemories(tenant.id, user.id);
    await audit(deps, tenant.id, user.id, 'memory.clear', String(removed));
    return c.json({ ok: true, removed });
  });

  /**
   * 管理者のダッシュボードで、自分がどう表示されているか（仕様書 第6.7.10節 規定 4）。
   *
   * @remarks
   * 「見られているかもしれない」に、実物で答えるための窓口である。
   * 返すのは自分の状態だけで、ほかの人の状態は返さない。
   */
  app.get('/presence', async (c) => {
    const { tenant, user } = c.get('ctx');
    const now = new Date();
    const since = new Date(now.getTime() - 24 * 3_600_000).toISOString();
    const [liveRuns, pending, sessions, secretaryEvents, settings, view] = await Promise.all([
      deps.repo.listLiveRuns(tenant.id, since),
      deps.repo.listPendingApprovals(tenant.id),
      deps.repo.listActiveSessions(tenant.id),
      deps.repo.listAuditSince(
        tenant.id, ['secretary.direct', 'secretary.route', 'secretary.chat', 'secretary.help'], 30,
      ),
      deps.repo.getTenantSettings(tenant.id),
      deps.tenantView(tenant.id),
    ]);
    const mine = liveRuns.filter(({ job }) => job.requestedBy === user.id);
    const stepsByRun = new Map(await Promise.all(
      mine.map(async ({ run }) => [run.id, await deps.repo.listRunSteps(tenant.id, run.id)] as const),
    ));
    const [presence] = buildPresence({
      now, users: [user], sessions, liveRuns: mine, stepsByRun, pending,
      secretaryEvents: secretaryEvents.map((e) => ({ actorId: e.actorId, occurredAt: e.occurredAt })),
      agentName: (id) => view.allAgents.find((a) => a.id === id)?.name ?? id,
    });
    return c.json({
      presence,
      // 会社が選んでいる粒度（第6.7.4.1節）
      granularity: settings.dashboard.people,
      shown: [
        '状態（業務を実行中・承認の依頼ありなど）',
        'いま使っている業務の名前',
        '活動の表示名（「リサーチ中」など）',
        '接続の経路と端末の種類',
      ],
      hidden: [
        '秘書との会話の中身',
        '業務の入力と成果物の中身',
        '接続元の場所',
        '個人ごとの勤務時間の集計',
        '過去の状態の履歴',
      ],
    });
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
    const [usage, settings, compartments, agents, groups, groupIds] = await Promise.all([
      deps.repo.usageForUser(tenant.id, user.id, monthStart),
      deps.repo.getTenantSettings(tenant.id),
      deps.repo.listUserCompartments(tenant.id, user.id),
      deps.agentsFor(tenant.id, user.id),
      deps.repo.listGroups(tenant.id),
      deps.repo.listUserGroupIds(tenant.id, user.id),
    ]);
    return c.json({
      seat: user.roles.includes('admin') ? '管理者' : user.roles.includes('external') ? '外部協力者' : '一般',
      thisMonth: { runs: usage.runs, costJpy: Math.round(usage.costJpy * 100) / 100 },
      availableAgents: agents.filter((a) => !settings.agents.disabled.includes(a.id)).length,
      compartments,
      // 本人が所属するグループ（第16.7.7節）。他の人の所属は返さない
      groups: groups.filter((g) => groupIds.includes(g.id)).map((g) => g.name),
      // プランと標準利用量は課金の実装とあわせて出す（第21章）
      plan: null,
    });
  });

  return app;
}

type Section = keyof UserSettings;

function validate(
  section: string, body: unknown, agentIds: string[],
): { section: Section; value: unknown } | { error: string } {
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
      return {
        section,
        value: {
          name: str(o['name'], 30), callMe: str(o['callMe'], 30), style, proactivity,
          // 読み上げの入り切り（第10.5.2節）
          speak: o['speak'] !== false,
          // 声は一覧にあるものだけを受け付ける。話し方は本人の言葉（第10.5.6節）
          voice: VOICE_CHOICES.some((v) => v.name === o['voice']) ? String(o['voice']) : '',
          voiceStyle: str(o['voiceStyle'], VOICE_STYLE_MAX),
          // 見本か、本人が上げた画像だけ。ほかの文字列は捨てる（任意の URL を出させない）
          avatar: isValidAvatar(str(o['avatar'], 80)) ? str(o['avatar'], 80) : '',
        },
      };
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
      // 控えの届け先（第6.5.5.2節）。既定はどちらも切で、画面内は切れない
      const ch = (o['channels'] ?? {}) as Record<string, unknown>;
      const channels = { chat: ch['chat'] === true };
      return { section, value: { kinds, quietHours: q ? { from: q.from, to: q.to } : null, channels } };
    }
    case 'memory': {
      // 記憶とデータ（第6.5.4節）。対象外の言葉は 1 行に 1 つ、空行は落とす
      const list = Array.isArray(o['excludes']) ? o['excludes'] : [];
      const excludes = [...new Set(list.map((x) => String(x).trim()).filter(Boolean))].slice(0, 50);
      if (excludes.some((w) => w.length > 50)) {
        return { error: '覚えない言葉は 1 つ 50 字までにしてください' };
      }
      return {
        section,
        value: {
          learning: o['learning'] !== false,
          excludes,
          keepConversations: o['keepConversations'] !== false,
        },
      };
    }
    case 'menu': {
      const ids = agentIds;
      const list = (v: unknown) => (Array.isArray(v) ? v.map(String).filter((x) => ids.includes(x)) : []);
      return { section, value: { hidden: [...new Set(list(o['hidden']))], order: [...new Set(list(o['order']))] } };
    }
    default:
      return { error: `不明な設定の区分です: ${section}` };
  }
}

/**
 * 本人宛ての通知を作る（仕様書 第6.5.5.1節）。昇華の提案と判断を知らせるのに使う。
 *
 * @remarks 本人が受け取らないと決めた種類は作らない。
 */
async function notify(
  deps: AppDeps, tenantId: string, userId: string, title: string, body: string,
): Promise<void> {
  const prefs = await deps.repo.getUserSettings(tenantId, userId);
  if (!prefs.notifications.kinds.approval) return;
  await deps.repo.createNotification({
    id: randomUUID(), tenantId, userId, kind: 'approval', title, body,
    runId: null, readAt: null, createdAt: new Date().toISOString(),
  });
}

async function audit(deps: AppDeps, tenantId: string, userId: string, action: string, target: string) {
  await deps.repo.appendAudit({
    id: randomUUID(), tenantId, actorType: 'user', actorId: userId, action,
    targetType: 'user', targetId: target, detail: {}, occurredAt: new Date().toISOString(),
  });
}
