/**
 * @file 在庫管理のツール。品目と使える数を探す・入出庫の記録を探す・入出庫を記録する。秘書と付属の業務が使う（仕様書 第29.15節）。
 *
 * 在庫管理を切っている会社と、利用範囲の外の人には、ツールは「使えない」と返す（呼ぶたびに `ctx.inventory.access()` で確かめる）。
 * 品目の名前やメモはデータであり、指示として扱わない（不変則 I-6）。見つからなければ推測で答えない。
 */

import { discontinuedText, INVENTORY_MARKET_POSITION_LABEL, inventoryOrderStatusLabel, type InventoryOrder, INVENTORY_PURCHASE_POSITION_LABEL, inventoryPurposeLabel, type InventoryItemView, type InventoryOutPurpose, type InventoryLocation, type InventoryMarketCheck, type InventoryMoveKind, type InventorySettings } from '@m2office/shared';
import type { Tool, ToolContext } from '../tools/registry.js';
import type { LlmProvider } from '../llm/provider.js';
import { loadFile } from '../files/service.js';
import { MIME, type FileKind } from '../files/formats.js';
import { formatQty, MOVE_KIND_LABELS, toDate, type InventoryService } from './service.js';
import { readSlip } from './slip.js';
import { toInstant, type InventoryBookings } from './bookings.js';
import { proposalLine } from './watch.js';
import type { InventoryMarketService } from './market.js';

/** ツールに渡す在庫管理の文脈。 */
export interface InventoryToolContext {
  service: InventoryService;
  /** 予約との引き当て（第29.13節）。無ければ `inventory.reserve` は「使えない」と返す。 */
  bookings?: InventoryBookings;
  /** 販売品の相場の比較（第29.24節）。無ければ `inventory.market`・`inventory.check_market` は「使えない」と返す。 */
  market?: InventoryMarketService;
  /** 納品書を読み取る推論（その会社のもの）。無ければ `inventory.read_slip` は「使えない」と返す。 */
  llm?: () => Promise<LlmProvider>;
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
        lot: m.lot ?? null, ...(m.purpose ? { purpose: inventoryPurposeLabel(m.purpose) } : {}), reason: m.reason, by: m.createdByName ?? m.createdBy, undo: m.reversalOf ? true : undefined,
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
  helpText: '入庫・出庫・移動を在庫に記録します。社内の記録に足すだけで、誰にも送りません',
  description: [
    '在庫に入庫（in）・出庫（out）・移動（transfer）を記録する。item は品名・自社のコード・バーコード。',
    '出庫では purpose に用途を入れる: 売った・販売した → sale、使った・社内で使う → internal、捨てた・期限切れ・壊れた → disposal、どれでもない → other。本人の言葉から決め、確かめない。言葉から分からなければ省く（品目の既定になる）。',
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
      purpose: { type: 'string', description: '出庫の用途（sale 販売・internal 社内消費・disposal 廃棄・other その他）', enum: ['sale', 'internal', 'disposal', 'other'] },
      reason: { type: 'string', description: 'メモ（任意。用途で足りれば入れない）' },
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
      ...(kind === 'out' && ['sale', 'internal', 'disposal', 'other'].includes(str(args['purpose'])) ? { purpose: str(args['purpose']) as InventoryOutPurpose } : {}),
      reason: str(args['reason']), source: 'secretary',
    });
    if (!res.ok) return { recorded: false, reason: res.error };
    const byLoc = new Map(locs.map((l) => [l.id, l]));
    return {
      recorded: true, kind: MOVE_KIND_LABELS[kind as InventoryMoveKind], item: res.item.name,
      ...(res.moves[0]?.purpose ? { purpose: inventoryPurposeLabel(res.moves[0].purpose) } : {}),
      qty: formatQty(res.item, res.moves.reduce((a, m) => a + Math.abs(m.delta), 0)),
      places: res.moves.map((m) => ({ from: m.fromLocationId ? placeName(byLoc.get(m.fromLocationId)) : null, to: m.toLocationId ? placeName(byLoc.get(m.toLocationId)) : null, lot: m.lot ?? null })),
      availableNow: formatQty(res.item, res.item.available),
      ...(res.item.low ? { low: true } : {}),
      ...(res.warnings.length ? { warnings: res.warnings } : {}),
    };
  },
};

