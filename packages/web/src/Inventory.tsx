/**
 * @file 在庫管理のパソコンの画面。品目の一覧と検索・バーコードで引く（USB のリーダー）・スマホで開く・品目を追加・知らないバーコードの結び付け・
 * 取り込みと書き出し・場所と棚のラベル・棚卸しへの入口・品目の詳細と入出庫の記録と取り消し。
 *
 * 数は使える数（在庫 − 引き当て − 期限切れ）を先に出す。説明文を常に出さない（原則 u11）。分からなければ秘書に聞けばよい。
 * USB のバーコードリーダーは文字を打って Enter を押すため、探す欄でそのまま読める。
 * カメラで読むのはスマホ用のページ（`/m/inventory`。MobileInventory.tsx）で行う（仕様書 第29.11.1節）。
 *
 * @see 仕様書 第29章 在庫管理
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { INVENTORY_ITEM_KINDS, inventoryCostValue, inventoryKindLabel, inventoryMargin, inventoryPurposeLabel, inventorySaleValue, type InventoryItem, type InventoryOutPurpose, type InventoryItemKind, type InventoryItemView, type InventoryLocation, type InventoryMove, type InventoryMoveKind, type InventorySupplier } from '@m2office/shared';
import { api, describeError, type InventoryDetail, type InventoryList } from './api.js';
import { Stocktake } from './Stocktake.js';
import { BookingsPanel, OrderPanel, SlipResultPanel, SuppliersPanel } from './InventoryOrders.js';
import { PublishPanel } from './InventoryPublish.js';
import { SalesUnmatchedPanel } from './InventoryUnmatched.js';
import { UsageChart, UsagePanel } from './InventoryUsage.js';
import { MarketPanel, MarketSection } from './InventoryMarket.js';
import { InventorySummary, isOut, needsOrder, type SummaryFilter } from './InventorySummary.js';
import type { InventorySlipResult } from './api.js';
import { OutDoneLine, PurposeChips, purposeOf, type OutDone } from './inventory-out.js';

// 記録の種類 `out` は画面では「出庫」と呼ぶ（第 0.406.0 版。第29.11.1節）
const KIND_LABELS: Record<InventoryMoveKind, string> = { in: '入庫', out: '出庫', transfer: '移動', adjust: '調整' };

const round = (n: number) => Math.round(n * 1000) / 1000;

/** 数の出し方（使う単位と、仕入れの単位があれば添える）。例: 「10 回（2 本）」。 */
function qtyText(item: Pick<InventoryItem, 'unit' | 'packUnit' | 'packSize'>, qty: number): string {
  const base = `${round(qty)} ${item.unit}`;
  return item.packUnit && item.packSize && qty !== 0 ? `${base}（${round(qty / item.packSize)} ${item.packUnit}）` : base;
}

const placeName = (l: InventoryLocation | undefined) => (l ? (l.shelf ? `${l.warehouse} ${l.shelf}` : l.warehouse) : '—');

/** 日本時間の今日（YYYY-MM-DD）。 */
const todayJst = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Tokyo', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());

/**
 * 在庫管理の画面。
 *
 * @param itemId 開いている品目。一覧なら `null`
 * @param onOpen 品目を開く・一覧に戻る（URL を合わせる）
 * @param userId 見ている人（自分の記録だけを取り消せる）
 */
export function Inventory({ itemId, onOpen, userId }: { itemId: string | null; onOpen: (itemId: string | null) => void; userId: string }) {
  // 品目を作ったときの知らせ（単位の欄の数を数として読んだなど）を、開いた品目の上に一度だけ出す
  const [flash, setFlash] = useState<string | null>(null);
  // 棚卸しは一覧の中で開く（数えている間に品目の詳細へ移らないため）
  const [counting, setCounting] = useState(false);
  if (counting && !itemId) return <Stocktake userId={userId} onBack={() => setCounting(false)} />;
  if (itemId) return <ItemView id={itemId} onBack={() => { setFlash(null); onOpen(null); }} userId={userId} initialMessage={flash} />;
  return <ListView onOpen={(id, note) => { setFlash(note ?? null); onOpen(id); }} onStocktake={() => setCounting(true)} />;
}

/**
 * 需要の予測の印。一覧では短く（「多め 1.5 倍」）出し、マウスを重ねると詳しい中身を、押すとポップアップで出す（2026-10-19。場所を中身に使う）。
 */
function ForecastBadge({ item, compact }: { item: InventoryItemView; compact: boolean }) {
  const [at, setAt] = useState<{ top: number; left: number } | null>(null);
  const ref = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!at) return undefined;
    const close = (e: MouseEvent) => { if (!(e.target as Element | null)?.closest('.forecast-pop, .forecast-badge')) setAt(null); };
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape') setAt(null); };
    const away = () => setAt(null);
    document.addEventListener('mousedown', close);
    document.addEventListener('keydown', key);
    window.addEventListener('scroll', away, true);
    return () => { document.removeEventListener('mousedown', close); document.removeEventListener('keydown', key); window.removeEventListener('scroll', away, true); };
  }, [at]);
  const f = item.forecast!;
  const up = f.factor > 1;
  const full = up ? `多めに使う見込み（${f.factor} 倍${f.note ? `。${f.note}` : ''}）` : `少なめの見込み（${f.factor} 倍${f.note ? `。${f.note}` : ''}）`;
  if (!compact) return <span className="badge" title={f.note || undefined}>{full}</span>;
  return (
    <>
      <button type="button" ref={ref} className="badge forecast-badge" title={full} aria-expanded={!!at}
        onClick={(e) => {
          e.stopPropagation();
          if (at) { setAt(null); return; }
          const r = ref.current!.getBoundingClientRect();
          // 下に余白が無ければ上に出す（ポップアップの高さはおよそ 150）
          setAt({ top: r.bottom + 160 > window.innerHeight ? Math.max(8, r.top - 160) : r.bottom + 4, left: Math.max(8, Math.min(r.right - 260, window.innerWidth - 268)) });
        }}>{up ? '多め' : '少なめ'} {f.factor} 倍</button>
      {at && createPortal(
        <div className="forecast-pop" role="dialog" aria-label="需要の予測" style={{ top: at.top, left: at.left }} onClick={(e) => e.stopPropagation()}>
          <strong>需要の予測</strong>
          <div>{up ? '次の 4 週は、いつもより多めに使う見込みです' : '次の 4 週は、いつもより少なめの見込みです'}（{f.factor} 倍）</div>
          {f.note && <div>理由: {f.note}</div>}
          {f.low !== null && <div className="muted small">予測の目安: {f.low} {item.unit}{item.lowThreshold !== null ? '（品目に決めた目安が先に効きます）' : ''}</div>}
          <div className="muted small">{new Date(f.at).toLocaleDateString('ja-JP', { month: 'numeric', day: 'numeric' })} に決め直しました</div>
        </div>,
        document.body,
      )}
    </>
  );
}

/** 印（残りわずか・期限切れ・マイナス・需要の予測）。`compact` なら一覧向けに短く出す。 */
function Marks({ item, compact = false }: { item: InventoryItemView; compact?: boolean }) {
  return (
    <>
      {item.status === 'stopped' && <span className="badge">止めた</span>}
      {item.onHand < 0 && <span className="badge danger">マイナス</span>}
      {item.expired > 0 && <span className="badge danger">期限切れ {qtyText(item, item.expired)}</span>}
      {item.low && item.status === 'active' && <span className="badge warn">残りわずか</span>}
      {/* 需要の予測（第29.14節）。倍率が 1 でない品目に、見込みと理由を出す */}
      {item.status === 'active' && item.forecast && item.forecast.factor !== 1 && <ForecastBadge item={item} compact={compact} />}
    </>
  );
}

