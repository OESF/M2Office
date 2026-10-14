/**
 * @file 効果の欄と効果のレポート（仕様書 第6.7.13節）。数字はプログラムが計算し（`figures.ts`）、AI は文だけを書く（`report.ts`）。
 *
 * ワーカーが毎月 1 日の 7 時（日本時間）を過ぎたら先月の分を 1 回だけ作って管理者に知らせ、管理者はいつでも今月か先月の分を作り直せる。
 * 見るのは管理者だけ。人ごとの数字と、削減時間をお金に換えた値は出さない。
 */

import { randomUUID } from 'node:crypto';
import { EFFECT_REPORT_DAY, EFFECT_REPORT_HOUR, EFFECT_REPORT_KEEP_MONTHS, type EffectFigures, type EffectPeriod, type EffectReport, type EffectReportBrief } from '@m2office/shared';
import type { Repository } from '../repository/types.js';
import type { LlmProvider } from '../llm/provider.js';
import { silentLogger, type Logger } from '../log/logger.js';
import { DEFAULT_STANDARD_MINUTES, LOOKUP_AGENT_ID, PLAN_REPORT_AGENT_ID } from '../agents/index.js';
import { purposeLabel } from '../usage/purpose-labels.js';
import { addMonths, buildEffectFigures, effectNotices, jstDay, monthRange, periodRange, type EffectRange } from './figures.js';
import { writeEffectReport } from './report.js';
import type { EffectStore } from './store.js';

/** 効果の部品が使うもの。 */
export interface EffectServiceDeps {
  store: EffectStore;
  repo: Repository;
  /** 会社の推論（文を書く）。使えなければ決まった形の文にする */
  llmFor: (tenantId: string) => Promise<LlmProvider>;
  /**
   * 会社の業務。`usable` は会社で使える業務、`all` は名前を引くためのすべての業務（使えなくなった業務の過去の実行にも名前を付ける）
   */
  agentsFor: (tenantId: string) => Promise<{ usable: { id: string; name: string }[]; all: { id: string; name: string }[] }>;
  logger?: Logger;
}

/** 完了しなかった業務に出さない業務（秘書が自分で使うもの）。 */
const INTERNAL = new Set([LOOKUP_AGENT_ID, PLAN_REPORT_AGENT_ID]);

/** 効果の欄と効果のレポート。 */
export class EffectService {
  private readonly log: Logger;

  constructor(private readonly deps: EffectServiceDeps) {
    this.log = deps.logger ?? silentLogger;
  }

  /**
   * 欄の数字（第6.7.13節）。
   *
   * @param now いま（今月の終わりと、導入からの終わり）
   */
  async figures(tenantId: string, period: EffectPeriod, now: Date = new Date()): Promise<EffectFigures> {
    const first = period === 'all' ? await this.deps.store.firstActivity(tenantId) : null;
    const range = periodRange(period, now, first);
    const previous = period === 'all' ? null : monthRange(addMonths(range.fromDay.slice(0, 7), -1), now);
    return this.compute(tenantId, period, range, previous);
  }

  /** その月の数字（前の月と比べる）。 */
  private async monthFigures(tenantId: string, month: string, now: Date): Promise<EffectFigures> {
    const thisMonth = jstDay(now).slice(0, 7);
    const period: EffectPeriod = month === thisMonth ? 'thisMonth' : 'lastMonth';
    return this.compute(tenantId, period, monthRange(month, now), monthRange(addMonths(month, -1), now));
  }

  private async compute(tenantId: string, period: EffectPeriod, range: EffectRange, previous: EffectRange | null): Promise<EffectFigures> {
    const [runs, ai, prevRuns, prevAi, settings, agents] = await Promise.all([
      this.deps.store.runTotals(tenantId, range.from, range.until),
      this.deps.store.aiTotals(tenantId, range.from, range.until),
      previous ? this.deps.store.runTotals(tenantId, previous.from, previous.until) : Promise.resolve(null),
      previous ? this.deps.store.aiTotals(tenantId, previous.from, previous.until) : Promise.resolve(null),
      this.deps.repo.getTenantSettings(tenantId),
      this.deps.agentsFor(tenantId),
    ]);
    const disabled = new Set(settings.agents.disabled);
    const names = (id: string) => agents.all.find((a) => a.id === id)?.name ?? agents.usable.find((a) => a.id === id)?.name ?? id;
    return buildEffectFigures({
      period, range, runs, ai,
      previous: previous && prevRuns && prevAi ? { label: previous.label, runs: prevRuns, aiCostJpy: prevAi.reduce((n, a) => n + a.costJpy, 0) } : null,
      usable: agents.usable.filter((a) => !disabled.has(a.id)),
      names,
      minutesPerRun: settings.effect.minutesPerRun,
      defaults: DEFAULT_STANDARD_MINUTES,
      purposeLabel: (p) => purposeLabel(p, agents.all),
      internal: INTERNAL,
    });
  }

