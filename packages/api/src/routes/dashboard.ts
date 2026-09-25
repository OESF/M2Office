/**
 * @file ダッシュボードの API。会社の管理者が「いま」と「集計」を見るためのデータを返す。
 *
 * 返すのは状態・業務の名前・件数・時間・費用までであり、入力・成果物・会話の中身は返さない。
 * 個人ごとの勤務時間の集計も返さない。
 *
 * @see 仕様書 第6.7節 ダッシュボード
 */

import { Hono } from 'hono';
import { isValidAvatar, type Approval, type AuditEvent, type Job, type Run, type User } from '@m2office/shared';
import {
  ACTIVE_WINDOW_MIN, agentFace, buildPresence, summarizePresence, stepLabel,
  type TenantExtensions,
} from '@m2office/core';
import type { AppDeps } from '../context.js';
import { requireRole, type AppEnv } from '../middleware/tenant.js';

/** 秘書と会話中の判定に使う監査ログの種類（第6.7.4.1節）。 */
const SECRETARY_ACTIONS = ['secretary.direct', 'secretary.route', 'secretary.chat', 'secretary.help'];

/** 音声で会話中の判定に使う監査ログの種類（第6.7.4.1節）。始まりと終わりの 2 つを残す。 */
const VOICE_ACTIONS = ['secretary.voice'];

/** SSE で状態を組み立て直す間隔（ミリ秒）。変わったときだけ送る（第6.7.9節）。 */
const STREAM_TICK_MS = Number(process.env['DASHBOARD_STREAM_TICK_MS'] ?? 2000);

