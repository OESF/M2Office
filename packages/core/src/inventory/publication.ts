/**
 * @file 在庫の Web への公開（仕様書 第29.12節・第29.12.1節、段 5）。
 *
 * 何を公開するか（品目・分類と価格を出すか・数か状態か）を管理者が一度承認し、その範囲の数の変化は承認なしに流す。
 * 公開の中身は在庫が変わるたびに作り直して置いておき、埋め込みのページと公開のデータは置いたものだけを返す
 * （見る人が多くても在庫の表を直接読まない）。仕入れ値・ロット・場所・記録した人・内部のコード・予約した人は出さない。
 */

import { randomBytes, randomUUID } from 'node:crypto';
import {
  INVENTORY_PUBLICATION_MAX, INVENTORY_PUBLIC_STATUS_LABELS, type AuditEvent, type InventoryItemView, type InventoryPublication, type InventoryPublicationScope,
  type InventoryPublicField, type InventoryPublicRow, type InventoryPublicSnapshot,
} from '@m2office/shared';
import type { Repository } from '../repository/types.js';
import type { InventoryService } from './service.js';
import type { InventoryStore, PublicationRecord } from './store.js';

/** 公開の URL の鍵の形（base64url の 32 字）。形の違う鍵は引かずに断る。 */
export const PUBLICATION_KEY = /^[A-Za-z0-9_-]{32}$/;

/** 最初のまとまりの ID（重ねて作らないため決めておく）。 */
const FIRST_PUBLICATION_ID = 'p-first';

/** 続けて起きた変化を 1 回の作り直しにまとめる待ち時間（ミリ秒）。 */
const REFRESH_DEBOUNCE_MS = 1000;

/** 出せる項目。 */
const FIELDS: InventoryPublicField[] = ['category', 'price'];

/** 依存。 */
export interface InventoryPublisherDeps {
  store: InventoryStore;
  service: InventoryService;
  repo: Repository;
  logger?: { warn: (msg: string, meta?: Record<string, unknown>) => void };
}

/** 公開のまとまり 1 つの、画面に出すもの（管理者向け）。 */
export interface PublicationView {
  publication: InventoryPublication;
  /** 承認した品目のうち、いま止めている品目の数（出ていない）。 */
  stoppedInScope: number;
}

/**
 * 公開の中身を作る（純粋な関数）。
 *
 * @param views 品目の一覧（使える数と印つき。止めた品目は含めない）
 * @remarks 承認した品目だけを、一覧の並び（分類・名前）のまま出す。承認していない項目は行に入れない
 */
export function buildPublicSnapshot(views: InventoryItemView[], scope: InventoryPublicationScope, at: string): InventoryPublicSnapshot {
  const ids = new Set(scope.itemIds);
  const items: InventoryPublicRow[] = views.filter((v) => ids.has(v.id) && v.status === 'active').map((v) => {
    const status = v.available <= 0 ? 'out' : v.low ? 'low' : 'in';
    return {
      name: v.publicName.trim() || v.name,
      ...(scope.fields.includes('category') ? { category: v.category } : {}),
      ...(scope.fields.includes('price') && v.price !== null ? { price: v.price, priceTaxIncluded: v.priceTaxIncluded } : {}),
      ...(scope.showCount ? { available: Math.max(0, v.available), unit: v.unit } : {}),
      status,
    };
  });
  return { generatedAt: at, showCount: scope.showCount, items };
}

/** HTML に入れる文字を逃がす。 */
function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
}

/** 日本時間の「2026年10月1日 14:05」。 */
function jstTime(iso: string): string {
  const d = new Date(new Date(iso).getTime() + 9 * 3600_000);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}年${d.getUTCMonth() + 1}月${d.getUTCDate()}日 ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}`;
}

/**
 * 埋め込みのページ（他のサイトの iframe に入れる表）を作る。
 *
 * @param snapshot 作り直して置いた公開の中身。`null` なら「表示できません」
 * @remarks スクリプトを持たず、外のものを読まない。文字はすべて逃がす（品目の名前は会社が入れた文字）
 */
export function renderPublicPage(snapshot: InventoryPublicSnapshot | null): string {
  const head = `<!doctype html><html lang="ja"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex"><title>在庫の状況</title><style>