/** 一覧の絞り込み（第29.6.1節）。その端末で覚えておく。 */
interface ListFilter {
  kind: InventoryItemKind | '';
  category: string;
  state: '' | 'out' | 'order' | 'low' | 'runningOut' | 'expiring' | 'expired';
}
const FILTER_KEY = 'm2o.inventory.filter';
const STATE_LABEL: Record<Exclude<ListFilter['state'], ''>, string> = { out: '在庫切れ', order: '要発注', low: '残りわずか', runningOut: '無くなる見込み', expiring: '期限が近い（30 日）', expired: '期限切れ' };

/** 覚えておいた絞り込みを読む（読めなければ絞らない）。 */
function loadFilter(): ListFilter {
  try {
    const v = JSON.parse(localStorage.getItem(FILTER_KEY) ?? 'null') as Partial<ListFilter> | null;
    return { kind: (v?.kind as ListFilter['kind']) ?? '', category: typeof v?.category === 'string' ? v.category : '', state: (v?.state as ListFilter['state']) ?? '' };
  } catch {
    return { kind: '', category: '', state: '' };
  }
}

/** 品目が絞り込みに当たるか。 */
function matchesFilter(i: InventoryItemView, f: ListFilter, runningOut: Set<string>, today: string, soon: string): boolean {
  if (f.kind && i.kind !== f.kind) return false;
  if (f.category && (i.category || '（分類なし）') !== f.category) return false;
  if (f.state === 'out') return isOut(i);
  if (f.state === 'order') return needsOrder(i, runningOut);
  if (f.state === 'low') return i.low;
  if (f.state === 'runningOut') return runningOut.has(i.id);
  if (f.state === 'expiring') return !!i.nearestExpiry && i.nearestExpiry >= today && i.nearestExpiry <= soon;
  if (f.state === 'expired') return i.expired > 0;
  return true;
}

/** 円の表記。 */
const yenText = (n: number) => `${n.toLocaleString('ja-JP')} 円`;

/** 一覧の、はじめは隠す列の材料（品目に無いもの）。 */
interface ExtraContext { suppliers: Map<string, string>; lowDefault: number; forecastOn: boolean }

/**
 * 一覧の、はじめは隠す列（表の「列」で選ぶと出る。仕様書 第6.1.2.1節）。品目の詳細にしか無かった項目を、一覧でも見られるようにする。
 */
const EXTRA_COLUMNS: { label: string; num?: boolean; adminOnly?: boolean; cell: (i: InventoryItemView, x: ExtraContext) => string }[] = [
  { label: '自社のコード', cell: (i) => i.sku },
  { label: 'バーコード', cell: (i) => i.codes.join(' ') },
  { label: '公開する名前', cell: (i) => i.publicName },
  { label: '単位', cell: (i) => (i.packUnit && i.packSize ? `${i.unit}（1 ${i.packUnit} = ${i.packSize} ${i.unit}）` : i.unit) },
  { label: '販売価格', num: true, cell: (i) => (i.price === null ? '' : `${yenText(i.price)}（${i.priceTaxIncluded ? '税込' : '税抜'}）`) },
  { label: '消費税率', num: true, cell: (i) => (i.kind === 'sale' ? `${i.taxRate}%` : '') },
  { label: '社員価格', num: true, cell: (i) => (i.employeePrice === null ? '' : yenText(i.employeePrice)) },
  {
    label: '在庫額（税込）', num: true,
    // 販売品の「在庫 − 期限切れ」× 販売価格（売価で見た目安。第29.6.1節）
    cell: (i) => {
      if (i.kind !== 'sale' || i.price === null) return '';
      const amount = i.price * Math.max(0, i.onHand - i.expired);
      return yenText(Math.round(i.priceTaxIncluded ? amount : (amount * (100 + i.taxRate)) / 100));
    },
  },
  // 仕入価格・利益・利益率・在庫額（仕入価格）は、利用範囲の管理者だけに出す（第29.6.2節）
  { label: '仕入価格', num: true, adminOnly: true, cell: (i) => (i.purchasePrice === null || i.purchasePrice === undefined ? '' : `${yenText(i.purchasePrice)}（${i.purchaseTaxIncluded ? '税込' : '税抜'}）`) },
  { label: '利益', num: true, adminOnly: true, cell: (i) => { const m = inventoryMargin(i); return m ? yenText(m.profit) : ''; } },
  { label: '利益率', num: true, adminOnly: true, cell: (i) => { const m = inventoryMargin(i); return m ? `${m.rate}%` : ''; } },
  { label: '在庫額（仕入価格）', num: true, adminOnly: true, cell: (i) => { const v = inventoryCostValue(i); return v === null ? '' : yenText(v); } },
  { label: '引き当て', num: true, cell: (i) => (i.reserved ? qtyText(i, i.reserved) : '') },
  { label: '期限切れの数', num: true, cell: (i) => (i.expired ? qtyText(i, i.expired) : '') },
  {
    label: '残りわずかの目安', num: true,
    cell: (i, x) => (i.lowThreshold !== null ? `${i.lowThreshold} ${i.unit}` : x.forecastOn && i.forecast?.low != null ? `${i.forecast.low} ${i.unit}（予測）` : `${x.lowDefault} ${i.unit}（既定）`),
  },
  { label: '仕入先', cell: (i, x) => (i.supplierId ? x.suppliers.get(i.supplierId) ?? '' : '') },
  { label: '仕入れにかかる日数', num: true, cell: (i) => (i.leadDays === null ? '' : `${i.leadDays} 日`) },
  { label: 'メモ', cell: (i) => i.note },
];

