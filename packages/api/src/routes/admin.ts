/**
 * @file 管理者ページ（`/admin`）が使う API。利用状況・実行の一覧・定時実行の一覧・設定・ユーザー・知識を扱う。
 *
 * 管理者ロールを持つ者だけが呼べる。管理者でも、他人の会話や実行の中身は見られない（不変則 I-10）。
 *
 * @see 仕様書 第6.6節 管理者ページ
 */

import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { Hono, type Context } from 'hono';
import {
  agentDisplayName,
  isValidInvoiceNumber, parsePresentationId, type AutomationPolicy, type CompanyInfo, type Role, type SlideTemplate, type TenantSettings,
  type AuditEvent, type User, type WritingStyle, DEFAULT_AI_PER_USER_SHARE
} from '@m2office/shared';
import {
  DEFAULT_STANDARD_MINUTES, GOOGLE_DATA_RETENTION_DAYS, KNOWLEDGE_MAX_CHARS,
  describeRule, scheduleBlocker, scheduleChecks, stepLabel, toolGoogleScopes, type AuditQuery, jstMonth, appPath, backupConfigFromEnv, machineConfigFromEnv, machineStatus, requestBackup
} from '@m2office/core';
import type { AppDeps } from '../context.js';
import { requireRole, type AppEnv } from '../middleware/tenant.js';
import { AUDIT_CATEGORIES, auditCsv, presentAudit, type AuditNames } from '../audit/present.js';

/**
 * 管理者ページ（`/admin`）が使う API（仕様書 第6.6節）。
 *
 * 管理者ロールを持つ者だけが呼べる。
 *
 * @remarks
 * **管理者でも、他人の会話ログと個人記憶、実行の中身は見られない**（不変則 I-10）。
 * ここで返すのは実行の状態と監査の記録であり、やり取りの中身ではない。
 * 実行の一覧に入力や成果物を含めないのはそのためである。
 */
