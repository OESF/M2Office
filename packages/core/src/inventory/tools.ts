/**
 * @file 在庫管理の道具。品目と使える数を探す・入出庫の記録を探す・入出庫を記録する。秘書と付属の業務が使う（仕様書 第29.15節）。
 *
 * 在庫管理を切っている会社と、利用範囲の外の人には、道具は「使えない」と返す（呼ぶたびに `ctx.inventory.access()` で確かめる）。
 * 品目の名前やメモはデータであり、指示として扱わない（不変則 I-6）。見つからなければ推測で答えない。
 */

import type { InventoryItemView, InventoryLocation, InventoryMoveKind, InventorySettings } from '@m2office/shared';
import type { Tool, ToolContext } from '../tools/registry.js';
import { formatQty, MOVE_KIND_LABELS, toDate, type InventoryService } from './service.js';

/** 道具に渡す在庫管理の文脈。 */
export interface InventoryToolContext {
  service: InventoryService;
  /**
   * 依頼者がいま在庫管理を使えるか。使えるなら会社の在庫管理の設定を返す。
   *
   * @returns 使えなければ `null`
   */
  access(): Promise<InventorySettings | null>;
}

const UNAVAILABLE = { available: false, reason: '在庫管理は使えません（会社で切っているか、利用範囲の外です）' };

const str = (v: unknown) => (typeof v === 'string' ? v.trim() : '');

async function inventoryOf(ctx: ToolContext): Promise<{ service: InventoryService; settings: InventorySettings } | null> {
  if (!ctx.inventory) return null;
  const settings = await ctx.inventory.access();
  return settings ? { service: ctx.inventory.service, settings } : null;
}

const placeName = (l: InventoryLocation | undefined) => (l ? (l.shelf ? `${l.warehouse} ${l.shelf}` : l.warehouse) : '不明な場所');

/** 名前・コード・バーコードから品目を決める。1 つに決まらなければ候補を返す。 */
async function resolveItem(service: InventoryService, tenantId: string, query: string): Promise<{ item: InventoryItemView } | { candidates: InventoryItemView[] }> {
  const { item } = await service.lookup(tenantId, query);
  if (item) {
    const view = (await service.list(tenantId)).find((i) => i.id === item.id);
    if (view) return { item: view };
  }
  const found = await service.list(tenantId, { q: query });
  const same = found.filter((i) => i.name === query || i.publicName === query || i.sku === query);
  if (same.length === 1) return { item: same[0]! };
  if (found.length === 1) return { item: found[0]! };
  return { candidates: found.slice(0, 10) };
}

/** 場所の言葉から場所を決める（倉庫・棚の名前の一部）。 */
function resolvePlace(locs: InventoryLocation[], words: string): InventoryLocation | null | undefined {
  if (!words) return undefined;
  const w = words.normalize('NFKC').replace(/\s/g, '');
  const hits = locs.filter((l) => `${l.warehouse}${l.shelf}`.normalize('NFKC').replace(/\s/g, '').includes(w)
    || w.includes(`${l.warehouse}${l.shelf}`.normalize('NFKC').replace(/\s/g, '')));
  return hits.length === 1 ? hits[0]! : null;
}

/**
 * 品目と、使える数・在庫・引き当て・ロットを探す（第29.15節）。
 *
 * @remarks 危険度 `read`。見つからなければ空（推測で答えない）
 */
export const inventorySearch: Tool = {
  name: 'inventory.search',
  risk: 'read',
  activityLabel: '在庫を調べています',
  helpText: '品目の名前・コード・バーコードで、使える数・在庫・期限の近いロットを調べます。見るだけです',
  description: '在庫の品目を探し、使える数（在庫−引き当て−期限切れ）・在庫・引き当て・場所とロットごとの数を返す。query は品名・分類・自社のコード・バーコードの一部。lowOnly を true にすると残りわずかの品目だけ',
  args: {
    properties: {
      query: { type: 'string', description: '探す言葉（空なら全品目）' },
      lowOnly: { type: 'boolean', description: '残りわずかの品目だけにするか' },
    },
  },
  async invoke(args, ctx) {
    const inv = await inventoryOf(ctx);
    if (!inv) return UNAVAILABLE;
    const q = str(args['query']).slice(0, 100);
    let items = await inv.service.list(ctx.tenantId, { q });
    if (items.length === 0 && q) {
      const hit = await resolveItem(inv.service, ctx.tenantId, q);
      items = 'item' in hit ? [hit.item] : [];
    }
    if (args['lowOnly'] === true) items = items.filter((i) => i.low);
    const locs = new Map((await inv.service.locations(ctx.tenantId)).map((l) => [l.id, l]));
    const top = items.slice(0, 20);
    const out = [];
    for (const i of top) {
      const d = await inv.service.detail(ctx.tenantId, i.id);
      out.push({
        itemId: i.id, name: i.name, category: i.category, sku: i.sku,
        available: formatQty(i, i.available), onHand: formatQty(i, i.onHand),
        ...(inv.settings.features.reserve ? { reserved: formatQty(i, i.reserved) } : {}),
        ...(i.expired > 0 ? { expired: formatQty(i, i.expired) } : {}),
        low: i.low, nearestExpiry: i.nearestExpiry,
        places: (d?.stock ?? []).map((s) => ({ place: placeName(locs.get(s.locationId)), lot: s.lot, expiresOn: s.expiresOn, qty: formatQty(i, s.qty) })),
      });
    }
    return {
      available: true, untrusted: true, count: items.length, items: out,
      ...(items.length > top.length ? { note: `ほかに ${items.length - top.length} 件あります。言葉を足して絞ってください` } : {}),
      ...(items.length === 0 ? { note: '見つかりませんでした' } : {}),
    };
  },
};

