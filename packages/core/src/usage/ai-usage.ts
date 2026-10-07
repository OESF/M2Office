/**
 * @file AI の利用の記録と上限（仕様書 第6.6.2節「AI の利用の記録と上限」、ADR-0079）。
 *
 * AI を呼ぶたびに、会社・利用者・用途・モデル・トークン・費用を 1 行残す（中身は残さない）。呼ぶ側に書き忘れが出ないよう、
 * 会社ごとの推論を渡すところ（`TenantAiResolver`）で包む（{@link meterLlm}）。誰の・何のための呼び出しかは、
 * 入口（API の要求・秘書・業務の実行・ワーカーの処理）が {@link withAiUsage} で決め、包みが読む。
 *
 * 上限は月（日本の時刻の 1 日 0 時から）の円で数える。会社の上限の 8 割と 10 割で管理者に、1 人の上限に当たった人には本人に知らせる。
 * 10 割を超えたら新しい AI の利用を止める（第21.2.3節）。**始まっている業務の実行は止めない**（途中で切ると中途半端な状態が残るため）。
 * ローカル AI は費用 0 円で残し、上限には数えない。
 */

import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { createPool } from '../repository/pool.js';
import { DEFAULT_AI_PER_USER_SHARE, type AiLimitSettings, type Notification } from '@m2office/shared';
import type { LlmProvider, LlmResponse } from '../llm/provider.js';
import type { ResearchProvider } from '../research/provider.js';
import type { Repository } from '../repository/types.js';
import { costJpy, usdJpy } from '../llm/models.js';

/** 誰の・何のための呼び出しか。 */
export interface AiUsageScope {
  /** 呼び出した人。ワーカーの処理なら無し。 */
  userId?: string | null;
  /** 用途（`secretary`・`voice`・`agent:<業務の ID>`・`api:<口>`・`worker:<処理>` など）。 */
  purpose: string;
  /** 業務の実行の中なら、その実行の ID。始まっている実行は上限で止めない。 */
  runId?: string | null;
}

const scopeStore = new AsyncLocalStorage<AiUsageScope>();

/**
 * 呼び出しの持ち主と用途を決めて、その中で `fn` を動かす。中で呼ぶ AI の記録と上限の確かめに使う。
 *
 * @remarks 入れ子にすれば内側が勝つ。決めていない呼び出しは用途 `other`・利用者なしで残る
 */
export function withAiUsage<T>(scope: AiUsageScope, fn: () => T): T {
  return scopeStore.run(scope, fn);
}

/** いまの呼び出しの持ち主と用途（決めていなければ `undefined`）。 */
export function currentAiUsage(): AiUsageScope | undefined {
  return scopeStore.getStore();
}

/** 上限に当たって、新しい AI の利用を止めたことを伝える。API は 429 にする。 */
export class AiLimitError extends Error {
  constructor(message: string, readonly scope: 'company' | 'user') {
    super(message);
    this.name = 'AiLimitError';
  }
}

/** 会社の上限に当たったときの文（第21.2.3節。原則 u4）。 */
export const AI_LIMIT_COMPANY_MESSAGE = '今月の AI の利用の上限に達しました。管理者にご確認ください';
/** 1 人の上限に当たったときの文。 */
export const AI_LIMIT_USER_MESSAGE = 'あなたの今月の AI の利用が、1 人の上限に達しました。管理者にご確認ください';

/** 1 回の呼び出しの記録。 */
export interface AiUsageEntry {
  userId: string | null;
  purpose: string;
  model: string | null;
  inputTokens: number;
  outputTokens: number;
  /** 画像の枚数・動画の秒など、トークンで数えないもの。 */
  units: number;
  costJpy: number;
  local: boolean;
  runId: string | null;
}

/** 利用の数え（月の合計と人ごと・用途ごと）。 */
export interface AiUsageTotals {
  costJpy: number;
  calls: number;
  byUser: { userId: string | null; costJpy: number; calls: number }[];
  byPurpose: { purpose: string; costJpy: number; calls: number }[];
}

/** 記録の置き場。 */
export interface AiUsageStore {
  insert(tenantId: string, e: AiUsageEntry): Promise<void>;
  /** `since` からの合計（人ごと・用途ごと）。 */
  totals(tenantId: string, since: Date): Promise<AiUsageTotals>;
  /** 日ごとの費用（日本の日付 → 円）。`since` から。 */
  daily(tenantId: string, since: Date): Promise<{ day: string; costJpy: number }[]>;
  /** 知らせを送った印を付ける。初めてなら `true`（月に 1 度だけ送るため）。 */
  markAlert(tenantId: string, month: string, level: string, userId: string): Promise<boolean>;
  /** 古い記録を消す。消した行の数。 */
  prune(tenantId: string, before: Date): Promise<number>;
}

