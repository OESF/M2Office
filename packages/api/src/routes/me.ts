/**
 * @file 個人設定の API。本人の設定・表示名・ログイン中の端末・利用状況と、声を試すことを扱う。
 *
 * @see 仕様書 第6.5節 個人設定
 */

import { randomUUID } from 'node:crypto';
import { Hono } from 'hono';
import {
  agentDisplayName,
  BRIEF_SECTIONS, WEEKLY_SECTIONS, VOICE_CHOICES, VOICE_STYLE_MAX, isValidAvatar, type UserSettings, type MenuCategory,
  CARDS_EXTENSION_ID, HR_EXTENSION_ID, SIGNAGE_EXTENSION_ID, INVENTORY_EXTENSION_ID, WEB_COLUMNS_EXTENSION_ID, INQUIRIES_EXTENSION_ID, COMPETITORS_EXTENSION_ID, ANNOUNCEMENTS_EXTENSION_ID, WEB_REVIEW_EXTENSION_ID, CONTRACTS_EXTENSION_ID, RESERVATIONS_EXTENSION_ID, SUBSIDIES_EXTENSION_ID, MEMBERS_EXTENSION_ID, PRINT_DESIGNS_EXTENSION_ID, MENU_CATEGORY_MAX, MENU_CATEGORY_NAME_MAX,
  GOOGLE_APP_IDS, LAUNCHER_LABEL_MAX, LAUNCHER_LINK_MAX, checkLauncherUrl, type LauncherLink,
} from '@m2office/shared';
import { AUDIO, AiNotConfiguredError, AiPolicyBlockedError, LEARNED_SOURCE, cleanTopics, buildPresence, loadFile, refusalMessage, refuseToRemember, jstMonth } from '@m2office/core';
import type { AppDeps } from '../context.js';
import type { AppEnv } from '../middleware/tenant.js';
import { speakSample } from '../voice/sample.js';
import { voiceNameOf } from '../voice/persona.js';

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

  /**
   * 本人のアバター（Google のプロフィール写真）を、画面に埋め込める形で返す（仕様書 第6.5.1.1節）。
   *
   * @remarks
   * **本人の写真だけを返す。** 利用者の ID を受け取らない（他人の写真を出させない）。
   * 秘書のアバターと同じく、種類を推測させず（`nosniff`）、何も読み込ませない（`Content-Security-Policy`）。
   */
  app.get('/photo', async (c) => {
    const { tenant, user } = c.get('ctx');
    const photo = await deps.repo.getUserPhoto(tenant.id, user.id);
    if (!photo) return c.json({ error: '写真はありません' }, 404);
    return new Response(Buffer.from(photo.bytes), {
      headers: {
        'content-type': photo.mime,
        'x-content-type-options': 'nosniff',
        'content-security-policy': "default-src 'none'; sandbox",
        // 本人だけのものであり、共有の置き場に残させない。取り込み直したら URL の v= が変わる
        'cache-control': 'private, max-age=86400',
      },
    });
  });

  /**
   * 会社のロゴ（仕様書 第6.6.1節）。画面の左上に出す。会社の全員が見られる。
   *
   * @remarks PNG・JPEG だけを返す。画面に埋め込むため inline で返すが、スクリプトは動かさない（CSP と nosniff）
   */
  app.get('/company-logo', async (c) => {
    const { tenant } = c.get('ctx');
    const id = (await deps.repo.getTenantSettings(tenant.id)).company.logoFileId;
    const meta = id ? await deps.repo.getFile(tenant.id, id) : null;
    if (!id || !meta || (meta.kind !== 'png' && meta.kind !== 'jpeg')) return c.json({ error: 'ロゴはありません' }, 404);
    const bytes = await deps.files.get(tenant.id, id);
    if (!bytes) return c.json({ error: 'ロゴはありません' }, 404);
    return new Response(Buffer.from(bytes), {
      headers: {
        'content-type': meta.kind === 'png' ? 'image/png' : 'image/jpeg',
        'x-content-type-options': 'nosniff',
        'content-security-policy': "default-src 'none'; sandbox",
        // ロゴを替えると URL の v= が変わる
        'cache-control': 'private, max-age=86400',
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
    let value = checked.value;
    if (checked.section === 'menu') {
      // カテゴリーを送らなかった保存（並びだけの保存）では、今のカテゴリーを残す
      const v = value as UserSettings['menu'];
      if (v.categories === undefined) {
        const current = (await deps.repo.getUserSettings(tenant.id, user.id)).menu;
        value = { ...v, categories: current.categories ?? [], categoryOf: current.categoryOf ?? {} };
      }
    }
    if (checked.section === 'brief') {
      // 秘書が選んだ印は画面から変えさせない。画面で分野を消しても、秘書が選び直さないよう印は付けたままにする（第9.5.5.1.1節）
      const current = (await deps.repo.getUserSettings(tenant.id, user.id)).brief;
      value = { ...(value as object), seededAt: current.seededAt ?? new Date().toISOString(), seedNote: current.seedNote };
    }
    await deps.repo.saveUserSettings(tenant.id, user.id, checked.section, value as never);
    await audit(deps, tenant.id, user.id, 'me.settings.update', checked.section);
    return c.json({ ok: true });
  });

  /** 声を試している最中の人（`会社:利用者`）。押し直しで何本も開かない。 */
  const sampling = new Set<string>();

  /**
   * 声を試す（仕様書 第10.5.8節）。画面に入っている秘書の設定（保存の前でもよい）で、秘書に名乗りの挨拶を話させる。
   *
   * @remarks
   * 設定は保存しない。実際の音声の対話と同じ提供者と名乗りの指示を使う。
   * 声は 24 kHz・16 ビットの PCM を base64 で返す。**どこにも保存しない**（第10.5.3節）。
   * 会話ログ・記憶・監査ログの `secretary.voice` には残さない。
   */
  app.post('/voice-test', async (c) => {
    const { tenant, user } = c.get('ctx');
    const checked = validate('secretary', await c.req.json<unknown>().catch(() => ({})), []);
    if ('error' in checked) return c.json({ error: checked.error }, 400);
    const prefs = checked.value as UserSettings['secretary'];
    if (!prefs.speak) return c.json({ error: '「声で答える」を切っているため、声を試せません' }, 400);
    const key = `${tenant.id}:${user.id}`;
    if (sampling.has(key)) return c.json({ error: 'いま話しています。終わってからお試しください' }, 429);
    // 推論が使えない会社では試さない。音声の対話と同じ断りを返す（第10.5.4節）
    let provider: Awaited<ReturnType<typeof deps.ai.voiceFor>>;
    try {
      provider = await deps.ai.voiceFor(tenant.id);
    } catch (err) {
      if (err instanceof AiNotConfiguredError || err instanceof AiPolicyBlockedError) return c.json({ error: err.message }, 409);
      throw err;
    }
    // 会社の呼び方は略称（無ければ正式な会社名。仕様書 第6.6.1節）
    const company = (await deps.repo.getTenantSettings(tenant.id).catch(() => null))?.company;
    const org = company?.shortName?.trim() || company?.legalName?.trim() || '';
    sampling.add(key);
    try {
      const sample = await speakSample(provider, { org, displayName: user.displayName, secretary: prefs }, voiceNameOf(prefs.voice));
      return c.json({
        text: sample.text,
        audio: Buffer.from(sample.pcm).toString('base64'),
        sampleRate: AUDIO.outputHz,
        notes: sample.notes,
      });
    } catch (err) {
      deps.log.warn('声を試せませんでした', { tenantId: tenant.id, userId: user.id, err });
      return c.json({ error: '声を試せませんでした。しばらくしてからお試しください' }, 502);
    } finally {
      sampling.delete(key);
    }
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

  /** 整理でしまった記憶（第11.11.4節）。理由（まとめた・古い・使われない）とともに返す。1 年で消える。 */
  app.get('/memories/archived', async (c) => {
    const { tenant, user } = c.get('ctx');
    const items = await deps.repo.listArchivedMemories(tenant.id, user.id);
    return c.json({ items });
  });

  /** しまった記憶を戻す（第11.11.4節）。 */
  app.post('/memories/:id/restore', async (c) => {
    const { tenant, user } = c.get('ctx');
    const ok = await deps.repo.setMemoryStatus(tenant.id, user.id, c.req.param('id'), 'active', null, null, new Date().toISOString());
    if (!ok) return c.json({ error: '記憶が見つかりません' }, 404);
    // 戻した中身は監査ログに入れない（第11.5.1節）
    await audit(deps, tenant.id, user.id, 'memory.restore', c.req.param('id'));
    return c.json({ ok: true });
  });

  /** 自分の記憶から、秘書が会社の知識にしたものの履歴（第6.5.4節「昇華の履歴」。判断は秘書が行う。第11.3節）。 */
  app.get('/promotions', async (c) => {
    const { tenant, user } = c.get('ctx');
    const items = await deps.repo.listPromotions(tenant.id, { userId: user.id });
    return c.json({ items });
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
    const memory = (await deps.repo.listMemories(tenant.id, user.id)).find((m) => m.id === c.req.param('id'));
    const ok = await deps.repo.deleteMemory(tenant.id, user.id, c.req.param('id'));
    if (!ok) return c.json({ error: '記憶が見つかりません' }, 404);
    // 秘書が自分で覚えたものを本人が消したら、同じ文は再び覚えない（仕様書 第11.5.2節、ADR-0027）
    if (memory?.source === LEARNED_SOURCE) {
      await deps.repo.createMemoryCandidate({
        id: randomUUID(), tenantId: tenant.id, userId: user.id, text: memory.text,
        status: 'dismissed', sourceDay: memory.createdAt.slice(0, 10), createdAt: new Date().toISOString(),
      });
    }
    // 消した中身は監査ログに入れない（第11.5.1節）
    await audit(deps, tenant.id, user.id, 'memory.delete', c.req.param('id'));
    return c.json({ ok: true });
  });

  /**
   * 記憶を 1 件直す（仕様書 第11.5.2節）。秘書が自分で覚えたものも、本人が直せる。
   *
   * @remarks
   * 認証情報・覚えない言葉・長すぎる文は、頼んで覚えるときと同じく断る（第11.5.1節）。
   * 秘書が覚えた文を直したら、元の文は再び覚えない（消したときと同じ扱い）。
   */
  app.patch('/memories/:id', async (c) => {
    const { tenant, user } = c.get('ctx');
    const body = (await c.req.json().catch(() => ({}))) as { text?: unknown };
    const text = typeof body.text === 'string' ? body.text.trim() : '';
    const settings = await deps.repo.getUserSettings(tenant.id, user.id);
    // 本人が直すときは、覚えることを止めていても直せる。止めているのは秘書が覚えることである
    const refusal = refuseToRemember(text, { ...settings.memory, learning: true });
    if (refusal) return c.json({ error: refusalMessage(refusal) }, 400);
    const memory = (await deps.repo.listMemories(tenant.id, user.id)).find((m) => m.id === c.req.param('id'));
    if (!memory) return c.json({ error: '記憶が見つかりません' }, 404);
    await deps.repo.updateMemory(tenant.id, user.id, memory.id, text);
    if (memory.source === LEARNED_SOURCE && memory.text !== text) {
      await deps.repo.createMemoryCandidate({
        id: randomUUID(), tenantId: tenant.id, userId: user.id, text: memory.text,
        status: 'dismissed', sourceDay: memory.createdAt.slice(0, 10), createdAt: new Date().toISOString(),
      });
    }
    // 直した中身は監査ログに入れない（第11.5.1節）
    await audit(deps, tenant.id, user.id, 'memory.update', memory.id);
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
    const [liveRuns, pending, sessions, secretaryEvents, settings, view, voiceEvents] = await Promise.all([
      deps.repo.listLiveRuns(tenant.id, since),
      deps.repo.listPendingApprovals(tenant.id),
      deps.repo.listActiveSessions(tenant.id),
      deps.repo.listAuditSince(
        tenant.id, ['secretary.direct', 'secretary.route', 'secretary.chat', 'secretary.help'], 30,
      ),
      deps.repo.getTenantSettings(tenant.id),
      deps.tenantView(tenant.id),
      deps.repo.listAuditSince(tenant.id, ['secretary.voice'], 50),
    ]);
    const mine = liveRuns.filter(({ job }) => job.requestedBy === user.id);
    const stepsByRun = new Map(await Promise.all(
      mine.map(async ({ run }) => [run.id, await deps.repo.listRunSteps(tenant.id, run.id)] as const),
    ));
    const [presence] = buildPresence({
      now, users: [user], sessions, liveRuns: mine, stepsByRun, pending,
      secretaryEvents: secretaryEvents.map((e) => ({ actorId: e.actorId, occurredAt: e.occurredAt })),
      voiceEvents: voiceEvents.map((e) => ({ actorId: e.actorId, occurredAt: e.occurredAt, targetId: e.targetId })),
      agentName: (id) => agentDisplayName(view.allAgents.find((a) => a.id === id)?.name, id),
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
        'Google のプロフィール写真',
        '秘書の名前・アバターと、秘書の状態（「議事録の作成を実行中」「待機」など）',
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
      // 今月の本人の AI の利用（円・概算）と、1 人の上限（会社に上限が無ければ null。第6.6.2節）
      ai: await myAiUsage(deps, tenant.id, user.id),
    });
  });

  return app;
}

/** 今月の本人の AI の利用と 1 人の上限（記録の仕組みが無ければ `null`）。 */
async function myAiUsage(deps: AppDeps, tenantId: string, userId: string): Promise<{ usedJpy: number; limitJpy: number | null } | null> {
  const meter = deps.ai.meter();
  if (!meter) return null;
  const [t, limit] = await Promise.all([meter.totals(tenantId, jstMonth(new Date()).start), meter.userLimit(tenantId)]);
  const mine = t.byUser.find((u) => u.userId === userId)?.costJpy ?? 0;
  return { usedJpy: Math.round(mine * 100) / 100, limitJpy: limit === null ? null : Math.round(limit) };
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
      return {
        section,
        value: { furigana: str(o['furigana'], 100), title: str(o['title'], 100), timezone, home: str(o['home'], 200), workplace: str(o['workplace'], 200) },
      };
    }
    case 'secretary': {
      const style = o['style'] === 'concise' ? 'concise' : 'polite';
      const p = o['proactivity'];
      const proactivity = p === 'low' || p === 'high' ? p : 'normal';
      return {
        section,
        value: {
          name: str(o['name'], 30), callMe: str(o['callMe'], 30), style, proactivity,
          // 声で答えるかと、音声の字幕を出すか（第6.5.3節・第10.5.2節）
          speak: o['speak'] !== false,
          captions: o['captions'] !== false,
          // 声は一覧にあるものだけを受け付ける。話し方は本人の言葉（第10.5.6節）
          voice: VOICE_CHOICES.some((v) => v.name === o['voice']) ? String(o['voice']) : '',
          voiceStyle: str(o['voiceStyle'], VOICE_STYLE_MAX),
          // 見本か、本人が上げた画像だけ。ほかの文字列は捨てる（任意の URL を出させない）
          avatar: isValidAvatar(str(o['avatar'], 80)) ? str(o['avatar'], 80) : '',
          // 音声の聞き違えを直した組（第10.5.9節）。画面から保存したときも消さない
          mishears: (Array.isArray(o['mishears']) ? o['mishears'] : []).slice(-50).flatMap((m) => {
            const heard = str((m as { heard?: unknown })?.heard, 20);
            const meant = str((m as { meant?: unknown })?.meant, 20);
            return heard && meant ? [{ heard, meant }] : [];
          }),
          // 会議の後の議事録の入り切りと、作らない会議の題名（第9.5.2.1節）
          autoMinutes: o['autoMinutes'] !== false,
          noMinutes: (Array.isArray(o['noMinutes']) ? o['noMinutes'] : []).map((x) => str(x, 30)).filter(Boolean).slice(0, 30),
        },
      };
    }
    case 'notifications': {
      const k = (o['kinds'] ?? {}) as Record<string, unknown>;
      const kinds = {
        brief: k['brief'] !== false, run: k['run'] !== false,
        approval: k['approval'] !== false, failure: k['failure'] !== false, inventory: k['inventory'] !== false, attendance: k['attendance'] !== false,
        signage: k['signage'] !== false, inquiry: k['inquiry'] !== false, competitor: k['competitor'] !== false, announcement: k['announcement'] !== false, webReview: k['webReview'] !== false, column: k['column'] !== false, contract: k['contract'] !== false, reservation: k['reservation'] !== false, subsidy: k['subsidy'] !== false, member: k['member'] !== false, print: k['print'] !== false,
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
      // 名刺・在庫など（内蔵の拡張）も業務の 1 つとして並べ・ピン止めできる（仕様書 第6.1.1節）
      const ids = [...agentIds, CARDS_EXTENSION_ID, INVENTORY_EXTENSION_ID, HR_EXTENSION_ID, SIGNAGE_EXTENSION_ID, WEB_COLUMNS_EXTENSION_ID, INQUIRIES_EXTENSION_ID, COMPETITORS_EXTENSION_ID, ANNOUNCEMENTS_EXTENSION_ID, WEB_REVIEW_EXTENSION_ID, CONTRACTS_EXTENSION_ID, RESERVATIONS_EXTENSION_ID, SUBSIDIES_EXTENSION_ID, MEMBERS_EXTENSION_ID, PRINT_DESIGNS_EXTENSION_ID];
      const list = (v: unknown) => (Array.isArray(v) ? v.map(String).filter((x) => ids.includes(x)) : []);
      // ピン止め（仕様書 第6.1.1節）。配列でなければ、まだ変えていない（null）として残す
      const pinned = Array.isArray(o['pinned']) ? [...new Set(list(o['pinned']))] : null;
      const value: UserSettings['menu'] = { hidden: [...new Set(list(o['hidden']))], order: [...new Set(list(o['order']))], pinned };
      // カテゴリー（第6.1.1節）。送られなければ今の値を残す（古い画面から並びだけを保存しても消さない）
      if (o['categories'] !== undefined || o['categoryOf'] !== undefined) {
        const cats = cleanCategories(o['categories']);
        if ('error' in cats) return cats;
        const catIds = new Set(cats.map((x) => x.id));
        const of = o['categoryOf'] && typeof o['categoryOf'] === 'object' && !Array.isArray(o['categoryOf'])
          ? Object.fromEntries(Object.entries(o['categoryOf'] as Record<string, unknown>)
            .filter(([k, v]) => ids.includes(k) && typeof v === 'string' && catIds.has(v)) as [string, string][])
          : {};
        value.categories = cats;
        value.categoryOf = of;
      }
      return { section, value };
    }
    case 'launcher': {
      // アプリの一覧（第6.1.1.2節）。出さない Google のサービスと、本人が登録したリンク
      const hiddenIn = Array.isArray(o['hidden']) ? o['hidden'].map(String) : [];
      const hidden = GOOGLE_APP_IDS.filter((id) => hiddenIn.includes(id));
      const linksIn = Array.isArray(o['links']) ? o['links'] : [];
      if (linksIn.length > LAUNCHER_LINK_MAX) return { error: `リンクは ${LAUNCHER_LINK_MAX} 件までです` };
      const links: LauncherLink[] = [];
      for (const x of linksIn) {
        const l = (x ?? {}) as Record<string, unknown>;
        const id = typeof l['id'] === 'string' ? l['id'].trim() : '';
        if (!/^[A-Za-z0-9_-]{1,40}$/.test(id) || links.some((y) => y.id === id)) return { error: 'リンクの形が違います' };
        const checked = checkLauncherUrl(String(l['url'] ?? ''));
        if ('error' in checked) return checked;
        // 名前が空なら、URL のホスト名を名前にする
        const label = [...str(l['label'], 200)].length ? str(l['label'], 200) : new URL(checked.url).hostname;
        if ([...label].length > LAUNCHER_LABEL_MAX) return { error: `リンクの名前は ${LAUNCHER_LABEL_MAX} 字までにしてください` };
        links.push({ id, label, url: checked.url });
      }
      return { section, value: { hidden, links } };
    }
    case 'brief': {
      // 朝のブリーフの中身（第6.5.3.1節）。画面では消す・戻すだけだが、形はここで整える
      const topics = cleanTopics(o['topics']);
      const omitIn = Array.isArray(o['omit']) ? o['omit'].map(String) : [];
      const omit = BRIEF_SECTIONS.map((x) => x.id).filter((id) => omitIn.includes(id));
      // 週次ブリーフの外した項目（ADR-0048）
      const weeklyIn = Array.isArray(o['weeklyOmit']) ? o['weeklyOmit'].map(String) : [];
      const weeklyOmit = WEEKLY_SECTIONS.map((x) => x.id).filter((id) => weeklyIn.includes(id));
      return { section, value: { topics, omit, weeklyOmit } };
    }
    default:
      return { error: `不明な設定の区分です: ${section}` };
  }
}

/**
 * 左のメニューのカテゴリーを整える（仕様書 第6.1.1節）。名前の前後の空白を落とし、同じ名前と空の名前を断る。
 *
 * @returns 整えたカテゴリー。数や名前の長さが決まりを超えれば `error`
 */
function cleanCategories(v: unknown): MenuCategory[] | { error: string } {
  if (v === undefined || v === null) return [];
  if (!Array.isArray(v)) return { error: 'カテゴリーの形が違います' };
  if (v.length > MENU_CATEGORY_MAX) return { error: `カテゴリーは ${MENU_CATEGORY_MAX} 個までです` };
  const out: MenuCategory[] = [];
  for (const x of v) {
    const c = x as { id?: unknown; name?: unknown };
    const id = typeof c.id === 'string' ? c.id.trim() : '';
    const name = typeof c.name === 'string' ? c.name.trim() : '';
    if (!/^[A-Za-z0-9_-]{1,40}$/.test(id) || !name) return { error: 'カテゴリーの名前を入れてください' };
    if ([...name].length > MENU_CATEGORY_NAME_MAX) return { error: `カテゴリーの名前は ${MENU_CATEGORY_NAME_MAX} 字までにしてください` };
    if (out.some((y) => y.id === id || y.name === name)) return { error: `同じ名前のカテゴリー（${name}）があります` };
    out.push({ id, name });
  }
  return out;
}

async function audit(deps: AppDeps, tenantId: string, userId: string, action: string, target: string) {
  await deps.repo.appendAudit({
    id: randomUUID(), tenantId, actorType: 'user', actorId: userId, action,
    targetType: 'user', targetId: target, detail: {}, occurredAt: new Date().toISOString(),
  });
}