/**
 * 見張りの結果（第29.14節）。無くなる見込みの早い順・残りわずか・使用期限の近いものと、発注の案（仕入先と発注の方法・連絡先）。
 *
 * @remarks 危険度 `read`。推論を使わない決まった計算。発注はしない（発注のメールは付属の業務「発注の下書き」が承認のあとに送る）
 */
export const inventoryForecast: Tool = {
  name: 'inventory.forecast',
  risk: 'read',
  activityLabel: '足りなくなりそうなものを調べています',
  helpText: '在庫の使う速さから、あと何日で無くなるか・残りわずか・使用期限の近いものと、発注の案を出します。見るだけです',
  description: '在庫の見張りの結果を急ぐ順に返す。各品目に、使える数・1 日に使う数・あと何日で無くなるか・仕入れにかかる日数・使用期限の近いロット・発注の案（数・仕入先・発注の方法 mail/web/phone・連絡先・理由）。query で品目を絞れる。all を true にすると足りている品目も返す',
  args: {
    properties: {
      query: { type: 'string', description: '品目の名前の一部（省けば全品目）' },
      all: { type: 'boolean', description: '足りている品目も返すか' },
    },
  },
  async invoke(args, ctx) {
    const inv = await inventoryOf(ctx);
    if (!inv) return UNAVAILABLE;
    const q = str(args['query']).normalize('NFKC').toLowerCase();
    const rows = (await inv.service.forecast(ctx.tenantId))
      .filter((r) => (args['all'] === true || r.runningOut || r.low || r.expiring.length > 0) && (!q || r.name.normalize('NFKC').toLowerCase().includes(q)))
      .slice(0, 30);
    return {
      available: true, untrusted: true, count: rows.length,
      items: rows.map((r) => ({
        itemId: r.itemId, name: r.name, available: formatQty(r, r.available), dailyUse: `${r.dailyUse} ${r.unit}`,
        daysLeft: r.daysLeft, leadDays: r.leadDays, low: r.low, runningOut: r.runningOut,
        ...(r.forecastNote ? { forecast: r.forecastNote } : {}),
        ...(r.weekdayNote ? { weekday: r.weekdayNote } : {}),
        ...(r.onOrder ? { onOrder: formatQty(r, r.onOrder), onOrderDue: r.onOrderDue ?? null } : {}),
        ...(r.discontinued ? { discontinued: discontinuedText(r.discontinued) } : {}),
        expiring: r.expiring.map((e) => ({ lot: e.lot, expiresOn: e.expiresOn, qty: formatQty(r, e.qty), days: e.days })),
        proposal: r.proposal ? {
          text: proposalLine(r), qty: r.proposal.qty, packs: r.proposal.packs, unit: r.unit, packUnit: r.packUnit,
          supplier: r.proposal.supplierName, method: r.proposal.method, contact: r.proposal.contact, reason: r.proposal.reason,
        } : null,
      })),
      ...(rows.length === 0 ? { note: '足りなくなりそうなもの・期限の近いものはありません' } : {}),
    };
  },
};

/** ツールが受け取ったファイルを、納品書として読める形にする。 */
async function slipFile(ctx: ToolContext, fileId: string): Promise<{ bytes: Uint8Array; mimeType: string; id: string } | { error: string }> {
  const f = await loadFile(ctx.repo, ctx.files, ctx.tenantId, fileId, { id: ctx.userId, roles: [] });
  if (!f) return { error: 'ファイルが見つかりません' };
  const kind = f.meta.kind as FileKind;
  if (!['png', 'jpeg', 'webp', 'heic', 'pdf'].includes(kind)) return { error: `納品書の画像か PDF ではありません: ${kind}` };
  return { bytes: f.bytes, mimeType: MIME[kind], id: f.meta.id };
}