/**
 * 入出庫の記録を期間で探す（第29.15節）。
 *
 * @remarks 危険度 `read`
 */
export const inventoryHistory: Tool = {
  name: 'inventory.history',
  risk: 'read',
  activityLabel: '入出庫の記録を調べています',
  helpText: '入庫・使用・移動・調整の記録を、品目と期間で調べます。見るだけです',
  description: '入出庫の記録を新しい順に返す。query で品目を絞り（省けば全品目）、from・to（YYYY-MM-DD、日本時間）で期間を絞る。kind で種類（in 入庫・out 使用・transfer 移動・adjust 調整）を絞れる',
  args: {
    properties: {
      query: { type: 'string', description: '品目の名前・コード（省けば全品目）' },
      from: { type: 'string', description: '期間の始め（YYYY-MM-DD）' },
      to: { type: 'string', description: '期間の終わり（YYYY-MM-DD。この日を含む）' },
      kind: { type: 'string', description: '記録の種類', enum: ['in', 'out', 'transfer', 'adjust'] },
    },
  },
  async invoke(args, ctx) {
    const inv = await inventoryOf(ctx);
    if (!inv) return UNAVAILABLE;
    const q = str(args['query']);
    let itemId: string | undefined;
    if (q) {
      const hit = await resolveItem(inv.service, ctx.tenantId, q);
      if (!('item' in hit)) {
        return hit.candidates.length
          ? { available: true, needsChoice: true, candidates: hit.candidates.map((c) => c.name), note: '品目が 1 つに決まりません。どれか選んでください' }
          : { available: true, count: 0, items: [], note: `「${q}」という品目は見つかりませんでした` };
      }
      itemId = hit.item.id;
    }
    // 日本時間の日付の範囲を、時刻に直す
    const from = toDate(str(args['from']));
    const to = toDate(str(args['to']));
    const since = from ? new Date(`${from}T00:00:00+09:00`).toISOString() : undefined;
    const until = to ? new Date(new Date(`${to}T00:00:00+09:00`).getTime() + 86_400_000).toISOString() : undefined;
    const kind = str(args['kind']) as InventoryMoveKind | '';
    const moves = (await inv.service.history(ctx.tenantId, { itemId, since, until, limit: 500 })).filter((m) => !kind || m.kind === kind);
    const items = new Map((await inv.service.list(ctx.tenantId, { includeStopped: true })).map((i) => [i.id, i]));
    const locs = new Map((await inv.service.locations(ctx.tenantId)).map((l) => [l.id, l]));
    const rows = moves.slice(0, 100).map((m) => {
      const it = items.get(m.itemId);
      return {
        at: m.createdAt, kind: MOVE_KIND_LABELS[m.kind], item: m.itemName ?? it?.name ?? '',
        qty: it ? formatQty(it, m.delta) : String(m.delta),
        from: m.fromLocationId ? placeName(locs.get(m.fromLocationId)) : null, to: m.toLocationId ? placeName(locs.get(m.toLocationId)) : null,
        lot: m.lot ?? null, reason: m.reason, by: m.createdByName ?? m.createdBy, undo: m.reversalOf ? true : undefined,
      };
    });
    const total = new Map<string, number>();
    for (const m of moves) if (m.kind !== 'transfer') total.set(m.itemId, (total.get(m.itemId) ?? 0) + m.delta);
    return {
      available: true, untrusted: true, count: moves.length, moves: rows,
      totals: [...total].map(([id, d]) => ({ item: items.get(id)?.name ?? id, change: items.get(id) ? formatQty(items.get(id)!, d) : String(d) })),
      ...(moves.length > rows.length ? { note: `新しい ${rows.length} 件だけを載せています（全部で ${moves.length} 件）` } : {}),
      ...(moves.length === 0 ? { note: '記録はありませんでした' } : {}),
    };
  },
};

