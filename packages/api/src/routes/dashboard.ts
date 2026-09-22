/**
 * @file ダッシュボードの API。会社の管理者が「いま」と「集計」を見るためのデータを返す。
 *
 * 返すのは状態・業務の名前・件数・時間・費用までであり、入力・成果物・会話の中身は返さない。
 * 個人ごとの勤務時間の集計も返さない。
 *
 * @see 仕様書 第6.7節 ダッシュボード
 */

import { Hono } from 'hono';
import type { Approval, AuditEvent, Job, Run, User } from '@m2office/shared';
import { OFFICIAL_AGENTS, resolveOfficialAgent, stepLabel } from '@m2office/core';
import type { AppDeps } from '../context.js';
import { requireRole, type AppEnv } from '../middleware/tenant.js';

/** 「ログイン中」とみなす、最後の操作からの時間（分）。 */
const ACTIVE_WINDOW_MIN = 15;

/** ダッシュボードの出来事として扱う監査ログの種類。ログインは含めない（第6.7.10節）。 */
const EVENT_ACTIONS = [
  'job.create', 'run.complete', 'run.fail', 'run.await_approval', 'run.await_confirmation',
  'approval.decide', 'schedule.skip',
];

/** 流れの中の 1 段階の状態。 */
type StepState = 'done' | 'current' | 'waiting' | 'failed' | 'todo';

/**
 * ダッシュボードの API を組み立てる。
 *
 * @remarks 管理者ロールを持つ者だけが呼べる（仕様書 第6.7.2節）。
 */
