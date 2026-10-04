/**
 * @file Web の分析の置き場（仕様書 第34.14節・第34.18節・第34.19節）。月の便り（`web_review_reports`）を会社ごとに、月ごとに 1 つ置く。
 * 段 2 で、直すべき所（`web_review_findings`。同じ種類・同じ対象は 1 つ）とページごとの数字（`web_page_metrics`）を足した。
 * PostgreSQL（行単位のセキュリティで会社を絞る）と、試験用のメモリの 2 つ。
 */

import { randomUUID } from 'node:crypto';
import pg from 'pg';
import type {
  WebPageMetrics, WebReviewFigures, WebReviewFinding, WebReviewFindingKind, WebReviewFindingStatus, WebReviewReport, WebReviewReportBrief,
} from '@m2office/shared';

/** 新しい月の便り。 */
export type NewWebReviewReport = Omit<WebReviewReport, 'id' | 'createdAt'>;

/** 見つけた直すべき所（置き場に入れる形）。 */
export type NewWebReviewFinding = Pick<WebReviewFinding, 'kind' | 'target' | 'title' | 'figures' | 'advice' | 'requestDraft' | 'columnId'>;

/** 済んだにした所がまた見つかったとき、新しいに戻すまでの日数（第34.19節）。 */
const REOPEN_DAYS = 28;

/** 月の便りの置き場。 */
export interface WebReviewStore {
  /** 新しい順の一覧 */
  list(tenantId: string, limit: number): Promise<WebReviewReportBrief[]>;
  /** その月の便り。無ければ `null` */
  get(tenantId: string, month: string): Promise<WebReviewReport | null>;
  /** いちばん新しい便り */
  latest(tenantId: string): Promise<WebReviewReport | null>;
  /**
   * 便りを置く。その月の便りがすでにあれば置かない（月に 1 回だけ）。
   *
   * @returns 置いたら ID、すでにあれば `null`
   */
  add(tenantId: string, r: NewWebReviewReport): Promise<string | null>;
  /**
   * 直すべき所を置く。同じ種類・同じ対象があれば数字と案を新しくする（見送りはそのまま、済んだは 28 日を過ぎていれば新しいに戻す）。
   *
   * @returns `new`（初めて・新しいに戻した）か `updated`
   */
  putFinding(tenantId: string, f: NewWebReviewFinding, now?: Date): Promise<'new' | 'updated'>;
  /** 直すべき所（見つけた新しい順）。状態を渡せばその状態だけ */
  findings(tenantId: string, statuses?: WebReviewFindingStatus[], limit?: number): Promise<WebReviewFinding[]>;
  finding(tenantId: string, id: string): Promise<WebReviewFinding | null>;
  setFindingStatus(tenantId: string, id: string, status: WebReviewFindingStatus): Promise<void>;
  /** 制作会社に依頼文を送ったことを残す（状態は「見た」にする） */
  markRequestSent(tenantId: string, id: string, at: string): Promise<void>;
  /** ページごとの数字（この 28 日）を置き換える */
  putPageMetrics(tenantId: string, m: Omit<WebPageMetrics, 'updatedAt'>): Promise<void>;
  pageMetrics(tenantId: string, path: string): Promise<WebPageMetrics | null>;
}

interface FindingRow {
  id: string;
  kind: WebReviewFindingKind;
  target: string;
  title: string;
  figures: Record<string, number | string | null>;
  advice: string;
  request_draft: { subject: string; body: string } | null;
  column_id: string | null;
  status: WebReviewFindingStatus;
  found_at: Date | string;
  updated_at: Date | string;
  request_sent_at: Date | string | null;
}

const toFinding = (r: FindingRow): WebReviewFinding => ({
  id: r.id, kind: r.kind, target: r.target, title: r.title, figures: r.figures ?? {}, advice: r.advice, requestDraft: r.request_draft,
  columnId: r.column_id, status: r.status, foundAt: new Date(r.found_at).toISOString(), updatedAt: new Date(r.updated_at).toISOString(),
  requestSentAt: r.request_sent_at ? new Date(r.request_sent_at).toISOString() : null,
});

const FINDING_COLUMNS = 'id, kind, target, title, figures, advice, request_draft, column_id, status, found_at, updated_at, request_sent_at';

/** また見つかったときの状態（見送りはそのまま、済んだは 28 日を過ぎていれば新しいに戻す）。 */
function nextStatus(status: WebReviewFindingStatus, updatedAt: string, now: Date): WebReviewFindingStatus {
  if (status === 'done' && now.getTime() - Date.parse(updatedAt) > REOPEN_DAYS * 86_400_000) return 'new';
  return status;
}

interface Row {
  id: string;
  month: string;
  figures: WebReviewFigures;
  summary: string;
  good: string;
  concern: string;
  next: string[];
  created_at: Date | string;
}

const toReport = (r: Row): WebReviewReport => ({
  id: r.id, month: r.month, figures: r.figures, summary: r.summary, good: r.good, concern: r.concern, next: r.next ?? [],
  createdAt: new Date(r.created_at).toISOString(),
});

