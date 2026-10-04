/**
 * @file 競合の分析の置き場（仕様書 第36.14節・第36.18節）。自社の像・競合・取り出した事実・レポート・後ろで行う作業。
 *
 * PostgreSQL では行ごとのセキュリティで会社を分ける（不変則 I-2）。地図で見つけた競合は place ID だけを持ち、名前・URL は持たない。
 * 緯度と経度は 30 日を過ぎたら消す（{@link CompetitorStore.forgetLocations}）。自動テスト用にメモリの置き場も持つ。
 */

import { randomUUID } from 'node:crypto';
import pg from 'pg';
import type { CompetitorFactKind, CompetitorJob, CompetitorOrigin, CompetitorProfile, CompetitorReport } from '@m2office/shared';

/** 置き場の競合 1 社（place ID・位置を含む。画面には出さない形）。 */
export interface StoredCompetitor {
  id: string;
  origin: CompetitorOrigin;
  placeId: string | null;
  name: string;
  url: string;
  lat: number | null;
  lng: number | null;
  locationAt: string | null;
  reason: string;
  status: 'watching' | 'removed';
  lastReadAt: string | null;
  pagesRead: number;
  pagesFailed: number;
  readNote: string;
  createdBy: string;
  createdAt: string;
}

/** 新しい競合。 */
export type NewCompetitor = Pick<StoredCompetitor, 'origin' | 'placeId' | 'name' | 'url' | 'lat' | 'lng' | 'reason' | 'createdBy'>;

/** 直せる項目。 */
export type CompetitorPatch = Partial<Pick<StoredCompetitor, 'status' | 'reason' | 'lastReadAt' | 'pagesRead' | 'pagesFailed' | 'readNote' | 'lat' | 'lng' | 'name' | 'url'>>;

/** 置き場の事実。 */
export interface StoredFact {
  id: string;
  competitorId: string | null;
  period: string;
  kind: CompetitorFactKind;
  text: string;
  sourceUrl: string;
  pageHash: string;
  createdAt: string;
}

/** 新しい事実。 */
export type NewFact = Pick<StoredFact, 'kind' | 'text' | 'sourceUrl' | 'pageHash'>;

/** 読んだページの印（文字の指紋。ページの文字は残さない）。 */
export interface StoredPage {
  period: string;
  url: string;
  hash: string;
}

/** 置き場の作業（引数を含む）。 */
export interface StoredJob extends CompetitorJob {
  args: Record<string, unknown>;
  startedAt: string | null;
}

