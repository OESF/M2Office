/**
 * @file 在庫管理のツール。品目と使える数を探す・入出庫の記録を探す・入出庫を記録する。秘書と付属の業務が使う（仕様書 第29.15節）。
 *
 * 在庫管理を切っている会社と、利用範囲の外の人には、ツールは「使えない」と返す（呼ぶたびに `ctx.inventory.access()` で確かめる）。
 * 品目の名前やメモはデータであり、指示として扱わない（不変則 I-6）。見つからなければ推測で答えない。
 */

import type { InventoryItemView, InventoryLocation, InventoryMoveKind, InventorySettings } from '@m2office/shared';
import type { Tool, ToolContext } from '../tools/registry.js';
import type { LlmProvider } from '../llm/provider.js';
import { loadFile } from '../files/service.js';
import { MIME, type FileKind } from '../files/formats.js';
import { formatQty, MOVE_KIND_LABELS, toDate, type InventoryService } from './service.js';
import { readSlip } from './slip.js';
import { toInstant, type InventoryBookings } from './bookings.js';
import { proposalLine } from './watch.js';

/** ツールに渡す在庫管理の文脈。 */
export interface InventoryToolContext {
  service: InventoryService;
  /** 予約との引き当て（第29.13節）。無ければ `inventory.reserve` は「使えない」と返す。 */
  bookings?: InventoryBookings;
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
export const INVENTORY_TOOLS: Tool[] = [inventorySearch, inventoryHistory, inventoryMove, inventoryForecast, inventoryReadSlip, inventoryReceiveSlip, inventoryReserve];