export function adminRoute(deps: AppDeps) {
  const app = new Hono<AppEnv>();
  app.use('*', requireRole('admin'));

  /** 利用者と権限（第6.6.4節）。 */
  app.get('/users', async (c) => {
    const { tenant } = c.get('ctx');
    const users = await deps.repo.listUsers(tenant.id);
    return c.json({ items: users });
  });

  /** 実行の一覧。状態・費用・起動経路だけを返す（第6.6.8節）。 */
  app.get('/runs', async (c) => {
    const { tenant } = c.get('ctx');
    const rows = await deps.repo.listRunsWithJobs(tenant.id, { limit: 100 });
    const { allAgents } = await deps.tenantView(tenant.id);
    // 入力（job.input）と成果物は返さない。状態を見るためのものであり、中身を見るためではない
    const items = rows.map(({ run: r, job }) => ({
      id: r.id, status: r.status, startedAt: r.startedAt, endedAt: r.endedAt,
      tokensUsed: r.tokensUsed, costJpy: r.costJpy,
      agentId: job.agentId, agentName: agentDisplayName(allAgents.find((a) => a.id === job.agentId)?.name, job.agentId, job.agentName),
      origin: job.origin, requestedBy: job.requestedBy,
    }));
    return c.json({ items });
  });

  /**
   * 会社の全員の定時実行（仕様書 第6.6.8.2節）。人・業務・繰り返し・次回・前回・状態を返す。
   *
   * @remarks
   * **業務の入力は返さない**（本人が業務に渡す中身。不変則 I-10）。操作の口も持たない（本人の画面だけで行う。第6.1.7節）。
   * 次の回に動かない理由は、起動役と同じ判定（`scheduleBlocker`）で、いま見たときのものを返す。
   * 並びは動かないものを先に、次に人・次回の順
   */
  app.get('/schedules', async (c) => {
    const { tenant } = c.get('ctx');
    const [schedules, users] = await Promise.all([deps.repo.listSchedules(tenant.id, null), deps.repo.listUsers(tenant.id)]);
    const view = await deps.tenantView(tenant.id);
    const checks = scheduleChecks({ repo: deps.repo, hub: deps.hub, connector: deps.connector });
    const items = await Promise.all(schedules.map(async (s) => {
      const { def, block } = await scheduleBlocker(checks, s);
      return {
        id: s.id, userId: s.userId,
        // 名前を引けなければ記録の値のまま出す（推測で名前を作らない）
        userName: users.find((u) => u.id === s.userId)?.displayName ?? s.userId,
        agentId: s.agentId,
        agentName: agentDisplayName(def?.name ?? view.allAgents.find((a) => a.id === s.agentId)?.name, s.agentId),
        label: describeRule(s.rule), timezone: s.timezone,
        nextRunAt: s.nextRunAt, lastRunAt: s.lastRunAt,
        state: !s.enabled ? 'paused' as const : block ? 'blocked' as const : 'active' as const,
        blockedReason: block?.label ?? null,
      };
    }));
    const rank = { blocked: 0, active: 1, paused: 2 };
    items.sort((a, b) => rank[a.state] - rank[b.state]
      || a.userName.localeCompare(b.userName, 'ja')
      || (a.nextRunAt ?? '').localeCompare(b.nextRunAt ?? ''));
    return c.json({ items });
  });

  /**
   * 実行 1 件の**状態だけ**（仕様書 第6.6.8節）。一覧でその場に開くために使う（第6.2.4節）。
   *
   * @remarks
   * **中身は返さない。** 段の入力と出力、成果物、業務の入力は含めない。
   * 返すのは段の表示名と状態、失敗の理由、時刻、費用、削減時間までである。
   * 管理者が見られるのは状態・費用・起動経路だけであり、これは不変則 I-10 の帰結である。
   */
  app.get('/runs/:id', async (c) => {
    const { tenant } = c.get('ctx');
    const run = await deps.repo.getRun(tenant.id, c.req.param('id'));
    if (!run) return c.json({ error: '実行が見つかりません' }, 404);
    const job = await deps.repo.getJob(tenant.id, run.jobId);
    const view = await deps.tenantView(tenant.id);
    const def = job ? view.allAgents.find((a) => a.id === job.agentId) : undefined;
    const labels = new Map((def?.steps ?? []).map((st) => [st.id, stepLabel(st)]));
    const steps = (await deps.repo.listRunSteps(tenant.id, run.id)).map((st) => ({
      seq: st.seq,
      label: labels.get(st.stepId) ?? st.stepId,
      kind: st.kind,
      status: st.status,
      startedAt: st.startedAt,
      endedAt: st.endedAt,
    }));
    return c.json({
      id: run.id,
      status: run.status,
      startedAt: run.startedAt,
      endedAt: run.endedAt,
      failureReason: run.failureReason,
      tokensUsed: run.tokensUsed,
      costJpy: run.costJpy,
      savedMinutes: run.savedMinutes,
      origin: job?.origin ?? null,
      steps,
    });
  });

  /** 利用量の集計。エージェント別の件数と費用（第6.6.7節）。 */
  app.get('/usage', async (c) => {
    const { tenant } = c.get('ctx');
    const rows = await deps.repo.usageByAgent(tenant.id);
    const { allAgents } = await deps.tenantView(tenant.id);
    const items = rows.map((r) => ({
      ...r,
      name: agentDisplayName(allAgents.find((a) => a.id === r.agentId)?.name, r.agentId),
      costJpy: Math.round(r.costJpy * 100) / 100,
    }));
    return c.json({
      items,
      total: {
        runs: items.reduce((s, i) => s + i.runs, 0),
        costJpy: Math.round(items.reduce((s, i) => s + i.costJpy, 0) * 100) / 100,
      },
      note: null,
    });
  });

  /**
   * 今月の AI の利用と上限（仕様書 第6.6.2節、ADR-0079）。用途ごと・人ごとの内訳。費用は概算。
   *
   * @remarks 業務の中身は返さない（用途の名前と数だけ）
   */
  app.get('/ai-usage', async (c) => {
    const { tenant } = c.get('ctx');
    const meter = deps.ai.meter();
    const settings = (await deps.repo.getTenantSettings(tenant.id)).aiLimits;
    const source = (await deps.ai.geminiFor(tenant.id)).source;
    const { month, start } = jstMonth(new Date());
    if (!meter) return c.json({ month, recorded: false, settings, source, platformCap: null, monthlyJpy: null, userLimitJpy: null, usedJpy: 0, calls: 0, byPurpose: [], byUser: [] });
    const [t, limit, userLimit, users, view] = await Promise.all([
      meter.totals(tenant.id, start), meter.monthlyLimit(tenant.id), meter.userLimit(tenant.id), deps.repo.listUsers(tenant.id), deps.tenantView(tenant.id),
    ]);
    const yen = (v: number) => Math.round(v * 100) / 100;
    return c.json({
      month, recorded: true, settings, source, platformCap: source === 'tenant' ? null : meter.platformCap(),
      monthlyJpy: limit, userLimitJpy: userLimit === null ? null : Math.round(userLimit), usedJpy: yen(t.costJpy), calls: t.calls,
      byPurpose: t.byPurpose.map((p) => ({ purpose: p.purpose, label: purposeLabel(p.purpose, view.allAgents), costJpy: yen(p.costJpy), calls: p.calls })),
      byUser: t.byUser.map((u) => ({
        userId: u.userId, name: u.userId ? users.find((x) => x.id === u.userId)?.displayName ?? '（利用者）' : '自動の処理', costJpy: yen(u.costJpy), calls: u.calls,
        over: userLimit !== null && !!u.userId && u.costJpy >= userLimit,
      })),
    });
  });

  /**
   * ローカルの形の「機械」の様子（仕様書 第8.6.7節）。版・各部の動き・ディスク・証明書・ローカル AI・控え。クラウドの形では 404。
   *
   * @remarks 業務のデータは返さない
   */
  app.get('/machine', async (c) => {
    if (deps.ai.deployment() !== 'onsite') return c.json({ error: 'ローカルの形だけで使えます' }, 404);
    const version = (() => { try { return (JSON.parse(readFileSync(appPath('package.json'), 'utf8')) as { version?: string }).version ?? '0'; } catch { return '0'; } })();
    return c.json(await machineStatus(machineConfigFromEnv(process.env, version)));
  });

  /** 今すぐ控えを取る（ワーカーが次の見回りで取る。第8.6.5節）。控えの置き場が無ければ 400。 */
  app.post('/machine/backup', async (c) => {
    const { tenant, user } = c.get('ctx');
    if (deps.ai.deployment() !== 'onsite') return c.json({ error: 'ローカルの形だけで使えます' }, 404);
    const cfg = backupConfigFromEnv(process.env);
    if (!cfg) return c.json({ error: '控えの置き場が設定されていません（M2O_BACKUP_DIR）' }, 400);
    await requestBackup(cfg.dir, user.id);
    await audit(deps, tenant.id, user.id, 'machine.backup_request', 'machine', 'backup', {});
    return c.json({ ok: true }, 202);
  });

  /** 監査ログ（第16.6節）。 */
  /**
   * 監査ログ（仕様書 第6.6.8.1節）。期間・人・操作の種類で絞り、誰が（人の名前）・何をしたか（業務の言葉）・何に対して（名前）で返す。
   *
   * @remarks 記録の名前と値も並べて返す。`people` と `categories` は絞り込みの選択肢
   */
  app.get('/audit-events', async (c) => {
    const { tenant } = c.get('ctx');
    const q = auditQuery(c.req.query());
    const events = await deps.repo.searchAudit(tenant.id, q);
    const names = await auditNames(deps, tenant.id, events);
    const users = await deps.repo.listUsers(tenant.id);
    return c.json({
      items: events.map((e) => presentAudit(e, names)),
      hasMore: events.length === q.limit,
      people: users.map((u) => ({ id: u.id, name: u.displayName })),
      categories: AUDIT_CATEGORIES.map((x) => ({ id: x.id, label: x.label })),
    });
  });

  /** 監査ログを CSV で出力する（絞った結果をそのまま）。出力したことも記録する（第6.6.8.1節）。 */
  app.get('/audit-events/export', async (c) => {
    const { tenant, user } = c.get('ctx');
    const q = { ...auditQuery(c.req.query()), limit: AUDIT_EXPORT_MAX, offset: 0 };
    const events = await deps.repo.searchAudit(tenant.id, q);
    const names = await auditNames(deps, tenant.id, events);
    await deps.repo.appendAudit({
      id: randomUUID(), tenantId: tenant.id, actorType: 'user', actorId: user.id, action: 'audit.export', targetType: 'audit', targetId: 'csv',
      detail: { from: q.from ?? null, to: q.to ?? null, userId: q.userId ?? null, actions: q.actions ?? null, rows: events.length },
      occurredAt: new Date().toISOString(),
    });
    c.header('Content-Type', 'text/csv; charset=utf-8');
    c.header('Content-Disposition', `attachment; filename="audit-${new Date().toISOString().slice(0, 10)}.csv"`);
    return c.body(auditCsv(events.map((e) => presentAudit(e, names))));
  });

  /** 会社の設定をまとめて返す（第6.6.1節、第6.6.5節、第15.2.1節）。 */
  app.get('/settings', async (c) => {
    const { tenant } = c.get('ctx');
    const settings = await deps.repo.getTenantSettings(tenant.id);
    const view = await deps.tenantView(tenant.id);
    return c.json({
      ...settings,
      catalog: view.agents.map((a) => ({
        id: a.id, name: a.name, description: a.description,
        usesWriteInternal: a.tools.some((t) => view.registry.get(t)?.risk === 'write-internal'),
        defaultMinutes: DEFAULT_STANDARD_MINUTES[a.id] ?? 0,
      })),
    });
  });

  /**
   * 会社の設定の 1 区分を保存する。
   *
   * @remarks
   * 区分ごとに値を検証してから保存する。`external-send` 以上の承認を省略する項目は
   * 受け付けない（自動化ポリシーは `write-internal` だけを持つ。第9.4節）。
   */
  app.put('/settings/:section', async (c) => {
    const { tenant, user } = c.get('ctx');
    const section = c.req.param('section');
    const body = await c.req.json<unknown>();
    const checked = validateSection(section, body, (await deps.tenantView(tenant.id)).allAgents.map((a) => a.id));
    if ('error' in checked) return c.json({ error: checked.error }, 400);
    if (checked.section === 'aiLimits') {
      // 運営一括の会社は、運営が決めた上限を超えて上げられない（第6.6.2節）
      const meter = deps.ai.meter();
      const cap = meter?.platformCap() ?? null;
      const v = checked.value as TenantSettings['aiLimits'];
      const source = (await deps.ai.geminiFor(tenant.id)).source;
      if (cap !== null && source !== 'tenant' && v.monthlyJpy !== null && v.monthlyJpy > cap) {
        return c.json({ error: `運営が決めた上限（${cap.toLocaleString('ja-JP')} 円）を超えて上げられません` }, 400);
      }
      meter?.forget(tenant.id);
    }

    await deps.repo.saveTenantSettings(tenant.id, checked.section, checked.value as never, user.id);
    if (checked.section === 'agents' || checked.section === 'automation') {
      // 初期設定の「使う業務を選ぶ」を済みにする（仕様書 第6.10.3節）
      const current = await deps.repo.getTenantSettings(tenant.id);
      if (!current.onboarding.agentsReviewedAt) {
        await deps.repo.saveTenantSettings(tenant.id, 'onboarding',
          { ...current.onboarding, agentsReviewedAt: new Date().toISOString() }, user.id);
      }
    }
    await audit(deps, tenant.id, user.id, 'settings.update', 'tenant_settings', checked.section,
      { section: checked.section });
    return c.json({ ok: true });
  });

  /**
   * 利用者を招待する（第6.6.4節）。
   *
   * @remarks
   * Workspace のドメインと一致するアドレスだけを受け付ける（第16.1節「テナント判定」）。
   * ログインは Google アカウントで行うため、パスワードは持たない。
   */
  app.post('/users', async (c) => {
    const { tenant, user } = c.get('ctx');
    const body = await c.req.json<{ email?: string; displayName?: string; roles?: string[] }>();
    const email = (body.email ?? '').trim().toLowerCase();
    if (!/^[^@\s]+@[^@\s]+$/.test(email)) return c.json({ error: 'メールアドレスの形式が正しくありません' }, 400);
    if (tenant.workspaceDomain && email.split('@')[1] !== tenant.workspaceDomain) {
      return c.json({ error: `${tenant.workspaceDomain} のアドレスだけを招待できます` }, 400);
    }
    const roles = normalizeRoles(body.roles ?? ['member']);
    if ('error' in roles) return c.json({ error: roles.error }, 400);
    if (await deps.repo.findUserByEmail(tenant.id, email)) {
      return c.json({ error: 'すでに登録されています' }, 409);
    }
    const created: User = {
      id: `u-${randomUUID()}`, tenantId: tenant.id, email,
      displayName: (body.displayName ?? '').trim() || email.split('@')[0]!,
      roles: roles.value, status: 'active',
    };
    await deps.repo.createUser(created);
    await audit(deps, tenant.id, user.id, 'user.invite', 'user', created.id, { roles: created.roles });
    return c.json(created, 201);
  });

  /**
   * 表示名・ロール・状態を変える（第6.6.4節）。
   *
   * @remarks
   * 利用中の管理者が 1 人もいなくなる変更は拒否する。
   * 管理者を失うと、テナントの設定を誰も変えられなくなるため（第16.1節「運用上の前提」）。
   */
  app.patch('/users/:id', async (c) => {
    const { tenant, user } = c.get('ctx');
    const target = await deps.repo.findUserById(tenant.id, c.req.param('id'));
    if (!target) return c.json({ error: '利用者が見つかりません' }, 404);
    const body = await c.req.json<{ displayName?: string; roles?: string[]; status?: string }>();

    const next: User = { ...target };
    if (body.displayName !== undefined) {
      if (!body.displayName.trim()) return c.json({ error: '表示名を入力してください' }, 400);
      next.displayName = body.displayName.trim();
    }
    if (body.roles !== undefined) {
      const roles = normalizeRoles(body.roles);
      if ('error' in roles) return c.json({ error: roles.error }, 400);
      next.roles = roles.value;
    }
    if (body.status !== undefined) {
      if (body.status !== 'active' && body.status !== 'disabled') {
        return c.json({ error: '状態は active か disabled を指定してください' }, 400);
      }
      next.status = body.status;
    }

    const users = await deps.repo.listUsers(tenant.id);
    const admins = users
      .map((u) => (u.id === next.id ? next : u))
      .filter((u) => u.status === 'active' && u.roles.includes('admin'));
    if (admins.length === 0) {
      return c.json({ error: '利用中の管理者が 1 人もいなくなるため、変更できません' }, 409);
    }

    await deps.repo.updateUser(next);
    // 利用を停止したら、その人の Google を使う動いている途中の業務を止める（仕様書 第6.5.2.1節）
    let stoppedRuns = 0;
    // 自分だけの名刺の数（止めてから 30 日で削除される。第27.7節、Q-94）。管理者には件数だけを示す
    let personalCards = 0;
    if (target.status === 'active' && next.status === 'disabled') {
      const now = new Date();
      stoppedRuns = (await deps.revocation.stopUserRuns(tenant.id, next.id, 'user-suspended', now)).length;
      await deps.retention.purgeUser(tenant.id, next.id, now);
      personalCards = await deps.cards.store.countPersonalContacts(tenant.id, next.id);
    }
    await audit(deps, tenant.id, user.id, 'user.update', 'user', next.id,
      { roles: next.roles, status: next.status, ...(stoppedRuns > 0 ? { stoppedRuns } : {}), ...(personalCards > 0 ? { personalCards } : {}) });
    return c.json({ ...next, stoppedRuns, personalCards });
  });

  /**
   * 本人か会社から Google のデータの削除を求められたとき、その人のメールの署名から名刺を新しくした値を前の値に戻し、
   * 変更の記録を消す（第27.6.1節、Q-152）。Google の連携の解除では戻さないため、求めがあったときにだけ管理者が行う。
   */
  app.post('/users/:id/forget-mail-signatures', async (c) => {
    const { tenant, user } = c.get('ctx');
    const target = (await deps.repo.listUsers(tenant.id)).find((u) => u.id === c.req.param('id'));
    if (!target) return c.json({ error: '利用者が見つかりません' }, 404);
    const count = await deps.cards.service.forgetMailSignatures(tenant.id, target.id, user.id);
    return c.json({ ok: true, count });
  });

  /**
   * 組織知識の一覧と、区画の選択肢（第6.6.6節・第11.11.5節）。社内規程・議事録・秘書が学んだことを、廃止した・しまったものも含めて返す。
   * 画面は種類ごとに分けて並べる。あわせて、最後に整理した日と数を返す（中身は返さない）。
   */
  app.get('/knowledge', async (c) => {
    const { tenant } = c.get('ctx');
    const [items, compartments, last] = await Promise.all([
      deps.repo.listKnowledge(tenant.id, { all: true }), deps.repo.listCompartments(tenant.id),
      deps.repo.listAuditSince(tenant.id, ['knowledge.consolidate'], 1),
    ]);
    const consolidated = last[0] ? { at: last[0].occurredAt, detail: last[0].detail } : null;
    return c.json({ items, compartments, consolidated });
  });

  /** 日本時間の今日。 */
  const today = () => new Date(Date.now() + 9 * 3_600_000).toISOString().slice(0, 10);
  /** 廃止・しまったものを戻せる期間（第11.11.2節・第11.11.4節）。 */
  const RESTORE_DAYS = 365;

  /**
   * 社内規程を登録・改定したら、人事・給与の設定と食い違う項目を探して版に残す（第11.11.2節・第30.8.2節）。
   * 待たずに裏で行う（保存の答えを遅らせない）。失敗しても保存は取り消さない。
   */
  const checkHr = (tenantId: string, itemId: string, version: number, body: string) => {
    void deps.hr.service.checkRule(tenantId, body, (raw) => deps.repo.setRuleHrCheck(tenantId, itemId, version, { raw }))
      .catch(() => undefined);
  };

  /**
   * 知識を登録・更新する（第6.6.6節「規程の登録」、第11.11節）。
   *
   * @param newId ID を発行するか。`POST`（新しい社内規程の登録）のときだけ真
   *
   * @remarks
   * 管理者が登録するものは社内規程にする（種類は登録の経路で決め、人に選ばせない）。社内規程を直すと版を残す。施行日（`effectiveFrom`）が先なら、
   * 施行日までは前の版で答える。議事録と秘書が学んだことは、版を残さずに直す。廃止した・しまったものは、戻してから直す。
   */
  const saveKnowledge = (newId: boolean) => async (c: Context<AppEnv>) => {
    const { tenant, user } = c.get('ctx');
    const body = await c.req.json<{
      kind?: string; title?: string; body?: string; source?: string; compartment?: string | null; effectiveFrom?: string | null;
    }>();
    const title = (body.title ?? '').trim();
    const text = (body.body ?? '').trim();
    if (!title || !text) return c.json({ error: '題名と本文を入力してください' }, 400);
    if (text.length > KNOWLEDGE_MAX_CHARS) {
      return c.json({ error: `本文が長すぎます（${KNOWLEDGE_MAX_CHARS.toLocaleString('ja-JP')} 字まで）。章などで分けて登録してください` }, 400);
    }
    const compartment = body.compartment || null;
    if (compartment) {
      const names = (await deps.repo.listCompartments(tenant.id)).map((x) => x.name);
      if (!names.includes(compartment)) return c.json({ error: `区画が見つかりません: ${compartment}` }, 400);
    }
    const effectiveFrom = body.effectiveFrom ? String(body.effectiveFrom) : today();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(effectiveFrom) || Number.isNaN(Date.parse(effectiveFrom))) return c.json({ error: '施行日を YYYY-MM-DD で入れてください' }, 400);
    const id = newId || c.req.param('id') === 'new' ? `k-${randomUUID()}` : c.req.param('id')!;
    // 呼ぶ側が ID を指したときに無ければ、その ID で新しい社内規程として作る（第13.3節、ADR-0019）
    const existing = (await deps.repo.listKnowledge(tenant.id, { all: true })).find((k) => k.id === id) ?? null;
    if (existing && existing.status !== 'active') return c.json({ error: existing.status === 'retired' ? '廃止した知識です。戻してから直してください' : 'しまった知識です。戻してから直してください' }, 409);
    const source = (body.source ?? '').trim() || title;
    const item = {
      id, tenantId: tenant.id, kind: existing?.kind ?? ((body.kind ?? 'rule').trim() || 'rule'), title, body: text,
      source, compartment, updatedAt: new Date().toISOString(),
    };
    let extra: Record<string, unknown> = {};
    if (!existing || existing.category === 'rule') {
      const saved = await deps.repo.saveRuleVersion({ ...item, effectiveFrom }, user.id, today());
      if (!saved) return c.json({ error: '知識が見つかりません' }, 404);
      extra = { version: saved.version, applied: saved.applied, effectiveFrom };
      await audit(deps, tenant.id, user.id, existing ? 'knowledge.rule.revise' : 'knowledge.rule.create', 'knowledge', id, { compartment, ...extra });
      checkHr(tenant.id, id, saved.version, text);
    } else {
      await deps.repo.saveKnowledge({ ...item, originRunId: existing.originRunId ?? null, googleDerived: existing.googleDerived ?? false });
      await audit(deps, tenant.id, user.id, 'knowledge.save', 'knowledge', id, { compartment, category: existing.category });
    }
    // 分け方を管理者が確かめられるように、分けた節を返す（第11.7.2節）
    const sections = (await deps.repo.listKnowledgeSections(tenant.id, id)) ?? [];
    return c.json({ id, sections, ...extra }, newId ? 201 : 200);
  };

  // 新規は ID を発行する。更新は呼ぶ側が ID を指す（仕様書 第13.3節、ADR-0019）
  app.post('/knowledge', saveKnowledge(true));
  app.put('/knowledge/:id', saveKnowledge(false));

  /** 1 件の知識を、どう節に分けたか（第6.6.6節「分け方の確認」）。 */
  app.get('/knowledge/:id/sections', async (c) => {
    const { tenant } = c.get('ctx');
    const sections = await deps.repo.listKnowledgeSections(tenant.id, c.req.param('id'));
    if (!sections) return c.json({ error: '知識が見つかりません' }, 404);
    return c.json({ sections });
  });

  /** 社内規程の版の一覧（第11.11.2節）。 */
  app.get('/knowledge/:id/versions', async (c) => {
    const { tenant } = c.get('ctx');
    const versions = await deps.repo.listKnowledgeVersions(tenant.id, c.req.param('id'));
    if (!versions) return c.json({ error: '知識が見つかりません' }, 404);
    return c.json({ versions });
  });

  /** 社内規程の 1 つの版（本文つき）。 */
  app.get('/knowledge/:id/versions/:version', async (c) => {
    const { tenant } = c.get('ctx');
    const v = await deps.repo.getKnowledgeVersion(tenant.id, c.req.param('id'), Number(c.req.param('version')));
    if (!v) return c.json({ error: '版が見つかりません' }, 404);
    return c.json({ version: v });
  });

  /**
   * 社内規程・議事録を廃止する（第11.11.2節）。消さずに検索から外し、1 年は戻せる。確認の画面を挟まない（ADR-0028。戻せる形で守る）。
   */
  app.post('/knowledge/:id/retire', async (c) => {
    const { tenant, user } = c.get('ctx');
    const item = (await deps.repo.listKnowledge(tenant.id, { all: true })).find((k) => k.id === c.req.param('id'));
    if (!item) return c.json({ error: '知識が見つかりません' }, 404);
    if (item.category === 'learned') return c.json({ error: '秘書が学んだことは、廃止ではなく削除します' }, 409);
    if (item.status !== 'active') return c.json({ error: 'すでに廃止しています' }, 409);
    await deps.repo.setKnowledgeStatus(tenant.id, item.id, 'retired', null, null, new Date().toISOString());
    await audit(deps, tenant.id, user.id, item.category === 'rule' ? 'knowledge.rule.retire' : 'knowledge.minutes.retire', 'knowledge', item.id, {});
    return c.json({ ok: true });
  });

  /** 廃止した社内規程・議事録と、しまった秘書が学んだことを戻す（1 年以内。第11.11.2節・第11.11.4節）。 */
  app.post('/knowledge/:id/restore', async (c) => {
    const { tenant, user } = c.get('ctx');
    const item = (await deps.repo.listKnowledge(tenant.id, { all: true })).find((k) => k.id === c.req.param('id'));
    if (!item) return c.json({ error: '知識が見つかりません' }, 404);
    if (item.status === 'active') return c.json({ error: '使っている知識です' }, 409);
    if (item.statusAt && Date.now() - Date.parse(item.statusAt) > RESTORE_DAYS * 86_400_000) return c.json({ error: '1 年を過ぎたため戻せません' }, 409);
    await deps.repo.setKnowledgeStatus(tenant.id, item.id, 'active', null, null, new Date().toISOString());
    const action = item.category === 'rule' ? 'knowledge.rule.restore' : item.category === 'minutes' ? 'knowledge.minutes.restore' : 'knowledge.restore';
    await audit(deps, tenant.id, user.id, action, 'knowledge', item.id, {});
    return c.json({ ok: true });
  });

  /**
   * 秘書が学んだことを消す（第11.11.1節）。社内規程と議事録は消さない（廃止する）。
   */
  app.delete('/knowledge/:id', async (c) => {
    const { tenant, user } = c.get('ctx');
    const item = (await deps.repo.listKnowledge(tenant.id, { all: true })).find((k) => k.id === c.req.param('id'));
    if (!item) return c.json({ error: '知識が見つかりません' }, 404);
    if (item.category !== 'learned') return c.json({ error: '社内規程と議事録は削除せずに廃止します' }, 409);
    await deps.repo.deleteKnowledge(tenant.id, item.id);
    await audit(deps, tenant.id, user.id, 'knowledge.delete', 'knowledge', item.id, {});
    return c.json({ ok: true });
  });

  /** 接続の状態（第6.6.3節）。Google 未接続の間はダミーであることを示す。 */
  app.get('/connectors', (c) =>
    c.json({
      workspace: {
        source: deps.connector.sourceFor(c.get('ctx').tenant.id),
        label: deps.connector.sourceFor(c.get('ctx').tenant.id) === 'mock'
          ? 'ダミーデータで動作中（Google 未接続）'
          : 'Google Workspace に接続中',
      },
      llm: { provider: deps.llm.name },
    }),
  );

  /**
   * この会社の業務が求める Google の権限（仕様書 第14.3.2節 規定 1・2）。
   *
   * @remarks
   * 使える業務（公式と、導入済み・有効な拡張機能。無効にした業務は除く）のツールから集める。
   * 段階的な認可で求める権限の一覧であり、どの業務が制限付きの権限（CASA の対象）を招くかを示す。
   */
  app.get('/google-permissions', async (c) => {
    const { tenant } = c.get('ctx');
    const [view, settings] = await Promise.all([deps.tenantView(tenant.id), deps.repo.getTenantSettings(tenant.id)]);
    const byScope = new Map<string, { scope: string; level: string; tools: Set<string>; agents: Set<string> }>();
    for (const agent of view.agents.filter((a) => !settings.agents.disabled.includes(a.id))) {
      for (const tool of view.registry.allowed(agent.tools)) {
        for (const g of toolGoogleScopes(tool)) {
          const e = byScope.get(g.scope) ?? { scope: g.scope, level: g.level, tools: new Set(), agents: new Set() };
          e.tools.add(tool.name);
          e.agents.add(agent.name);
          byScope.set(g.scope, e);
        }
      }
    }
    const order = { restricted: 0, sensitive: 1, 'non-sensitive': 2 } as Record<string, number>;
    return c.json({
      items: [...byScope.values()]
        .sort((a, b) => (order[a.level] ?? 3) - (order[b.level] ?? 3) || a.scope.localeCompare(b.scope))
        .map((e) => ({ scope: e.scope, level: e.level, tools: [...e.tools].sort(), agents: [...e.agents].sort() })),
    });
  });

  return app;
}

