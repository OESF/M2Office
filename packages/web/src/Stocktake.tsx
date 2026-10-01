/**
 * @file 棚卸しの画面（仕様書 第29.10節・第29.11.1節）。始める・数える・差の一覧・確定。
 *
 * パソコンの画面の棚卸し。USB のバーコードリーダーで読むか名前で探して数え、差の一覧を見て確定する。
 * スマホではスマホ用のページ（MobileInventory.tsx）で数える（仕様書 第29.11.1節）。
 * 棚のラベル（QR）を読めば場所が決まり、品目のバーコードを読むたびに 1 つ足す。GS1 を読めばロットと使用期限も決まる。
 * 差の一覧は差の大きい順。数えていない品目は確定しても 0 にしない。説明文を常に出さない（原則 u11）。
 */

import { useCallback, useEffect, useState } from 'react';
import type { InventoryCountRow, InventoryCountScope, InventoryCountView, InventoryItemView, InventoryLocation } from '@m2office/shared';
import { api, describeError } from './api.js';

const round = (n: number) => Math.round(n * 1000) / 1000;
const placeName = (l: InventoryLocation | undefined) => (l ? (l.shelf ? `${l.warehouse} ${l.shelf}` : l.warehouse) : '—');
const qtyOf = (r: Pick<InventoryCountRow, 'unit' | 'packUnit' | 'packSize'>, n: number) =>
  (r.packUnit && r.packSize && n !== 0 ? `${round(n)} ${r.unit}（${round(n / r.packSize)} ${r.packUnit}）` : `${round(n)} ${r.unit}`);

/**
 * 棚卸しの画面。
 *
 * @param userId 見ている人（始めた人と管理者は確定できる）
 * @param onBack 在庫の一覧に戻る
 */
export function Stocktake({ userId, onBack }: { userId: string; onBack: () => void }) {
  const [view, setView] = useState<InventoryCountView | null | undefined>(undefined);
  const [admin, setAdmin] = useState(false);
  const [locations, setLocations] = useState<InventoryLocation[]>([]);
  const [items, setItems] = useState<InventoryItemView[]>([]);
  const [message, setMessage] = useState<string | null>(null);

  const load = useCallback(() => {
    Promise.all([api.inventory.counts.current(), api.inventory.list()])
      .then(([c, l]) => { setView(c.open); setLocations(l.locations); setItems(l.items); setAdmin(l.admin); })
      .catch((e) => setMessage(describeError(e, '読み込めませんでした')));
  }, []);
  useEffect(load, [load]);

  if (view === undefined) return <p className="muted">{message ?? '読み込んでいます…'}</p>;
  return (
    <div className="inventory stocktake">
      <button className="link small" onClick={onBack}>← 在庫</button>
      {message && <p className="small muted" role="status">{message}</p>}
      {view
        ? <Counting view={view} locations={locations} items={items} userId={userId} admin={admin}
          onChanged={setView} onDone={(text) => { setMessage(text); load(); }} />
        : <StartForm locations={locations} items={items} onStarted={(v) => { setMessage(null); setView(v); }} />}
    </div>
  );
}

/** 棚卸しを始める（対象: 全体・場所・分類）。 */
function StartForm({ locations, items, onStarted }: {
  locations: InventoryLocation[]; items: InventoryItemView[]; onStarted: (v: InventoryCountView) => void;
}) {
  const [scope, setScope] = useState<InventoryCountScope>('all');
  const [value, setValue] = useState('');
  const [error, setError] = useState<string | null>(null);
  const categories = [...new Set(items.map((i) => i.category).filter(Boolean))].sort();
  const start = async () => {
    try {
      const r = await api.inventory.counts.start(scope, scope === 'all' ? undefined : value);
      onStarted(r.view);
    } catch (e) {
      setError(describeError(e, '始められませんでした'));
    }
  };
  return (
    <div className="card inventory-move">
      <h2>棚卸し</h2>
      <div className="row wrap">
        <div className="segmented" role="tablist">
          {([['all', '全体'], ['location', '場所'], ['category', '分類']] as const).map(([k, label]) => (
            <button key={k} role="tab" aria-selected={scope === k} className={scope === k ? 'on' : ''}
              disabled={(k === 'location' && locations.length === 0) || (k === 'category' && categories.length === 0)}
              onClick={() => { setScope(k); setValue(''); }}>{label}</button>
          ))}
        </div>
        {scope === 'location' && (
          <select value={value} onChange={(e) => setValue(e.target.value)} aria-label="場所">
            <option value="">場所を選ぶ</option>
            {locations.map((l) => <option key={l.id} value={l.id}>{placeName(l)}</option>)}
          </select>
        )}
        {scope === 'category' && (
          <select value={value} onChange={(e) => setValue(e.target.value)} aria-label="分類">
            <option value="">分類を選ぶ</option>
            {categories.map((c) => <option key={c} value={c}>{c}</option>)}
          </select>
        )}
        <button className="btn" disabled={scope !== 'all' && !value} onClick={() => void start()}>始める</button>
      </div>
      {error && <p className="error small">{error}</p>}
    </div>
  );
}

