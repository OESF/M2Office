/**
 * @file 販促物の置き場（仕様書 第41.13節）。PostgreSQL（行単位の制限つき）と、テスト用のメモリ。
 *
 * 物（`print_designs`）と版（`print_design_versions`。3 案も版）を持つ。画像と書き出した PNG・PDF はファイルの置き場に置き、表には持たない。
 */

import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { NO_PRINT_SIGNAGE, type PrintCheck, type PrintCopy, type PrintDesign, type PrintImageSource, type PrintKind, type PrintSignageState, type PrintSize, type PrintVersion } from '@m2office/shared';

/** 置き場の物（作った人の名前は持たない。画面に出すときに足す）。`signageAssetId` は流している店頭サイネージの素材（第41.18節）。 */
export type StoredDesign = Omit<PrintDesign, 'createdByName'> & { endedNotified: boolean; signageAssetId: string | null };

/** 新しい物。 */
export type NewDesign = Pick<StoredDesign, 'title' | 'kind' | 'size' | 'request' | 'remadeFrom' | 'createdBy'> & { postFrom?: string | null; postTo?: string | null; place?: string };

/** 新しい版。 */
export type NewVersion = Omit<PrintVersion, 'id' | 'no' | 'createdAt'>;

/** 直せる項目。 */
export type DesignPatch = Partial<Pick<StoredDesign, 'title' | 'currentVersionId' | 'postFrom' | 'postTo' | 'place' | 'removedAt' | 'endedNotified' | 'signage' | 'signageAssetId'>>;

/** 販促物の置き場。 */
export interface PrintDesignStore {
  list(tenantId: string, limit?: number): Promise<StoredDesign[]>;
  get(tenantId: string, id: string): Promise<StoredDesign | null>;
  create(tenantId: string, d: NewDesign): Promise<string>;
  update(tenantId: string, id: string, patch: DesignPatch): Promise<void>;
  delete(tenantId: string, id: string): Promise<void>;
  versions(tenantId: string, designId: string): Promise<PrintVersion[]>;
  getVersion(tenantId: string, id: string): Promise<PrintVersion | null>;
  /** 版を足す（番号は続きの番号）。 */
  addVersion(tenantId: string, v: NewVersion): Promise<string>;
  deleteVersion(tenantId: string, id: string): Promise<void>;
}

const iso = (v: unknown): string => (v instanceof Date ? v.toISOString() : new Date(String(v ?? '')).toISOString());
const isoOrNull = (v: unknown): string | null => (v ? iso(v) : null);
const day = (v: unknown): string | null => {
  if (!v) return null;
  if (v instanceof Date) return new Date(v.getTime() - v.getTimezoneOffset() * 60_000).toISOString().slice(0, 10);
  return String(v).slice(0, 10);
};

interface DesignRow {
  id: string; title: string; kind: PrintKind; size: PrintSize; current_version_id: string | null; post_from: unknown; post_to: unknown; place: string;
  removed_at: unknown; ended_notified: boolean; request: string; remade_from: string | null; created_by: string; created_at: unknown; updated_at: unknown;
  signage_state: PrintSignageState | null; signage_asset_id: string | null; signage_screens: string[] | null; signage_at: unknown;
}
interface VersionRow {
  id: string; design_id: string; no: number; proposal: boolean; template: string; palette: number; color: string; headline_scale: number;
  copy: PrintCopy; image: PrintImageSource; ai_image: boolean; checks: PrintCheck[] | null; instruction: string; created_by: string; created_at: unknown;
}

const toDesign = (r: DesignRow): StoredDesign => ({
  id: r.id, title: r.title, kind: r.kind, size: r.size, currentVersionId: r.current_version_id, postFrom: day(r.post_from), postTo: day(r.post_to), place: r.place,
  removedAt: isoOrNull(r.removed_at), endedNotified: r.ended_notified, request: r.request, remadeFrom: r.remade_from, createdBy: r.created_by,
  createdAt: iso(r.created_at), updatedAt: iso(r.updated_at),
  signage: { state: r.signage_state ?? 'none', screens: r.signage_screens ?? [], at: isoOrNull(r.signage_at) }, signageAssetId: r.signage_asset_id,
});
const toVersion = (r: VersionRow): PrintVersion => ({
  id: r.id, designId: r.design_id, no: r.no, proposal: r.proposal, template: r.template, palette: r.palette, color: r.color, headlineScale: Number(r.headline_scale),
  copy: r.copy, image: r.image, aiImage: r.ai_image, checks: r.checks ?? [], instruction: r.instruction, createdBy: r.created_by, createdAt: iso(r.created_at),
});