/** 一覧・探す（バーコードも）・品目を追加・取り込みと書き出し・場所。 */
function ListView({ onOpen, onStocktake }: { onOpen: (id: string, note?: string | null) => void; onStocktake: () => void }) {
  const [list, setList] = useState<InventoryList | null>(null);
  const [q, setQ] = useState('');
  const [stopped, setStopped] = useState(false);
  const [filter, setFilterState] = useState<ListFilter>(loadFilter);
  // 一覧の、はじめは隠す列の仕入先の名前
  const [supplierNames, setSupplierNames] = useState<Map<string, string>>(new Map());
  useEffect(() => { api.inventory.suppliers().then((r) => setSupplierNames(new Map(r.suppliers.map((s) => [s.id, s.name])))).catch(() => undefined); }, []);
  const setFilter = (f: ListFilter) => {
    setFilterState(f);
    try { localStorage.setItem(FILTER_KEY, JSON.stringify(f)); } catch { /* 覚えられなくても絞り込みは効く */ }
  };
  const [message, setMessage] = useState<string | null>(null);
  const [adding, setAdding] = useState<{ name: string; code: string } | null>(null);
  // 一覧の上に開く欄。一度に 1 つだけ開き、開いているあいだは品目の一覧を出さない（第29.11節「作業の欄」）
  const [panel, setPanel] = useState<'places' | 'orders' | 'usage' | 'market' | 'suppliers' | 'bookings' | 'publish' | 'unmatched' | null>(null);
  // 照らせなかった販売の数（外部のアプリの販売の通知。第29.20.1節）。あるときだけボタンを出す
  const [unmatched, setUnmatched] = useState(0);
  const [slip, setSlip] = useState<InventorySlipResult | null>(null);
  const slipPicker = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [mobileQr, setMobileQr] = useState<string | null>(null);
  // 知らないバーコード。新しい品目にするか、既にある品目に結び付ける（第29.11節）
  const [unknown, setUnknown] = useState<string | null>(null);
  // 一覧から出庫する欄（行の「出庫」かバーコード。第29.9.1節）。記録した結果の行は「取り消す」を添える
  const [quick, setQuick] = useState<QuickOutState | null>(null);
  const [outDone, setOutDone] = useState<OutDone | null>(null);
  /** 開いている作業の欄をすべて閉じる（一覧に戻る）。 */
  const closeWork = () => {
    setPanel(null);
    setAdding(null);
    setSlip(null);
    setUnknown(null);
    if (mobileQr) URL.revokeObjectURL(mobileQr);
    setMobileQr(null);
  };
  /** 欄を開く（ほかの欄は閉じる）。開いている欄のボタンをもう一度押すと閉じる。 */
  const toggle = (p: 'places' | 'orders' | 'usage' | 'market' | 'suppliers' | 'bookings' | 'publish' | 'unmatched') => {
    if (panel === p) { setPanel(null); return; }
    closeWork();
    setPanel(p);
  };
  const working = panel !== null || adding !== null || slip !== null || mobileQr !== null || unknown !== null;
  // 絞り込み（区分・分類・状態）と、絞り込んだ販売品の在庫額（第29.6.1節）
  const categories = useMemo(() => [...new Set((list?.items ?? []).map((i) => i.category || '（分類なし）'))].sort((a, b) => a.localeCompare(b, 'ja')), [list]);
  const shown = useMemo(() => {
    if (!list) return [];
    const jst = new Date(Date.now() + 9 * 3_600_000);
    const today = jst.toISOString().slice(0, 10);
    const soon = new Date(jst.getTime() + 30 * 86_400_000).toISOString().slice(0, 10);
    const out = new Set(list.runningOut ?? []);
    return list.items.filter((i) => matchesFilter(i, filter, out, today, soon));
  }, [list, filter]);
  const saleValue = useMemo(() => (list ? inventorySaleValue(shown, list.taxRounding ?? 'floor') : null), [list, shown]);
  const extraColumns = EXTRA_COLUMNS.filter((c) => !c.adminOnly || list?.admin);
  const extra: ExtraContext = { suppliers: supplierNames, lowDefault: list?.settings.lowDefault ?? 0, forecastOn: list?.settings.features.forecast !== false };
  // サマリーのどのカードが効いているか
  const summaryActive: SummaryFilter = filter.category ? null
    : (['out', 'order', 'expired', 'expiring'] as const).find((s) => filter.state === s && !filter.kind) ?? (filter.kind === 'sale' && !filter.state ? 'sale' : null);
  const picker = useRef<HTMLInputElement>(null);
  const search = useRef<HTMLInputElement>(null);
  const more = useRef<HTMLDetailsElement>(null);
  // 「その他」は、外を押したら閉じる
  useEffect(() => {
    const close = (e: MouseEvent) => { if (more.current && !more.current.contains(e.target as Node)) more.current.removeAttribute('open'); };
    document.addEventListener('click', close);
    return () => document.removeEventListener('click', close);
  }, []);

  const load = useCallback(() => {
    api.inventory.list({ q, stopped }).then(setList).catch((e) => setMessage(describeError(e, '読み込めませんでした')));
    api.inventory.salesUnmatched().then((r) => setUnmatched(r.items.length)).catch(() => undefined);
  }, [q, stopped]);
  useEffect(() => {
    const t = setTimeout(load, q ? 250 : 0);
    return () => clearTimeout(t);
  }, [load, q]);

  /** 読んだ値（カメラ・リーダー・Enter）を引く。品目なら開き、知らないバーコードなら、どうするかを出す。 */
  const lookup = async (raw: string) => {
    const code = raw.trim();
    if (!code) return;
    try {
      const r = await api.inventory.lookup(code);
      // 品目を読んだら出庫の欄を開く（同じ品目なら 1 つ足し、別の品目なら前の品目を記録してから開く。第29.9.1節）
      if (r.item) {
        const view = list?.items.find((x) => x.id === r.item!.id) ?? (await api.inventory.list({ q: '', stopped: false })).items.find((x) => x.id === r.item!.id);
        setQ('');
        if (view && view.status === 'active') await openQuick(view); else onOpen(r.item.id);
        return;
      }
      if (r.location) { setQ(''); setMessage(`棚「${placeName(r.location)}」のラベルです`); return; }
      if (r.parsed.kind !== 'other') { closeWork(); setUnknown(r.parsed.code); }
    } catch (e) {
      setMessage(describeError(e, '読めませんでした'));
    }
  };
  const scan = () => (!q.trim() && quick ? recordQuick() : lookup(q));

  /** 出庫の欄を開く。同じ品目なら 1 つ足す。別の品目が開いていれば、その品目を記録してから開く。 */
  const openQuick = async (item: InventoryItemView) => {
    if (quick?.item.id === item.id) { setQuick({ ...quick, qty: quick.qty + 1 }); search.current?.focus({ preventScroll: true }); return; }
    if (quick) await recordQuick();
    setQuick({ item, qty: 1, purpose: purposeOf(item) });
    // 手元は探す欄に置く（続けて読んだバーコードが入り、空のまま Enter で記録できる）
    search.current?.focus({ preventScroll: true });
  };
  /** 出庫の欄の品目を記録する。 */
  const recordQuick = async () => {
    if (!quick) return;
    const { item, qty, purpose } = quick;
    try {
      const r = await api.inventory.move({ kind: 'out', itemId: item.id, qty, unit: 'unit', purpose });
      setQuick(null);
      setOutDone({
        text: [`${item.name} を ${qty} ${item.unit} 出庫しました（${inventoryPurposeLabel(purpose)}）。使える数は ${qtyText(r.item, r.item.available)} です`, ...r.warnings].join('。'),
        moveId: r.moves[0]?.id ?? null,
      });
      load();
    } catch (e) {
      setMessage(describeError(e, '記録できませんでした'));
    }
  };
  const undoOut = async () => {
    if (!outDone?.moveId) return;
    try {
      await api.inventory.undo(outDone.moveId);
      setOutDone({ text: '出庫を取り消しました', moveId: null });
      load();
    } catch (e) {
      setMessage(describeError(e, '取り消せませんでした'));
    }
  };

  /** 納品書の写真・PDF を渡して入庫する。読めた行はすぐ入庫になり、照らせない行が残る。 */
  const readSlipFile = async (f: File | undefined) => {
    if (!f) return;
    setBusy(true);
    setMessage('納品書を読み取っています…');
    try {
      const result = await api.inventory.slip(f);
      closeWork();
      setSlip(result);
      setMessage(null);
      load();
    } catch (e) {
      setMessage(describeError(e, '納品書を読み取れませんでした'));
    } finally {
      setBusy(false);
      if (slipPicker.current) slipPicker.current.value = '';
    }
  };

  const importFile = async (f: File | undefined) => {
    if (!f) return;
    setBusy(true);
    setMessage(null);
    try {
      const r = await api.inventory.importFile(f);
      const parts = [`${r.created} 件を足し、${r.updated} 件を直しました`];
      if (r.stocked) parts.push(`${r.stocked} 件に在庫の数を入れました`);
      if (r.skipped.length) parts.push(`取り込めなかった行: ${r.skipped.slice(0, 5).map((s) => `${s.row} 行目（${s.reason}）`).join('、')}${r.skipped.length > 5 ? ` ほか ${r.skipped.length - 5} 行` : ''}`);
      setMessage(parts.join('。'));
      load();
    } catch (e) {
      setMessage(describeError(e, '取り込めませんでした'));
    } finally {
      setBusy(false);
      if (picker.current) picker.current.value = '';
    }
  };

  return (
    <div className="inventory">
      {/* 上の段は 3 つに分ける（2026-10-19 にボタンが多く見にくいと三浦さんが求めた）。
          1 段目: 探す欄とよく使う操作。たまに使う操作は「その他」にまとめる。2 段目: 欄を開くもの（タブ）。3 段目: 絞り込みと在庫額 */}
      <div className="inventory-bar">
        <input ref={search} className="cards-search" type="search" placeholder="品名・コード・バーコード" value={q} aria-label="品目を探す"
          onChange={(e) => setQ(e.target.value)} onKeyDown={(e) => {
            if (e.key === 'Enter') void scan();
            if (e.key === 'Escape' && quick) setQuick(null);
          }} />
        <button className="btn" onClick={() => {
          if (adding) { setAdding(null); return; }
          closeWork();
          setAdding({ name: q.trim(), code: '' });
        }}>品目を追加</button>
        <button className="btn ghost" onClick={onStocktake}>棚卸し</button>
        <button className="btn ghost" disabled={busy} onClick={() => slipPicker.current?.click()}>納品書から入庫</button>
        <details className="inventory-more" ref={more} onToggle={(e) => {
          // 開いたときに、左にはみ出すなら左寄せに切り替える（狭い幅で「その他」が行の左に来たとき）
          const d = e.currentTarget;
          d.classList.remove('align-left');
          const menu = d.querySelector('.inventory-more-menu');
          const box = d.parentElement?.getBoundingClientRect();
          if (d.open && menu && box && menu.getBoundingClientRect().left < box.left) d.classList.add('align-left');
        }}>
          <summary className="btn ghost">その他</summary>
          <div className="inventory-more-menu" role="menu" onClick={() => more.current?.removeAttribute('open')}>
            <button role="menuitem" disabled={busy} onClick={() => picker.current?.click()}>取り込み（CSV・Excel）</button>
            <button role="menuitem" onClick={() => void api.inventory.exportFile('csv').catch((e) => setMessage(describeError(e, '書き出せませんでした')))}>書き出し（CSV）</button>
            <button role="menuitem" disabled={!list || list.locations.length === 0}
              onClick={() => void api.inventory.downloadLabels().catch((e) => setMessage(describeError(e, 'ラベルを作れませんでした')))}>棚ラベルの印刷</button>
            <button role="menuitem" onClick={() => {
              if (mobileQr) { URL.revokeObjectURL(mobileQr); setMobileQr(null); return; }
              void api.inventory.mobileQrUrl().then((url) => { closeWork(); setMobileQr(url); }).catch((e) => setMessage(describeError(e, 'QR を作れませんでした')));
            }}>スマホで開く</button>
          </div>
        </details>
        <input ref={slipPicker} type="file" hidden accept="image/png,image/jpeg,image/webp,application/pdf"
          onChange={(e) => void readSlipFile(e.target.files?.[0])} />
        <input ref={picker} type="file" hidden accept=".csv,.xlsx,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
          onChange={(e) => void importFile(e.target.files?.[0])} />
      </div>
      <nav className="inventory-tabs" aria-label="在庫の欄">
        <button className={panel === 'places' ? 'active' : ''} onClick={() => toggle('places')}>場所（{list?.locations.length ?? 0}）</button>
        <button className={panel === 'orders' ? 'active' : ''} onClick={() => toggle('orders')}>発注の案</button>
        <button className={panel === 'usage' ? 'active' : ''} onClick={() => toggle('usage')}>減り具合</button>
        {list?.settings.features.market !== false && <button className={panel === 'market' ? 'active' : ''} onClick={() => toggle('market')}>価格の比較</button>}
        <button className={panel === 'suppliers' ? 'active' : ''} onClick={() => toggle('suppliers')}>仕入先</button>
        {list?.settings.features.reserve && <button className={panel === 'bookings' ? 'active' : ''} onClick={() => toggle('bookings')}>取り置き</button>}
        {list?.admin && list.settings.features.publish && <button className={panel === 'publish' ? 'active' : ''} onClick={() => toggle('publish')}>Web へ公開</button>}
        {unmatched > 0 && <button className={panel === 'unmatched' ? 'active warn' : 'warn'} onClick={() => toggle('unmatched')}>照らせなかった販売（{unmatched}）</button>}
      </nav>
      {message && <p className="small muted" role="status">{message}</p>}
      {/* 在庫のサマリー（2026-10-19。いまの状況を一目で）。カードを押すとその状態で絞り込む */}
      {!working && list && list.items.length > 0 && (
        <InventorySummary items={list.items} runningOut={list.runningOut ?? []} todayOut={list.todayOut ?? 0} taxRounding={list.taxRounding ?? 'floor'}
          active={summaryActive} onOrders={() => toggle('orders')}
          onFilter={(f) => setFilter(f === null ? { kind: '', category: '', state: '' } : f === 'sale' ? { kind: 'sale', category: '', state: '' } : { kind: '', category: '', state: f })} />
      )}
      {working && <button className="link-btn inventory-back" onClick={closeWork}>‹ 品目の一覧</button>}
      {panel === 'places' && list && <Places locations={list.locations} admin={list.admin} onChanged={load} />}
      {panel === 'orders' && <OrderPanel onOpenItem={(id) => onOpen(id)} />}
      {panel === 'suppliers' && <SuppliersPanel />}
      {panel === 'bookings' && list && <BookingsPanel items={list.items} onChanged={load} />}
      {panel === 'publish' && list && <PublishPanel items={list.items} />}
      {panel === 'unmatched' && list && <SalesUnmatchedPanel items={list.items} onChanged={load} />}
      {slip && list && <SlipResultPanel result={slip} items={list.items} onRecorded={load} onClose={() => setSlip(null)} />}
      {mobileQr && (
        <div className="card inventory-new mobile-qr">
          <img src={mobileQr} alt="スマホ用の在庫のページを開く QR" width={180} height={180} />
          <span className="small muted">{`${location.origin}/m/inventory`}</span>
        </div>
      )}
      {unknown && list && (
        <UnknownCode code={unknown} items={list.items} onNew={() => { setAdding({ name: '', code: unknown }); setUnknown(null); }}
          onLinked={(id) => { setUnknown(null); onOpen(id, `バーコード ${unknown} を結び付けました`); }} onCancel={() => setUnknown(null)} />
      )}
      {adding && (
        <NewItem initial={adding} onCancel={() => setAdding(null)}
          onSaved={(id, note) => { setAdding(null); onOpen(id, note); }} />
      )}
      {!working && list && list.items.length === 0 && <p className="muted">{q ? '見つかりませんでした' : '品目はまだありません'}</p>}
      {/* 絞り込みは「減り具合」のタブでも出す（同じ絞り込みが効く） */}
      {(!working || panel === 'usage' || panel === 'market') && list && list.items.length > 0 && (
        <div className="row wrap inventory-filter">
          <select value={filter.kind} onChange={(e) => setFilter({ ...filter, kind: e.target.value as ListFilter['kind'] })} aria-label="区分で絞る">
            <option value="">すべての区分</option>
            {INVENTORY_ITEM_KINDS.map((k) => <option key={k.id} value={k.id}>{k.label}</option>)}
          </select>
          <select value={filter.category} onChange={(e) => setFilter({ ...filter, category: e.target.value })} aria-label="分類で絞る">
            <option value="">すべての分類</option>
            {categories.map((c) => <option key={c} value={c}>{c}</option>)}
          </select>
          <select value={filter.state} onChange={(e) => setFilter({ ...filter, state: e.target.value as ListFilter['state'] })} aria-label="状態で絞る">
            <option value="">すべての状態</option>
            {(Object.keys(STATE_LABEL) as Exclude<ListFilter['state'], ''>[]).map((k) => <option key={k} value={k}>{STATE_LABEL[k]}</option>)}
          </select>
          {(filter.kind || filter.category || filter.state) && <button className="link-btn small" onClick={() => setFilter({ kind: '', category: '', state: '' })}>絞り込みを外す</button>}
          {/* 絞り込んだ販売品の在庫額（売価で見た目安。在庫の評価ではない。第29.6.1節）。絞り込んでいないときはサマリーのカードに出る */}
          {(filter.kind || filter.category || filter.state) && saleValue && (saleValue.counted > 0 || saleValue.noPrice > 0) && (
            <span className="inventory-value">
              販売品の在庫額（売価）: <strong>税込 {yenText(saleValue.withTax)}</strong>（税抜 {yenText(saleValue.withoutTax)}）・{saleValue.counted} 品目
              {saleValue.noPrice > 0 && <span className="muted small">（販売価格の無い {saleValue.noPrice} 品目は数えていません）</span>}
            </span>
          )}
        </div>
      )}
      {/* 減り具合（第29.14.1節）。一覧の絞り込みがそのまま効く */}
      {panel === 'usage' && <UsagePanel itemIds={new Set(shown.map((i) => i.id))} onOpenItem={(id) => onOpen(id)} />}
      {/* 販売品の相場と競合の比較（第29.24節）。一覧の絞り込みがそのまま効く */}
      {panel === 'market' && <MarketPanel items={shown} onOpenItem={(id) => onOpen(id)} admin={!!list?.admin} />}
      {!working && quick && (
        <QuickOut state={quick} onChange={setQuick} onRecord={() => void recordQuick()} onClose={() => setQuick(null)} />
      )}
      {!working && outDone && <OutDoneLine done={outDone} onUndo={() => void undoOut()} />}
      {!working && list && list.items.length > 0 && shown.length === 0 && <p className="muted">絞り込みに当たる品目はありません</p>}
      {!working && list && shown.length > 0 && (
        <div className="table-scroll"><table className="table inventory-table">
          <thead>
            <tr>
              {/* 先頭の列で出庫する（いちばん多い操作。2026-10-19 に三浦さんが列にするよう求めた。第29.9.1節） */}
              <th className="inv-out-col">出庫</th>
              <th>品名</th><th>区分</th><th>分類</th><th className="num">使える数</th><th className="num onhand">在庫</th><th>期限</th>
              {/* はじめは隠す列（表の「列」で選ぶと出る。仕様書 第6.1.2.1節） */}
              {extraColumns.map((c) => <th key={c.label} data-col-default="hidden" className={c.num ? 'num' : undefined}>{c.label}</th>)}
              {/* 印の列も「列」で出し入れできるよう見出しを付ける */}
              <th className="marks">状態</th>
            </tr>
          </thead>
          <tbody>
            {shown.map((i) => (
              <tr key={i.id} className="clickable" onClick={() => onOpen(i.id)}>
                <td className="inv-out-col">
                  {i.status === 'active' && (
                    <button className={`inv-cart${quick?.item.id === i.id ? ' on' : ''}`} onClick={(e) => { e.stopPropagation(); void openQuick(i); }}
                      aria-label={`${i.name} を出庫`} title="出庫">🛒</button>
                  )}
                </td>
                <td>
                  <button className="link" onClick={(e) => { e.stopPropagation(); onOpen(i.id); }}>{i.name}</button>
                </td>
                <td className="small nowrap">{inventoryKindLabel(i.kind)}</td>
                <td className="small muted">{i.category}</td>
                <td className="num">{qtyText(i, i.available)}</td>
                <td className="num muted onhand">{i.onHand !== i.available ? qtyText(i, i.onHand) : ''}</td>
                <td className="small date">{i.nearestExpiry ?? ''}</td>
                {extraColumns.map((c) => <td key={c.label} className={c.num ? 'num small nowrap' : 'small'}>{c.cell(i, extra)}</td>)}
                <td className="marks"><Marks item={i} compact /></td>
              </tr>
            ))}
          </tbody>
        </table></div>
      )}
      {!working && (
        <div className="row small inventory-foot">
          <label className="check"><input type="checkbox" checked={stopped} onChange={(e) => setStopped(e.target.checked)} /> 止めた品目も出す</label>
        </div>
      )}
    </div>
  );
}