/** 競合の分析の置き場。 */
export interface CompetitorStore {
  profile(tenantId: string): Promise<CompetitorProfile | null>;
  saveProfile(tenantId: string, profile: CompetitorProfile): Promise<void>;
  list(tenantId: string): Promise<StoredCompetitor[]>;
  get(tenantId: string, id: string): Promise<StoredCompetitor | null>;
  /** 足す。同じ place ID がすでにあれば、その ID を返す（外したものもそのまま） */
  add(tenantId: string, c: NewCompetitor): Promise<string>;
  update(tenantId: string, id: string, patch: CompetitorPatch): Promise<void>;
  /** 自動で覚えた見ている競合のうち、`keep` に無いものを消す（探し直し。人が入れたもの・外したものは残す） */
  dropAutoExcept(tenantId: string, keep: string[]): Promise<number>;
  /** 決まった日時より前の緯度と経度を消す（30 日まで。第36.13節） */
  forgetLocations(tenantId: string, before: string): Promise<number>;
  facts(tenantId: string, competitorId: string | null): Promise<StoredFact[]>;
  /** その回の事実を置き換える */
  replaceFacts(tenantId: string, competitorId: string | null, period: string, facts: NewFact[]): Promise<void>;
  /** 競合ごとの、いちばん新しい回の事実の数 */
  factCounts(tenantId: string): Promise<Map<string, number>>;
  addReport(tenantId: string, r: Omit<CompetitorReport, 'id' | 'createdAt'>): Promise<string>;
  reports(tenantId: string, limit: number): Promise<CompetitorReport[]>;
  addJob(tenantId: string, job: { kind: CompetitorJob['kind']; args: Record<string, unknown>; requestedBy: string }): Promise<string>;
  /** 待っているか動いている作業（いちばん新しいもの） */
  activeJob(tenantId: string): Promise<StoredJob | null>;
  /** 最後に終わった作業 */
  lastJob(tenantId: string): Promise<StoredJob | null>;
  /** 待っている作業を 1 つ取り、動いている状態にする（ほかが取らないように） */
  claimJob(tenantId: string): Promise<StoredJob | null>;
  setJobMessage(tenantId: string, id: string, message: string): Promise<void>;
  finishJob(tenantId: string, id: string, status: 'done' | 'failed', message: string): Promise<void>;
  /** 決まった日時より前に動き始めたまま止まった作業を失敗にする（ワーカーが止まったとき） */
  failStale(tenantId: string, before: string): Promise<number>;
  /** 1 社（自社なら `null`）のページの印（新しい回から） */
  pages(tenantId: string, competitorId: string | null): Promise<StoredPage[]>;
  /** その回のページの印を置き換える */
  replacePages(tenantId: string, competitorId: string | null, period: string, pages: { url: string; hash: string }[]): Promise<void>;
  /** 1 社（自社なら `null`）の事実とページの印を、新しい `keep` 回分だけ残す */
  prune(tenantId: string, competitorId: string | null, keep: number): Promise<void>;
  /** 最後に終わった、全体の見回り（探すか、1 社だけでない見回り）の日時。無ければ `null` */
  lastFullRunAt(tenantId: string): Promise<string | null>;
  /** 最後に終わった探す作業の日時。無ければ `null` */
  lastDiscoverAt(tenantId: string): Promise<string | null>;
}

const newId = (p: string) => `${p}-${randomUUID()}`;

interface CompetitorRow {
  id: string; origin: CompetitorOrigin; place_id: string | null; name: string; url: string; lat: number | null; lng: number | null;
  location_at: Date | string | null; reason: string; status: 'watching' | 'removed'; last_read_at: Date | string | null; pages_read: number; pages_failed: number;
  read_note: string; created_by: string; created_at: Date | string;
}

/** 日時を ISO の文字にする（ドライバーの設定で、Date か文字のどちらでも来る）。 */
const iso = (d: Date | string | null) => (d ? new Date(d).toISOString() : null);
const isoNow = (d: Date | string) => new Date(d).toISOString();

function toCompetitor(r: CompetitorRow): StoredCompetitor {
  return {
    id: r.id, origin: r.origin, placeId: r.place_id, name: r.name, url: r.url, lat: r.lat, lng: r.lng, locationAt: iso(r.location_at),
    reason: r.reason, status: r.status, lastReadAt: iso(r.last_read_at), pagesRead: r.pages_read, pagesFailed: r.pages_failed,
    readNote: r.read_note, createdBy: r.created_by, createdAt: isoNow(r.created_at),
  };
}

interface JobRow {
  id: string; kind: CompetitorJob['kind']; args: Record<string, unknown>; status: CompetitorJob['status']; message: string; requested_by: string;
  created_at: Date | string; started_at: Date | string | null; finished_at: Date | string | null;
}

function toJob(r: JobRow): StoredJob {
  return {
    id: r.id, kind: r.kind, args: r.args ?? {}, status: r.status, message: r.message, requestedBy: r.requested_by,
    createdAt: isoNow(r.created_at), startedAt: iso(r.started_at), finishedAt: iso(r.finished_at),
  };
}

/** PostgreSQL の置き場。 */
export class PostgresCompetitorStore implements CompetitorStore {
  private readonly pool: pg.Pool;

  constructor(connectionString: string) {
    this.pool = new pg.Pool({ connectionString, max: 4 });
  }

  async close(): Promise<void> {
    await this.pool.end();
  }