export function dashboardRoute(deps: AppDeps) {
  const app = new Hono<AppEnv>();
  app.use('*', requireRole('admin'));

  /** いまの状態。上部の数値・業務の流れ・承認の滞留・出来事（第6.7.3節）。 */
  app.get('/live', async (c) => {
    const { tenant } = c.get('ctx');
    const now = new Date();
    const todayStart = jstDayStart(now, 0);

    const [users, liveRuns, pending, todayRows, activeUsers, events] = await Promise.all([
      deps.repo.listUsers(tenant.id),
      deps.repo.listLiveRuns(tenant.id, todayStart),
      deps.repo.listPendingApprovals(tenant.id),
      deps.repo.runStats(tenant.id, todayStart),
      deps.repo.countActiveUsers(tenant.id, new Date(now.getTime() - ACTIVE_WINDOW_MIN * 60_000)),
      deps.repo.listAuditSince(tenant.id, EVENT_ACTIONS, 30),
    ]);
    const nameOf = names(users);

    // 承認待ちを実行に結び付ける（誰の判断を待っているかを示すため）
    const approvalByRun = new Map<string, Approval>();
    for (const a of pending) {
      const step = await deps.repo.getRunStepById(tenant.id, a.runStepId);
      if (step) approvalByRun.set(step.runId, a);
    }

    const flows = [];
    for (const { run, job } of liveRuns) {
      const steps = await deps.repo.listRunSteps(tenant.id, run.id);
      const confirming = steps.some((s) => s.status === 'awaiting' && s.stepId.endsWith(':confirm'));
      const approval = approvalByRun.get(run.id) ?? null;
      flows.push({
        runId: run.id,
        agentName: agentName(job.agentId),
        status: run.status,
        requester: nameOf(job.requestedBy),
        origin: job.origin,
        startedAt: run.startedAt,
        steps: flowSteps(job, run, confirming),
        waitingFor: approval
          ? { who: approverText(approval, nameOf), since: approval.createdAt, kind: confirming ? 'confirm' : 'approval' }
          : null,
        failureReason: run.status === 'failed' ? run.failureReason : null,
      });
    }

    const backlog = [];
    for (const a of pending) {
      const step = await deps.repo.getRunStepById(tenant.id, a.runStepId);
      const run = step ? await deps.repo.getRun(tenant.id, step.runId) : null;
      const job = run ? await deps.repo.getJob(tenant.id, run.jobId) : null;
      backlog.push({
        approvalId: a.id,
        agentName: job ? agentName(job.agentId) : '不明な業務',
        // 操作の確認は引数（中身）を含むため、何の確認かだけを示す
        what: step?.stepId.endsWith(':confirm') ? '操作の確認' : firstLine(a.present),
        requester: job ? nameOf(job.requestedBy) : '—',
        approver: approverText(a, nameOf),
        since: a.createdAt,
      });
    }
    backlog.sort((x, y) => x.since.localeCompare(y.since));

    const today = todayRows.reduce(
      (t, r) => ({
        runs: t.runs + r.runs,
        costJpy: t.costJpy + r.costJpy,
        savedMinutes: t.savedMinutes + r.savedMinutes,
        failed: t.failed + (r.status === 'failed' ? r.runs : 0),
      }),
      { runs: 0, costJpy: 0, savedMinutes: 0, failed: 0 },
    );

    const runAgent = new Map(liveRuns.map(({ run, job }) => [run.id, job.agentId]));
    const recent = await deps.repo.listRunsWithJobs(tenant.id, { limit: 200 });
    for (const { run, job } of recent) runAgent.set(run.id, job.agentId);

    return c.json({
      generatedAt: now.toISOString(),
      counts: {
        activeUsers,
        running: liveRuns.filter(({ run }) => run.status === 'queued' || run.status === 'running').length,
        awaitingApproval: pending.length,
        failedToday: today.failed,
        todayRuns: today.runs,
        todayCostJpy: round2(today.costJpy),
        todaySavedMinutes: round1(today.savedMinutes),
      },
      flows,
      backlog,
      events: events.map((e) => eventView(e, nameOf, runAgent)).filter((e) => e !== null),
    });
  });

  /** 集計（第6.7.8節）。`days` は 1・7・30 のいずれか。 */
  app.get('/stats', async (c) => {
    const { tenant } = c.get('ctx');
    const days = [1, 7, 30].includes(Number(c.req.query('days'))) ? Number(c.req.query('days')) : 7;
    const now = new Date();
    const since = jstDayStart(now, days - 1);

    const [rows, secretary, knowledge, pending, settings] = await Promise.all([
      deps.repo.runStats(tenant.id, since),
      deps.repo.countAuditActions(tenant.id, since, [
        'secretary.direct', 'secretary.route', 'secretary.chat', 'tool.invoke',
      ]),
      deps.repo.countKnowledge(tenant.id),
      deps.repo.listPendingApprovals(tenant.id),
      deps.repo.getTenantSettings(tenant.id),
    ]);

    // 日ごと（欠けた日も 0 で埋める）
    const dayKeys = Array.from({ length: days }, (_, i) => jstDate(now, days - 1 - i));
    const daily = dayKeys.map((day) => {
      const r = rows.filter((x) => x.day === day);
      return {
        day,
        runs: sum(r, 'runs'),
        completed: sum(r.filter((x) => x.status === 'completed'), 'runs'),
        failed: sum(r.filter((x) => x.status === 'failed'), 'runs'),
        costJpy: round2(sum(r, 'costJpy')),
        savedMinutes: round1(sum(r, 'savedMinutes')),
      };
    });

    const hourly = Array.from({ length: 24 }, (_, h) => sum(rows.filter((x) => x.hour === h), 'runs'));

    const byAgent = OFFICIAL_AGENTS.map((a) => {
      const r = rows.filter((x) => x.agentId === a.id);
      const completed = sum(r.filter((x) => x.status === 'completed'), 'runs');
      const finished = sum(r.filter((x) => ['completed', 'failed', 'cancelled'].includes(x.status)), 'runs');
      return {
        agentId: a.id,
        name: a.name,
        enabled: !settings.agents.disabled.includes(a.id),
        runs: sum(r, 'runs'),
        completed,
        successRate: finished > 0 ? round1((completed / finished) * 100) : null,
        avgDurationSec: completed > 0 ? Math.round(sum(r.filter((x) => x.status === 'completed'), 'durationSec') / completed) : null,
        savedMinutes: round1(sum(r, 'savedMinutes')),
        costJpy: round2(sum(r, 'costJpy')),
        tokens: sum(r, 'tokens'),
      };
    });

    const completed = sum(rows.filter((x) => x.status === 'completed'), 'runs');
    const finished = sum(rows.filter((x) => ['completed', 'failed', 'cancelled'].includes(x.status)), 'runs');
    const layer = (a: string) => secretary.filter((x) => x.action === a).reduce((t, x) => t + x.n, 0);
    const oldest = pending.map((p) => p.createdAt).sort()[0] ?? null;

    return c.json({
      days,
      since,
      totals: {
        runs: sum(rows, 'runs'),
        completed,
        failed: sum(rows.filter((x) => x.status === 'failed'), 'runs'),
        successRate: finished > 0 ? round1((completed / finished) * 100) : null,
        avgDurationSec: completed > 0 ? Math.round(sum(rows.filter((x) => x.status === 'completed'), 'durationSec') / completed) : null,
        savedMinutes: round1(sum(rows, 'savedMinutes')),
        costJpy: round2(sum(rows, 'costJpy')),
        tokens: sum(rows, 'tokens'),
      },
      daily,
      hourly,
      byAgent,
      secretary: {
        direct: layer('secretary.direct'),
        route: layer('secretary.route'),
        chat: layer('secretary.chat'),
      },
      backlog: { pending: pending.length, oldestSince: oldest },
      knowledge: {
        items: knowledge,
        searches: secretary
          .filter((x) => x.action === 'tool.invoke' && x.targetId === 'knowledge.search')
          .reduce((t, x) => t + x.n, 0),
      },
      health: {
        workspace: deps.connector.source === 'mock' ? 'ダミーデータで動作中（Google 未接続）' : 'Google Workspace に接続中',
        llm: deps.llm.name === 'stub' ? 'スタブ（推論を行わない開発用）' : deps.llm.name,
      },
    });
  });

  return app;
}