/** 一覧から出庫する欄の中身。 */
interface QuickOutState {
  item: InventoryItemView;
  qty: number;
  purpose: InventoryOutPurpose;
}

/**
 * 一覧から出庫する欄（第29.9.1節）。数は 1、用途は品目の既定で開き、Enter か「記録する」で記録する。
 *
 * @remarks 数は − ＋ で変える（打つ欄に入れると、続けて読んだバーコードの数字が入ってしまうため）。
 * 手元は一覧の探す欄に置いたままにし、探す欄が空のときの Enter で記録、Esc で閉じる（一覧の側で受ける）
 */
function QuickOut({ state, onChange, onRecord, onClose }: {
  state: QuickOutState; onChange: (s: QuickOutState) => void; onRecord: () => void; onClose: () => void;
}) {
  const { item, qty } = state;
  return (
    <div className="card inv-quick" role="dialog" aria-label={`${item.name} を出庫`} onKeyDown={(e) => { if (e.key === 'Escape') onClose(); }}>
      <strong className="inv-quick-name">{item.name}</strong>
      <span className="small muted">使える数 {qtyText(item, item.available)}</span>
      <span className="inv-quick-qty">
        <button className="btn ghost small" onClick={() => onChange({ ...state, qty: Math.max(1, qty - 1) })} aria-label="1 つ減らす">−</button>
        <strong>{qty}</strong><span className="small">{item.unit}</span>
        <button className="btn ghost small" onClick={() => onChange({ ...state, qty: qty + 1 })} aria-label="1 つ増やす">＋</button>
      </span>
      <PurposeChips value={state.purpose} onChange={(purpose) => onChange({ ...state, purpose })} />
      <button className="btn" onClick={onRecord}>記録する</button>
      <button className="btn ghost small" onClick={onClose}>閉じる</button>
    </div>
  );
}

