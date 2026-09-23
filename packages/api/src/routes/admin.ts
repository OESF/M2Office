/**
 * @file 管理者ページ（`/admin`）が使う API。利用状況・実行の一覧・設定・ユーザー・知識を扱う。
 *
 * 管理者ロールを持つ者だけが呼べる。管理者でも、他人の会話や実行の中身は見られない（不変則 I-10）。
 *
 * @see 仕様書 第6.6節 管理者ページ
 */

import { randomUUID } from 'node:crypto';
import { Hono } from 'hono';
import {
  isValidInvoiceNumber, parsePresentationId, parseSynonymLines, type AutomationPolicy, type CompanyInfo, type Role, type SlideTemplate, type TenantSettings,
  type User, type WritingStyle,
} from '@m2office/shared';
import { DEFAULT_STANDARD_MINUTES, GOOGLE_DATA_RETENTION_DAYS, KNOWLEDGE_MAX_CHARS } from '@m2office/core';
import type { AppDeps } from '../context.js';
import { requireRole, type AppEnv } from '../middleware/tenant.js';

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
      agentId: job.agentId, agentName: allAgents.find((a) => a.id === job.agentId)?.name ?? job.agentId,
      origin: job.origin, requestedBy: job.requestedBy,
    }));
    return c.json({ items });
  });

  /** 利用量の集計。エージェント別の件数と費用（第6.6.7節）。 */
  app.get('/usage', async (c) => {
    const { tenant } = c.get('ctx');
    const rows = await deps.repo.usageByAgent(tenant.id);
    const { allAgents } = await deps.tenantView(tenant.id);
    const items = rows.map((r) => ({
      ...r,
      name: allAgents.find((a) => a.id === r.agentId)?.name ?? r.agentId,
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

  /** 監査ログ（第16.6節）。 */
  app.get('/audit-events', async (c) => {
    const { tenant } = c.get('ctx');
    const items = await deps.repo.listAudit(tenant.id, 200);
    return c.json({ items });
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

    await deps.repo.saveTenantSettings(tenant.id, checked.section, checked.value as never, user.id);
    if (checked.section === 'agents' || checked.section === 'automation') {
      // 初期設定の「使う業務を選ぶ」を済みにする（仕様書 第6.10.3節）
      const current = await deps.repo.getTenantSettings(tenant.id);
      if (!current.onboarding.agentsReviewedAt) {
        await deps.repo.saveTenantSettings(tenant.id, 'onboarding',
          { ...current.onboarding, agentsReviewedAt: new Date().toISOString() }, user.id);
      }
    }
    if (checked.section === 'knowledge') {
      // 言い換えの登録と変更は、専用の操作として残す（第11.7.7節）
      const v = checked.value as TenantSettings['knowledge'];
      await audit(deps, tenant.id, user.id, 'knowledge.synonyms.save', 'tenant_settings', 'knowledge',
        { standardSynonyms: v.standardSynonyms, groups: v.synonyms.length });
    } else {
      await audit(deps, tenant.id, user.id, 'settings.update', 'tenant_settings', checked.section,
        { section: checked.section });
    }
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
    if (target.status === 'active' && next.status === 'disabled') {
      const now = new Date();
      stoppedRuns = (await deps.revocation.stopUserRuns(tenant.id, next.id, 'user-suspended', now)).length;
      await deps.retention.purgeUser(tenant.id, next.id, now);
    }
    await audit(deps, tenant.id, user.id, 'user.update', 'user', next.id,
      { roles: next.roles, status: next.status, ...(stoppedRuns > 0 ? { stoppedRuns } : {}) });
    return c.json({ ...next, stoppedRuns });
  });

  /** 組織知識の一覧と、区画の選択肢（第6.6.6節）。 */
  app.get('/knowledge', async (c) => {
    const { tenant } = c.get('ctx');
    const [items, compartments] = await Promise.all([
      deps.repo.listKnowledge(tenant.id), deps.repo.listCompartments(tenant.id),
    ]);
    return c.json({ items, compartments });
  });

  /**
   * 規程などを組織知識として登録・更新する（第6.6.6節「規程の登録」）。
   *
   * @remarks
   * 導入時の初期投入に使う（第22.2節）。AG-04 はここに登録したものから答える。
   */
  app.put('/knowledge/:id', async (c) => {
    const { tenant, user } = c.get('ctx');
    const body = await c.req.json<{
      kind?: string; title?: string; body?: string; source?: string; compartment?: string | null;
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
    const id = c.req.param('id') === 'new' ? `k-${randomUUID()}` : c.req.param('id');
    await deps.repo.saveKnowledge({
      id, tenantId: tenant.id, kind: (body.kind ?? 'rule').trim() || 'rule', title, body: text,
      source: (body.source ?? '').trim() || title, compartment, updatedAt: new Date().toISOString(),
    });
    await audit(deps, tenant.id, user.id, 'knowledge.save', 'knowledge', id, { compartment });
    // 分け方を管理者が確かめられるように、分けた節を返す（第11.7.2節）
    const sections = (await deps.repo.listKnowledgeSections(tenant.id, id)) ?? [];
    return c.json({ id, sections });
  });

  /** 1 件の知識を、どう節に分けたか（第6.6.6節「分け方の確認」）。 */
  app.get('/knowledge/:id/sections', async (c) => {
    const { tenant } = c.get('ctx');
    const sections = await deps.repo.listKnowledgeSections(tenant.id, c.req.param('id'));
    if (!sections) return c.json({ error: '知識が見つかりません' }, 404);
    return c.json({ sections });
  });

  app.delete('/knowledge/:id', async (c) => {
    const { tenant, user } = c.get('ctx');
    const ok = await deps.repo.deleteKnowledge(tenant.id, c.req.param('id'));
    if (!ok) return c.json({ error: '知識が見つかりません' }, 404);
    await audit(deps, tenant.id, user.id, 'knowledge.delete', 'knowledge', c.req.param('id'), {});
    return c.json({ ok: true });
  });

  /** 接続の状態（第6.6.3節）。Google 未接続の間はダミーであることを示す。 */
  app.get('/connectors', (c) =>
    c.json({
      workspace: {
        source: deps.connector.source,
        label: deps.connector.source === 'mock'
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
        if (!tool.google) continue;
        const e = byScope.get(tool.google.scope) ?? { scope: tool.google.scope, level: tool.google.level, tools: new Set(), agents: new Set() };
        e.tools.add(tool.name);
        e.agents.add(agent.name);
        byScope.set(tool.google.scope, e);
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
      const value: CompanyInfo = {
        legalName: str('legalName', 200), address: str('address', 300), phone: str('phone', 50),
        fiscalYearStartMonth: month, invoiceRegistrationNumber: invoice, taxRounding: rounding,
        closingDay: closing, paymentTerms: str('paymentTerms', 200),
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
    case 'knowledge': {
      // 言い換え（仕様書 第11.7.7節）。1 行に 1 組の文でも、組の配列でも受け付ける
      const raw = o['synonyms'];
      const text = typeof raw === 'string'
        ? raw
        : Array.isArray(raw) ? raw.map((g) => (Array.isArray(g) ? g.map(String).join('、') : String(g))).join('\n') : '';
      const parsed = parseSynonymLines(text);
      if ('error' in parsed) return { error: parsed.error };
      return { section: 'knowledge', value: { standardSynonyms: o['standardSynonyms'] !== false, synonyms: parsed.groups } };
    }
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