/**
 * 納品書の画像・PDF から、行ごとの品名・品番・数・ロット・使用期限を取り出す（第29.15節）。
 *
 * @remarks 危険度 `read`。入庫はしない（入庫は `inventory.receive_slip`）。金額は読まない。読み取りは推論であり確かな値ではない
 */
export const inventoryReadSlip: Tool = {
  name: 'inventory.read_slip',
  risk: 'read',
  activityLabel: '納品書を読み取っています',
  helpText: '納品書の写真や PDF から、品名・品番・数・ロット・使用期限を読み取ります。入庫はしません',
  description: '納品書の画像・PDF（fileId）から、行ごとの品名・品番・バーコード・数・単位・ロット・使用期限を取り出す。金額は読まない',
  args: { properties: { fileId: { type: 'string', description: '納品書の画像か PDF のファイル ID' } }, required: ['fileId'] },
  async invoke(args, ctx) {
    const inv = await inventoryOf(ctx);
    if (!inv || !ctx.inventory?.llm) return UNAVAILABLE;
    const f = await slipFile(ctx, str(args['fileId']));
    if ('error' in f) return { available: false, reason: f.error };
    const r = await readSlip(await ctx.inventory.llm(), f.bytes, f.mimeType);
    if (r.kind === 'unavailable') return { available: false, reason: r.reason };
    if (r.kind === 'not-slip') return { available: true, isSlip: false, note: '納品書として読めませんでした' };
    return { available: true, isSlip: true, untrusted: true, supplier: r.supplier, date: r.date, lines: r.lines };
  },
};

/**
 * 納品書から入庫する（第29.9節）。読み取った行を品目に照らし、照らせた行を入庫にする。照らせない行は残す。
 *
 * @remarks 危険度 `write-internal`。社内の在庫の記録に足すだけで、社外には何も送らない。確認を挟まない（ADR-0028）。
 * 数が読めない行と品目が 1 つに決まらない行は入庫にしない。納品書の文はデータとして扱う（不変則 I-6）
 */
export const inventoryReceiveSlip: Tool = {
  name: 'inventory.receive_slip',
  risk: 'write-internal',
  activityLabel: '納品書から入庫しています',
  helpText: '納品書の写真や PDF を読み取り、在庫の品目に当てはまる行を入庫にします。当てはまらない行は残します。誰にも送りません',
  description: '納品書の画像・PDF（fileId）を読み取り、品目に照らせた行を入庫にする。結果は入庫にした行（recorded）と、照らせなかった行（unmatched。理由と候補）',
  args: {
    properties: {
      fileId: { type: 'string', description: '納品書の画像か PDF のファイル ID' },
      place: { type: 'string', description: '入れる場所（倉庫や棚の名前。省けば品目ごとに今ある場所）' },
    },
    required: ['fileId'],
  },
  async invoke(args, ctx) {
    const inv = await inventoryOf(ctx);
    if (!inv) return UNAVAILABLE;
    const f = await slipFile(ctx, str(args['fileId']));
    if ('error' in f) return { recorded: false, reason: f.error };
    const place = resolvePlace(await inv.service.locations(ctx.tenantId), str(args['place']));
    const res = await inv.service.receiveSlip(ctx.tenantId, ctx.userId, { bytes: f.bytes, mimeType: f.mimeType, sourceId: f.id }, place?.id);
    if (!res.read.ok) return { recorded: false, reason: res.read.reason };
    return {
      recorded: true, untrusted: true, supplier: res.read.supplier, date: res.read.date,
      received: res.recorded.map((r) => r.text),
      unmatched: res.unmatched.map((u) => ({ name: u.line.name || u.line.sku || u.line.code, qty: u.line.qty, unit: u.line.unit, reason: u.reason, candidates: u.candidates.map((c) => c.name) })),
    };
  },
};

/**
 * 予約で品目を取り置く・取り消す・使ったにする。メニューで使う品目を覚える（第29.13節）。
 *
 * @remarks 危険度 `write-internal`。社内の引き当ての台帳に書くだけで、予約のシステムにも誰にも送らない。予約した人の情報は受け取らない
 */