/** 知らないバーコードを読んだとき: 新しい品目にするか、既にある品目に結び付ける（第29.11節）。 */
function UnknownCode({ code, items, onNew, onLinked, onCancel }: {
  code: string; items: InventoryItemView[]; onNew: () => void; onLinked: (itemId: string) => void; onCancel: () => void;
}) {
  const [q, setQ] = useState('');
  const [error, setError] = useState<string | null>(null);
  const hits = q.trim() ? items.filter((i) => `${i.name}${i.sku}`.toLowerCase().includes(q.trim().toLowerCase())).slice(0, 8) : [];
  const link = async (id: string) => {
    try {
      await api.inventory.update(id, { codes: [code] });
      onLinked(id);
    } catch (e) {
      setError(describeError(e, '結び付けられませんでした'));
    }
  };
  return (
    <div className="card inventory-new">
      <div className="row wrap">
        <span className="small">{code}</span>
        <button className="btn small" onClick={onNew}>新しい品目にする</button>
        <input className="grow" placeholder="既にある品目に結び付ける（名前で探す）" value={q} onChange={(e) => setQ(e.target.value)} aria-label="結び付ける品目を探す" />
        <button className="btn ghost small" onClick={onCancel}>キャンセル</button>
      </div>
      {hits.length > 0 && (
        <ul className="plain">{hits.map((i) => <li key={i.id}><button className="link" onClick={() => void link(i.id)}>{i.name}</button></li>)}</ul>
      )}
      {error && <p className="error small">{error}</p>}
    </div>
  );
}