const ROLES: Role[] = ['admin', 'approver', 'member', 'external', 'developer'];

function normalizeRoles(input: string[]): { value: Role[] } | { error: string } {
  const roles = [...new Set(input)];
  const unknown = roles.filter((r) => !ROLES.includes(r as Role));
  if (unknown.length > 0) return { error: `不明なロールです: ${unknown.join(', ')}` };
  if (roles.length === 0) return { error: 'ロールを 1 つ以上指定してください' };
  return { value: roles as Role[] };
}

type Section = keyof TenantSettings;

/** 口の名前（`api:<口>`・`worker:<処理>`）を、利用状況に出す業務の言葉にする。 */
const PURPOSE_LABELS: Record<string, string> = {
  secretary: '秘書', voice: '音声の秘書', other: 'そのほか', worker: '自動の処理',
  'api:columns': 'コラムの作成', 'api:print-designs': '販促物の作成', 'api:competitors': '競合の分析', 'api:cards': '名刺管理',
  'api:inventory': '在庫管理', 'api:signage': '店頭サイネージ', 'api:announcements': 'お知らせの作成', 'api:inquiries': '問い合わせの記録',
  'api:web-review': 'Webの分析', 'api:contracts': '契約書の管理', 'api:subsidies': '補助金・助成金', 'api:members': '会員とポイント',
  'api:hr': '人事・給与', 'api:reservations': '予約', 'api:knowledge': '知識', 'api:files': 'ファイル', 'api:me': '個人設定', 'api:admin': '管理者ページ',
  'worker:competitors': '競合の分析（見回り）', 'worker:columns': 'コラムの作成（予定とテーマ案）', 'worker:web-review': 'Webの分析（月の便り）',
  'worker:subsidies': '補助金・助成金（月の調べもの）', 'worker:knowledge': '秘書が学んだことの整理', 'worker:proactive': '秘書の先回り',
  'worker:memory': '会話から覚えること', 'worker:inquiries': '問い合わせの見張り', 'worker:announcements': 'お知らせの作成（予約）',
};