/** SSE の心拍の間隔（ミリ秒）。経路の途中で切られることを防ぐ。 */
const STREAM_HEARTBEAT_MS = 15_000;

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
    return c.json(await live(tenant.id));
  });

  /**
   * 人の状態に添える、本人のプロフィール写真（仕様書 第6.7.4.4節）。
   *
   * @remarks
   * **個人名で表示する会社で、停止していない利用者のものだけ**を返す。
   * 種類を推測させず（`nosniff`）、何も読み込ませない（`Content-Security-Policy`）。
   */
  app.get('/people/:userId/photo', async (c) => {
    const { tenant } = c.get('ctx');
    const target = await shownUser(tenant.id, c.req.param('userId'));
    const photo = target ? await deps.repo.getUserPhoto(tenant.id, target.id) : null;
    if (!photo) return c.json({ error: '写真はありません' }, 404);
    return imageResponse(photo.bytes, photo.mime, 86400);
  });

  /**
   * 人の状態に添える、その人の秘書のアバター（本人が上げた画像。仕様書 第6.7.4.4節）。
   *
   * @remarks
   * **本人が個人設定に登録した画像だけ**を返す。ファイルの ID は受け取らない（任意のファイルを出させない）。
   * 同梱の絵は画面の静的な置き場から出すため、ここを通らない。
   */
  app.get('/people/:userId/secretary-avatar', async (c) => {
    const { tenant } = c.get('ctx');
    const target = await shownUser(tenant.id, c.req.param('userId'));
    const avatar = target ? (await deps.repo.getUserSettings(tenant.id, target.id)).secretary.avatar ?? '' : '';
    if (!avatar.startsWith('file:')) return c.json({ error: 'アバターは登録されていません' }, 404);
    const id = avatar.slice('file:'.length);
    const meta = await deps.repo.getFile(tenant.id, id);
    const bytes = meta && (meta.kind === 'png' || meta.kind === 'jpeg') ? await deps.files.get(tenant.id, id) : null;
    if (!meta || !bytes) return c.json({ error: 'アバターは登録されていません' }, 404);
    return imageResponse(bytes, meta.mime, 60);
  });

  /**
   * 写真やアバターを出してよい利用者。個人名で表示する会社の、停止していない利用者だけ（第6.7.4.4節）。
   *
   * @returns 出してよければその利用者。そうでなければ `null`
   */
  async function shownUser(tenantId: string, userId: string): Promise<User | null> {
    const settings = await deps.repo.getTenantSettings(tenantId);
    if (settings.dashboard.people !== 'names') return null;
    const user = await deps.repo.findUserById(tenantId, userId);
    return user && user.status === 'active' ? user : null;
  }

  /**
   * いまの状態を送り続ける（SSE。仕様書 第6.7.9節、ADR-0013）。
   *
   * @remarks
   * 変わったときだけ送る。状態は記憶上で比べるだけで保存しない（第6.7.10節）。
   * テナント境界: 接続したテナントの状態だけを組み立てて送る（不変則 I-2）。
   */
  app.get('/stream', (c) => {
    const { tenant } = c.get('ctx');
    const log = c.get('log');
    const stream = new ReadableStream({
      async start(controller) {
        const send = (text: string) => controller.enqueue(new TextEncoder().encode(text));
        let previous = '';
        let lastBeat = Date.now();
        let closed = false;
        c.req.raw.signal.addEventListener('abort', () => { closed = true; });
        send(': 接続しました\n\n');
        while (!closed) {
          try {
            const snapshot = JSON.stringify(await live(tenant.id));
            if (snapshot !== previous) {
              previous = snapshot;
              send(`event: live\ndata: ${snapshot}\n\n`);
              lastBeat = Date.now();
            } else if (Date.now() - lastBeat >= STREAM_HEARTBEAT_MS) {
              send(': 心拍\n\n');
              lastBeat = Date.now();
            }
          } catch (err) {
            log.warn('ダッシュボードの送信で例外が発生しました', { tenantId: tenant.id, err });
            break;
          }
          await new Promise((r) => setTimeout(r, STREAM_TICK_MS));
        }
        try { controller.close(); } catch { /* すでに閉じている */ }
      },
    });
    return new Response(stream, {
      headers: {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-store',
        connection: 'keep-alive',
        // 串（リバースプロキシ）の緩衝を止める
        'x-accel-buffering': 'no',
      },
    });
  });

  /** 「いま」の中身を組み立てる。`/live` と SSE の双方が使う。 */
  async function live(tenantId: string) {
    const view = await deps.tenantView(tenantId);
    const agentName = (id: string) => nameOfAgent(view, id);
    const now = new Date();
    const todayStart = jstDayStart(now, 0);

    const [
      users, liveRuns, pending, todayRows, activeUsers, events, sessions, secretaryEvents, settings,
      voiceEvents, secretaries, photos,
    ] =
      await Promise.all([
        deps.repo.listUsers(tenantId),
        deps.repo.listLiveRuns(tenantId, todayStart),
        deps.repo.listPendingApprovals(tenantId),
        deps.repo.runStats(tenantId, todayStart),
        deps.repo.countActiveUsers(tenantId, new Date(now.getTime() - ACTIVE_WINDOW_MIN * 60_000)),
        deps.repo.listAuditSince(tenantId, EVENT_ACTIONS, 30),
        deps.repo.listActiveSessions(tenantId),
        deps.repo.listAuditSince(tenantId, SECRETARY_ACTIONS, 30),
        deps.repo.getTenantSettings(tenantId),
        deps.repo.listAuditSince(tenantId, VOICE_ACTIONS, 50),
        deps.repo.listSecretarySettings(tenantId),
        deps.repo.listUserPhotoStamps(tenantId),
      ]);
    const nameOf = names(users);

    // 承認待ちを実行に結び付ける（誰の判断を待っているかを示すため）
    const approvalByRun = new Map<string, Approval>();
    for (const a of pending) {
      const step = await deps.repo.getRunStepById(tenantId, a.runStepId);
      if (step) approvalByRun.set(step.runId, a);
    }

    /*
      業務の流れは**いま動いているものだけ**を並べる（仕様書 第6.7.5.1節）。
      失敗は別の囲みへ回す。混ぜると、何時間も前のものが並び続けて、
      いま動いているのかどうかが読み取れなくなる。
    */
    const flows = [];
    const failures = [];
    for (const { run, job } of liveRuns) {
      if (run.status === 'failed') {
        failures.push({
          runId: run.id,
          agentName: agentName(job.agentId),
          requester: nameOf(job.requestedBy),
          at: run.endedAt ?? run.startedAt,
          reason: run.failureReason ?? '理由が記録されていません',
        });
        continue;
      }
      const steps = await deps.repo.listRunSteps(tenantId, run.id);
      const confirming = steps.some((s) => s.status === 'awaiting' && s.stepId.endsWith(':confirm'));
      const approval = approvalByRun.get(run.id) ?? null;
      flows.push({
        runId: run.id,
        agentName: agentName(job.agentId),
        status: run.status,
        requester: nameOf(job.requestedBy),
        origin: job.origin,
        startedAt: run.startedAt,
        steps: flowSteps(view, job, run, confirming),
        waitingFor: approval
          ? { who: approverText(approval, nameOf), since: approval.createdAt, kind: confirming ? 'confirm' : 'approval' }
          : null,
      });
    }
    failures.sort((x, y) => y.at.localeCompare(x.at));

    const backlog = [];
    for (const a of pending) {
      const step = await deps.repo.getRunStepById(tenantId, a.runStepId);
      const run = step ? await deps.repo.getRun(tenantId, step.runId) : null;
      const job = run ? await deps.repo.getJob(tenantId, run.jobId) : null;
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
    const recent = await deps.repo.listRunsWithJobs(tenantId, { limit: 200 });
    for (const { run, job } of recent) runAgent.set(run.id, job.agentId);

    // 人の状態（第6.7.4.1節）。粒度は会社の設定に従う（Q-64）
    const stepsByRun = new Map(await Promise.all(
      liveRuns.map(async ({ run }) => [run.id, await deps.repo.listRunSteps(tenantId, run.id)] as const),
    ));
    const people = buildPresence({
      now, users, sessions, liveRuns, stepsByRun, pending,
      secretaryEvents: secretaryEvents.map((e) => ({ actorId: e.actorId, occurredAt: e.occurredAt })),
      voiceEvents: voiceEvents.map((e) => ({ actorId: e.actorId, occurredAt: e.occurredAt, targetId: e.targetId })),
      agentName,
    });
    // 本人と秘書を 1 組にして見せる（第6.7.4.4節）。写真と秘書の名前は、個人名で出す会社にだけ返す
    const pairs = people.map((p) => {
      const sec = secretaries.get(p.userId);
      const stamp = photos.get(p.userId);
      return {
        ...p,
        photo: stamp ? `/v1/admin/dashboard/people/${encodeURIComponent(p.userId)}/photo?v=${encodeURIComponent(stamp)}` : null,
        secretary: {
          ...p.secretary,
          name: sec?.name?.trim() || '秘書',
          avatar: secretaryAvatarUrl(p.userId, sec?.avatar ?? ''),
        },
      };
    });

    /*
      業務エージェントごとの受け持ち（仕様書 第6.7.4.2節）。
      **使えるものはすべて出す。** 動いていない業務も「待機」として出さないと、
      誰にも使われていない業務があることに気づけない。
    */
    const byAgent = new Map<string, { running: number; awaiting: number; queued: number }>();
    for (const { run, job } of liveRuns) {
      const a = byAgent.get(job.agentId) ?? { running: 0, awaiting: 0, queued: 0 };
      if (run.status === 'running') a.running += 1;
      else if (run.status === 'awaiting_approval') a.awaiting += 1;
      else if (run.status === 'queued') a.queued += 1;
      byAgent.set(job.agentId, a);
    }
    const todayByAgent = new Map<string, { runs: number; failed: number }>();
    for (const r of todayRows) {
      const t = todayByAgent.get(r.agentId) ?? { runs: 0, failed: 0 };
      t.runs += r.runs;
      if (r.status === 'failed') t.failed += r.runs;
      todayByAgent.set(r.agentId, t);
    }
    const agents = view.agents.map((def) => {
      const busy = byAgent.get(def.id) ?? { running: 0, awaiting: 0, queued: 0 };
      const t = todayByAgent.get(def.id) ?? { runs: 0, failed: 0 };
      return {
        agentId: def.id, name: def.name, face: agentFace(def),
        ...busy, todayRuns: t.runs, todayFailed: t.failed,
      };
    });
    // 忙しい順。同じなら今日の件数の多い順
    agents.sort((x, y) =>
      (y.running + y.awaiting + y.queued) - (x.running + x.awaiting + x.queued) || y.todayRuns - x.todayRuns);

    return {
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
      // 個人名を出さない設定の会社には、状態ごとの人数と業務の名前だけを返す
      people: settings.dashboard.people === 'names' ? pairs : null,
      peopleSummary: settings.dashboard.people === 'names' ? null : summarizePresence(people),
      agents,
      flows,
      failures,
      backlog,
      events: events.map((e) => eventView(e, nameOf, runAgent, agentName)).filter((e) => e !== null),
    };
  }

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

    const byAgent = (await deps.agentsFor(tenant.id)).map((a) => {
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
        workspace: deps.connector.sourceFor(tenant.id) === 'mock' ? 'ダミーデータで動作中（Google 未接続）' : 'Google Workspace に接続中',
        llm: deps.llm.name === 'stub' ? 'スタブ（推論を行わない開発用）' : deps.llm.name,
      },
    });
  });

  return app;
}