/**
 * 品目を追加する欄（名前・はじめの数・単位・分類と、読んだバーコード）。
 *
 * @remarks 数と単位を並べて置く（「3」「本」）。単位の欄に数が入っても、サーバーが数として読む（第29.6節）
 */
function NewItem({ initial, onCancel, onSaved }: {
  initial: { name: string; code: string };
  onCancel: () => void;
  onSaved: (id: string, note: string | null) => void;
}) {
  const [name, setName] = useState(initial.name);
  const [qty, setQty] = useState('');
  const [unit, setUnit] = useState('個');
  const [category, setCategory] = useState('');
  // 区分（第29.6.1節）。既定は消耗品
  const [kind, setKind] = useState<InventoryItemKind>('supply');
  const [error, setError] = useState<string | null>(null);
  // 知らないバーコードから作るときは、JAN から商品名を引いて欄に入れておく（第29.6節）。入れ始めた欄は上書きしない
  const [looking, setLooking] = useState<'busy' | 'none' | null>(null);
  useEffect(() => {
    if (!initial.code || initial.name || !/^\d{8,14}$/.test(initial.code)) return undefined;
    let alive = true;
    setLooking('busy');
    api.inventory.jan(initial.code).then((r) => {
      if (!alive) return;
      setLooking(r.found ? null : 'none');
      if (!r.found) return;
      setName((cur) => cur || r.name || '');
      setCategory((cur) => cur || r.category || '');
    }).catch(() => { if (alive) setLooking('none'); });
    return () => { alive = false; };
  }, [initial.code, initial.name]);
  const save = async () => {
    try {
      const n = qty.trim() === '' ? null : Number(qty);
      if (n !== null && (!Number.isFinite(n) || n < 0)) { setError('数は 0 以上で入れてください'); return; }
      const r = await api.inventory.create({ name, unit, category, kind, initialQty: n, ...(initial.code ? { codes: [initial.code] } : {}) });
      onSaved(r.item.id, r.note);
    } catch (e) {
      setError(describeError(e, '足せませんでした'));
    }
  };
  return (
    <div className="card inventory-new">
      <div className="row wrap">
        <input className="grow" autoFocus placeholder="品名" value={name} onChange={(e) => setName(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') void save(); }} />
        {initial.code && <span className="small muted">{initial.code}</span>}
        {looking === 'busy' && <span className="small muted" role="status">商品名を調べています…</span>}
        {looking === 'none' && <span className="small muted" role="status">商品名は見つかりませんでした</span>}
      </div>
      {/* 数と単位は同じ行に並べる（「3」「本」）。単位の欄に数を入れる取り違えを防ぐ */}
      <div className="row wrap">
        <input className="num-input" type="number" inputMode="decimal" min={0} placeholder="いまの数" value={qty}
          onChange={(e) => setQty(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') void save(); }} aria-label="いまの数" />
        <input className="unit-input" placeholder="個・本・冊" value={unit} onChange={(e) => setUnit(e.target.value)} aria-label="単位（数え方）" />
        <select value={kind} onChange={(e) => setKind(e.target.value as InventoryItemKind)} aria-label="区分">
          {INVENTORY_ITEM_KINDS.map((k) => <option key={k.id} value={k.id}>{k.label}</option>)}
        </select>
        <input className="short" placeholder="分類" value={category} onChange={(e) => setCategory(e.target.value)} aria-label="分類" />
        <button className="btn" disabled={!name.trim()} onClick={() => void save()}>追加</button>
        <button className="btn ghost" onClick={onCancel}>キャンセル</button>
      </div>
      {error && <p className="error small">{error}</p>}
    </div>
  );
}

/** 場所（倉庫と棚）。足す・外す（管理者）。 */
function Places({ locations, admin, onChanged }: { locations: InventoryLocation[]; admin: boolean; onChanged: () => void }) {
  const [warehouse, setWarehouse] = useState('');
  const [shelf, setShelf] = useState('');
  const [error, setError] = useState<string | null>(null);
  const add = async () => {
    try {
      await api.inventory.addLocation(warehouse, shelf);
      setShelf('');
      setError(null);
      onChanged();
    } catch (e) {
      setError(describeError(e, '足せませんでした'));
    }
  };
  const remove = async (id: string) => {
    try {
      await api.inventory.removeLocation(id);
      onChanged();
    } catch (e) {
      setError(describeError(e, '外せませんでした'));
    }
  };
  return (
    <div className="card inventory-places">
      <ul className="plain">
        {locations.map((l) => (
          <li key={l.id} className="row">
            <span className="grow">{placeName(l)}</span>
            {admin && <button className="link danger small" onClick={() => void remove(l.id)}>外す</button>}
          </li>
        ))}
      </ul>
      <div className="row wrap">
        <input className="short" placeholder="倉庫" value={warehouse} onChange={(e) => setWarehouse(e.target.value)} aria-label="倉庫" />
        <input className="short" placeholder="棚" value={shelf} onChange={(e) => setShelf(e.target.value)} aria-label="棚" />
        <button className="btn small" disabled={!warehouse.trim()} onClick={() => void add()}>追加</button>
      </div>
      {error && <p className="error small">{error}</p>}
    </div>
  );
}

/** 品目の詳細: 記録する・場所とロットごとの数・項目・最近の記録。 */
function ItemView({ id, onBack, userId, initialMessage = null }: { id: string; onBack: () => void; userId: string; initialMessage?: string | null }) {
  const [detail, setDetail] = useState<InventoryDetail | null>(null);
  const [list, setList] = useState<InventoryList | null>(null);
  const [suppliers, setSuppliers] = useState<InventorySupplier[]>([]);
  const [message, setMessage] = useState<string | null>(initialMessage);

  const load = useCallback(() => {
    Promise.all([api.inventory.get(id), api.inventory.list(), api.inventory.suppliers()])
      .then(([d, l, s]) => { setDetail(d); setList(l); setSuppliers(s.suppliers.filter((x) => x.status === 'active')); })
      .catch((e) => setMessage(describeError(e, '読み込めませんでした')));
  }, [id]);
  useEffect(load, [load]);

  if (!detail || !list) return <p className="muted">{message ?? '読み込んでいます…'}</p>;
  const { item } = detail;
  const margin = inventoryMargin(item);
  const locs = new Map(list.locations.map((l) => [l.id, l]));
  const reversed = new Set(detail.moves.map((m) => m.reversalOf).filter(Boolean));
  const today = todayJst();
  const canUndo = (m: InventoryMove) => m.createdBy === userId && !m.reversalOf && !reversed.has(m.id)
    && new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Tokyo', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(m.createdAt)) === today;
  const undo = async (moveId: string) => {
    try {
      await api.inventory.undo(moveId);
      setMessage('取り消しました');
      load();
    } catch (e) {
      setMessage(describeError(e, '取り消せませんでした'));
    }
  };
  const setStatus = async (status: 'active' | 'stopped') => {
    try {
      await api.inventory.setStatus(item.id, status);
      load();
    } catch (e) {
      setMessage(describeError(e, '変えられませんでした'));
    }
  };

  return (
    <div className="inventory">
      <button className="link small" onClick={onBack}>← 一覧</button>
      <div className="inventory-head">
        <h2>{item.name}</h2>
        <div className="inventory-figures">
          <span><span className="muted small">使える数</span> <strong>{qtyText(item, item.available)}</strong></span>
          {item.onHand !== item.available && <span className="muted small">在庫 {qtyText(item, item.onHand)}</span>}
          {item.reserved > 0 && <span className="muted small">引き当て {qtyText(item, item.reserved)}</span>}
          {/* 利益と利益率（利用範囲の管理者だけ。第29.6.2節） */}
          {list.admin && margin && <span className="muted small">利益 {yenText(margin.profit)}（利益率 {margin.rate}%・税抜）</span>}
          <Marks item={item} />
        </div>
      </div>
      {message && <p className="small muted" role="status">{message}</p>}
      {item.status === 'active' && (
        <MoveForm item={item} locations={list.locations} features={list.settings.features}
          onDone={(text) => { setMessage(text); load(); }} />
      )}
      {detail.stock.length > 0 && (
        <table className="table inventory-stock">
          <thead><tr><th>場所</th>{list.settings.features.lots && <th>ロット</th>}{list.settings.features.lots && <th>使用期限</th>}<th className="num">数</th></tr></thead>
          <tbody>
            {detail.stock.map((s) => (
              <tr key={`${s.locationId}:${s.lotId ?? ''}`}>
                <td>{placeName(locs.get(s.locationId))}</td>
                {list.settings.features.lots && <td>{s.lot ?? ''}</td>}
                {list.settings.features.lots && <td className={s.expiresOn && s.expiresOn < today ? 'danger' : ''}>{s.expiresOn ?? ''}</td>}
                <td className="num">{qtyText(item, s.qty)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <UsageChart weekly={detail.weekly ?? []} usage={detail.usage ?? null} unit={item.unit} />
      {list.settings.features.market !== false && <MarketSection item={item} admin={list.admin} />}
      <ItemFields item={item} unitsOn={list.settings.features.units} suppliers={suppliers} onSaved={load} admin={list.admin} />
      {detail.moves.length > 0 && (
        <>
          <h3>記録</h3>
          <ul className="plain inventory-moves">
            {detail.moves.map((m) => (
              <li key={m.id} className="row">
                <span className="small muted">{new Date(m.createdAt).toLocaleString('ja-JP', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })}</span>
                <span>{m.reversalOf ? '取り消し' : KIND_LABELS[m.kind]}</span>
                <span className="num">{m.kind === 'transfer' ? qtyText(item, m.delta) : `${m.delta > 0 ? '+' : ''}${qtyText(item, m.delta)}`}</span>
                <span className="small muted grow">
                  {m.kind === 'transfer' ? `${placeName(locs.get(m.fromLocationId ?? ''))} → ${placeName(locs.get(m.toLocationId ?? ''))}` : placeName(locs.get((m.toLocationId ?? m.fromLocationId) ?? ''))}
                  {m.purpose ? ` ${inventoryPurposeLabel(m.purpose)}` : ''}{m.lot ? ` ロット ${m.lot}` : ''}{m.reason ? ` ${m.reason}` : ''} {m.createdByName ?? ''}
                </span>
                {canUndo(m) && <button className="link small" onClick={() => void undo(m.id)}>取り消す</button>}
              </li>
            ))}
          </ul>
        </>
      )}
      {list.admin && (
        <div className="row small">
          {item.status === 'active'
            ? <button className="link danger" onClick={() => void setStatus('stopped')}>この品目を止める</button>
            : <button className="link" onClick={() => void setStatus('active')}>使うに戻す</button>}
        </div>
      )}
    </div>
  );
}

/** 入庫・出庫・移動・調整を記録する欄。 */
function MoveForm({ item, locations, features, onDone }: {
  item: InventoryItemView;
  locations: InventoryLocation[];
  features: InventoryList['settings']['features'];
  onDone: (text: string) => void;
}) {
  // いちばん多い出庫を、数 1 で選んでおく（第29.9.1節）
  const [kind, setKind] = useState<InventoryMoveKind>('out');
  const [qty, setQty] = useState('1');
  const [purpose, setPurpose] = useState<InventoryOutPurpose>(() => purposeOf(item));
  const [memo, setMemo] = useState(false);
  useEffect(() => setPurpose(purposeOf(item)), [item.id]); // eslint-disable-line react-hooks/exhaustive-deps
  const [pack, setPack] = useState(false);
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [lot, setLot] = useState('');
  const [expiresOn, setExpiresOn] = useState('');
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const canPack = features.units && !!item.packUnit && !!item.packSize;
  const withLot = features.lots && (kind === 'in' || kind === 'adjust');

  const save = async () => {
    const n = Number(qty);
    if (!Number.isFinite(n) || n === 0) { setError('数を入れてください'); return; }
    setBusy(true);
    setError(null);
    try {
      const r = await api.inventory.move({
        kind, itemId: item.id, qty: n, unit: pack && canPack ? 'pack' : 'unit',
        ...(from ? { locationId: from } : {}), ...(kind === 'transfer' && to ? { toLocationId: to } : {}),
        ...(withLot && lot ? { lot } : {}), ...(withLot && expiresOn ? { expiresOn } : {}),
        ...(reason ? { reason } : {}),
        ...(kind === 'out' ? { purpose } : {}),
      });
      setQty(kind === 'out' ? '1' : '');
      setLot('');
      setExpiresOn('');
      setReason('');
      setMemo(false);
      onDone([`${KIND_LABELS[kind]}${kind === 'out' ? `（${inventoryPurposeLabel(purpose)}）` : ''}を記録しました。使える数は ${qtyText(r.item, r.item.available)} です`, ...r.warnings].join('。'));
    } catch (e) {
      setError(describeError(e, '記録できませんでした'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="card inventory-move">
      <div className="row wrap">
        <div className="segmented" role="tablist">
          {(['out', 'in', 'transfer', 'adjust'] as InventoryMoveKind[]).map((k) => (
            <button key={k} role="tab" aria-selected={kind === k} className={kind === k ? 'on' : ''} onClick={() => setKind(k)}>{KIND_LABELS[k]}</button>
          ))}
        </div>
        <input className="num-input" type="number" inputMode="decimal" placeholder={kind === 'adjust' ? '増減（−も可）' : '数'} value={qty}
          onChange={(e) => setQty(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') void save(); }} aria-label="数" />
        {canPack
          ? (
            <div className="segmented">
              <button className={!pack ? 'on' : ''} onClick={() => setPack(false)}>{item.unit}</button>
              <button className={pack ? 'on' : ''} onClick={() => setPack(true)}>{item.packUnit}</button>
            </div>
          )
          : <span className="small muted">{item.unit}</span>}
        {locations.length > 1 && (
          <select value={from} onChange={(e) => setFrom(e.target.value)} aria-label={kind === 'transfer' ? '移動の元' : '場所'}>
            <option value="">{kind === 'transfer' ? '元: 今ある場所' : '場所: 今ある場所'}</option>
            {locations.map((l) => <option key={l.id} value={l.id}>{placeName(l)}</option>)}
          </select>
        )}
        {kind === 'transfer' && (
          <select value={to} onChange={(e) => setTo(e.target.value)} aria-label="移動の先">
            <option value="">先を選ぶ</option>
            {locations.map((l) => <option key={l.id} value={l.id}>{placeName(l)}</option>)}
          </select>
        )}
      </div>
      <div className="row wrap">
        {withLot && <input className="short" placeholder="ロット" value={lot} onChange={(e) => setLot(e.target.value)} aria-label="ロット" />}
        {withLot && <input type="date" value={expiresOn} onChange={(e) => setExpiresOn(e.target.value)} aria-label="使用期限" />}
        {kind === 'out' && <PurposeChips value={purpose} onChange={setPurpose} />}
        {/* 理由の文はふだん出さない。調整は理由が要るので出す。ほかは「メモ」で開く（第29.9.1節） */}
        {kind === 'adjust' || memo
          ? <input className="grow" placeholder={kind === 'adjust' ? '理由（必須）' : 'メモ'} value={reason} onChange={(e) => setReason(e.target.value)} aria-label={kind === 'adjust' ? '理由' : 'メモ'} />
          : <button className="link small" onClick={() => setMemo(true)}>メモ</button>}
        <button className="btn" disabled={busy || !qty || (kind === 'transfer' && !to) || (kind === 'adjust' && !reason.trim())} onClick={() => void save()}>記録する</button>
      </div>
      {error && <p className="error small">{error}</p>}
    </div>
  );
}

/** 品目の項目（その場で直す）。 */
function ItemFields({ item, unitsOn, suppliers, onSaved, admin = false }: {
  item: InventoryItemView; unitsOn: boolean; suppliers: InventorySupplier[]; onSaved: () => void;
  /** 利用範囲の管理者か（仕入価格を見て直せる。第29.6.2節）。 */
  admin?: boolean;
}) {
  const [draft, setDraft] = useState(() => toDraft(item));
  const [code, setCode] = useState('');
  const [error, setError] = useState<string | null>(null);
  useEffect(() => setDraft(toDraft(item)), [item]);
  const changed = JSON.stringify(draft) !== JSON.stringify(toDraft(item));
  const numOrNull = (v: string) => (v.trim() === '' ? null : Number(v));

  const save = async (extraCode?: string) => {
    try {
      await api.inventory.update(item.id, {
        name: draft.name, publicName: draft.publicName, sku: draft.sku, category: draft.category, kind: draft.kind, taxRate: draft.taxRate, unit: draft.unit, note: draft.note,
        packUnit: draft.packUnit, packSize: numOrNull(draft.packSize), price: numOrNull(draft.price), employeePrice: numOrNull(draft.employeePrice), lowThreshold: numOrNull(draft.lowThreshold),
        // 仕入価格は利用範囲の管理者だけが送る（第29.6.2節）
        ...(admin ? { purchasePrice: numOrNull(draft.purchasePrice), purchaseTaxIncluded: draft.purchaseTaxIncluded } : {}),
        supplierId: draft.supplierId || null, leadDays: numOrNull(draft.leadDays),
        ...(extraCode ? { codes: [extraCode] } : {}),
      });
      setError(null);
      setCode('');
      onSaved();
    } catch (e) {
      setError(describeError(e, '保存できませんでした'));
    }
  };
  const removeCode = async (c: string) => {
    await api.inventory.removeCode(item.id, c).catch(() => undefined);
    onSaved();
  };
  const field = (key: keyof ReturnType<typeof toDraft>, label: string, type = 'text') => (
    <>
      <dt>{label}</dt>
      <dd><input type={type} value={String(draft[key])} onChange={(e) => setDraft({ ...draft, [key]: e.target.value })} /></dd>
    </>
  );

  return (
    <div className="inventory-fields">
      <dl className="card-fields">
        {field('name', '品名')}
        {field('publicName', '公開する名前')}
        {field('sku', '自社のコード')}
        {field('category', '分類')}
        <dt>区分</dt>
        <dd>
          <select value={draft.kind} onChange={(e) => setDraft({ ...draft, kind: e.target.value as InventoryItemKind })} aria-label="区分">
            {INVENTORY_ITEM_KINDS.map((k) => <option key={k.id} value={k.id}>{k.label}</option>)}
          </select>
        </dd>
        {field('unit', '単位')}
        {unitsOn && field('packUnit', '仕入れの単位')}
        {unitsOn && field('packSize', '入り数', 'number')}
        <dt>販売価格</dt>
        <dd>
          {/* 販売価格を入れはじめたら、消耗品のままの品目は販売品にする（選び直せる。第29.6.1節） */}
          <input type="number" value={draft.price} onChange={(e) => setDraft({
            ...draft, price: e.target.value,
            ...(item.price === null && draft.price === '' && e.target.value !== '' && draft.kind === 'supply' ? { kind: 'sale' as const } : {}),
          })} />
        </dd>
        {draft.kind === 'sale' && (
          <>
            <dt>消費税率</dt>
            <dd>
              <select value={draft.taxRate} onChange={(e) => setDraft({ ...draft, taxRate: Number(e.target.value) === 8 ? 8 : 10 })} aria-label="消費税率">
                <option value={10}>10%</option>
                <option value={8}>8%（軽減税率）</option>
              </select>
            </dd>
          </>
        )}
        {field('employeePrice', '社員価格', 'number')}
        {admin && (
          <>
            <dt>仕入価格</dt>
            <dd>
              <input type="number" value={draft.purchasePrice} onChange={(e) => setDraft({ ...draft, purchasePrice: e.target.value })} aria-label="仕入価格（1 つあたり）" />
              <select value={draft.purchaseTaxIncluded ? 'in' : 'ex'} onChange={(e) => setDraft({ ...draft, purchaseTaxIncluded: e.target.value === 'in' })} aria-label="仕入価格の税">
                <option value="ex">税抜</option>
                <option value="in">税込</option>
              </select>
            </dd>
          </>
        )}
        {field('lowThreshold', '残りわずかの目安', 'number')}
        <dt>仕入先</dt>
        <dd>
          <select value={draft.supplierId} onChange={(e) => setDraft({ ...draft, supplierId: e.target.value })} aria-label="仕入先">
            <option value="">決めていない</option>
            {suppliers.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
          </select>
        </dd>
        {field('leadDays', '仕入れにかかる日数', 'number')}
        <dt>バーコード</dt>
        <dd>
          {item.codes.map((c) => (
            <span key={c} className="code-chip">{c} <button className="edit-btn" aria-label={`${c} を外す`} onClick={() => void removeCode(c)}>×</button></span>
          ))}
          <input className="short" placeholder="読むか打つ" value={code} onChange={(e) => setCode(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter' && code.trim()) void save(code.trim()); }} aria-label="バーコードを足す" />
        </dd>
        <dt>メモ</dt>
        <dd><textarea value={draft.note} onChange={(e) => setDraft({ ...draft, note: e.target.value })} /></dd>
      </dl>
      {changed && (
        <div className="row">
          <button className="btn" onClick={() => void save()}>保存</button>
          <button className="btn ghost" onClick={() => setDraft(toDraft(item))}>戻す</button>
        </div>
      )}
      {error && <p className="error small">{error}</p>}
    </div>
  );
}

function toDraft(i: InventoryItem) {
  const s = (n: number | null) => (n === null ? '' : String(n));
  return {
    name: i.name, publicName: i.publicName, sku: i.sku, category: i.category, kind: i.kind, taxRate: i.taxRate as 10 | 8, unit: i.unit, packUnit: i.packUnit,
    packSize: s(i.packSize), price: s(i.price), employeePrice: s(i.employeePrice), lowThreshold: s(i.lowThreshold), note: i.note,
    purchasePrice: s(i.purchasePrice ?? null), purchaseTaxIncluded: !!i.purchaseTaxIncluded,
    supplierId: i.supplierId ?? '', leadDays: s(i.leadDays),
  };
}