  private async tx<T>(tenantId: string, fn: (c: pg.PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query('begin');
      await client.query(`select set_config('app.tenant_id', $1, true)`, [tenantId]);
      const out = await fn(client);
      await client.query('commit');
      return out;
    } catch (err) {
      await client.query('rollback').catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
  }

  private async q<T extends pg.QueryResultRow>(tenantId: string, text: string, params: unknown[] = []): Promise<T[]> {
    return this.tx(tenantId, async (c) => (await c.query<T>(text, params as never[])).rows);
  }

  async profile(tenantId: string): Promise<CompetitorProfile | null> {
    const rows = await this.q<{ profile: CompetitorProfile }>(tenantId, 'select profile from competitor_profiles where tenant_id = $1', [tenantId]);
    return rows[0]?.profile ?? null;
  }

  async saveProfile(tenantId: string, profile: CompetitorProfile): Promise<void> {
    await this.q(tenantId, `insert into competitor_profiles (tenant_id, profile, updated_at) values ($1, $2, now())
      on conflict (tenant_id) do update set profile = excluded.profile, updated_at = now()`, [tenantId, JSON.stringify(profile)]);
  }

  async list(tenantId: string): Promise<StoredCompetitor[]> {
    return (await this.q<CompetitorRow>(tenantId, 'select * from competitors where tenant_id = $1 order by created_at', [tenantId])).map(toCompetitor);
  }

  async get(tenantId: string, id: string): Promise<StoredCompetitor | null> {
    const rows = await this.q<CompetitorRow>(tenantId, 'select * from competitors where tenant_id = $1 and id = $2', [tenantId, id]);
    return rows[0] ? toCompetitor(rows[0]) : null;
  }

  async add(tenantId: string, c: NewCompetitor): Promise<string> {
    return this.tx(tenantId, async (client) => {
      if (c.placeId) {
        const hit = await client.query<{ id: string }>('select id from competitors where tenant_id = $1 and place_id = $2', [tenantId, c.placeId]);
        if (hit.rows[0]) return hit.rows[0].id;
      }
      const id = newId('cmp');
      const located = c.lat !== null && c.lng !== null;
      await client.query(`insert into competitors (id, tenant_id, origin, place_id, name, url, lat, lng, location_at, reason, created_by)
        values ($1, $2, $3, $4, $5, $6, $7, $8, ${located ? 'now()' : 'null'}, $9, $10)`,
      [id, tenantId, c.origin, c.placeId, c.origin === 'map' ? '' : c.name, c.origin === 'map' ? '' : c.url, c.lat, c.lng, c.reason, c.createdBy]);
      return id;
    });
  }

  async update(tenantId: string, id: string, patch: CompetitorPatch): Promise<void> {
    const cols: Record<string, string> = {
      status: 'status', reason: 'reason', lastReadAt: 'last_read_at', pagesRead: 'pages_read', pagesFailed: 'pages_failed', readNote: 'read_note',
      lat: 'lat', lng: 'lng', name: 'name', url: 'url',
    };
    const sets: string[] = [];
    const params: unknown[] = [tenantId, id];
    for (const [k, v] of Object.entries(patch)) {
      if (v === undefined || !cols[k]) continue;
      params.push(v);
      // 列名は上の固定の対応表からのみ取る
      sets.push(`${cols[k]} = $${params.length}`);
    }
    if ('lat' in patch) sets.push(patch.lat === null ? 'location_at = null' : 'location_at = now()');
    if (!sets.length) return;
    await this.q(tenantId, `update competitors set ${sets.join(', ')} where tenant_id = $1 and id = $2`, params);
  }

  async dropAutoExcept(tenantId: string, keep: string[]): Promise<number> {
    const rows = await this.q<{ id: string }>(tenantId, `delete from competitors where tenant_id = $1 and origin in ('map', 'ai') and status = 'watching'
      and not (id = any($2::text[])) returning id`, [tenantId, keep]);
    return rows.length;
  }

  async forgetLocations(tenantId: string, before: string): Promise<number> {
    const rows = await this.q<{ id: string }>(tenantId, `update competitors set lat = null, lng = null, location_at = null
      where tenant_id = $1 and location_at < $2 returning id`, [tenantId, before]);
    return rows.length;
  }

  async facts(tenantId: string, competitorId: string | null): Promise<StoredFact[]> {
    const rows = await this.q<{ id: string; competitor_id: string | null; period: string; kind: CompetitorFactKind; text: string; source_url: string; page_hash: string; created_at: Date | string }>(tenantId,
      `select * from competitor_facts where tenant_id = $1 and competitor_id is not distinct from $2 order by period desc, created_at`, [tenantId, competitorId]);
    return rows.map((r) => ({ id: r.id, competitorId: r.competitor_id, period: r.period, kind: r.kind, text: r.text, sourceUrl: r.source_url, pageHash: r.page_hash, createdAt: isoNow(r.created_at) }));
  }

  async replaceFacts(tenantId: string, competitorId: string | null, period: string, facts: NewFact[]): Promise<void> {
    await this.tx(tenantId, async (c) => {
      await c.query('delete from competitor_facts where tenant_id = $1 and competitor_id is not distinct from $2 and period = $3', [tenantId, competitorId, period]);
      for (const f of facts) {
        await c.query(`insert into competitor_facts (id, tenant_id, competitor_id, period, kind, text, source_url, page_hash)
          values ($1, $2, $3, $4, $5, $6, $7, $8)`, [newId('cfa'), tenantId, competitorId, period, f.kind, f.text, f.sourceUrl, f.pageHash]);
      }
    });
  }

  async factCounts(tenantId: string): Promise<Map<string, number>> {
    const rows = await this.q<{ competitor_id: string; n: string }>(tenantId, `select f.competitor_id, count(*) as n from competitor_facts f
      where f.tenant_id = $1 and f.competitor_id is not null
        and f.period = (select max(g.period) from competitor_facts g where g.tenant_id = f.tenant_id and g.competitor_id = f.competitor_id)
      group by f.competitor_id`, [tenantId]);
    return new Map(rows.map((r) => [r.competitor_id, Number(r.n)]));
  }

  async addReport(tenantId: string, r: Omit<CompetitorReport, 'id' | 'createdAt'>): Promise<string> {
    const id = newId('crp');
    await this.q(tenantId, 'insert into competitor_reports (id, tenant_id, period, text, changes, themes, created_by) values ($1, $2, $3, $4, $5, $6, $7)',
      [id, tenantId, r.period, r.text, r.changes, JSON.stringify(r.themes ?? []), r.createdBy]);
    return id;
  }

  async reports(tenantId: string, limit: number): Promise<CompetitorReport[]> {
    const rows = await this.q<{ id: string; period: string; text: string; changes: number; themes: string[] | null; created_by: string; created_at: Date | string }>(tenantId,
      'select * from competitor_reports where tenant_id = $1 order by created_at desc limit $2', [tenantId, limit]);
    return rows.map((r) => ({ id: r.id, period: r.period, text: r.text, changes: r.changes, themes: r.themes ?? [], createdBy: r.created_by, createdAt: isoNow(r.created_at) }));
  }

  async addJob(tenantId: string, job: { kind: CompetitorJob['kind']; args: Record<string, unknown>; requestedBy: string }): Promise<string> {
    const id = newId('cjb');
    await this.q(tenantId, 'insert into competitor_jobs (id, tenant_id, kind, args, requested_by) values ($1, $2, $3, $4, $5)',
      [id, tenantId, job.kind, JSON.stringify(job.args), job.requestedBy]);
    return id;
  }

  async activeJob(tenantId: string): Promise<StoredJob | null> {
    const rows = await this.q<JobRow>(tenantId, `select * from competitor_jobs where tenant_id = $1 and status in ('queued', 'running') order by created_at desc limit 1`, [tenantId]);
    return rows[0] ? toJob(rows[0]) : null;
  }

  async lastJob(tenantId: string): Promise<StoredJob | null> {
    const rows = await this.q<JobRow>(tenantId, `select * from competitor_jobs where tenant_id = $1 and status in ('done', 'failed') order by finished_at desc nulls last limit 1`, [tenantId]);
    return rows[0] ? toJob(rows[0]) : null;
  }

  async claimJob(tenantId: string): Promise<StoredJob | null> {
    const rows = await this.q<JobRow>(tenantId, `update competitor_jobs set status = 'running', started_at = now()
      where id = (select id from competitor_jobs where tenant_id = $1 and status = 'queued'
                  and not exists (select 1 from competitor_jobs r where r.tenant_id = $1 and r.status = 'running')
                  order by created_at limit 1 for update skip locked)
      returning *`, [tenantId]);
    return rows[0] ? toJob(rows[0]) : null;
  }

  async setJobMessage(tenantId: string, id: string, message: string): Promise<void> {
    await this.q(tenantId, 'update competitor_jobs set message = $3 where tenant_id = $1 and id = $2', [tenantId, id, message.slice(0, 300)]);
  }

  async finishJob(tenantId: string, id: string, status: 'done' | 'failed', message: string): Promise<void> {
    await this.q(tenantId, 'update competitor_jobs set status = $3, message = $4, finished_at = now() where tenant_id = $1 and id = $2', [tenantId, id, status, message.slice(0, 300)]);
  }

  async failStale(tenantId: string, before: string): Promise<number> {
    const rows = await this.q<{ id: string }>(tenantId, `update competitor_jobs set status = 'failed', message = '途中で止まりました。もう一度頼んでください', finished_at = now()
      where tenant_id = $1 and status = 'running' and started_at < $2 returning id`, [tenantId, before]);
    return rows.length;
  }

  async pages(tenantId: string, competitorId: string | null): Promise<StoredPage[]> {
    return this.q<StoredPage>(tenantId, `select period, url, hash from competitor_pages
      where tenant_id = $1 and competitor_id is not distinct from $2 order by period desc, url`, [tenantId, competitorId]);
  }

  async replacePages(tenantId: string, competitorId: string | null, period: string, pages: { url: string; hash: string }[]): Promise<void> {
    await this.tx(tenantId, async (c) => {
      await c.query('delete from competitor_pages where tenant_id = $1 and competitor_id is not distinct from $2 and period = $3', [tenantId, competitorId, period]);
      for (const p of pages) {
        await c.query('insert into competitor_pages (tenant_id, competitor_id, period, url, hash) values ($1, $2, $3, $4, $5)', [tenantId, competitorId, period, p.url, p.hash]);
      }
    });
  }

  async prune(tenantId: string, competitorId: string | null, keep: number): Promise<void> {
    await this.tx(tenantId, async (c) => {
      for (const table of ['competitor_facts', 'competitor_pages']) {
        // 表の名前は上の固定の一覧からのみ取る
        await c.query(`delete from ${table} where tenant_id = $1 and competitor_id is not distinct from $2 and period not in (
          select period from (select distinct period from ${table} where tenant_id = $1 and competitor_id is not distinct from $2) p order by period desc limit $3)`,
        [tenantId, competitorId, keep]);
      }
    });
  }

  async lastFullRunAt(tenantId: string): Promise<string | null> {
    const rows = await this.q<{ at: Date | string | null }>(tenantId, `select max(finished_at) as at from competitor_jobs
      where tenant_id = $1 and status = 'done' and (kind = 'discover' or not (args ? 'competitorId'))`, [tenantId]);
    return iso(rows[0]?.at ?? null);
  }

  async lastDiscoverAt(tenantId: string): Promise<string | null> {
    const rows = await this.q<{ at: Date | string | null }>(tenantId, `select max(finished_at) as at from competitor_jobs where tenant_id = $1 and status = 'done' and kind = 'discover'`, [tenantId]);
    return iso(rows[0]?.at ?? null);
  }
}

/** メモリの置き場（自動テスト用）。 */
export class MemoryCompetitorStore implements CompetitorStore {
  private profiles = new Map<string, CompetitorProfile>();
  private comps: (StoredCompetitor & { tenantId: string })[] = [];
  private factRows: (StoredFact & { tenantId: string })[] = [];
  private reportRows: (CompetitorReport & { tenantId: string })[] = [];
  private jobs: (StoredJob & { tenantId: string })[] = [];
  private pageRows: (StoredPage & { tenantId: string; competitorId: string | null })[] = [];