/** PostgreSQL の置き場。 */
export class PostgresWebReviewStore implements WebReviewStore {
  private readonly pool: pg.Pool;

  constructor(connectionString: string) {
    this.pool = new pg.Pool({ connectionString, max: 2 });
  }

  async close(): Promise<void> {
    await this.pool.end();
  }

  private async q<T extends pg.QueryResultRow>(tenantId: string, text: string, params: unknown[] = []): Promise<T[]> {
    const client = await this.pool.connect();
    try {
      await client.query('begin');
      await client.query(`select set_config('app.tenant_id', $1, true)`, [tenantId]);
      const rows = (await client.query<T>(text, params as never[])).rows;
      await client.query('commit');
      return rows;
    } catch (err) {
      await client.query('rollback').catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
  }

  async list(tenantId: string, limit: number): Promise<WebReviewReportBrief[]> {
    const rows = await this.q<{ id: string; month: string; summary: string; created_at: Date | string }>(tenantId,
      `select id, month, summary, created_at from web_review_reports where tenant_id = $1 order by month desc limit $2`, [tenantId, limit]);
    return rows.map((r) => ({ id: r.id, month: r.month, summary: r.summary, createdAt: new Date(r.created_at).toISOString() }));
  }

  async get(tenantId: string, month: string): Promise<WebReviewReport | null> {
    const rows = await this.q<Row>(tenantId, `select id, month, figures, summary, good, concern, next, created_at from web_review_reports where tenant_id = $1 and month = $2`, [tenantId, month]);
    return rows[0] ? toReport(rows[0]) : null;
  }

  async latest(tenantId: string): Promise<WebReviewReport | null> {
    const rows = await this.q<Row>(tenantId, `select id, month, figures, summary, good, concern, next, created_at from web_review_reports where tenant_id = $1 order by month desc limit 1`, [tenantId]);
    return rows[0] ? toReport(rows[0]) : null;
  }

  async add(tenantId: string, r: NewWebReviewReport): Promise<string | null> {
    const id = `wr-${randomUUID()}`;
    const rows = await this.q<{ id: string }>(tenantId,
      `insert into web_review_reports (id, tenant_id, month, figures, summary, good, concern, next) values ($1, $2, $3, $4, $5, $6, $7, $8)
       on conflict (tenant_id, month) do nothing returning id`,
      [id, tenantId, r.month, JSON.stringify(r.figures), r.summary, r.good, r.concern, r.next]);
    return rows[0]?.id ?? null;
  }

  async putFinding(tenantId: string, f: NewWebReviewFinding, now: Date = new Date()): Promise<'new' | 'updated'> {
    const [old] = await this.q<FindingRow>(tenantId, `select ${FINDING_COLUMNS} from web_review_findings where tenant_id = $1 and kind = $2 and target = $3`, [tenantId, f.kind, f.target]);
    const body = [f.title, JSON.stringify(f.figures), f.advice, f.requestDraft ? JSON.stringify(f.requestDraft) : null, f.columnId];
    if (!old) {
      await this.q(tenantId, `insert into web_review_findings (id, tenant_id, kind, target, title, figures, advice, request_draft, column_id)
        values ($1, $2, $3, $4, $5, $6, $7, $8, $9) on conflict (tenant_id, kind, target) do nothing`, [`wf-${randomUUID()}`, tenantId, f.kind, f.target, ...body]);
      return 'new';
    }
    const status = nextStatus(old.status, new Date(old.updated_at).toISOString(), now);
    const reopened = status === 'new' && old.status !== 'new';
    await this.q(tenantId, `update web_review_findings set title = $3, figures = $4, advice = $5, request_draft = $6, column_id = $7, status = $8,
      updated_at = now()${reopened ? ', found_at = now()' : ''} where tenant_id = $1 and id = $2`, [tenantId, old.id, ...body, status]);
    return reopened ? 'new' : 'updated';
  }

  async findings(tenantId: string, statuses?: WebReviewFindingStatus[], limit = 100): Promise<WebReviewFinding[]> {
    const rows = await this.q<FindingRow>(tenantId,
      `select ${FINDING_COLUMNS} from web_review_findings where tenant_id = $1 and ($2::text[] is null or status = any($2)) order by found_at desc, kind limit $3`,
      [tenantId, statuses ?? null, limit]);
    return rows.map(toFinding);
  }

  async finding(tenantId: string, id: string): Promise<WebReviewFinding | null> {
    const rows = await this.q<FindingRow>(tenantId, `select ${FINDING_COLUMNS} from web_review_findings where tenant_id = $1 and id = $2`, [tenantId, id]);
    return rows[0] ? toFinding(rows[0]) : null;
  }

  async setFindingStatus(tenantId: string, id: string, status: WebReviewFindingStatus): Promise<void> {
    await this.q(tenantId, `update web_review_findings set status = $3, updated_at = now() where tenant_id = $1 and id = $2`, [tenantId, id, status]);
  }

  async markRequestSent(tenantId: string, id: string, at: string): Promise<void> {
    await this.q(tenantId, `update web_review_findings set request_sent_at = $3, status = 'seen', updated_at = now() where tenant_id = $1 and id = $2`, [tenantId, id, at]);
  }

  async putPageMetrics(tenantId: string, m: Omit<WebPageMetrics, 'updatedAt'>): Promise<void> {
    const { path, start, end, ...metrics } = m;
    await this.q(tenantId, `insert into web_page_metrics (tenant_id, path, start_date, end_date, metrics) values ($1, $2, $3, $4, $5)
      on conflict (tenant_id, path) do update set start_date = excluded.start_date, end_date = excluded.end_date, metrics = excluded.metrics, updated_at = now()`,
      [tenantId, path, start, end, JSON.stringify(metrics)]);
  }

  async pageMetrics(tenantId: string, path: string): Promise<WebPageMetrics | null> {
    const rows = await this.q<{ path: string; start_date: string; end_date: string; metrics: Omit<WebPageMetrics, 'path' | 'start' | 'end' | 'updatedAt'>; updated_at: Date | string }>(tenantId,
      `select path, start_date::text, end_date::text, metrics, updated_at from web_page_metrics where tenant_id = $1 and path = $2`, [tenantId, path]);
    const r = rows[0];
    return r ? { path: r.path, start: r.start_date, end: r.end_date, ...r.metrics, updatedAt: new Date(r.updated_at).toISOString() } : null;
  }
}

/** 試験用のメモリの置き場。 */
export class MemoryWebReviewStore implements WebReviewStore {
  private readonly rows = new Map<string, WebReviewReport & { tenantId: string }>();

