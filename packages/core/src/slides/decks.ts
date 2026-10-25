/**
 * @file 作ったスライドを覚え、一覧・共有の切り替え・削除を行う（仕様書 第9.4.2節「作ったスライドの扱い」、Q-264、ADR-0108）。
 *
 * 作り直すために、作った人ごとに構成（調べた結果から作った資料の中身）を持つ。会社ごとに分ける（不変則 I-2）。
 * 作り直す・共有の切り替え・削除は作った人だけが行える。会社で共有されたものは、会社の人が一覧で見られる。
 * 会社で共有は、会社の Google Workspace のドメインへの閲覧だけ。ドメインを確かめられなければ共有しない（境界 2）。
 */

import type pg from 'pg';
import type { SlideDeckSharing, SlideDeckSummary } from '@m2office/shared';
import type { WorkspaceConnector } from '../connectors/types.js';
import type { Repository } from '../repository/types.js';
import { createPool } from '../repository/pool.js';
import type { SlidePlan } from './plan.js';

/** 作ったスライド 1 件（置き場の形）。 */
export interface SlideDeck {
  id: string;
  tenantId: string;
  userId: string;
  presentationId: string;
  title: string;
  /** 組み込みのデザインの名前（会社のテンプレートで作ったときは `null`）。 */
  design: string | null;
  /** 会社のテンプレートの名前。 */
  template: string | null;
  /** Google スライドのテーマの ID（第9.4.2節「Google スライドのテーマを使う」）。作り直しで同じテーマを使う。 */
  theme: string | null;
  sharing: SlideDeckSharing;
  /** 最初の頼みと、直す頼みの積み重ね。 */
  request: string;
  plan: SlidePlan;
  /** AI が作った画像の頼み（場所の名前 → 頼み）。作り直すときに、同じ頼みの画像を使い回す。 */
  imagePrompts: Record<string, string>;
  runId: string | null;
  /** M2Office が組み立て終えた時刻（ドライブの更新の時刻）。これより後に変わっていれば、人が手を入れた。 */
  builtAt: string;
  createdAt: string;
  updatedAt: string;
}

/** 作ったスライドの置き場。 */
export interface SlideDeckStore {
  save(deck: SlideDeck): Promise<void>;
  get(tenantId: string, id: string): Promise<SlideDeck | null>;
  /** 本人が作ったもの（新しい順）。 */
  listMine(tenantId: string, userId: string, limit: number): Promise<SlideDeck[]>;
  /** 会社で共有されたもの（本人のものを除く。新しい順）。 */
  listShared(tenantId: string, exceptUserId: string, limit: number): Promise<SlideDeck[]>;
  remove(tenantId: string, id: string): Promise<void>;
}

/** 一覧に出す件数の上限。 */
export const SLIDE_DECK_LIST_MAX = 100;

type Row = Omit<SlideDeck, 'plan' | 'imagePrompts'> & { plan: SlidePlan; imagePrompts: Record<string, string> | null };
const COLUMNS = `id, tenant_id as "tenantId", user_id as "userId", presentation_id as "presentationId", title, design, template, theme_id as "theme", sharing,
  request, plan, image_prompts as "imagePrompts", run_id as "runId", built_at as "builtAt", created_at as "createdAt", updated_at as "updatedAt"`;
const iso = (v: unknown) => (v instanceof Date ? v.toISOString() : String(v));
const fromRow = (r: Row): SlideDeck => ({
  ...r, imagePrompts: r.imagePrompts ?? {}, builtAt: iso(r.builtAt), createdAt: iso(r.createdAt), updatedAt: iso(r.updatedAt),
});

/** 作ったスライドの置き場（PostgreSQL。移行 159）。 */
export class PostgresSlideDeckStore implements SlideDeckStore {
  private readonly pool: pg.Pool;

  constructor(connectionString: string) {
    this.pool = createPool(connectionString, { max: 2, name: 'slide-decks' });
  }