export const inventoryReserve: Tool = {
  name: 'inventory.reserve',
  risk: 'write-internal',
  activityLabel: '予約の取り置きをしています',
  helpText: '予約に合わせて品目を取り置き（使える数だけを減らす）、取り消し・使ったにし、メニューで使う品目を覚えます。誰にも送りません',
  description: [
    'action=hold: 品目（item）を数（qty）だけ、予約の日時（when。ISO 8601 か「2026-09-30 10:00」の形。今日の日付から計算）に取り置く。予約番号（booking）があれば入れる。',
    'action=cancel / use: 予約番号（booking）の取り置きを取り消す・使ったにする（使用の記録を足す）。',
    'action=teach: 予約のメニュー（menu）で使う品目（item）と数（qty）を覚える。在庫を使わないメニューなら item を空にする。',
    '予約した人の名前は入れない。',
  ].join(''),
  args: {
    properties: {
      action: { type: 'string', description: 'hold・cancel・use・teach', enum: ['hold', 'cancel', 'use', 'teach'] },
      item: { type: 'string', description: '品目（品名・自社のコード・バーコード）' },
      qty: { type: 'number', description: '数（使う単位）' },
      when: { type: 'string', description: '予約の日時' },
      booking: { type: 'string', description: '予約番号' },
      menu: { type: 'string', description: '予約のメニュー（コース・施術・プラン）の名前' },
    },
    required: ['action'],
  },
  async invoke(args, ctx) {
    const inv = await inventoryOf(ctx);
    if (!inv || !ctx.inventory?.bookings) return UNAVAILABLE;
    if (!inv.settings.features.reserve) return { done: false, reason: '予約との引き当てを使っていません（管理者ページの拡張機能の在庫管理で入れられます）' };
    const bookings = ctx.inventory.bookings;
    const action = str(args['action']);
    const findItem = async (): Promise<{ item: InventoryItemView } | { candidates: string[] }> => {
      const hit = await resolveItem(inv.service, ctx.tenantId, str(args['item']));
      return 'item' in hit ? { item: hit.item } : { candidates: hit.candidates.map((c) => c.name) };
    };
    if (action === 'hold') {
      const found = await findItem();
      if (!('item' in found)) return { done: false, needsChoice: found.candidates.length > 0, candidates: found.candidates, note: '品目が 1 つに決まりません。どれか本人に尋ねてください' };
      const qty = typeof args['qty'] === 'number' ? args['qty'] : Number(args['qty'] ?? 1);
      const res = await bookings.hold(ctx.tenantId, ctx.userId, {
        itemId: found.item.id, qty, startsAt: toInstant(str(args['when'])), externalId: str(args['booking']) || undefined,
        menu: str(args['menu']) || undefined, source: 'secretary',
      });
      if ('error' in res) return { done: false, reason: res.error };
      const [view] = (await inv.service.list(ctx.tenantId)).filter((i) => i.id === found.item.id);
      return { done: true, booking: res.externalId, when: res.startsAt, item: found.item.name, qty: formatQty(found.item, qty), availableNow: view ? formatQty(view, view.available) : null };
    }
    if (action === 'cancel' || action === 'use') {
      const ref = str(args['booking']);
      const b = (await bookings.list(ctx.tenantId, { limit: 1000 })).find((x) => x.externalId === ref && x.status === 'booked');
      if (!b) return { done: false, reason: `予約番号「${ref}」の取り置きが見つかりません` };
      const res = action === 'use' ? await bookings.consume(ctx.tenantId, ctx.userId, b.id) : await bookings.cancel(ctx.tenantId, b.id);
      if ('error' in res) return { done: false, reason: res.error };
      return { done: true, booking: ref, action: action === 'use' ? '使った' : '取り消した' };
    }
    if (action === 'teach') {
      const menu = str(args['menu']);
      if (!menu) return { done: false, reason: 'メニューの名前を入れてください' };
      if (!str(args['item'])) {
        const n = await bookings.teachMenu(ctx.tenantId, ctx.userId, menu, []);
        return { done: true, menu, note: '在庫を使わないメニューとして覚えました', applied: n };
      }
      const found = await findItem();
      if (!('item' in found)) return { done: false, needsChoice: found.candidates.length > 0, candidates: found.candidates };
      const qty = typeof args['qty'] === 'number' ? args['qty'] : Number(args['qty'] ?? 1);
      const n = await bookings.teachMenu(ctx.tenantId, ctx.userId, menu, [{ itemId: found.item.id, qty: qty > 0 ? qty : 1 }]);
      return { done: true, menu, item: found.item.name, qty, applied: n };
    }
    return { done: false, reason: 'action は hold・cancel・use・teach のどれかです' };
  },
};