  async list(tenantId: string, limit: number): Promise<WebReviewReportBrief[]> {
    return [...this.rows.values()].filter((r) => r.tenantId === tenantId).sort((a, b) => b.month.localeCompare(a.month)).slice(0, limit)
      .map((r) => ({ id: r.id, month: r.month, summary: r.summary, createdAt: r.createdAt }));
  }

  async get(tenantId: string, month: string): Promise<WebReviewReport | null> {
    const r = this.rows.get(`${tenantId}:${month}`);
    return r ? { ...r } : null;
  }

  async latest(tenantId: string): Promise<WebReviewReport | null> {
    const [first] = await this.list(tenantId, 1);
    return first ? this.get(tenantId, first.month) : null;
  }

  async add(tenantId: string, r: NewWebReviewReport): Promise<string | null> {
    const key = `${tenantId}:${r.month}`;
    if (this.rows.has(key)) return null;
    const id = `wr-${randomUUID()}`;
    this.rows.set(key, { ...r, id, tenantId, createdAt: new Date().toISOString() });
    return id;
  }

  private readonly found = new Map<string, WebReviewFinding & { tenantId: string }>();
  private readonly metrics = new Map<string, WebPageMetrics>();

  async putFinding(tenantId: string, f: NewWebReviewFinding, now: Date = new Date()): Promise<'new' | 'updated'> {
    const old = [...this.found.values()].find((x) => x.tenantId === tenantId && x.kind === f.kind && x.target === f.target);
    const at = now.toISOString();
    if (!old) {
      const id = `wf-${randomUUID()}`;
      this.found.set(id, { ...f, id, tenantId, status: 'new', foundAt: at, updatedAt: at });
      return 'new';
    }
    const status = nextStatus(old.status, old.updatedAt, now);
    const reopened = status === 'new' && old.status !== 'new';
    this.found.set(old.id, { ...old, ...f, status, updatedAt: at, ...(reopened ? { foundAt: at } : {}) });
    return reopened ? 'new' : 'updated';
  }

  async findings(tenantId: string, statuses?: WebReviewFindingStatus[], limit = 100): Promise<WebReviewFinding[]> {
    return [...this.found.values()].filter((x) => x.tenantId === tenantId && (!statuses || statuses.includes(x.status)))
      .sort((a, b) => b.foundAt.localeCompare(a.foundAt)).slice(0, limit).map(({ tenantId: _t, ...x }) => x);
  }

  async finding(tenantId: string, id: string): Promise<WebReviewFinding | null> {
    const x = this.found.get(id);
    if (!x || x.tenantId !== tenantId) return null;
    const { tenantId: _t, ...rest } = x;
    return rest;
  }

  async setFindingStatus(tenantId: string, id: string, status: WebReviewFindingStatus): Promise<void> {
    const x = this.found.get(id);
    if (x && x.tenantId === tenantId) this.found.set(id, { ...x, status, updatedAt: new Date().toISOString() });
  }

  async markRequestSent(tenantId: string, id: string, at: string): Promise<void> {
    const x = this.found.get(id);
    if (x && x.tenantId === tenantId) this.found.set(id, { ...x, status: 'seen', requestSentAt: at, updatedAt: at });
  }

  async putPageMetrics(tenantId: string, m: Omit<WebPageMetrics, 'updatedAt'>): Promise<void> {
    this.metrics.set(`${tenantId}:${m.path}`, { ...m, updatedAt: new Date().toISOString() });
  }

  async pageMetrics(tenantId: string, path: string): Promise<WebPageMetrics | null> {
    return this.metrics.get(`${tenantId}:${path}`) ?? null;
  }
}