/** 用途の名前（業務は業務の名前）。 */
function purposeLabel(purpose: string, agents: { id: string; name: string }[]): string {
  if (purpose.startsWith('agent:')) {
    const id = purpose.slice(6);
    return agentDisplayName(agents.find((a) => a.id === id)?.name, id);
  }
  return PURPOSE_LABELS[purpose] ?? (purpose.startsWith('api:') ? `画面の操作（${purpose.slice(4)}）` : purpose.startsWith('worker:') ? `自動の処理（${purpose.slice(7)}）` : purpose);
}

/** 設定の区分ごとに値を検証し、保存できる形に整える。 */
function validateSection(
  section: string,
  body: unknown,
  agentIds: string[],
): { section: Section; value: TenantSettings[Section] } | { error: string } {
  const o = (body ?? {}) as Record<string, unknown>;
  const str = (k: string, max = 2000) => String(o[k] ?? '').slice(0, max);
  switch (section) {
    case 'company': {
      const month = Number(o['fiscalYearStartMonth']);
      if (!Number.isInteger(month) || month < 1 || month > 12) return { error: '会計年度の開始月は 1〜12 です' };
      const invoice = str('invoiceRegistrationNumber', 20).trim();
      if (!isValidInvoiceNumber(invoice)) return { error: '登録番号は T に続く 13 桁の数字です' };
      const rounding = o['taxRounding'];
      if (rounding !== 'floor' && rounding !== 'round' && rounding !== 'ceil') {
        return { error: '端数処理は切り捨て・四捨五入・切り上げのいずれかです' };
      }
      const closing = o['closingDay'] === 'end' ? 'end' : Number(o['closingDay']);
      if (closing !== 'end' && (!Number.isInteger(closing) || closing < 1 || closing > 28)) {
        return { error: '締め日は 1〜28 日、または月末です' };
      }
      const postal = str('postalCode', 10).trim();
      if (postal && !/^\d{3}-?\d{4}$/.test(postal)) return { error: '郵便番号は 123-4567 の形で書いてください' };
      // 自社の Web サイト（第36.4節）。http か https の URL だけ
      const website = str('website', 300).trim();
      // 営業する曜日（0=日〜6=土）と祝日を休みにするか（第 0.243.0 版）。選ばれていなければ月〜金
      const days = Array.isArray(o['businessDays']) ? [...new Set((o['businessDays'] as unknown[]).map(Number).filter((n) => Number.isInteger(n) && n >= 0 && n <= 6))].sort() : [1, 2, 3, 4, 5];
      if (days.length === 0) return { error: '営業する曜日を 1 つ以上選んでください' };
      if (website && !/^https?:\/\/[^\s/]+\.[^\s]+$/i.test(website)) return { error: 'Web サイトは https:// から始まる URL で書いてください' };
      const value: CompanyInfo = {
        legalName: str('legalName', 200), shortName: str('shortName', 30).trim(),
        postalCode: postal && !postal.includes('-') ? `${postal.slice(0, 3)}-${postal.slice(3)}` : postal,
        address: str('address', 300), phone: str('phone', 50),
        fiscalYearStartMonth: month, invoiceRegistrationNumber: invoice, taxRounding: rounding,
        closingDay: closing, paymentTerms: str('paymentTerms', 200),
        // 画面の左上のロゴ（仕様書 第6.6.1節）。会社が上げた画像のファイル ID
        logoFileId: str('logoFileId', 100).trim() || null,
        website,
        businessDays: days,
        holidaysClosed: o['holidaysClosed'] !== false,
      };
      return { section: 'company', value };
    }
    case 'writingStyle': {
      const terms = Array.isArray(o['terms']) ? o['terms'] : [];
      const value: WritingStyle = {
        selfReference: str('selfReference', 20), greeting: str('greeting', 500),
        closing: str('closing', 500), signature: str('signature', 1000), notes: str('notes', 2000),
        terms: terms.slice(0, 50)
          .map((t) => ({ use: String((t as Record<string, unknown>)['use'] ?? '').trim(),
                         avoid: String((t as Record<string, unknown>)['avoid'] ?? '').trim() }))
          .filter((t) => t.use && t.avoid),
      };
      return { section: 'writingStyle', value };
    }
    case 'automation': {
      const ok = (v: unknown) => v === 'require' || v === 'allow';
      if (!ok(o['writeInternal'])) return { error: 'writeInternal は require か allow です' };
      const perAgent: Record<string, 'require' | 'allow'> = {};
      for (const [k, v] of Object.entries((o['perAgent'] ?? {}) as Record<string, unknown>)) {
        if (!agentIds.includes(k)) return { error: `不明なエージェントです: ${k}` };
        if (!ok(v)) return { error: `${k} の値は require か allow です` };
        perAgent[k] = v as 'require' | 'allow';
      }
      const value: AutomationPolicy = { writeInternal: o['writeInternal'] as 'require' | 'allow', perAgent };
      return { section: 'automation', value };
    }
    case 'agents': {
      const disabled = Array.isArray(o['disabled']) ? o['disabled'].map(String) : [];
      const unknown = disabled.filter((id) => !agentIds.includes(id));
      if (unknown.length > 0) return { error: `不明なエージェントです: ${unknown.join(', ')}` };
      return { section: 'agents', value: { disabled: [...new Set(disabled)] } };
    }
    case 'effect': {
      // 標準所要時間（分）。削減時間の推計に使う（仕様書 第6.7.12節）
      const input = (o['minutesPerRun'] ?? {}) as Record<string, unknown>;
      const minutesPerRun: Record<string, number> = {};
      for (const [k, v] of Object.entries(input)) {
        if (!agentIds.includes(k)) return { error: `不明なエージェントです: ${k}` };
        const n = Number(v);
        if (!Number.isFinite(n) || n < 0 || n > 600) return { error: '標準所要時間は 0〜600 分で入力してください' };
        minutesPerRun[k] = Math.round(n * 10) / 10;
      }
      return { section: 'effect', value: { minutesPerRun } };
    }
    case 'dashboard': {
      // 人の状態の粒度（第6.7.4.1節、Q-64）。既定は個人名
      const people = o['people'] === 'counts' ? 'counts' : 'names';
      return { section: 'dashboard', value: { people } };
    }
    case 'slides': {
      // スライドのテンプレート（仕様書 第9.4.2節）。URL から ID を取り出し、名前の重なりと既定を整える
      const input = Array.isArray(o['templates']) ? o['templates'] : [];
      if (input.length > 10) return { error: 'テンプレートは 10 件までです' };
      const templates: SlideTemplate[] = [];
      for (const [i, raw] of input.entries()) {
        const t = (raw ?? {}) as Record<string, unknown>;
        const presentationId = parsePresentationId(String(t['url'] ?? t['presentationId'] ?? ''));
        if (!presentationId) return { error: `${i + 1} 件目: Google スライドの URL（または ID）を確認してください` };
        const name = String(t['name'] ?? '').trim().slice(0, 40) || `テンプレート ${i + 1}`;
        if (templates.some((x) => x.name === name)) return { error: `名前「${name}」が重なっています` };
        templates.push({
          id: String(t['id'] ?? '') || `st-${randomUUID()}`, name, presentationId,
          description: String(t['description'] ?? '').trim().slice(0, 200), isDefault: t['isDefault'] === true,
        });
      }
      // 既定はちょうど 1 つ。指定が無ければ先頭、複数なら最初のものだけを既定にする
      const first = templates.findIndex((x) => x.isDefault);
      templates.forEach((x, i) => { x.isDefault = i === (first === -1 ? 0 : first); });
      return { section: 'slides', value: { templates } };
    }
    case 'privacy': {
      // Google から取得したデータを残す日数（仕様書 第14.3.2節）。短くはできるが、7 日より長くはできない
      const days = Number(o['googleDataRetentionDays']);
      if (!Number.isInteger(days) || days < 0 || days > GOOGLE_DATA_RETENTION_DAYS) {
        return { error: `残す日数は 0〜${GOOGLE_DATA_RETENTION_DAYS} 日で指定してください` };
      }
      return { section: 'privacy', value: { googleDataRetentionDays: days } };
    }
    case 'invoice': {
      // 帳票の体裁（仕様書 第15.2.2節、Q-57）。ロゴは会社が上げた画像のファイル ID
      const text = (v: unknown, max: number) => String(v ?? '').trim().slice(0, max);
      const logoFileId = text(o['logoFileId'], 100) || null;
      return {
        section: 'invoice',
        value: {
          logoFileId,
          bankAccount: text(o['bankAccount'], 200),
          paymentDue: text(o['paymentDue'], 50),
          notes: text(o['notes'], 300),
          sealBox: o['sealBox'] === true,
        },
      };
    }
    case 'aiLimits': {
      // AI の利用の上限（第6.6.2節、ADR-0079）。上限なしは null。1 人の割合は 1〜10 割
      const raw = o['monthlyJpy'];
      const monthly = raw === null || raw === '' || raw === undefined ? null : Number(raw);
      if (monthly !== null && (!Number.isFinite(monthly) || monthly < 0 || monthly > 100_000_000)) return { error: '月の上限は 0〜1 億円で入れてください（上限なしは空）' };
      const share = o['perUserShare'] === undefined ? DEFAULT_AI_PER_USER_SHARE : Number(o['perUserShare']);
      if (!Number.isFinite(share) || share < 0.1 || share > 1) return { error: '1 人の上限は会社の上限の 1〜10 割です' };
      return { section: 'aiLimits', value: { monthlyJpy: monthly === null ? null : Math.round(monthly), perUserShare: Math.round(share * 100) / 100 } };
    }
    case 'knowledge':
      // 言い換えは秘書が探すたびに考える。新しく登録することはしない（仕様書 第11.7.7.0節、ADR-0028）。登録済みの組はそのまま効く
      return { error: '言い換えは秘書が探すたびに考えるため、登録できません' };
    default:
      return { error: `不明な設定の区分です: ${section}` };
  }
}