/** PostgreSQL の置き場。会社ごとに `app.tenant_id` を入れて行単位の制限を効かせる。 */
export class PostgresPrintDesignStore implements PrintDesignStore {
  private readonly pool: pg.Pool;

  constructor(connectionString: string) {
    this.pool = new pg.Pool({ connectionString, max: 4 });
  }

  private async q<T extends pg.QueryResultRow>(tenantId: string, text: string, params: unknown[] = []): Promise<T[]> {
    const c = await this.pool.connect();
    try {
      await c.query('begin');
      await c.query(`select set_config('app.tenant_id', $1, true)`, [tenantId]);
      const r = await c.query<T>(text, params);
      await c.query('commit');
      return r.rows;
    } catch (err) {
      await c.query('rollback').catch(() => undefined);
      throw err;
    } finally {
      c.release();
    }
  }

  async list(tenantId: string, limit = 500): Promise<StoredDesign[]> {
    return (await this.q<DesignRow>(tenantId, `select * from print_designs where tenant_id = $1 order by updated_at desc limit $2`, [tenantId, limit])).map(toDesign);
  }

  async get(tenantId: string, id: string): Promise<StoredDesign | null> {
    const rows = await this.q<DesignRow>(tenantId, `select * from print_designs where tenant_id = $1 and id = $2`, [tenantId, id]);
    return rows[0] ? toDesign(rows[0]) : null;
  }