  async profile(tenantId: string) { return this.profiles.get(tenantId) ?? null; }
  async saveProfile(tenantId: string, profile: CompetitorProfile) { this.profiles.set(tenantId, profile); }
  async list(tenantId: string) { return this.comps.filter((c) => c.tenantId === tenantId).map(({ tenantId: _t, ...c }) => ({ ...c })); }
  async get(tenantId: string, id: string) {
    const c = this.comps.find((x) => x.tenantId === tenantId && x.id === id);
    if (!c) return null;
    const { tenantId: _t, ...rest } = c;
    return { ...rest };
  }

  async add(tenantId: string, c: NewCompetitor) {
    const hit = c.placeId ? this.comps.find((x) => x.tenantId === tenantId && x.placeId === c.placeId) : null;
    if (hit) return hit.id;
    const id = newId('cmp');
    const located = c.lat !== null && c.lng !== null;
    this.comps.push({
      ...c, name: c.origin === 'map' ? '' : c.name, url: c.origin === 'map' ? '' : c.url, id, tenantId, status: 'watching', lastReadAt: null, pagesRead: 0, pagesFailed: 0, readNote: '',
      locationAt: located ? new Date().toISOString() : null, createdAt: new Date().toISOString(),
    });
    return id;
  }

  async update(tenantId: string, id: string, patch: CompetitorPatch) {
    const c = this.comps.find((x) => x.tenantId === tenantId && x.id === id);
    if (!c) return;
    for (const [k, v] of Object.entries(patch)) if (v !== undefined) (c as unknown as Record<string, unknown>)[k] = v;
    if ('lat' in patch) c.locationAt = patch.lat === null ? null : new Date().toISOString();
  }