/** 在庫管理のツール。 */
/** 頼んだ人が管理者か（仕入れの相場を答えてよいか。第29.6.2節）。 */
async function isAdminUser(ctx: ToolContext): Promise<boolean> {
  return (await ctx.repo.listUsers(ctx.tenantId)).some((u) => u.id === ctx.userId && u.roles.includes('admin'));
}

/** 相場の結果を秘書に渡す形（出典は安い順に 3 件まで）。 */
const marketView = (name: string, c: InventoryMarketCheck) => ({
  name, kind: c.kind ?? 'sale', status: c.status, ourPrice: c.ourPrice, median: c.median, min: c.min, max: c.max, diffPct: c.diffPct,
  position: c.position ? (c.kind === 'purchase' ? INVENTORY_PURCHASE_POSITION_LABEL : INVENTORY_MARKET_POSITION_LABEL)[c.position] : null, comment: c.comment, checkedAt: c.checkedAt.slice(0, 10),
  sources: c.sources.slice().sort((a, b) => a.price - b.price).slice(0, 3).map((s) => ({ shop: s.shop, price: s.price, url: s.url, competitor: s.from === 'competitor' })),
});

/**
 * 販売品の相場を、覚えている結果から答える（第29.24節）。
 *
 * @remarks 危険度 `read`。価格は変えない。調べていない品目は「まだ調べていない」と返す（推測で答えない）
 */
export const inventoryMarket: Tool = {
  name: 'inventory.market',
  risk: 'read',
  activityLabel: '販売品の相場を見ています',
  helpText: '販売品について、調べてある相場（中央値・最安・最高）と自社の価格との差を答えます。見るだけです',
  description: '販売品の相場の結果（自社の価格・相場の中央値・最安と最高・差・位置（安め・相場並み・高め）・出典）を返す。query は品名の一部（空なら全販売品）。position で high（高め）・low（安め）・fair（相場並み）に絞れる。kind を purchase にすると仕入れの相場（頼んだ人が在庫管理の管理者のときだけ）',
  args: {
    properties: {
      query: { type: 'string', description: '品名の一部（空なら全販売品）' },
      position: { type: 'string', description: 'high・low・fair のどれかで絞る（任意）' },
      kind: { type: 'string', description: 'sale（販売価格の相場。既定）か purchase（仕入れの相場）' },
    },
  },
  async invoke(args, ctx) {
    const inv = await inventoryOf(ctx);
    if (!inv || !ctx.inventory?.market) return UNAVAILABLE;
    if (inv.settings.features.market === false) return { available: false, reason: '相場の比較は、在庫の設定で切られています' };
    const q = str(args['query']).slice(0, 100);
    const kind = str(args['kind']) === 'purchase' ? 'purchase' : 'sale';
    // 仕入れの相場は自社の仕入価格を含むため、頼んだ人が管理者のときだけ答える（第29.6.2節）
    if (kind === 'purchase' && !(await isAdminUser(ctx))) return { available: false, reason: '仕入れの相場は、在庫管理を使える管理者だけが見られます' };
    const items = (await inv.service.list(ctx.tenantId, { q })).filter((i) => kind === 'purchase' ? i.purchasePrice !== null && i.purchasePrice !== undefined : i.kind === 'sale');
    const latest = new Map((await ctx.inventory.market.latest(ctx.tenantId, kind)).map((c) => [c.itemId, c]));
    const pos = str(args['position']);
    const rows = items.map((i) => ({ i, c: latest.get(i.id) }))
      .filter((x) => !pos || x.c?.position === pos).slice(0, 20)
      .map(({ i, c }) => (c ? marketView(i.name, c) : { name: i.name, status: 'unchecked', comment: 'まだ調べていません' }));
    return { available: true, untrusted: true, count: rows.length, items: rows, ...(rows.length === 0 ? { note: '当たる販売品はありません' } : {}) };
  },
};