  /** 新しい順の一覧（25 か月分）。 */
  list(tenantId: string): Promise<EffectReportBrief[]> {
    return this.deps.store.list(tenantId, EFFECT_REPORT_KEEP_MONTHS);
  }

  get(tenantId: string, id: string): Promise<EffectReport | null> {
    return this.deps.store.get(tenantId, id);
  }

  /**
   * 管理者が今月（ここまで）か先月のレポートを作る（同じ月は置き換える）。
   *
   * @param which `this`（今月）か `last`（先月）
   */
  async create(who: { tenantId: string; userId: string }, which: 'this' | 'last', now: Date = new Date()): Promise<EffectReport> {
    const thisMonth = jstDay(now).slice(0, 7);
    const month = which === 'this' ? thisMonth : addMonths(thisMonth, -1);
    const r = await this.build(who.tenantId, month, 'manual', who.userId, now, true);
    await this.audit(who.tenantId, who.userId, r.id, month);
    return r;
  }

  private async build(tenantId: string, month: string, kind: 'monthly' | 'manual', userId: string | null, now: Date, replace: boolean): Promise<EffectReport> {
    const figures = await this.monthFigures(tenantId, month, now);
    const notices = effectNotices(figures);
    const llm = await this.deps.llmFor(tenantId).catch(() => null);
    const settings = await this.deps.repo.getTenantSettings(tenantId);
    const company = settings.company.shortName || settings.company.legalName;
    const body = await writeEffectReport(llm, figures, notices, company);
    const saved = await this.deps.store.save(tenantId, { month, kind, figures, body, createdBy: userId }, replace);
    // 置かなかった（自動で作るときに、すでにあった）なら、いまあるものを返す
    return saved ?? (await this.deps.store.byMonth(tenantId, month))!;
  }

  private async audit(tenantId: string, actor: string, reportId: string, month: string): Promise<void> {
    await this.deps.repo.appendAudit({
      id: randomUUID(), tenantId, actorType: 'user', actorId: actor, action: 'effect.report', targetType: 'effect_report', targetId: reportId, detail: { month }, occurredAt: new Date().toISOString(),
    }).catch((err: unknown) => this.log.warn('効果のレポートの監査ログを残せませんでした', { error: String(err) }));
  }

  /**
   * 1 回分の見回り（ワーカー）。毎月 1 日の 7 時（日本時間）を過ぎたら、会社ごとに先月の分を 1 回だけ作って管理者に知らせる。
   * その月に業務の実行も AI の利用も無い会社には作らない。25 か月を過ぎたレポートを消す。
   */
  async tick(now: Date = new Date()): Promise<{ created: number }> {
    const jst = new Date(now.getTime() + 9 * 3_600_000);
    const due = !(jst.getUTCDate() < EFFECT_REPORT_DAY || (jst.getUTCDate() === EFFECT_REPORT_DAY && jst.getUTCHours() < EFFECT_REPORT_HOUR));
    if (!due) return { created: 0 };
    const month = addMonths(jstDay(now).slice(0, 7), -1);
    let created = 0;
    for (const tenantId of await this.deps.repo.listTenantIds()) {
      try {
        if (await this.deps.store.byMonth(tenantId, month)) continue;
        const range = monthRange(month, now);
        const [runs, ai] = await Promise.all([this.deps.store.runTotals(tenantId, range.from, range.until), this.deps.store.aiTotals(tenantId, range.from, range.until)]);
        if (!runs.some((r) => r.completed > 0) && !ai.some((a) => a.calls > 0)) continue;
        const r = await this.build(tenantId, month, 'monthly', null, now, false);
        await this.deps.store.prune(tenantId, addMonths(month, -(EFFECT_REPORT_KEEP_MONTHS - 1)));
        await this.notifyAdmins(tenantId, `${Number(month.slice(5))} 月の効果のレポートが届きました`, r.body.summary.join('\n'));
        created += 1;
      } catch (err) {
        this.log.warn('効果のレポートを作れませんでした', { tenantId, error: String(err) });
      }
    }
    return { created };
  }

  private async notifyAdmins(tenantId: string, title: string, body: string): Promise<void> {
    const admins = (await this.deps.repo.listUsers(tenantId)).filter((u) => u.status === 'active' && u.roles.includes('admin'));
    for (const u of admins) {
      await this.deps.repo.createNotification({
        id: randomUUID(), tenantId, userId: u.id, kind: 'effect', title, body: body.slice(0, 300), runId: null, readAt: null, createdAt: new Date().toISOString(),
      }).catch((err: unknown) => this.log.warn('効果のレポートの知らせを作れませんでした', { error: String(err) }));
    }
  }
}