async function audit(
  deps: AppDeps, tenantId: string, userId: string, action: string, targetType: string,
  targetId: string, detail: Record<string, unknown>,
) {
  await deps.repo.appendAudit({
    id: randomUUID(), tenantId, actorType: 'user', actorId: userId, action, targetType, targetId,
    detail, occurredAt: new Date().toISOString(),
  });
}

/** 画面の 1 回で返す監査ログの件数（第6.6.8.1節）。 */
const AUDIT_PAGE = 200;
/** CSV に出す上限の件数。 */
const AUDIT_EXPORT_MAX = 10_000;
/** 期間を指定しないときの既定（直近 7 日）。 */
const AUDIT_DEFAULT_DAYS = 7;

/**
 * 画面の絞り込みを、監査ログの問い合わせにする。
 *
 * @param p `from`・`to`（日付 `YYYY-MM-DD`。日本時間の一日として扱い、`to` はその日の終わりまで）、`user`、`category`、`offset`
 */
function auditQuery(p: Record<string, string>): AuditQuery {
  const day = (v: string | undefined, end: boolean) => {
    if (!v || !/^\d{4}-\d{2}-\d{2}$/.test(v)) return undefined;
    const t = new Date(`${v}T00:00:00+09:00`);
    if (end) t.setUTCDate(t.getUTCDate() + 1);
    return t.toISOString();
  };
  const from = day(p['from'], false) ?? new Date(Date.now() - AUDIT_DEFAULT_DAYS * 86_400_000).toISOString();
  const category = AUDIT_CATEGORIES.find((x) => x.id === p['category']);
  const offset = Math.max(0, Number(p['offset']) || 0);
  return {
    from, ...(day(p['to'], true) ? { to: day(p['to'], true)! } : {}),
    ...(p['user'] ? { userId: p['user'] } : {}),
    ...(category ? { actions: category.prefixes } : {}),
    limit: AUDIT_PAGE, offset,
  };
}