/** 記録の置き場（PostgreSQL）。 */
export class PostgresAiUsageStore implements AiUsageStore {
  private readonly pool: pg.Pool;

  constructor(connectionString: string) {
    this.pool = createPool(connectionString, { max: 3, name: 'usage/ai-usage' });
  }

  async close(): Promise<void> {
    await this.pool.end();
  }

  private async q<T extends pg.QueryResultRow>(tenantId: string, sql: string, params: unknown[]): Promise<T[]> {
    const client = await this.pool.connect();
    try {
      await client.query('begin');
      await client.query(`select set_config('app.tenant_id', $1, true)`, [tenantId]);
      const r = await client.query<T>(sql, params);
      await client.query('commit');
      return r.rows;
    } catch (err) {
      await client.query('rollback').catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
  }

  async insert(tenantId: string, e: AiUsageEntry): Promise<void> {
    await this.q(tenantId, `insert into ai_usage (tenant_id, user_id, purpose, model, input_tokens, output_tokens, units, cost_jpy, local, run_id)
      values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
    [tenantId, e.userId, e.purpose.slice(0, 80), e.model, Math.round(e.inputTokens), Math.round(e.outputTokens), e.units, e.costJpy, e.local, e.runId]);
  }

  async totals(tenantId: string, since: Date): Promise<AiUsageTotals> {
    const rows = await this.q<{ user_id: string | null; purpose: string; cost: number; calls: number }>(tenantId,
      `select user_id, purpose, coalesce(sum(cost_jpy), 0)::float8 as cost, count(*)::int as calls
         from ai_usage where tenant_id = $1 and at >= $2 group by user_id, purpose`, [tenantId, since.toISOString()]);
    const byUser = new Map<string | null, { userId: string | null; costJpy: number; calls: number }>();
    const byPurpose = new Map<string, { purpose: string; costJpy: number; calls: number }>();
    let cost = 0;
    let calls = 0;
    for (const r of rows) {
      cost += r.cost;
      calls += r.calls;
      const u = byUser.get(r.user_id) ?? { userId: r.user_id, costJpy: 0, calls: 0 };
      u.costJpy += r.cost; u.calls += r.calls; byUser.set(r.user_id, u);
      const key = purposeGroup(r.purpose);
      const p = byPurpose.get(key) ?? { purpose: key, costJpy: 0, calls: 0 };
      p.costJpy += r.cost; p.calls += r.calls; byPurpose.set(key, p);
    }
    const sort = <X extends { costJpy: number }>(xs: X[]) => xs.sort((a, b) => b.costJpy - a.costJpy);
    return { costJpy: cost, calls, byUser: sort([...byUser.values()]), byPurpose: sort([...byPurpose.values()]) };
  }

  async daily(tenantId: string, since: Date): Promise<{ day: string; costJpy: number }[]> {
    const rows = await this.q<{ day: string; cost: number }>(tenantId,
      `select to_char(at at time zone 'Asia/Tokyo', 'YYYY-MM-DD') as day, coalesce(sum(cost_jpy), 0)::float8 as cost
         from ai_usage where tenant_id = $1 and at >= $2 group by 1 order by 1`, [tenantId, since.toISOString()]);
    return rows.map((r) => ({ day: r.day, costJpy: r.cost }));
  }

  async markAlert(tenantId: string, month: string, level: string, userId: string): Promise<boolean> {
    const rows = await this.q<{ month: string }>(tenantId,
      `insert into ai_usage_alerts (tenant_id, month, level, user_id) values ($1,$2,$3,$4) on conflict do nothing returning month`,
      [tenantId, month, level, userId]);
    return rows.length > 0;
  }

  async prune(tenantId: string, before: Date): Promise<number> {
    const rows = await this.q<{ id: string }>(tenantId, `delete from ai_usage where tenant_id = $1 and at < $2 returning id`, [tenantId, before.toISOString()]);
    return rows.length;
  }
}

/**
 * 用途を、利用状況に並べるまとまりにする（`agent:<ID>` は業務ごと、`api:columns/...` は口の最初の段まで）。
 */
export function purposeGroup(purpose: string): string {
  const m = /^(api|worker):([^/:]+)/.exec(purpose);
  return m ? `${m[1]}:${m[2]}` : purpose;
}

/** 日本の時刻の月（`YYYY-MM`）と、その月の初め（UTC の時刻）。 */
export function jstMonth(now: Date): { month: string; start: Date } {
  const jst = new Date(now.getTime() + 9 * 3_600_000);
  const y = jst.getUTCFullYear();
  const m = jst.getUTCMonth();
  return { month: `${y}-${String(m + 1).padStart(2, '0')}`, start: new Date(Date.UTC(y, m, 1) - 9 * 3_600_000) };
}

/** 会社の上限の決め方に要るもの。 */
export interface AiLimitSource {
  /** 会社の設定の上限。 */
  limits(tenantId: string): Promise<AiLimitSettings>;
  /** 推論の鍵の出どころ（運営一括か、会社の鍵か）。 */
  source(tenantId: string): Promise<'platform' | 'tenant' | 'none'>;
}

/**
 * 実際に効く会社の月の上限（円）。
 *
 * @param platformCap 配備の既定（`AI_MONTHLY_LIMIT_JPY`）。運営一括の会社は、これを超えて上げられない
 * @returns 上限なしなら `null`
 */
export function effectiveMonthlyLimit(limits: AiLimitSettings, source: 'platform' | 'tenant' | 'none', platformCap: number | null): number | null {
  if (source === 'tenant') return limits.monthlyJpy;
  if (platformCap === null) return limits.monthlyJpy;
  return limits.monthlyJpy === null ? platformCap : Math.min(limits.monthlyJpy, platformCap);
}

/** 上限の確かめの結果。 */
export interface AiLimitCheck {
  /** 止めるなら理由。 */
  blocked: AiLimitError | null;
  monthlyJpy: number | null;
  usedJpy: number;
}

export interface AiUsageMeterDeps {
  store: AiUsageStore;
  limits: AiLimitSource;
  /** 配備の既定の上限（円）。無ければ `null`。 */
  platformCap: number | null;
  /** 知らせを残す（管理者・本人）。 */
  notify(n: Notification): Promise<void>;
  /** 会社の管理者の ID。 */
  admins(tenantId: string): Promise<string[]>;
  now?: () => Date;
  /** 記録に失敗したことを残す。記録の失敗で AI の呼び出しを止めない。 */
  onError?(err: unknown): void;
}

/** 合計を覚えておく時間（ミリ秒）。呼び出しのたびにデータベースを数えないため。 */
const CACHE_MS = 60_000;

/**
 * AI の利用の記録と上限の確かめ。
 *
 * @remarks 合計はデータベースから 1 分ごとに読み直し、その間の呼び出しは手元で足す（複数のプロセスの差は 1 分で埋まる）
 */
export class AiUsageMeter {
  private readonly cache = new Map<string, { at: number; month: string; total: number; byUser: Map<string, number> }>();

  constructor(private readonly deps: AiUsageMeterDeps) {}

  private now(): Date {
    return this.deps.now ? this.deps.now() : new Date();
  }

  /** 今月の合計（覚えていればそれ）。 */
  private async month(tenantId: string): Promise<{ month: string; total: number; byUser: Map<string, number> }> {
    const now = this.now();
    const { month, start } = jstMonth(now);
    const hit = this.cache.get(tenantId);
    if (hit && hit.month === month && now.getTime() - hit.at < CACHE_MS) return hit;
    const t = await this.deps.store.totals(tenantId, start);
    const next = { at: now.getTime(), month, total: t.costJpy, byUser: new Map(t.byUser.filter((u) => u.userId).map((u) => [u.userId!, u.costJpy])) };
    this.cache.set(tenantId, next);
    return next;
  }

  /** 会社の実際の上限（円）。上限なしなら `null`。 */
  async monthlyLimit(tenantId: string): Promise<number | null> {
    const [limits, source] = await Promise.all([this.deps.limits.limits(tenantId), this.deps.limits.source(tenantId)]);
    return effectiveMonthlyLimit(limits, source, this.deps.platformCap);
  }

  /** 1 人の上限の割合。 */
  private async share(tenantId: string): Promise<number> {
    const s = (await this.deps.limits.limits(tenantId)).perUserShare;
    return Number.isFinite(s) && s > 0 && s <= 1 ? s : DEFAULT_AI_PER_USER_SHARE;
  }

  /**
   * 新しい AI の利用を始めてよいか。
   *
   * @param userId 使う人（ワーカーの処理なら無し）
   */
  async check(tenantId: string, userId?: string | null): Promise<AiLimitCheck> {
    const limit = await this.monthlyLimit(tenantId);
    if (limit === null) return { blocked: null, monthlyJpy: null, usedJpy: 0 };
    const m = await this.month(tenantId);
    if (m.total >= limit) return { blocked: new AiLimitError(AI_LIMIT_COMPANY_MESSAGE, 'company'), monthlyJpy: limit, usedJpy: m.total };
    if (userId) {
      const mine = m.byUser.get(userId) ?? 0;
      if (mine >= limit * (await this.share(tenantId))) return { blocked: new AiLimitError(AI_LIMIT_USER_MESSAGE, 'user'), monthlyJpy: limit, usedJpy: m.total };
    }
    return { blocked: null, monthlyJpy: limit, usedJpy: m.total };
  }

  /** 止めるべきなら投げる（{@link check} の短い形）。 */
  async assert(tenantId: string, userId?: string | null): Promise<void> {
    const r = await this.check(tenantId, userId);
    if (r.blocked) throw r.blocked;
  }

  /**
   * 1 回の呼び出しを残し、上限の知らせが要れば送る。
   *
   * @remarks 失敗しても投げない（記録の失敗で業務を止めない）
   */
  async record(tenantId: string, e: AiUsageEntry): Promise<void> {
    try {
      await this.deps.store.insert(tenantId, e);
      const hit = this.cache.get(tenantId);
      if (hit) {
        hit.total += e.costJpy;
        if (e.userId) hit.byUser.set(e.userId, (hit.byUser.get(e.userId) ?? 0) + e.costJpy);
      }
      if (e.costJpy > 0) await this.alerts(tenantId, e.userId);
    } catch (err) {
      this.deps.onError?.(err);
    }
  }

  /** 8 割・10 割・1 人の上限の知らせ（月に 1 度だけ）。 */
  private async alerts(tenantId: string, userId: string | null): Promise<void> {
    const limit = await this.monthlyLimit(tenantId);
    if (limit === null || limit <= 0) return;
    const m = await this.month(tenantId);
    const yen = (v: number) => `${Math.round(v).toLocaleString('ja-JP')} 円`;
    for (const [level, ratio, title] of [
      ['100', 1, '今月の AI の利用が上限に達しました'],
      ['80', 0.8, '今月の AI の利用が上限の 8 割を超えました'],
    ] as const) {
      if (m.total < limit * ratio) continue;
      if (!(await this.deps.store.markAlert(tenantId, m.month, level, ''))) break;
      const body = `今月 ${yen(m.total)} / 上限 ${yen(limit)}。${level === '100' ? '新しい業務と、AI を使う秘書への依頼を止めています。上限を上げればすぐに使えます。' : '上限に達すると、新しい AI の利用を止めます。'}`;
      for (const admin of await this.deps.admins(tenantId)) await this.deps.notify(this.notice(tenantId, admin, 'usage', title, body));
      break;
    }
    if (userId) {
      const mine = m.byUser.get(userId) ?? 0;
      const cap = limit * (await this.share(tenantId));
      if (mine >= cap && (await this.deps.store.markAlert(tenantId, m.month, 'user', userId))) {
        await this.deps.notify(this.notice(tenantId, userId, 'usageSelf', 'あなたの今月の AI の利用が、1 人の上限に達しました',
          `今月 ${yen(mine)} / 1 人の上限 ${yen(cap)}。新しい AI の利用を止めています。必要なら管理者に相談してください。`));
      }
    }
  }

  /**
   * 暴走の見張り（前の 14 日の平均の 3 倍を超えた日を、止めずに管理者に知らせる）。ワーカーが 1 日 1 回呼ぶ。
   *
   * @returns 知らせたか
   */
  async watchSpike(tenantId: string): Promise<boolean> {
    const now = this.now();
    const days = await this.deps.store.daily(tenantId, new Date(now.getTime() - 16 * 86_400_000));
    const today = new Date(now.getTime() + 9 * 3_600_000).toISOString().slice(0, 10);
    const done = days.filter((d) => d.day < today);
    const last = done[done.length - 1];
    if (!last) return false;
    const before = done.slice(0, -1).slice(-14);
    if (before.length < 7) return false;
    const avg = before.reduce((a, d) => a + d.costJpy, 0) / before.length;
    // 小さな額の揺れでは知らせない（1 日 100 円まで）
    if (last.costJpy < 100 || last.costJpy < avg * 3) return false;
    if (!(await this.deps.store.markAlert(tenantId, last.day, 'spike', ''))) return false;
    const yen = (v: number) => `${Math.round(v).toLocaleString('ja-JP')} 円`;
    for (const admin of await this.deps.admins(tenantId)) {
      await this.deps.notify(this.notice(tenantId, admin, 'usage', `${last.day} の AI の利用がふだんより多くなっています`,
        `その日 ${yen(last.costJpy)}（前の 14 日の平均 ${yen(avg)}）。止めてはいません。利用状況で用途と人を確かめてください。`));
    }
    return true;
  }

  /** 古い記録を消す。 */
  async prune(tenantId: string, before: Date): Promise<number> {
    return this.deps.store.prune(tenantId, before);
  }

  /** `since` からの合計（利用状況の画面）。 */
  async totals(tenantId: string, since: Date): Promise<AiUsageTotals> {
    return this.deps.store.totals(tenantId, since);
  }

  /** 1 人の上限（円）。会社に上限が無ければ `null`。 */
  async userLimit(tenantId: string): Promise<number | null> {
    const limit = await this.monthlyLimit(tenantId);
    return limit === null ? null : limit * (await this.share(tenantId));
  }

  /** 配備の既定の上限（運営一括の会社が上げられる上限）。 */
  platformCap(): number | null {
    return this.deps.platformCap;
  }

  /** 覚えている合計を捨てる（上限を変えたとき）。 */
  forget(tenantId: string): void {
    this.cache.delete(tenantId);
  }

  private notice(tenantId: string, userId: string, kind: 'usage' | 'usageSelf', title: string, body: string): Notification {
    return { id: randomUUID(), tenantId, userId, kind, title, body, runId: null, readAt: null, createdAt: this.now().toISOString() };
  }
}

/** 画像 1 枚の費用の目安（米ドル。2026-10 の料金表。第32.7.1節）。 */
const IMAGE_USD = 0.067;
/** 動画 1 秒の費用の目安（米ドル。Veo 3.1 Lite の 720p。2026-10 の料金表）。 */
const VIDEO_USD_PER_SECOND = 0.05;
/** 延長つきの動画の長さ（秒。8 秒＋延長 7 秒。第32.18.6節）。 */
const VIDEO_SECONDS = { base: 8, extended: 15 };
/** Web の調べもの 1 回の検索の費用の目安（米ドル。Google 検索のグラウンディング）。 */
const GROUNDING_USD = 0.014;

const yenOf = (usd: number) => Math.round(usd * usdJpy() * 10_000) / 10_000;

/** 応答から費用を出す。 */
function responseCost(res: LlmResponse, fallbackModel: string | null, local: boolean): { model: string | null; input: number; output: number; cost: number } {
  const model = res.model ?? fallbackModel;
  const input = res.inputTokens ?? (res.outputTokens === undefined ? res.tokensUsed : Math.max(0, res.tokensUsed - res.outputTokens));
  const output = res.outputTokens ?? 0;
  // モデルが分からなければ、高いほうの単価で数える（少なく見積もらない）
  return { model, input, output, cost: local ? 0 : costJpy(model ?? '', input, output) };
}

/**
 * 会社の推論を包み、呼び出しの前に上限を確かめ、呼び出しの後に記録する。
 *
 * @param local ローカル AI か（費用 0 円で残し、上限で止めない）
 * @remarks 業務の実行の中の呼び出し（`runId` がある）は止めない。始まった実行を途中で切らないため（第21.2.3節）
 */
export function meterLlm(tenantId: string, inner: LlmProvider, meter: AiUsageMeter, local = false): LlmProvider {
  if (inner.name === 'unconfigured') return inner;
  const scope = () => currentAiUsage() ?? { purpose: 'other' };
  const guard = async () => {
    const s = scope();
    if (local || s.runId) return;
    await meter.assert(tenantId, s.userId ?? null);
  };
  const log = (e: Omit<AiUsageEntry, 'userId' | 'purpose' | 'runId' | 'local'>) => {
    const s = scope();
    void meter.record(tenantId, { ...e, userId: s.userId ?? null, purpose: s.purpose, runId: s.runId ?? null, local });
  };
  const text = async (fn: () => Promise<LlmResponse>): Promise<LlmResponse> => {
    await guard();
    const res = await fn();
    const c = responseCost(res, null, local);
    log({ model: c.model, inputTokens: c.input, outputTokens: c.output, units: 0, costJpy: c.cost });
    return res;
  };
  const wrapped: LlmProvider = { name: inner.name, complete: (req) => text(() => inner.complete(req)) };
  if (inner.readImage) wrapped.readImage = (req) => text(() => inner.readImage!(req));
  if (inner.extractFromImage) wrapped.extractFromImage = (req) => text(() => inner.extractFromImage!(req));
  if (inner.generateImage) {
    wrapped.generateImage = async (req) => {
      await guard();
      const out = await inner.generateImage!(req);
      log({ model: 'image', inputTokens: 0, outputTokens: 0, units: out ? 1 : 0, costJpy: local || !out ? 0 : yenOf(IMAGE_USD) });
      return out;
    };
  }
  if (inner.generateVideo) {
    wrapped.generateVideo = async (req) => {
      await guard();
      const out = await inner.generateVideo!(req);
      const seconds = !out ? 0 : out.extended ? VIDEO_SECONDS.extended : VIDEO_SECONDS.base;
      log({ model: req.model, inputTokens: 0, outputTokens: 0, units: seconds, costJpy: local ? 0 : yenOf(seconds * VIDEO_USD_PER_SECOND) });
      return out;
    };
  }
  return wrapped;
}

/**
 * Web の調べものを包む（上限の確かめと記録）。
 *
 * @param model 調べものに使うモデル（費用の単価を引く）
 */
export function meterResearch(tenantId: string, inner: ResearchProvider, meter: AiUsageMeter, model: string): ResearchProvider {
  return {
    name: inner.name,
    research: async (topic, opts) => {
      const s = currentAiUsage() ?? { purpose: 'other' };
      if (!s.runId) await meter.assert(tenantId, s.userId ?? null);
      const out = await inner.research(topic, opts);
      const tokens = out.tokensUsed ?? 0;
      void meter.record(tenantId, {
        userId: s.userId ?? null, purpose: s.purpose, runId: s.runId ?? null, local: false, model,
        inputTokens: tokens, outputTokens: 0, units: 1, costJpy: out.source === 'gemini' ? costJpy(model, tokens, 0) + yenOf(GROUNDING_USD) : 0,
      });
      return out;
    },
  };
}

/** 音声の対話の使った量（Gemini Live の知らせ）を記録に直す。 */
export function voiceUsageEntry(scope: AiUsageScope, model: string, inputTokens: number, outputTokens: number): AiUsageEntry {
  return {
    userId: scope.userId ?? null, purpose: 'voice', runId: null, local: false, model,
    inputTokens, outputTokens, units: 0, costJpy: costJpy(model, inputTokens, outputTokens),
  };
}

/**
 * 配備の設定（環境変数）から、AI の利用の記録と上限を組み立てる（API とワーカーで同じものを使う）。
 *
 * @param env `AI_MONTHLY_LIMIT_JPY`（運営一括の会社の月の上限の既定と、上げられる上限。無ければ上限なし）
 */
export function aiUsageMeterFromEnv(opts: {
  repo: Pick<Repository, 'getTenantSettings' | 'getTenantCredential' | 'listUsers' | 'createNotification'>;
  connectionString: string;
  env: Record<string, string | undefined>;
  onError?: (err: unknown) => void;
}): AiUsageMeter {
  const raw = Number(opts.env['AI_MONTHLY_LIMIT_JPY'] ?? '');
  const { repo } = opts;
  return new AiUsageMeter({
    store: new PostgresAiUsageStore(opts.connectionString),
    platformCap: Number.isFinite(raw) && raw > 0 ? raw : null,
    limits: {
      limits: async (tenantId) => (await repo.getTenantSettings(tenantId)).aiLimits,
      source: async (tenantId) => {
        const cred = await repo.getTenantCredential(tenantId, 'gemini');
        return (cred?.meta as { mode?: string } | undefined)?.mode === 'byok' && cred?.secretEnc ? 'tenant' : 'platform';
      },
    },
    notify: (n) => repo.createNotification(n),
    admins: async (tenantId) => (await repo.listUsers(tenantId)).filter((u) => u.status === 'active' && u.roles.includes('admin')).map((u) => u.id),
    ...(opts.onError ? { onError: opts.onError } : {}),
  });
}

/**
 * これ以降の呼び出しの持ち主と用途を決める（ワーカーの起動のときに 1 度だけ。内側で {@link withAiUsage} を使えばそちらが勝つ）。
 */
export function enterAiUsage(scope: AiUsageScope): void {
  scopeStore.enterWith(scope);
}