/** 定義の段階を並べ、実行の位置から各段階の状態を決める（第6.7.5節）。 */
function flowSteps(job: Job, run: Run, confirming: boolean) {
  const def = resolveOfficialAgent(job.agentId, job.agentVersion);
  if (!def) return [];
  const out: { label: string; state: StepState }[] = [];
  def.steps.forEach((step, i) => {
    let state: StepState = i < run.cursor ? 'done' : i === run.cursor ? 'current' : 'todo';
    if (i === run.cursor) {
      if (run.status === 'failed') state = 'failed';
      else if (run.status === 'awaiting_approval') state = confirming ? 'done' : 'waiting';
      else if (run.status === 'queued' && run.cursor === 0) state = 'todo';
    }
    out.push({ label: stepLabel(step), state });
    // 操作の確認は定義に無い段階として、止まっているステップの直後に差し込む（第9.2.4節）
    if (i === run.cursor && confirming) out.push({ label: '確認', state: 'waiting' });
  });
  return out;
}

function eventView(
  e: AuditEvent,
  nameOf: (id: string | null | undefined) => string,
  runAgent: Map<string, string>,
): { at: string; kind: string; text: string } | null {
  const d = e.detail as Record<string, string | undefined>;
  const agentOfRun = (runId: string | undefined) => agentName(runAgent.get(runId ?? '') ?? '');
  switch (e.action) {
    case 'job.create':
      return {
        at: e.occurredAt, kind: 'start',
        text: d['origin'] === 'schedule'
          ? `定時実行で「${agentName(d['agentId'] ?? '')}」を開始（${nameOf(d['requestedBy'])}さん）`
          : `${nameOf(d['requestedBy'] ?? e.actorId)}さんが「${agentName(d['agentId'] ?? '')}」を開始`,
      };
    case 'run.complete':
      return { at: e.occurredAt, kind: 'done', text: `「${agentOfRun(e.targetId)}」が完了` };
    case 'run.fail':
      return { at: e.occurredAt, kind: 'fail', text: `「${agentOfRun(e.targetId)}」が失敗しました` };
    case 'run.await_approval':
      return { at: e.occurredAt, kind: 'wait', text: `「${agentOfRun(e.targetId)}」が承認待ちになりました` };
    case 'run.await_confirmation':
      return { at: e.occurredAt, kind: 'wait', text: `「${agentOfRun(e.targetId)}」が操作の確認待ちになりました` };
    case 'approval.decide':
      return {
        at: e.occurredAt, kind: d['decision'] === 'approved' ? 'done' : 'fail',
        text: `${nameOf(e.actorId)}さんが「${agentOfRun(d['runId'])}」を${d['decision'] === 'approved' ? '承認' : '却下'}`,
      };
    case 'schedule.skip':
      return { at: e.occurredAt, kind: 'fail', text: `定時実行を見送りました（${d['reason'] ?? '理由不明'}）` };
    default:
      return null;
  }
}

function approverText(a: Approval, nameOf: (id: string) => string): string {
  if (a.approverUserId) return `${nameOf(a.approverUserId)}さん`;
  const label: Record<string, string> = { admin: '管理者', approver: '承認者' };
  return a.approverRole.map((r) => label[r] ?? r).join('・');
}

function names(users: User[]): (id: string | null | undefined) => string {
  const m = new Map(users.map((u) => [u.id, u.displayName]));
  return (id) => (id ? m.get(id) ?? '不明な利用者' : '—');
}

function agentName(id: string): string {
  return OFFICIAL_AGENTS.find((a) => a.id === id)?.name ?? (id || '不明な業務');
}

function firstLine(text: string): string {
  return text.split('\n')[0] ?? '';
}

function sum<T>(rows: T[], key: keyof T): number {
  return rows.reduce((t, r) => t + Number(r[key] ?? 0), 0);
}

const round1 = (n: number) => Math.round(n * 10) / 10;
const round2 = (n: number) => Math.round(n * 100) / 100;

/** 日本時間の日付（YYYY-MM-DD）。`back` 日前。 */
function jstDate(now: Date, back: number): string {
  return new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Tokyo' })
    .format(new Date(now.getTime() - back * 86_400_000));
}

/** 日本時間で `back` 日前の 0 時（ISO 形式）。 */
function jstDayStart(now: Date, back: number): string {
  return new Date(`${jstDate(now, back)}T00:00:00+09:00`).toISOString();
}