/** 数える・差の一覧・確定。 */
function Counting({ view, locations, items, userId, admin, onChanged, onDone }: {
  view: InventoryCountView; locations: InventoryLocation[]; items: InventoryItemView[]; userId: string; admin: boolean;
  onChanged: (v: InventoryCountView) => void; onDone: (text: string) => void;
}) {
  const { count } = view;
  const [tab, setTab] = useState<'count' | 'diff'>('count');
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const scoped = count.scope === 'location' ? count.scopeValue : '';
  const [locationId, setLocationId] = useState(scoped || (locations.length === 1 ? locations[0]!.id : ''));
  const [last, setLast] = useState<InventoryCountRow | null>(null);
  const [setQty, setSetQty] = useState('');
  const [pack, setPack] = useState(false);
  const [search, setSearch] = useState('');
  const [note, setNote] = useState<string | null>(null);
  const [explain, setExplain] = useState<string | null | undefined>(undefined);
  const locs = new Map(locations.map((l) => [l.id, l]));
  const canClose = count.startedBy === userId || admin;
  const scopeText = count.scope === 'all' ? '全体' : count.scope === 'location' ? placeName(locs.get(count.scopeValue)) : count.scopeValue;

  const refresh = useCallback(async () => onChanged(await api.inventory.counts.get(count.id)), [count.id, onChanged]);

  /** 品目を 1 つ足す（数を入れたら、その数で置き換える）。 */
  const countItem = async (itemId: string, extra: { lot?: string; expiresOn?: string } = {}, qty?: { n: number; mode: 'add' | 'set' }) => {
    setBusy(true);
    setNote(null);
    try {
      const r = await api.inventory.counts.count(count.id, {
        itemId, qty: qty?.n ?? 1, mode: qty?.mode ?? 'add', unit: pack ? 'pack' : 'unit',
        ...(locationId ? { locationId } : {}), ...extra,
      });
      setLast(r.row);
      void refresh();
    } catch (e) {
      setNote(describeError(e, '数えられませんでした'));
    } finally {
      setBusy(false);
    }
  };

  /** 読んだ値: 棚のラベルなら場所を決め、品目なら 1 つ足す。 */
  const onCode = async (code: string) => {
    setBusy(true);
    try {
      const r = await api.inventory.lookup(code);
      if (r.location) {
        if (scoped && r.location.id !== scoped) { setNote(`この棚卸しは ${scopeText} だけです`); return; }
        setLocationId(r.location.id);
        setNote(`${placeName(r.location)} を数えます`);
        return;
      }
      if (!r.item) { setNote(`知らないバーコードです（${r.parsed.code}）。名前で探して選べます`); return; }
      setBusy(false);
      await countItem(r.item.id, { ...(r.parsed.lot ? { lot: r.parsed.lot } : {}), ...(r.parsed.expiresOn ? { expiresOn: r.parsed.expiresOn } : {}) });
    } catch (e) {
      setNote(describeError(e, '読めませんでした'));
    } finally {
      setBusy(false);
    }
  };

  // 差の一覧を開いたら、差の大きい品目の理由を秘書に一度だけ考えてもらう（推測。第29.10節）
  useEffect(() => {
    if (tab !== 'diff' || explain !== undefined || view.differing === 0) return;
    setExplain(null);
    api.inventory.counts.explain(count.id).then((r) => setExplain(r.text)).catch(() => setExplain(null));
  }, [tab, explain, view.differing, count.id]);

  const close = async () => {
    try {
      const r = await api.inventory.counts.close(count.id);
      onDone(`棚卸しを確定しました。${r.adjusted} 件を調整しました${r.uncounted ? `。数えていない ${r.uncounted} 件はそのままです` : ''}`);
    } catch (e) {
      setNote(describeError(e, '確定できませんでした'));
    }
  };
  const cancel = async () => {
    try {
      await api.inventory.counts.cancel(count.id);
      onDone('棚卸しをやめました。帳簿は変えていません');
    } catch (e) {
      setNote(describeError(e, 'やめられませんでした'));
    }
  };

  const found = search.trim()
    ? items.filter((i) => `${i.name}${i.sku}${i.category}`.toLowerCase().includes(search.trim().toLowerCase())).slice(0, 8)
    : [];

  return (
    <>
      <div className="inventory-head">
        <h2>棚卸し</h2>
        <span className="muted small">{scopeText}・{count.startedByName ?? ''}・数えた {view.counted}・数えていない {view.uncounted}</span>
      </div>
      <div className="segmented" role="tablist">
        <button role="tab" aria-selected={tab === 'count'} className={tab === 'count' ? 'on' : ''} onClick={() => setTab('count')}>数える</button>
        <button role="tab" aria-selected={tab === 'diff'} className={tab === 'diff' ? 'on' : ''} onClick={() => setTab('diff')}>
          差の一覧{view.differing ? `（${view.differing}）` : ''}
        </button>
      </div>

      {tab === 'count' && (
        <div className="card inventory-move stocktake-count">
          <div className="row wrap">
            <select value={locationId} disabled={!!scoped} onChange={(e) => setLocationId(e.target.value)} aria-label="数える場所">
              <option value="">場所: 今ある場所</option>
              {locations.map((l) => <option key={l.id} value={l.id}>{placeName(l)}</option>)}
            </select>
            <input className="grow" placeholder="バーコード" value={code} aria-label="バーコード（リーダーで読む）"
              onChange={(e) => setCode(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter' && code.trim()) { const c = code; setCode(''); void onCode(c); } }} />
          </div>
          {last && (
            <div className="stocktake-last" aria-live="polite">
              <div className="stocktake-name">{last.itemName}{last.lot ? <span className="muted small"> ロット {last.lot}</span> : null}</div>
              <div className="stocktake-qty">{qtyOf(last, last.counted ?? 0)}</div>
              <div className="muted small">{placeName(locs.get(last.locationId))}・帳簿 {qtyOf(last, last.book)}</div>
              <div className="row wrap">
                <button className="btn" disabled={busy} onClick={() => void countItem(last.itemId, last.lot ? { lot: last.lot } : {})}>＋1</button>
                <input className="num-input" type="number" inputMode="decimal" min={0} placeholder="数え直す" value={setQty}
                  onChange={(e) => setSetQty(e.target.value)} aria-label="数え直した数" />
                {last.packUnit && last.packSize ? (
                  <div className="segmented">
                    <button className={!pack ? 'on' : ''} onClick={() => setPack(false)}>{last.unit}</button>
                    <button className={pack ? 'on' : ''} onClick={() => setPack(true)}>{last.packUnit}</button>
                  </div>
                ) : null}
                <button className="btn ghost" disabled={busy || setQty === ''} onClick={() => {
                  const n = Number(setQty);
                  if (!Number.isFinite(n) || n < 0) return;
                  setSetQty('');
                  void countItem(last.itemId, last.lot ? { lot: last.lot } : {}, { n, mode: 'set' });
                }}>置き換える</button>
              </div>
            </div>
          )}
          <div className="row wrap">
            <input className="grow" placeholder="名前で探す" value={search} onChange={(e) => setSearch(e.target.value)} aria-label="品目を名前で探す" />
          </div>
          {found.length > 0 && (
            <ul className="plain stocktake-found">
              {found.map((i) => (
                <li key={i.id}><button className="link" onClick={() => { setSearch(''); void countItem(i.id); }}>{i.name}</button></li>
              ))}
            </ul>
          )}
          {note && <p className="small muted" role="status">{note}</p>}
        </div>
      )}

      {tab === 'diff' && (
        <div className="stocktake-diff">
          {explain && <div className="card stocktake-explain small"><Lines text={explain} /></div>}
          <table className="table">
            <thead><tr><th>品名</th><th>場所</th><th className="num">帳簿</th><th className="num">数えた</th><th className="num">差</th></tr></thead>
            <tbody>
              {view.rows.map((r) => (
                <tr key={`${r.itemId}:${r.locationId}:${r.lotId ?? ''}`} className={r.counted === null ? 'muted' : ''}>
                  <td>{r.itemName}{r.lot ? <span className="muted small"> {r.lot}</span> : null}</td>
                  <td className="small">{placeName(locs.get(r.locationId))}</td>
                  <td className="num">{qtyOf(r, r.book)}</td>
                  <td className="num">{r.counted === null ? '数えていない' : qtyOf(r, r.counted)}</td>
                  <td className={`num ${r.diff && r.diff < 0 ? 'danger' : ''}`}>{r.diff === null ? '' : `${r.diff > 0 ? '+' : ''}${round(r.diff)}`}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <div className="row wrap">
            {canClose && <button className="btn" onClick={() => void close()}>確定する</button>}
            {canClose && view.uncounted > 0 && <span className="small muted">数えていない {view.uncounted} 件はそのままにします</span>}
            <button className="btn ghost" onClick={() => void api.inventory.counts.exportFile(count.id).catch((e) => setNote(describeError(e, '書き出せませんでした')))}>書き出し</button>
            {canClose && <button className="link danger small" onClick={() => void cancel()}>やめる</button>}
          </div>
          {note && <p className="small muted" role="status">{note}</p>}
        </div>
      )}
    </>
  );
}

/** 秘書の理由の行（「- 品目: 理由」）を並べる。 */
function Lines({ text }: { text: string }) {
  return <ul className="plain">{text.split('\n').filter(Boolean).map((l, i) => <li key={i}>{l.replace(/^-\s*/, '')}</li>)}</ul>;
}
