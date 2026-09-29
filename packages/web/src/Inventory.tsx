/**
 * @file 在庫管理の画面。品目の一覧と検索・バーコードで引く・品目を足す・取り込みと書き出し・場所・品目の詳細と入出庫の記録と取り消し。
 *
 * 数は使える数（在庫 − 引き当て − 期限切れ）を先に出す。説明文を常に出さない（原則 u11）。分からなければ秘書に聞けばよい。
 * バーコードのスキャナーは文字を打って Enter を押すため、探す欄でそのまま読める（カメラで読むのは第29.11.1節の画面）。
 *
 * @see 仕様書 第29章 在庫管理
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import type { InventoryItem, InventoryItemView, InventoryLocation, InventoryMove, InventoryMoveKind } from '@m2office/shared';
import { api, describeError, type InventoryDetail, type InventoryList } from './api.js';

const KIND_LABELS: Record<InventoryMoveKind, string> = { in: '入庫', out: '使用', transfer: '移動', adjust: '調整' };

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
  if (itemId) return <ItemView id={itemId} onBack={() => { setFlash(null); onOpen(null); }} userId={userId} initialMessage={flash} />;
  return <ListView onOpen={(id, note) => { setFlash(note ?? null); onOpen(id); }} />;
}

/** 印（残りわずか・期限切れ・マイナス）。 */
function Marks({ item }: { item: InventoryItemView }) {
  return (
    <>
      {item.status === 'stopped' && <span className="badge">止めた</span>}
      {item.onHand < 0 && <span className="badge danger">マイナス</span>}
      {item.expired > 0 && <span className="badge danger">期限切れ {qtyText(item, item.expired)}</span>}
      {item.low && item.status === 'active' && <span className="badge warn">残りわずか</span>}
    </>
  );
}