  private async q<T>(tenantId: string, sql: string, params: unknown[]): Promise<T[]> {
    const client = await this.pool.connect();
    try {
      await client.query('begin');
      await client.query(`select set_config('app.tenant_id', $1, true)`, [tenantId]);
      const out = await client.query(sql, params);
      await client.query('commit');
      return out.rows as T[];
    } catch (err) {
      await client.query('rollback').catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
  }

  async save(d: SlideDeck): Promise<void> {
    await this.q(d.tenantId,
      `insert into slide_decks (id, tenant_id, user_id, presentation_id, title, design, template, sharing, request, plan, image_prompts, run_id, built_at, created_at, updated_at, theme_id)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
       on conflict (id) do update set presentation_id = excluded.presentation_id, title = excluded.title, design = excluded.design,
         template = excluded.template, theme_id = excluded.theme_id, sharing = excluded.sharing, request = excluded.request, plan = excluded.plan,
         image_prompts = excluded.image_prompts, run_id = excluded.run_id, built_at = excluded.built_at, updated_at = excluded.updated_at
       where slide_decks.tenant_id = excluded.tenant_id`,
      [d.id, d.tenantId, d.userId, d.presentationId, d.title, d.design, d.template, d.sharing, d.request,
        JSON.stringify(d.plan), JSON.stringify(d.imagePrompts), d.runId, d.builtAt, d.createdAt, d.updatedAt, d.theme]);
  }

  async get(tenantId: string, id: string): Promise<SlideDeck | null> {
    const rows = await this.q<Row>(tenantId, `select ${COLUMNS} from slide_decks where tenant_id = $1 and id = $2`, [tenantId, id]);
    return rows[0] ? fromRow(rows[0]) : null;
  }

  async listMine(tenantId: string, userId: string, limit: number): Promise<SlideDeck[]> {
    return (await this.q<Row>(tenantId,
      `select ${COLUMNS} from slide_decks where tenant_id = $1 and user_id = $2 order by updated_at desc limit $3`, [tenantId, userId, limit])).map(fromRow);
  }

  async listShared(tenantId: string, exceptUserId: string, limit: number): Promise<SlideDeck[]> {
    return (await this.q<Row>(tenantId,
      `select ${COLUMNS} from slide_decks where tenant_id = $1 and sharing = 'company' and user_id <> $2 order by updated_at desc limit $3`,
      [tenantId, exceptUserId, limit])).map(fromRow);
  }

  async remove(tenantId: string, id: string): Promise<void> {
    await this.q(tenantId, 'delete from slide_decks where tenant_id = $1 and id = $2', [tenantId, id]);
  }

  /** 終わるときに呼ぶ。 */
  async close(): Promise<void> {
    await this.pool.end();
  }
}

/** 作ったスライドの置き場（記憶。テストと見本）。 */
export class InMemorySlideDeckStore implements SlideDeckStore {
  readonly decks = new Map<string, SlideDeck>();

  async save(d: SlideDeck): Promise<void> {
    const had = this.decks.get(d.id);
    if (had && had.tenantId !== d.tenantId) return;
    this.decks.set(d.id, structuredClone(d));
  }

  async get(tenantId: string, id: string): Promise<SlideDeck | null> {
    const d = this.decks.get(id);
    return d && d.tenantId === tenantId ? structuredClone(d) : null;
  }

  async listMine(tenantId: string, userId: string, limit: number): Promise<SlideDeck[]> {
    return [...this.decks.values()].filter((d) => d.tenantId === tenantId && d.userId === userId)
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).slice(0, limit).map((d) => structuredClone(d));
  }

  async listShared(tenantId: string, exceptUserId: string, limit: number): Promise<SlideDeck[]> {
    return [...this.decks.values()].filter((d) => d.tenantId === tenantId && d.sharing === 'company' && d.userId !== exceptUserId)
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).slice(0, limit).map((d) => structuredClone(d));
  }

  async remove(tenantId: string, id: string): Promise<void> {
    if (this.decks.get(id)?.tenantId === tenantId) this.decks.delete(id);
  }
}