/** 定義の段階を並べ、実行の位置から各段階の状態を決める（第6.7.5節）。 */
function flowSteps(view: TenantExtensions, job: Job, run: Run, confirming: boolean) {
  const def = view.resolve(job.agentId, job.agentVersion);
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
  agentName: (id: string) => string,
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

function nameOfAgent(view: TenantExtensions, id: string): string {
  return view.allAgents.find((a) => a.id === id)?.name ?? (id || '不明な業務');
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

/**
 * 秘書のアバターを画面が読む URL（仕様書 第6.7.4.4節）。
 *
 * @param avatar 個人設定の値（`preset:<id>`・`file:<ID>`・空）
 * @returns 同梱の絵は静的な置き場、上げた画像は利用者ごとの口。無ければ `null`（画面は人の形のアイコンを出す）
 */
export function secretaryAvatarUrl(userId: string, avatar: string): string | null {
  if (avatar.startsWith('preset:') && isValidAvatar(avatar)) return `/avatars/${avatar.slice('preset:'.length)}.png`;
  if (avatar.startsWith('file:')) return `/v1/admin/dashboard/people/${encodeURIComponent(userId)}/secretary-avatar`;
  return null;
}

/** 画像を、画面に埋め込める形で返す。種類を推測させず、何も読み込ませない。 */
function imageResponse(bytes: Uint8Array, mime: string, maxAge: number): Response {
  return new Response(Buffer.from(bytes), {
    headers: {
      'content-type': mime,
      'x-content-type-options': 'nosniff',
      'content-security-policy': "default-src 'none'; sandbox",
      // 個人の画像であり、共有の置き場に残させない
      'cache-control': `private, max-age=${maxAge}`,
    },
  });
}