/**
 * 販売品の相場をいま調べる（第29.24節）。
 *
 * @remarks 危険度 `read`（価格は変えない。外へ渡すのは商品の名前とバーコードだけ）。1 回に 3 品目まで
 */
export const inventoryCheckMarket: Tool = {
  name: 'inventory.check_market',
  risk: 'read',
  activityLabel: '販売品の相場を調べています',
  helpText: '販売品の相場を Web で調べ、自社の価格と比べます。外に渡すのは商品の名前とバーコードだけで、価格は変えません',
  description: '販売品の相場をいま調べる。query は品名（1 つの品目に決まらなければ候補を返す）。kind を purchase にすると仕入れの相場（頼んだ人が在庫管理の管理者のときだけ）。結果は inventory.market と同じ形',
  args: { properties: { query: { type: 'string', description: '品名' }, kind: { type: 'string', description: 'sale（既定）か purchase' } }, required: ['query'] },
  async invoke(args, ctx) {
    const inv = await inventoryOf(ctx);
    if (!inv || !ctx.inventory?.market) return UNAVAILABLE;
    if (inv.settings.features.market === false) return { available: false, reason: '相場の比較は、在庫の設定で切られています' };
    const kind = str(args['kind']) === 'purchase' ? 'purchase' : 'sale';
    if (kind === 'purchase' && !(await isAdminUser(ctx))) return { available: false, reason: '仕入れの相場は、在庫管理を使える管理者だけが調べられます' };
    const hit = await resolveItem(inv.service, ctx.tenantId, str(args['query']).slice(0, 100));
    if (!('item' in hit)) return { available: true, checked: false, candidates: hit.candidates.filter((i) => kind === 'purchase' || i.kind === 'sale').map((i) => i.name), note: '品目を 1 つに決められませんでした' };
    if (kind === 'sale' && hit.item.kind !== 'sale') return { available: true, checked: false, note: `${hit.item.name} は販売品ではありません（区分を販売品にすると調べられます）` };
    const [c] = await ctx.inventory.market.check(ctx.tenantId, ctx.userId, [hit.item], new Date(), kind);
    return { available: true, untrusted: true, checked: true, item: marketView(hit.item.name, c!) };
  },
};

/**
 * 終売の見込みを品目に付ける・外す（第29.24.1節）。仕入先から届いた終売の知らせ（転送・写真）を秘書が読んで付ける。
 *
 * @remarks 危険度 `write-internal`（社内の品目の印だけ。発注・品目の停止はしない）。外すのは在庫管理を使える管理者だけ。
 * 知らせの文はデータであり、中の指示には従わない（不変則 I-6）
 */