/** 見ている人（会社と利用者）。 */
export interface SlideDeckViewer {
  tenantId: string;
  userId: string;
}

/** 開く道と PowerPoint の取り出しの道（見本の接続口で作ったものは無い）。 */
export function slideDeckLinks(presentationId: string): { url: string | null; pptxUrl: string | null } {
  if (presentationId.startsWith('mock-')) return { url: null, pptxUrl: null };
  const id = encodeURIComponent(presentationId);
  return { url: `https://docs.google.com/presentation/d/${id}/edit`, pptxUrl: `https://docs.google.com/presentation/d/${id}/export/pptx` };
}

/** メールアドレスのドメイン（小文字）。 */
const domainOf = (email: string) => email.split('@')[1]?.trim().toLowerCase() ?? '';

/**
 * 作ったスライドの一覧・共有の切り替え・削除（仕様書 第9.4.2節「作ったスライドの扱い」）。
 *
 * API（一覧の画面）とツール（秘書と業務）が同じ道を使う。
 */
export class SlideDeckService {
  constructor(private readonly deps: { store: SlideDeckStore; repo: Repository; connector: WorkspaceConnector }) {}

  /** 置き場（ツールが作ったスライドを覚えるのに使う）。 */
  get store(): SlideDeckStore {
    return this.deps.store;
  }

  /** 一覧に出す形にする。 */
  private summary(d: SlideDeck, viewer: SlideDeckViewer, ownerName?: string): SlideDeckSummary {
    return {
      id: d.id, title: d.title, design: d.design ?? d.template, sharing: d.sharing, ...slideDeckLinks(d.presentationId),
      ...(ownerName ? { ownerName } : {}), mine: d.userId === viewer.userId, createdAt: d.createdAt, updatedAt: d.updatedAt,
    };
  }

  /** 本人が作ったものと、会社で共有されたもの（新しい順）。 */
  async list(viewer: SlideDeckViewer): Promise<{ mine: SlideDeckSummary[]; shared: SlideDeckSummary[] }> {
    const [mine, shared] = await Promise.all([
      this.deps.store.listMine(viewer.tenantId, viewer.userId, SLIDE_DECK_LIST_MAX),
      this.deps.store.listShared(viewer.tenantId, viewer.userId, SLIDE_DECK_LIST_MAX),
    ]);
    const names = new Map<string, string>();
    for (const id of new Set(shared.map((d) => d.userId))) {
      const u = await this.deps.repo.findUserById(viewer.tenantId, id);
      if (u) names.set(id, u.displayName);
    }
    return {
      mine: mine.map((d) => this.summary(d, viewer)),
      shared: shared.map((d) => this.summary(d, viewer, names.get(d.userId) ?? '（退職した人）')),
    };
  }

  /**
   * 1 件を読む。本人のもの・会社で共有されたものだけ。
   *
   * @returns 見られなければ `null`
   */
  async get(viewer: SlideDeckViewer, id: string): Promise<SlideDeck | null> {
    const d = await this.deps.store.get(viewer.tenantId, id);
    if (!d) return null;
    return d.userId === viewer.userId || d.sharing === 'company' ? d : null;
  }

  /** 1 件を一覧の形で読む。 */
  async getSummary(viewer: SlideDeckViewer, id: string): Promise<SlideDeckSummary | null> {
    const d = await this.get(viewer, id);
    return d ? this.summary(d, viewer) : null;
  }

  /**
   * 会社で共有するときのドメイン。会社の Workspace のドメインが決まっていて、作った人のアカウントがそのドメインのときだけ。
   *
   * @returns ドメインか、共有しない理由
   */
  async companyDomain(viewer: SlideDeckViewer): Promise<{ domain: string } | { reason: string }> {
    const [tenant, user] = await Promise.all([this.deps.repo.findTenantById(viewer.tenantId), this.deps.repo.findUserById(viewer.tenantId, viewer.userId)]);
    const domain = tenant?.workspaceDomain?.trim().toLowerCase() ?? '';
    if (!domain) return { reason: '会社の Google Workspace のドメインが決まっていないため、会社で共有できません（管理者に設定を頼んでください）' };
    if (!user || domainOf(user.email) !== domain) {
      return { reason: `あなたの Google のアカウントが会社のドメイン（${domain}）ではないため、会社で共有できません（社外に出る恐れがあるため）` };
    }
    return { domain };
  }