/** 一覧・探す（バーコードも）・品目を足す・取り込みと書き出し・場所。 */
function ListView({ onOpen }: { onOpen: (id: string, note?: string | null) => void }) {
  const [list, setList] = useState<InventoryList | null>(null);
  const [q, setQ] = useState('');
  const [stopped, setStopped] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [adding, setAdding] = useState<{ name: string; code: string } | null>(null);
  const [places, setPlaces] = useState(false);
  const [busy, setBusy] = useState(false);
  const picker = useRef<HTMLInputElement>(null);

  const load = useCallback(() => {
    api.inventory.list({ q, stopped }).then(setList).catch((e) => setMessage(describeError(e, '読み込めませんでした')));
  }, [q, stopped]);
  useEffect(() => {
    const t = setTimeout(load, q ? 250 : 0);
    return () => clearTimeout(t);
  }, [load, q]);

  /** Enter で、バーコードとして引く。当たれば開き、無ければ品目を足す欄にコードを入れる。 */
  const scan = async () => {
    const code = q.trim();
    if (!code) return;
    try {
      const r = await api.inventory.lookup(code);
      if (r.item) { onOpen(r.item.id); return; }
      if (r.location) { setQ(''); setMessage(`棚「${placeName(r.location)}」のラベルです`); return; }
      if (r.parsed.kind !== 'other') setAdding({ name: '', code: r.parsed.code });
    } catch (e) {
      setMessage(describeError(e, '読めませんでした'));
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
      <div className="cards-toolbar">
        <input className="cards-search" type="search" placeholder="品名・コード・バーコード" value={q} aria-label="品目を探す"
          onChange={(e) => setQ(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') void scan(); }} />
        <button className="btn" onClick={() => setAdding({ name: q.trim(), code: '' })}>品目を足す</button>
        <button className="btn ghost" disabled={busy} onClick={() => picker.current?.click()}>取り込む</button>
        <button className="btn ghost" onClick={() => void api.inventory.exportFile('csv').catch((e) => setMessage(describeError(e, '書き出せませんでした')))}>書き出す</button>
        <input ref={picker} type="file" hidden accept=".csv,.xlsx,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
          onChange={(e) => void importFile(e.target.files?.[0])} />
      </div>
      {message && <p className="small muted" role="status">{message}</p>}
      {adding && (
        <NewItem initial={adding} onCancel={() => setAdding(null)}
          onSaved={(id, note) => { setAdding(null); onOpen(id, note); }} />
      )}
      {list && list.items.length === 0 && !adding && <p className="muted">{q ? '見つかりませんでした' : '品目はまだありません'}</p>}
      {list && list.items.length > 0 && (
        <table className="table inventory-table">
          <thead>
            <tr><th>品名</th><th className="num">使える数</th><th className="num onhand">在庫</th><th>期限</th><th /></tr>
          </thead>
          <tbody>
            {list.items.map((i) => (
              <tr key={i.id} className="clickable" onClick={() => onOpen(i.id)}>
                <td>
                  <button className="link" onClick={(e) => { e.stopPropagation(); onOpen(i.id); }}>{i.name}</button>
                  {i.category && <span className="muted small"> {i.category}</span>}
                </td>
                <td className="num">{qtyText(i, i.available)}</td>
                <td className="num muted onhand">{i.onHand !== i.available ? qtyText(i, i.onHand) : ''}</td>
                <td className="small date">{i.nearestExpiry ?? ''}</td>
                <td className="marks"><Marks item={i} /></td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <div className="row small inventory-foot">
        <label className="check"><input type="checkbox" checked={stopped} onChange={(e) => setStopped(e.target.checked)} /> 止めた品目も出す</label>
        <button className="link" onClick={() => setPlaces(!places)}>{places ? '場所を閉じる' : `場所（${list?.locations.length ?? 0}）`}</button>
      </div>
      {places && list && <Places locations={list.locations} admin={list.admin} onChanged={load} />}
    </div>
  );
}

/**
 * 品目を足す欄（名前・はじめの数・単位・分類と、読んだバーコード）。
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
  const [error, setError] = useState<string | null>(null);
  const save = async () => {
    try {
      const n = qty.trim() === '' ? null : Number(qty);
      if (n !== null && (!Number.isFinite(n) || n < 0)) { setError('数は 0 以上で入れてください'); return; }
      const r = await api.inventory.create({ name, unit, category, initialQty: n, ...(initial.code ? { codes: [initial.code] } : {}) });
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
      </div>
      {/* 数と単位は同じ行に並べる（「3」「本」）。単位の欄に数を入れる取り違えを防ぐ */}
      <div className="row wrap">
        <input className="num-input" type="number" inputMode="decimal" min={0} placeholder="いまの数" value={qty}
          onChange={(e) => setQty(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') void save(); }} aria-label="いまの数" />
        <input className="unit-input" placeholder="個・本・冊" value={unit} onChange={(e) => setUnit(e.target.value)} aria-label="単位（数え方）" />
        <input className="short" placeholder="分類" value={category} onChange={(e) => setCategory(e.target.value)} aria-label="分類" />
        <button className="btn" disabled={!name.trim()} onClick={() => void save()}>足す</button>
        <button className="btn ghost" onClick={onCancel}>やめる</button>
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
        <button className="btn small" disabled={!warehouse.trim()} onClick={() => void add()}>足す</button>
      </div>
      {error && <p className="error small">{error}</p>}
    </div>
  );
}

/** 品目の詳細: 記録する・場所とロットごとの数・項目・最近の記録。 */
function ItemView({ id, onBack, userId, initialMessage = null }: { id: string; onBack: () => void; userId: string; initialMessage?: string | null }) {
  const [detail, setDetail] = useState<InventoryDetail | null>(null);
  const [list, setList] = useState<InventoryList | null>(null);
  const [message, setMessage] = useState<string | null>(initialMessage);

  const load = useCallback(() => {
    Promise.all([api.inventory.get(id), api.inventory.list()])
      .then(([d, l]) => { setDetail(d); setList(l); })
      .catch((e) => setMessage(describeError(e, '読み込めませんでした')));
  }, [id]);
  useEffect(load, [load]);

  if (!detail || !list) return <p className="muted">{message ?? '読み込んでいます…'}</p>;
  const { item } = detail;
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
      <ItemFields item={item} unitsOn={list.settings.features.units} onSaved={load} />
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
                  {m.lot ? ` ロット ${m.lot}` : ''}{m.reason ? ` ${m.reason}` : ''} {m.createdByName ?? ''}
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

/** 入庫・使用・移動・調整を記録する欄。 */
function MoveForm({ item, locations, features, onDone }: {
  item: InventoryItemView;
  locations: InventoryLocation[];
  features: InventoryList['settings']['features'];
  onDone: (text: string) => void;
}) {
  const [kind, setKind] = useState<InventoryMoveKind>('in');
  const [qty, setQty] = useState('');
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
      });
      setQty('');
      setLot('');
      setExpiresOn('');
      setReason('');
      onDone([`${KIND_LABELS[kind]}を記録しました。使える数は ${qtyText(r.item, r.item.available)} です`, ...r.warnings].join('。'));
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
          {(['in', 'out', 'transfer', 'adjust'] as InventoryMoveKind[]).map((k) => (
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
        <input className="grow" placeholder={kind === 'adjust' ? '理由（必須）' : '理由'} value={reason} onChange={(e) => setReason(e.target.value)} aria-label="理由" />
        <button className="btn" disabled={busy || !qty || (kind === 'transfer' && !to) || (kind === 'adjust' && !reason.trim())} onClick={() => void save()}>記録する</button>
      </div>
      {error && <p className="error small">{error}</p>}
    </div>
  );
}

/** 品目の項目（その場で直す）。 */
function ItemFields({ item, unitsOn, onSaved }: { item: InventoryItemView; unitsOn: boolean; onSaved: () => void }) {
  const [draft, setDraft] = useState(() => toDraft(item));
  const [code, setCode] = useState('');
  const [error, setError] = useState<string | null>(null);
  useEffect(() => setDraft(toDraft(item)), [item]);
  const changed = JSON.stringify(draft) !== JSON.stringify(toDraft(item));
  const numOrNull = (v: string) => (v.trim() === '' ? null : Number(v));

  const save = async (extraCode?: string) => {
    try {
      await api.inventory.update(item.id, {
        name: draft.name, publicName: draft.publicName, sku: draft.sku, category: draft.category, unit: draft.unit, note: draft.note,
        packUnit: draft.packUnit, packSize: numOrNull(draft.packSize), price: numOrNull(draft.price), lowThreshold: numOrNull(draft.lowThreshold),
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
      <dd><input type={type} value={draft[key]} onChange={(e) => setDraft({ ...draft, [key]: e.target.value })} /></dd>
    </>
  );

  return (
    <div className="inventory-fields">
      <dl className="card-fields">
        {field('name', '品名')}
        {field('publicName', '公開する名前')}
        {field('sku', '自社のコード')}
        {field('category', '分類')}
        {field('unit', '単位')}
        {unitsOn && field('packUnit', '仕入れの単位')}
        {unitsOn && field('packSize', '入り数', 'number')}
        {field('price', '販売価格', 'number')}
        {field('lowThreshold', '残りわずかの目安', 'number')}
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
    name: i.name, publicName: i.publicName, sku: i.sku, category: i.category, unit: i.unit, packUnit: i.packUnit,
    packSize: s(i.packSize), price: s(i.price), lowThreshold: s(i.lowThreshold), note: i.note,
  };
}