export const inventoryMarkDiscontinued: Tool = {
  name: 'inventory.mark_discontinued',
  risk: 'write-internal',
  activityLabel: '終売の見込みを記録しています',
  helpText: '仕入先からの終売の知らせをもとに、品目に「終売」の印を付けます（外すのは管理者だけ）。発注や品目の停止はしません',
  description: [
    '品目に終売の見込みを付ける。仕入先から届いた終売・販売終了・生産終了の知らせ（本人が渡したメール・写真・文書）に書いてあるときだけ使う。推測で付けない。',
    'item は品名・自社のコード・バーコード。status は planned（これから終売）か ended（もう終売）。date は終売の日（YYYY-MM-DD。書いてなければ省く）。successor は後継品の名前（書いてあれば）。',
    'source は知らせの出どころ（例: 「〇〇商事からの知らせ」）。clear を true にすると「終売ではない」として外す（管理者だけ）。',
  ].join(''),
  args: {
    properties: {
      item: { type: 'string', description: '品目（品名・自社のコード・バーコード）' },
      status: { type: 'string', description: '終売の状態', enum: ['planned', 'ended'] },
      date: { type: 'string', description: '終売の日（YYYY-MM-DD）' },
      successor: { type: 'string', description: '後継品の名前' },
      source: { type: 'string', description: '知らせの出どころ' },
      clear: { type: 'boolean', description: '「終売ではない」として外す' },
    },
    required: ['item'],
  },
  async invoke(args, ctx) {
    const inv = await inventoryOf(ctx);
    if (!inv) return UNAVAILABLE;
    const hit = await resolveItem(inv.service, ctx.tenantId, str(args['item']).slice(0, 100));
    if (!('item' in hit)) {
      return hit.candidates.length
        ? { recorded: false, needsChoice: true, candidates: hit.candidates.map((c) => c.name), note: '品目が 1 つに決まりません。どれのことか本人に尋ねてください' }
        : { recorded: false, note: `「${str(args['item'])}」という品目はありません` };
    }
    if (args['clear'] === true) {
      if (!(await isAdminUser(ctx))) return { recorded: false, note: '終売の印を外せるのは、在庫管理を使える管理者だけです' };
      const r = await inv.service.dismissDiscontinued(ctx.tenantId, ctx.userId, hit.item.id);
      return 'error' in r ? { recorded: false, note: r.error } : { recorded: true, item: hit.item.name, cleared: true };
    }
    const status = str(args['status']) === 'ended' ? 'ended' : 'planned';
    const date = toDate(str(args['date']));
    const d = {
      status, date: date ?? null, successor: str(args['successor']).slice(0, 60), url: '',
      source: (str(args['source']) || '仕入先からの知らせ').slice(0, 60), checkedAt: new Date().toISOString(),
    } as const;
    const r = await inv.service.markDiscontinued(ctx.tenantId, ctx.userId, hit.item.id, d);
    return 'error' in r ? { recorded: false, note: r.error } : { recorded: true, item: hit.item.name, discontinued: discontinuedText(d) };
  },
};

/** 発注の答え方（秘書に返す形）。 */
function orderView(o: InventoryOrder) {
  return {
    number: o.number, supplier: o.supplierName, status: inventoryOrderStatusLabel(o.status, o.method), orderedAt: o.orderedAt?.slice(0, 10) ?? null, dueOn: o.dueOn,
    ...(o.overdueDays ? { overdueDays: o.overdueDays } : {}),
    lines: o.lines.map((l) => ({ item: l.itemName ?? '', ordered: `${l.qty} ${l.unit ?? ''}`.trim(), received: `${l.received} ${l.unit ?? ''}`.trim() })),
  };
}

/**
 * 発注の記録を答える（第29.14.4節）。入荷待ち・届いていない発注・品目の発注。
 *
 * @remarks 危険度 `read`
 */
export const inventoryOrders: Tool = {
  name: 'inventory.orders',
  risk: 'read',
  activityLabel: '発注の記録を確かめています',
  helpText: '発注済み・入荷待ち・届いていない発注を確かめます',
  description: '発注の記録を返す。item を入れるとその品目の発注だけ、late を true にすると届く予定の日を過ぎた発注だけ。既定は閉じていない発注（発注前・承認待ち・入荷待ち・一部入荷）',
  args: { properties: { item: { type: 'string', description: '品目（品名・コード）' }, late: { type: 'boolean', description: '届いていない（遅れた）発注だけ' } } },
  async invoke(args, ctx) {
    const inv = await inventoryOf(ctx);
    if (!inv) return UNAVAILABLE;
    let orders = await inv.service.orders(ctx.tenantId, { open: true });
    if (args['late'] === true) orders = orders.filter((o) => (o.overdueDays ?? 0) > 0);
    if (str(args['item'])) {
      const hit = await resolveItem(inv.service, ctx.tenantId, str(args['item']).slice(0, 100));
      if (!('item' in hit)) return { available: true, orders: [], candidates: hit.candidates.map((c) => c.name), note: '品目を 1 つに決められませんでした' };
      orders = orders.filter((o) => o.lines.some((l) => l.itemId === hit.item.id));
    }
    return { available: true, orders: orders.slice(0, 30).map(orderView), ...(orders.length === 0 ? { note: '閉じていない発注はありません' } : {}) };
  },
};