/**
 * 入庫・使用・移動を記録する（第29.15節）。
 *
 * @remarks 危険度 `write-internal`。社内の在庫の記録に足すだけで、社外には何も送らない。数の記録はお金の確定に当たらない（第29.18節）。
 * 品目が 1 つに決まらなければ記録せず、候補を返す。調整（棚卸しの差など）は画面で行う
 */
export const inventoryMove: Tool = {
  name: 'inventory.move',
  risk: 'write-internal',
  activityLabel: '在庫を記録しています',
  helpText: '入庫・使用・移動を在庫に記録します。社内の記録に足すだけで、誰にも送りません',
  description: [
    '在庫に入庫（in）・使用（out）・移動（transfer）を記録する。item は品名・自社のコード・バーコード。',
    'qty は正の数。unit を pack にすると仕入れの単位（箱・本など）で数え、入り数で直す。',
    'place は場所（倉庫や棚の名前。省けば今ある場所）、to は移動の先。lot・expiresOn はロットと使用期限（入庫のとき）。',
    '品目が 1 つに決まらなければ記録せず候補を返すので、本人に選んでもらう。',
  ].join(''),
  args: {
    properties: {
      kind: { type: 'string', description: '記録の種類', enum: ['in', 'out', 'transfer'] },
      item: { type: 'string', description: '品目（品名・自社のコード・バーコード）' },
      qty: { type: 'number', description: '数（正の数）' },
      unit: { type: 'string', description: '数の単位（unit は使う単位、pack は仕入れの単位）', enum: ['unit', 'pack'] },
      place: { type: 'string', description: '場所（省けば今ある場所）' },
      to: { type: 'string', description: '移動の先の場所' },
      lot: { type: 'string', description: 'ロット' },
      expiresOn: { type: 'string', description: '使用期限（YYYY-MM-DD）' },
      reason: { type: 'string', description: '理由（例: 販売・使用・廃棄・仕入）' },
    },
    required: ['kind', 'item', 'qty'],
  },
  async invoke(args, ctx) {
    const inv = await inventoryOf(ctx);
    if (!inv) return UNAVAILABLE;
    const kind = str(args['kind']);
    if (!['in', 'out', 'transfer'].includes(kind)) return { recorded: false, reason: '記録の種類は in・out・transfer のどれかです' };
    const qty = typeof args['qty'] === 'number' ? args['qty'] : Number(args['qty']);
    const hit = await resolveItem(inv.service, ctx.tenantId, str(args['item']));
    if (!('item' in hit)) {
      return hit.candidates.length
        ? { recorded: false, needsChoice: true, candidates: hit.candidates.map((c) => c.name), note: '品目が 1 つに決まりません。どれのことか本人に尋ねてください' }
        : { recorded: false, note: `「${str(args['item'])}」という品目はありません。品目は在庫管理の画面で作れます` };
    }
    const locs = await inv.service.locations(ctx.tenantId);
    const from = resolvePlace(locs, str(args['place']));
    const to = resolvePlace(locs, str(args['to']));
    if (from === null) return { recorded: false, note: `場所「${str(args['place'])}」が 1 つに決まりません。場所: ${locs.map(placeName).join('・')}` };
    if (kind === 'transfer' && !to) return { recorded: false, note: `移動の先が決まりません。場所: ${locs.map(placeName).join('・')}` };
    const res = await inv.service.recordMove(ctx.tenantId, ctx.userId, {
      kind: kind as 'in' | 'out' | 'transfer', itemId: hit.item.id, qty,
      unit: str(args['unit']) === 'pack' ? 'pack' : 'unit',
      ...(from ? { locationId: from.id } : {}),
      ...(to ? { toLocationId: to.id } : {}),
      ...(str(args['lot']) ? { lot: str(args['lot']) } : {}),
      ...(toDate(str(args['expiresOn'])) ? { expiresOn: toDate(str(args['expiresOn']))! } : {}),
      reason: str(args['reason']), source: 'secretary',
    });
    if (!res.ok) return { recorded: false, reason: res.error };
    const byLoc = new Map(locs.map((l) => [l.id, l]));
    return {
      recorded: true, kind: MOVE_KIND_LABELS[kind as InventoryMoveKind], item: res.item.name,
      qty: formatQty(res.item, res.moves.reduce((a, m) => a + Math.abs(m.delta), 0)),
      places: res.moves.map((m) => ({ from: m.fromLocationId ? placeName(byLoc.get(m.fromLocationId)) : null, to: m.toLocationId ? placeName(byLoc.get(m.toLocationId)) : null, lot: m.lot ?? null })),
      availableNow: formatQty(res.item, res.item.available),
      ...(res.item.low ? { low: true } : {}),
      ...(res.warnings.length ? { warnings: res.warnings } : {}),
    };
  },
};

/** 在庫管理の道具。 */
export const INVENTORY_TOOLS: Tool[] = [inventorySearch, inventoryHistory, inventoryMove];