  async dropAutoExcept(tenantId: string, keep: string[]) {
    const before = this.comps.length;
    this.comps = this.comps.filter((c) => !(c.tenantId === tenantId && c.origin !== 'manual' && c.status === 'watching' && !keep.includes(c.id)));
    return before - this.comps.length;
  }

  async forgetLocations(tenantId: string, before: string) {
    let n = 0;
    for (const c of this.comps) {
      if (c.tenantId === tenantId && c.locationAt && c.locationAt < before) { c.lat = null; c.lng = null; c.locationAt = null; n += 1; }
    }
    return n;
  }

  async facts(tenantId: string, competitorId: string | null) {
    return this.factRows.filter((f) => f.tenantId === tenantId && f.competitorId === competitorId)
      .sort((a, b) => b.period.localeCompare(a.period)).map(({ tenantId: _t, ...f }) => f);
  }

  async replaceFacts(tenantId: string, competitorId: string | null, period: string, facts: NewFact[]) {
    this.factRows = this.factRows.filter((f) => !(f.tenantId === tenantId && f.competitorId === competitorId && f.period === period));
    for (const f of facts) this.factRows.push({ ...f, id: newId('cfa'), tenantId, competitorId, period, createdAt: new Date().toISOString() });
  }

  async factCounts(tenantId: string) {
    const latest = new Map<string, string>();
    for (const f of this.factRows) if (f.tenantId === tenantId && f.competitorId && (latest.get(f.competitorId) ?? '') < f.period) latest.set(f.competitorId, f.period);
    const out = new Map<string, number>();
    for (const f of this.factRows) if (f.tenantId === tenantId && f.competitorId && latest.get(f.competitorId) === f.period) out.set(f.competitorId, (out.get(f.competitorId) ?? 0) + 1);
    return out;
  }