  /**
   * 共有の範囲を切り替える（作った人だけ）。会社の中なので承認は要らない（ADR-0028）。
   *
   * @returns 切り替えた後のもの、またはできない理由
   */
  async share(viewer: SlideDeckViewer, id: string, sharing: SlideDeckSharing): Promise<SlideDeckSummary | { error: string }> {
    const d = await this.deps.store.get(viewer.tenantId, id);
    if (!d || d.userId !== viewer.userId) return { error: 'スライドが見つかりません' };
    let domain: string | null = null;
    if (sharing === 'company') {
      const got = await this.companyDomain(viewer);
      if ('reason' in got) return { error: got.reason };
      domain = got.domain;
    }
    const ok = await this.deps.connector.slides.share(viewer, d.presentationId, domain);
    if (!ok) return { error: 'スライドがドライブに見つかりませんでした（ドライブで削除されたかもしれません）' };
    const next = { ...d, sharing, updatedAt: new Date().toISOString() };
    await this.deps.store.save(next);
    return this.summary(next, viewer);
  }

  /**
   * PowerPoint の形で受け取る（第9.4.2節「Google スライドのテーマを使う・PowerPoint の取り出し」）。新しいタブを開かずに保存させるため、M2Office が Google から受け取る。
   * 本人の権限（`drive.file`）で読めないもの（ほかの人が会社で共有したもの）と、Google の書き出しの上限（10 MB）を超えたものは、Google の書き出しの道を返す。
   *
   * @returns 中身と名前、Google の書き出しの道（`fallback`）、またはできない理由
   */
  async exportPptx(viewer: SlideDeckViewer, id: string): Promise<{ bytes: Uint8Array; filename: string } | { fallback: string; reason: string } | { error: string }> {
    const d = await this.get(viewer, id);
    if (!d) return { error: 'スライドが見つかりません' };
    const links = slideDeckLinks(d.presentationId);
    if (!links.pptxUrl) return { error: '見本の接続口で作ったため、PowerPoint にできません' };
    if (d.userId !== viewer.userId) return { fallback: links.pptxUrl, reason: 'ほかの人のスライドは Google から取り出します' };
    const got = await this.deps.connector.slides.exportPptx(viewer, d.presentationId);
    if (got === null) return { error: 'スライドがドライブに見つかりませんでした（ドライブで削除されたかもしれません）' };
    if (got === 'too-large') return { fallback: links.pptxUrl, reason: '大きいため、Google から取り出します' };
    const name = d.title.replace(/[\\/:*?"<>|\n\r]/g, ' ').trim().slice(0, 80) || 'スライド';
    return { bytes: got, filename: `${name}.pptx` };
  }

  /**
   * 削除する（作った人だけ）。ファイルはドライブのごみ箱に移す（30 日は戻せる）。ドライブで先に消されていれば一覧からだけ消す。
   *
   * @returns できない理由。できれば `null`
   */
  async remove(viewer: SlideDeckViewer, id: string): Promise<string | null> {
    const d = await this.deps.store.get(viewer.tenantId, id);
    if (!d || d.userId !== viewer.userId) return 'スライドが見つかりません';
    if (!d.presentationId.startsWith('mock-')) {
      // 共有を外してからごみ箱へ（ごみ箱のファイルも共有の相手からは見えなくなるが、念のため外す）
      if (d.sharing === 'company') await this.deps.connector.slides.share(viewer, d.presentationId, null).catch(() => false);
      await this.deps.connector.slides.trash(viewer, d.presentationId);
    }
    await this.deps.store.remove(viewer.tenantId, id);
    return null;
  }
}