  async create(tenantId: string, d: NewDesign): Promise<string> {
    const id = `prd-${randomUUID()}`;
    await this.q(tenantId,
      `insert into print_designs (id, tenant_id, title, kind, size, request, remade_from, created_by, post_from, post_to, place) values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
      [id, tenantId, d.title, d.kind, d.size, d.request, d.remadeFrom, d.createdBy, d.postFrom ?? null, d.postTo ?? null, d.place ?? '']);
    return id;
  }

  async update(tenantId: string, id: string, patch: DesignPatch): Promise<void> {
    const cols: Record<string, string> = {
      title: 'title', currentVersionId: 'current_version_id', postFrom: 'post_from', postTo: 'post_to', place: 'place', removedAt: 'removed_at', endedNotified: 'ended_notified',
      signageAssetId: 'signage_asset_id', signageState: 'signage_state', signageScreens: 'signage_screens', signageAt: 'signage_at',
    };
    const sets: string[] = [];
    const params: unknown[] = [tenantId, id];
    // サイネージの様子は 3 つの列に分けて持つ
    const { signage, ...rest } = patch;
    const flat: Record<string, unknown> = { ...rest, ...(signage ? { signageState: signage.state, signageScreens: JSON.stringify(signage.screens), signageAt: signage.at } : {}) };
    for (const [k, v] of Object.entries(flat)) {
      if (v === undefined || !cols[k]) continue;
      params.push(v);
      sets.push(`${cols[k]} = $${params.length}`);
    }
    if (sets.length) await this.q(tenantId, `update print_designs set ${sets.join(', ')}, updated_at = now() where tenant_id = $1 and id = $2`, params);
  }

  async delete(tenantId: string, id: string): Promise<void> {
    await this.q(tenantId, `delete from print_designs where tenant_id = $1 and id = $2`, [tenantId, id]);
  }

  async versions(tenantId: string, designId: string): Promise<PrintVersion[]> {
    return (await this.q<VersionRow>(tenantId, `select * from print_design_versions where tenant_id = $1 and design_id = $2 order by no`, [tenantId, designId])).map(toVersion);
  }

  async getVersion(tenantId: string, id: string): Promise<PrintVersion | null> {
    const rows = await this.q<VersionRow>(tenantId, `select * from print_design_versions where tenant_id = $1 and id = $2`, [tenantId, id]);
    return rows[0] ? toVersion(rows[0]) : null;
  }

  async addVersion(tenantId: string, v: NewVersion): Promise<string> {
    const id = `prv-${randomUUID()}`;
    await this.q(tenantId,
      `insert into print_design_versions (id, tenant_id, design_id, no, proposal, template, palette, color, headline_scale, copy, image, ai_image, checks, instruction, created_by)
       values ($1, $2, $3, (select coalesce(max(no), 0) + 1 from print_design_versions where tenant_id = $2 and design_id = $3), $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)`,
      [id, tenantId, v.designId, v.proposal, v.template, v.palette, v.color, v.headlineScale, JSON.stringify(v.copy), v.image, v.aiImage, JSON.stringify(v.checks), v.instruction, v.createdBy]);
    await this.q(tenantId, `update print_designs set updated_at = now() where tenant_id = $1 and id = $2`, [tenantId, v.designId]);
    return id;
  }

  async deleteVersion(tenantId: string, id: string): Promise<void> {
    await this.q(tenantId, `delete from print_design_versions where tenant_id = $1 and id = $2`, [tenantId, id]);
  }
}

/** テスト用のメモリの置き場。 */
export class MemoryPrintDesignStore implements PrintDesignStore {
  readonly designs = new Map<string, StoredDesign & { tenantId: string }>();
  readonly versionRows = new Map<string, PrintVersion & { tenantId: string }>();
  private clock = 0;
  now: () => Date = () => new Date(Date.now() + this.clock++);

  async list(tenantId: string): Promise<StoredDesign[]> {
    return [...this.designs.values()].filter((d) => d.tenantId === tenantId).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).map(({ tenantId: _t, ...d }) => ({ ...d }));
  }

  async get(tenantId: string, id: string): Promise<StoredDesign | null> {
    const d = this.designs.get(id);
    if (!d || d.tenantId !== tenantId) return null;
    const { tenantId: _t, ...rest } = d;
    return { ...rest };
  }

  async create(tenantId: string, d: NewDesign): Promise<string> {
    const id = `prd-${randomUUID()}`;
    const at = this.now().toISOString();
    this.designs.set(id, {
      id, tenantId, title: d.title, kind: d.kind, size: d.size, currentVersionId: null, postFrom: d.postFrom ?? null, postTo: d.postTo ?? null, place: d.place ?? '',
      removedAt: null, endedNotified: false, request: d.request, remadeFrom: d.remadeFrom, createdBy: d.createdBy, createdAt: at, updatedAt: at,
      signage: NO_PRINT_SIGNAGE, signageAssetId: null,
    });
    return id;
  }

  async update(tenantId: string, id: string, patch: DesignPatch): Promise<void> {
    const d = this.designs.get(id);
    if (d && d.tenantId === tenantId) this.designs.set(id, { ...d, ...Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined)), updatedAt: this.now().toISOString() });
  }

  async delete(tenantId: string, id: string): Promise<void> {
    const d = this.designs.get(id);
    if (!d || d.tenantId !== tenantId) return;
    this.designs.delete(id);
    for (const [k, v] of this.versionRows) if (v.designId === id) this.versionRows.delete(k);
  }

  async versions(tenantId: string, designId: string): Promise<PrintVersion[]> {
    return [...this.versionRows.values()].filter((v) => v.tenantId === tenantId && v.designId === designId).sort((a, b) => a.no - b.no).map(({ tenantId: _t, ...v }) => ({ ...v }));
  }

  async getVersion(tenantId: string, id: string): Promise<PrintVersion | null> {
    const v = this.versionRows.get(id);
    if (!v || v.tenantId !== tenantId) return null;
    const { tenantId: _t, ...rest } = v;
    return { ...rest };
  }

  async addVersion(tenantId: string, v: NewVersion): Promise<string> {
    const id = `prv-${randomUUID()}`;
    const no = Math.max(0, ...[...this.versionRows.values()].filter((x) => x.designId === v.designId).map((x) => x.no)) + 1;
    this.versionRows.set(id, { ...v, id, no, tenantId, createdAt: this.now().toISOString() });
    const d = this.designs.get(v.designId);
    if (d) this.designs.set(d.id, { ...d, updatedAt: this.now().toISOString() });
    return id;
  }

  async deleteVersion(tenantId: string, id: string): Promise<void> {
    const v = this.versionRows.get(id);
    if (v && v.tenantId === tenantId) this.versionRows.delete(id);
  }
}