  async addReport(tenantId: string, r: Omit<CompetitorReport, 'id' | 'createdAt'>) {
    const id = newId('crp');
    this.reportRows.push({ ...r, id, tenantId, createdAt: new Date(Date.now() + this.reportRows.length).toISOString() });
    return id;
  }

  async reports(tenantId: string, limit: number) {
    return this.reportRows.filter((r) => r.tenantId === tenantId).sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, limit).map(({ tenantId: _t, ...r }) => r);
  }

  async addJob(tenantId: string, job: { kind: CompetitorJob['kind']; args: Record<string, unknown>; requestedBy: string }) {
    const id = newId('cjb');
    this.jobs.push({ ...job, id, tenantId, status: 'queued', message: '', createdAt: new Date(Date.now() + this.jobs.length).toISOString(), startedAt: null, finishedAt: null });
    return id;
  }

  private strip(j: (StoredJob & { tenantId: string }) | undefined) {
    if (!j) return null;
    const { tenantId: _t, ...rest } = j;
    return { ...rest };
  }

  async activeJob(tenantId: string) {
    return this.strip(this.jobs.filter((j) => j.tenantId === tenantId && (j.status === 'queued' || j.status === 'running')).at(-1));
  }

  async lastJob(tenantId: string) {
    return this.strip(this.jobs.filter((j) => j.tenantId === tenantId && (j.status === 'done' || j.status === 'failed'))
      .sort((a, b) => (a.finishedAt ?? '').localeCompare(b.finishedAt ?? '')).at(-1));
  }