/**
 * 発注したことを記録する・取り消す（第29.14.4節）。Web・電話で発注したと本人が話したときに使う。
 *
 * @remarks 危険度 `write-internal`（社内の記録だけ。仕入先には何も送らない）
 */
export const inventoryRecordOrder: Tool = {
  name: 'inventory.record_order',
  risk: 'write-internal',
  activityLabel: '発注を記録しています',
  helpText: '発注したことを記録し、届くまで入荷待ちにします（社内の記録だけで、仕入先には何も送りません）',
  description: [
    '本人が「〇〇を発注した」と話したとき、発注を入荷待ちとして記録する。item は品目、qty は数、unit は unit（使う単位）か pack（仕入れの単位）。',
    'supplier は仕入先の名前（省けば品目の仕入先）。cancel に発注番号を入れると、その発注を取り消す（社内の記録だけ）。発注していないのに記録しない。',
  ].join(''),
  args: {
    properties: {
      item: { type: 'string', description: '品目（品名・自社のコード・バーコード）' },
      qty: { type: 'number', description: '数' },
      unit: { type: 'string', description: 'unit か pack', enum: ['unit', 'pack'] },
      supplier: { type: 'string', description: '仕入先の名前' },
      cancel: { type: 'string', description: '取り消す発注番号' },
    },
  },
  async invoke(args, ctx) {
    const inv = await inventoryOf(ctx);
    if (!inv) return UNAVAILABLE;
    if (str(args['cancel'])) {
      const o = (await inv.service.orders(ctx.tenantId, { open: true })).find((x) => x.number === str(args['cancel']).trim());
      if (!o) return { recorded: false, note: `発注番号「${str(args['cancel'])}」の閉じていない発注はありません` };
      const r = await inv.service.cancelOrder(ctx.tenantId, ctx.userId, o.id);
      return 'error' in r ? { recorded: false, note: r.error } : { recorded: true, cancelled: orderView(r) };
    }
    const hit = await resolveItem(inv.service, ctx.tenantId, str(args['item']).slice(0, 100));
    if (!('item' in hit)) {
      return hit.candidates.length
        ? { recorded: false, needsChoice: true, candidates: hit.candidates.map((c) => c.name), note: '品目が 1 つに決まりません。どれのことか本人に尋ねてください' }
        : { recorded: false, note: `「${str(args['item'])}」という品目はありません` };
    }
    const suppliers = await inv.service.suppliers(ctx.tenantId);
    const name = str(args['supplier']).trim();
    const supplier = name ? suppliers.find((x) => x.name.includes(name) || name.includes(x.name)) : suppliers.find((x) => x.id === hit.item.supplierId);
    if (!supplier) return { recorded: false, note: name ? `仕入先「${name}」が見つかりません` : `${hit.item.name} の仕入先が決まっていません。どこに発注したか本人に尋ねてください` };
    let qty = typeof args['qty'] === 'number' ? args['qty'] : Number(args['qty']);
    if (!Number.isFinite(qty) || qty <= 0) return { recorded: false, note: '発注した数を本人に尋ねてください' };
    if (str(args['unit']) === 'pack' && hit.item.packSize) qty *= hit.item.packSize;
    const r = await inv.service.createOrder(ctx.tenantId, ctx.userId, { supplierId: supplier.id, lines: [{ itemId: hit.item.id, qty }], status: 'ordered' });
    return 'error' in r ? { recorded: false, note: r.error } : { recorded: true, order: orderView(r) };
  },
};

export const INVENTORY_TOOLS: Tool[] = [inventorySearch, inventoryHistory, inventoryMove, inventoryForecast, inventoryReadSlip, inventoryReceiveSlip, inventoryReserve, inventoryMarket, inventoryCheckMarket, inventoryMarkDiscontinued, inventoryOrders, inventoryRecordOrder];