/**
 * 監査ログに出てくる ID の名前をまとめて引く（人・業務・接続・グループ・区画・実行）。
 *
 * @remarks 実行は、対象か根拠の `runId` に出てくるものだけを引く。引けないものは `undefined`（記録の値のまま出す）
 */
async function auditNames(deps: AppDeps, tenantId: string, events: AuditEvent[]): Promise<AuditNames> {
  const [users, view, groups, compartments] = await Promise.all([
    deps.repo.listUsers(tenantId), deps.tenantView(tenantId),
    deps.repo.listGroups(tenantId).catch(() => []), deps.repo.listCompartmentAssignments(tenantId).catch(() => []),
  ]);
  const runIds = new Set<string>();
  for (const e of events) {
    // 秘書の記録の対象は、起こした実行の ID のことがある（調べもの・取次）
    if (e.targetType === 'run' || (e.targetType === 'secretary' && /^[0-9a-f-]{36}$/.test(e.targetId))) runIds.add(e.targetId);
    if (typeof e.detail?.['runId'] === 'string') runIds.add(e.detail['runId'] as string);
  }
  const runs = new Map<string, { agentName: string; requestedBy: string }>();
  for (const id of runIds) {
    const run = await deps.repo.getRun(tenantId, id).catch(() => null);
    const job = run ? await deps.repo.getJob(tenantId, run.jobId).catch(() => null) : null;
    if (job) runs.set(id, { agentName: agentDisplayName(view.allAgents.find((a) => a.id === job.agentId)?.name, job.agentId, job.agentName), requestedBy: job.requestedBy });
  }
  return {
    user: (id) => users.find((u) => u.id === id)?.displayName,
    agent: (id) => view.allAgents.find((a) => a.id === id)?.name,
    connection: (id) => view.connections.find((x) => x.id === id)?.name,
    group: (id) => groups.find((g) => g.id === id)?.name,
    compartment: (id) => compartments.find((x) => x.id === id)?.name,
    run: (id) => runs.get(id),
  };
}