  async claimJob(tenantId: string) {
    if (this.jobs.some((j) => j.tenantId === tenantId && j.status === 'running')) return null;
    const j = this.jobs.find((x) => x.tenantId === tenantId && x.status === 'queued');
    if (!j) return null;
    j.status = 'running';
    j.startedAt = new Date().toISOString();
    return this.strip(j);
  }

  async setJobMessage(tenantId: string, id: string, message: string) {
    const j = this.jobs.find((x) => x.tenantId === tenantId && x.id === id);
    if (j) j.message = message;
  }

  async finishJob(tenantId: string, id: string, status: 'done' | 'failed', message: string) {
    const j = this.jobs.find((x) => x.tenantId === tenantId && x.id === id);
    if (j) { j.status = status; j.message = message; j.finishedAt = new Date().toISOString(); }
  }

  async failStale(tenantId: string, before: string) {
    let n = 0;
    for (const j of this.jobs) {
      if (j.tenantId === tenantId && j.status === 'running' && (j.startedAt ?? '') < before) { j.status = 'failed'; j.message = '途中で止まりました。もう一度頼んでください'; j.finishedAt = new Date().toISOString(); n += 1; }
    }
    return n;
  }

  async pages(tenantId: string, competitorId: string | null) {
    return this.pageRows.filter((p) => p.tenantId === tenantId && p.competitorId === competitorId)
      .sort((a, b) => b.period.localeCompare(a.period) || a.url.localeCompare(b.url)).map(({ period, url, hash }) => ({ period, url, hash }));
  }

  async replacePages(tenantId: string, competitorId: string | null, period: string, pages: { url: string; hash: string }[]) {
    this.pageRows = this.pageRows.filter((p) => !(p.tenantId === tenantId && p.competitorId === competitorId && p.period === period));
    for (const p of pages) this.pageRows.push({ ...p, tenantId, competitorId, period });
  }

  async prune(tenantId: string, competitorId: string | null, keep: number) {
    const mine = <T extends { tenantId: string; competitorId: string | null; period: string }>(rows: T[]) => rows.filter((r) => r.tenantId === tenantId && r.competitorId === competitorId);
    const keepFacts = new Set([...new Set(mine(this.factRows).map((f) => f.period))].sort().reverse().slice(0, keep));
    const keepPages = new Set([...new Set(mine(this.pageRows).map((p) => p.period))].sort().reverse().slice(0, keep));
    this.factRows = this.factRows.filter((f) => !(f.tenantId === tenantId && f.competitorId === competitorId) || keepFacts.has(f.period));
    this.pageRows = this.pageRows.filter((p) => !(p.tenantId === tenantId && p.competitorId === competitorId) || keepPages.has(p.period));
  }

  async lastFullRunAt(tenantId: string) {
    const done = this.jobs.filter((j) => j.tenantId === tenantId && j.status === 'done' && (j.kind === 'discover' || !j.args['competitorId']));
    return done.map((j) => j.finishedAt ?? '').sort().at(-1) || null;
  }

  async lastDiscoverAt(tenantId: string) {
    return this.jobs.filter((j) => j.tenantId === tenantId && j.status === 'done' && j.kind === 'discover').map((j) => j.finishedAt ?? '').sort().at(-1) || null;
  }
}