:root{--fg:#1f2328;--muted:#656d76;--line:#d0d7de;--in:#1a7f37;--low:#9a6700;--out:#cf222e;--bg:#fff}
body{margin:0;padding:12px;font:14px/1.5 -apple-system,BlinkMacSystemFont,"Hiragino Sans","Noto Sans JP",sans-serif;color:var(--fg);background:var(--bg)}
h2{font-size:13px;color:var(--muted);margin:14px 0 4px;font-weight:600}
table{width:100%;border-collapse:collapse}td{padding:6px 4px;border-bottom:1px solid var(--line);vertical-align:top}
td.n{text-align:right;white-space:nowrap}.s{white-space:nowrap;font-weight:600}.s.in{color:var(--in)}.s.low{color:var(--low)}.s.out{color:var(--out)}
.u{color:var(--muted);font-size:12px;margin-top:10px}p.none{color:var(--muted)}
</style></head><body>`;
  if (!snapshot) return `${head}<p class="none">表示できません</p></body></html>`;
  const groups = new Map<string, InventoryPublicRow[]>();
  for (const r of snapshot.items) {
    const k = r.category ?? '';
    groups.set(k, [...(groups.get(k) ?? []), r]);
  }
  const named = [...groups.keys()].some((k) => k);
  const row = (r: InventoryPublicRow) => {
    const price = r.price !== undefined ? `<td class="n">${esc(r.price.toLocaleString('ja-JP'))}円${r.priceTaxIncluded ? '（税込）' : '（税抜）'}</td>` : '';
    const count = r.available !== undefined ? `<td class="n">${esc(String(r.available))}${esc(r.unit ?? '')}</td>` : '';
    return `<tr><td>${esc(r.name)}</td>${price}${count}<td class="s ${r.status}">${INVENTORY_PUBLIC_STATUS_LABELS[r.status]}</td></tr>`;
  };
  const body = [...groups].map(([k, rows]) =>
    `${named ? `<h2>${esc(k || 'その他')}</h2>` : ''}<table>${rows.map(row).join('')}</table>`).join('');
  return `${head}${snapshot.items.length ? body : '<p class="none">公開している品目はありません</p>'}<p class="u">最終更新: ${jstTime(snapshot.generatedAt)}</p></body></html>`;
}

/**
 * 在庫の公開。まとまりの作成・名前の変更・承認・停止・削除、在庫が変わったときの作り直し、鍵での読み出しを受け持つ。
 *
 * @remarks 承認・停止・削除は管理者だけが呼べる（呼ぶ側の API で確かめる）。どれも監査ログに残す。
 * 1 社で {@link INVENTORY_PUBLICATION_MAX} 個までのまとまりを持ち、それぞれ別の URL で出す（第29.12.2節）
 */
export class InventoryPublisher {
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();

  constructor(private readonly deps: InventoryPublisherDeps) {}

  /** 公開できる会社か（在庫管理と「Web への公開」が入）。 */
  private async enabled(tenantId: string): Promise<boolean> {
    const s = (await this.deps.repo.getTenantSettings(tenantId)).inventory;
    return s.enabled && s.features.publish;
  }

  /**
   * 管理者に見せる、すべてのまとまり（作った順）。
   *
   * @param opts.ensureOne 1 つも無ければ、最初のまとまり（「公開 1」）を決まった ID で作る（「＋」を押さなくても始められるように）。
   * 同時に開いた画面が重ねて作らない
   */
  async list(tenantId: string, opts: { ensureOne?: boolean } = {}): Promise<PublicationView[]> {
    if (opts.ensureOne && (await this.deps.store.listPublications(tenantId)).length === 0) {
      await this.deps.store.createPublication(tenantId, { id: FIRST_PUBLICATION_ID, name: '公開 1', at: new Date().toISOString() });
    }
    const [rows, users, items] = await Promise.all([
      this.deps.store.listPublications(tenantId), this.deps.repo.listUsers(tenantId), this.deps.store.listItems(tenantId),
    ]);
    const active = new Set(items.map((i) => i.id));
    return rows.map((p) => toView(p, users, active));
  }

  /** 管理者に見せる、まとまり 1 つ。無ければ `null`。 */
  async view(tenantId: string, id: string): Promise<PublicationView | null> {
    const p = await this.deps.store.getPublication(tenantId, id);
    if (!p) return null;
    const [users, items] = await Promise.all([this.deps.repo.listUsers(tenantId), this.deps.store.listItems(tenantId)]);
    return toView(p, users, new Set(items.map((i) => i.id)));
  }

  /**
   * まとまりを足す（承認する前の形）。名前を省けば「公開 N」と付ける。
   *
   * @returns 足したまとまりか、足せない理由（数の上限）
   */
  async create(tenantId: string, name?: string): Promise<PublicationView | { error: string }> {
    const rows = await this.deps.store.listPublications(tenantId);
    if (rows.length >= INVENTORY_PUBLICATION_MAX) return { error: `公開は ${INVENTORY_PUBLICATION_MAX} つまでです` };
    const taken = new Set(rows.map((r) => r.name));
    let n = rows.length + 1;
    while (taken.has(`公開 ${n}`)) n++;
    const clean = cleanName(name);
    const id = `p-${randomBytes(6).toString('hex')}`;
    // 並びは作った順。同じ時刻に作っても順が入れ替わらないよう、前のまとまりより必ず後の時刻にする
    const last = rows.reduce((m, r) => Math.max(m, Date.parse(r.createdAt) || 0), 0);
    const at = new Date(Math.max(Date.now(), last + 1)).toISOString();
    await this.deps.store.createPublication(tenantId, { id, name: clean || `公開 ${n}`, at });
    return (await this.view(tenantId, id))!;
  }

  /** まとまりの名前を変える（公開のページには出さないので、承認し直さない）。 */
  async rename(tenantId: string, id: string, name: string): Promise<PublicationView | { error: string }> {
    const clean = cleanName(name);
    if (!clean) return { error: '名前を入れてください' };
    if (!(await this.deps.store.getPublication(tenantId, id))) return { error: '公開が見つかりません' };
    await this.deps.store.renamePublication(tenantId, id, clean);
    return (await this.view(tenantId, id))!;
  }

  /**
   * 承認する前の見本（承認の画面で、公開されるとおりに見せる）。
   *
   * @returns 中身が決まりに合わなければ理由
   */
  async preview(tenantId: string, scope: InventoryPublicationScope): Promise<InventoryPublicSnapshot | { error: string }> {
    const checked = await this.check(tenantId, scope);
    if ('error' in checked) return checked;
    return buildPublicSnapshot(await this.deps.service.list(tenantId), checked, new Date().toISOString());
  }

  /**
   * まとまりの中身を承認し、公開中にする（第29.12.1節）。押した管理者が承認者になる。
   *
   * @remarks 鍵は最初の承認のときに作り、承認し直しても変えない。監査ログに `inventory.publication.approve`
   */
  async approve(tenantId: string, userId: string, id: string, scope: InventoryPublicationScope): Promise<PublicationView | { error: string }> {
    if (!(await this.enabled(tenantId))) return { error: '会社の設定で「Web への公開」が切られています' };
    const prev = await this.deps.store.getPublication(tenantId, id);
    if (!prev) return { error: '公開が見つかりません' };
    const checked = await this.check(tenantId, scope);
    if ('error' in checked) return checked;
    const at = new Date().toISOString();
    await this.deps.store.approvePublication(tenantId, id, {
      key: prev.key ?? randomBytes(24).toString('base64url'), scope: checked, approvedBy: userId, approvedAt: at,
    });
    await this.audit(tenantId, userId, 'inventory.publication.approve', id, {
      name: prev.name, items: checked.itemIds.length, fields: checked.fields, showCount: checked.showCount, resumed: prev.status === 'stopped',
    });
    await this.refreshOne(tenantId, id);
    return (await this.view(tenantId, id))!;
  }

  /** まとまりの公開を止める。埋め込みのページは「表示できません」になる。監査ログに `inventory.publication.stop`。 */
  async stop(tenantId: string, userId: string, id: string): Promise<PublicationView | { error: string }> {
    const prev = await this.deps.store.getPublication(tenantId, id);
    if (!prev) return { error: '公開が見つかりません' };
    if (prev.status === 'live') {
      await this.deps.store.setPublicationStatus(tenantId, id, 'stopped');
      await this.audit(tenantId, userId, 'inventory.publication.stop', id, { name: prev.name });
    }
    return (await this.view(tenantId, id))!;
  }

  /**
   * まとまりを削除する。**止めてある（または承認する前の）まとまりだけ**。URL は 404 になり、元に戻せない。
   *
   * @remarks 監査ログに `inventory.publication.delete`
   */
  async remove(tenantId: string, userId: string, id: string): Promise<{ ok: true } | { error: string }> {
    const prev = await this.deps.store.getPublication(tenantId, id);
    if (!prev) return { error: '公開が見つかりません' };
    if (prev.status === 'live') return { error: '公開中のものは削除できません。先に止めてください' };
    await this.deps.store.deletePublication(tenantId, id);
    if (prev.status !== 'draft') await this.audit(tenantId, userId, 'inventory.publication.delete', id, { name: prev.name });
    return { ok: true };
  }

  /** 公開中のまとまりをすべて作り直す。公開を切った会社では何もしない。作り直した数を返す。 */
  async refresh(tenantId: string, now: Date = new Date()): Promise<number> {
    if (!(await this.enabled(tenantId))) return 0;
    const live = (await this.deps.store.listPublications(tenantId)).filter((p) => p.status === 'live' && p.scope);
    if (live.length === 0) return 0;
    const today = new Date(now.getTime() + 9 * 3600_000).toISOString().slice(0, 10);
    const views = await this.deps.service.list(tenantId, { today });
    for (const p of live) {
      await this.deps.store.savePublicationSnapshot(tenantId, p.id, buildPublicSnapshot(views, p.scope!, now.toISOString()), now.toISOString());
    }
    return live.length;
  }

  /** まとまり 1 つを作り直す（承認したとき）。 */
  private async refreshOne(tenantId: string, id: string, now: Date = new Date()): Promise<void> {
    const p = await this.deps.store.getPublication(tenantId, id);
    if (!p || p.status !== 'live' || !p.scope || !(await this.enabled(tenantId))) return;
    const today = new Date(now.getTime() + 9 * 3600_000).toISOString().slice(0, 10);
    const snapshot = buildPublicSnapshot(await this.deps.service.list(tenantId, { today }), p.scope, now.toISOString());
    await this.deps.store.savePublicationSnapshot(tenantId, id, snapshot, now.toISOString());
  }

  /**
   * 在庫が変わったことを受け取り、少し待ってから作り直す（続けて起きた変化を 1 回にまとめる）。
   *
   * @remarks 待たずに返す。作り直しの失敗は記録を止めない
   */
  changed(tenantId: string): void {
    const t = this.timers.get(tenantId);
    if (t) clearTimeout(t);
    this.timers.set(tenantId, setTimeout(() => {
      this.timers.delete(tenantId);
      this.refresh(tenantId).catch((err) => this.deps.logger?.warn('在庫の公開を作り直せませんでした', { tenantId, error: String(err) }));
    }, REFRESH_DEBOUNCE_MS));
  }

  /** すべての会社の公開を作り直す（日本時間の日付が変わったとき。使用期限を過ぎた数を外す）。作り直した会社の数を返す。 */
  async refreshAll(now: Date = new Date()): Promise<number> {
    let n = 0;
    for (const tenantId of await this.deps.repo.listTenantIds()) {
      try {
        if (await this.refresh(tenantId, now) > 0) n++;
      } catch (err) {
        this.deps.logger?.warn('在庫の公開を作り直せませんでした', { tenantId, error: String(err) });
      }
    }
    return n;
  }

  /**
   * 鍵から公開の中身を引く（ログインの無い人が読む）。
   *
   * @returns 鍵が違う・止めた・公開を切った会社は、どれも `null`（区別を返さない）
   */
  async byKey(key: string): Promise<InventoryPublicSnapshot | null> {
    if (!PUBLICATION_KEY.test(key)) return null;
    const p = await this.deps.store.findPublicationByKey(key);
    if (!p || p.status !== 'live' || !p.snapshot || !(await this.enabled(p.tenantId))) return null;
    return p.snapshot;
  }

  /** 公開の中身を確かめ、整える（知らない品目・止めた品目・知らない項目を除く）。 */
  private async check(tenantId: string, scope: InventoryPublicationScope): Promise<InventoryPublicationScope | { error: string }> {
    const active = new Set((await this.deps.store.listItems(tenantId)).map((i) => i.id));
    const itemIds = [...new Set(Array.isArray(scope?.itemIds) ? scope.itemIds : [])].filter((id) => typeof id === 'string' && active.has(id));
    if (itemIds.length === 0) return { error: '公開する品目を選んでください' };
    const fields = FIELDS.filter((f) => Array.isArray(scope.fields) && scope.fields.includes(f));
    return { itemIds, fields, showCount: scope.showCount === true };
  }

  private async audit(tenantId: string, userId: string, action: string, id: string, detail: Record<string, unknown>): Promise<void> {
    const ev: AuditEvent = {
      id: randomUUID(), tenantId, actorType: 'user', actorId: userId, action, targetType: 'inventory_publication', targetId: id,
      detail, occurredAt: new Date().toISOString(),
    };
    await this.deps.repo.appendAudit(ev);
  }
}

/** まとまりの名前を整える（40 字まで・改行なし）。 */
function cleanName(name: string | undefined): string {
  return [...(name ?? '').replace(/\s+/g, ' ').trim()].slice(0, 40).join('');
}

/** 置き場の行を、管理者に見せる形にする。 */
function toView(p: PublicationRecord, users: { id: string; displayName: string }[], active: Set<string>): PublicationView {
  return {
    publication: {
      id: p.id, name: p.name, scope: p.scope, approvedBy: p.approvedBy, approvedByName: users.find((u) => u.id === p.approvedBy)?.displayName,
      approvedAt: p.approvedAt, status: p.status, key: p.key, snapshotAt: p.snapshotAt,
    },
    stoppedInScope: (p.scope?.itemIds ?? []).filter((id) => !active.has(id)).length,
  };
}
