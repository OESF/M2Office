/**
 * @file 在庫管理のパソコンの画面の「販売管理とのつなぎ」と「照らせなかった販売」（仕様書 第29.20.1節、ADR-0087）。
 *
 * つなぎは、販売管理（レジ・POS・EC）ごとに作る。作ると鍵が一度だけ出る（M2Office はハッシュだけを持つ）。
 * 管理者が、渡す品目と項目（使える数か状態だけか・販売価格・社員価格）を選び、見本で確かめて「この内容で渡す」を押す。
 * 押すことが承認である（社外への送信。第9.4.0節）。承認した範囲の数の変化は、販売管理が読みに来て取る。
 * 照らせなかった販売は、在庫管理を使う人が品目を選んで記録する。説明文を常に出さない（原則 u11）。
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import type { InventoryItemView, InventorySaleUnmatched, InventorySalesLink, InventorySalesScope } from '@m2office/shared';
import { api, describeError, type InventorySalesItemView } from './api.js';
import { copyText } from './clipboard.js';

/** 日本時間の日時。 */
const when = (iso: string | null) => (iso ? new Date(iso).toLocaleString('ja-JP', { dateStyle: 'medium', timeStyle: 'short' }) : '—');

/** 2 つの範囲が同じか（品目の順は問わない）。 */
function sameScope(a: InventorySalesScope, b: InventorySalesScope): boolean {
  const set = (x: string[]) => [...x].sort().join('\u0000');
  return set(a.itemIds) === set(b.itemIds) && a.showCount === b.showCount && a.price === b.price && a.employeePrice === b.employeePrice;
}

/** 承認する前の、はじめの選び方（販売品に当たる分類があればその品目、無ければ何も選ばない。社員価格は渡さない）。 */
function initialScope(items: InventoryItemView[]): InventorySalesScope {
  const sale = items.filter((i) => i.status === 'active' && /販売/.test(i.category));
  return { itemIds: sale.map((i) => i.id), showCount: true, price: true, employeePrice: false };
}

const STATUS_LABEL = { in_stock: '在庫あり', low: '残りわずか', out: '終了' } as const;
const ACTION_LABEL = { hold: '注文', use: '販売', return: '返品' } as const;

/**
 * 販売管理とのつなぎの欄。管理者にだけ出す（呼ぶ側で確かめる）。
 *
 * @param items 品目の一覧（止めた品目を含まない）
 */
export function SalesLinksPanel({ items }: { items: InventoryItemView[] }) {
  const [list, setList] = useState<InventorySalesLink[] | null>(null);
  const [max, setMax] = useState(8);
  const [current, setCurrent] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [naming, setNaming] = useState<string | null>(null);
  const [shownKey, setShownKey] = useState<{ linkId: string; key: string } | null>(null);

  const load = useCallback(async (select?: string | null) => {
    try {
      const r = await api.inventory.salesLinks();
      setMax(r.max);
      setList(r.items);
      setCurrent((cur) => {
        const want = select !== undefined ? select : cur;
        return want && r.items.some((l) => l.id === want) ? want : r.items[0]?.id ?? null;
      });
    } catch (e) {
      setMessage(describeError(e, '読み込めませんでした'));
    }
  }, []);
  useEffect(() => { void load(); }, [load]);

  const create = async () => {
    const name = (naming ?? '').trim();
    if (!name) return;
    try {
      const r = await api.inventory.createSalesLink(name);
      setNaming(null);
      setShownKey({ linkId: r.link.id, key: r.key });
      await load(r.link.id);
    } catch (e) {
      setMessage(describeError(e, '作れませんでした'));
    }
  };

  if (!list) return <div className="card inventory-publish">{message ? <p className="error">{message}</p> : <p className="muted">読み込み中…</p>}</div>;
  const link = list.find((l) => l.id === current) ?? null;

  return (
    <div className="card inventory-publish">
      <div className="publish-tabs" role="tablist" aria-label="販売管理とのつなぎ">
        {list.map((l) => (
          <button key={l.id} role="tab" aria-selected={l.id === link?.id} className={`publish-tab${l.id === link?.id ? ' on' : ''}`} onClick={() => setCurrent(l.id)}>
            {l.name}
            <span className={`publish-tab-mark ${l.status === 'stopped' ? 'stopped' : l.scope ? 'live' : 'draft'}`}>{l.status === 'stopped' ? '止めています' : l.scope ? '渡しています' : '未承認'}</span>
            {l.unmatchedOpen > 0 && <span className="badge warn">{l.unmatchedOpen}</span>}
          </button>
        ))}
        {list.length < max && naming === null && <button className="publish-tab add" onClick={() => setNaming('')} aria-label="つなぎを足す">＋</button>}
      </div>
      {naming !== null && (
        <div className="row">
          <input value={naming} autoFocus maxLength={40} placeholder="レジ・ネットショップなど" aria-label="つなぎの名前"
            onChange={(e) => setNaming(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') void create(); }} />
          <button className="btn small" disabled={!naming.trim()} onClick={() => void create()}>作る</button>
          <button className="btn ghost small" onClick={() => setNaming(null)}>キャンセル</button>
        </div>
      )}
      {shownKey && shownKey.linkId === link?.id && <KeyBanner value={shownKey.key} onClose={() => setShownKey(null)} />}
      {message && <p className="small muted" role="status">{message}</p>}
      {link
        ? <SalesLinkEditor key={link.id} link={link} items={items} onKey={(key) => setShownKey({ linkId: link.id, key })} onChanged={(select) => void load(select)} />
        : naming === null && <p className="muted small">つなぎはまだありません</p>}
    </div>
  );
}

/** 鍵（一度だけ出す）。 */
function KeyBanner({ value, onClose }: { value: string; onClose: () => void }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="key-banner" role="status">
      <strong>鍵（いま一度だけ出ます）</strong>
      <span className="copy-row">
        <input readOnly value={value} onFocus={(e) => e.currentTarget.select()} aria-label="鍵" />
        <button className="btn ghost small" onClick={() => void copyText(value).then(setCopied)}>{copied ? 'コピーしました' : 'コピー'}</button>
        <button className="btn ghost small" onClick={onClose}>閉じる</button>
      </span>
    </div>
  );
}

/** つなぎ 1 つの欄（名前・様子・渡す範囲・見本・承認・鍵・止める・削除）。 */
function SalesLinkEditor({ link: initial, items, onKey, onChanged }: {
  link: InventorySalesLink; items: InventoryItemView[]; onKey: (key: string) => void; onChanged: (select?: string | null) => void;
}) {
  const [link, setLink] = useState(initial);
  const active = useMemo(() => items.filter((i) => i.status === 'active'), [items]);
  const [scope, setScope] = useState<InventorySalesScope>(initial.scope ?? initialScope(items));
  const [name, setName] = useState(initial.name);
  const [preview, setPreview] = useState<InventorySalesItemView[] | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (scope.itemIds.length === 0) { setPreview(null); return undefined; }
    const t = setTimeout(() => {
      api.inventory.previewSalesLink(scope).then((r) => setPreview(r.items)).catch((e) => setMessage(describeError(e, '見本を作れませんでした')));
    }, 300);
    return () => clearTimeout(t);
  }, [scope]);

  const unchanged = !!link.scope && sameScope(link.scope, scope);
  const chosen = new Set(scope.itemIds);
  const categories = [...new Set(active.map((i) => i.category).filter(Boolean))];
  const toggleItem = (id: string, on: boolean) => setScope({ ...scope, itemIds: on ? [...scope.itemIds, id] : scope.itemIds.filter((x) => x !== id) });
  const selectCategory = (cat: string) => setScope({ ...scope, itemIds: [...new Set([...scope.itemIds, ...active.filter((i) => i.category === cat).map((i) => i.id)])] });
  const base = `${location.origin}/v1/hooks/inventory/sales`;

  const act = async (fn: () => Promise<InventorySalesLink>, failed: string) => {
    setBusy(true);
    setMessage(null);
    try {
      const v = await fn();
      setLink(v);
      if (v.scope) setScope(v.scope);
      onChanged(v.id);
    } catch (e) {
      setMessage(describeError(e, failed));
    } finally {
      setBusy(false);
    }
  };
  const saveName = () => {
    const n = name.trim();
    if (!n || n === link.name) { setName(link.name); return; }
    void act(() => api.inventory.renameSalesLink(link.id, n), '名前を変えられませんでした');
  };
  const rekey = async () => {
    setBusy(true);
    try {
      const r = await api.inventory.rekeySalesLink(link.id);
      onKey(r.key);
      setLink(r.link);
    } catch (e) {
      setMessage(describeError(e, '鍵を出し直せませんでした'));
    } finally {
      setBusy(false);
    }
  };
  const remove = async () => {
    setBusy(true);
    try {
      await api.inventory.deleteSalesLink(link.id);
      onChanged(null);
    } catch (e) {
      setMessage(describeError(e, '削除できませんでした'));
      setBusy(false);
    }
  };

  return (
    <>
      <div className="publish-head">
        <input className="publish-name" value={name} onChange={(e) => setName(e.target.value)} onBlur={saveName}
          onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }} aria-label="つなぎの名前" maxLength={40} />
        {link.approvedAt && <span className="muted small">{link.approvedByName ?? '管理者'}さんが {when(link.approvedAt)} に承認</span>}
      </div>
      <dl className="kv small">
        <dt>最後に読みに来た</dt><dd>{when(link.lastReadAt)}</dd>
        <dt>最後の通知</dt><dd>{when(link.lastEventAt)}（この 7 日で {link.eventsLast7Days} 件）</dd>
        {link.unmatchedOpen > 0 && <><dt>照らせなかった行</dt><dd className="warn-text">{link.unmatchedOpen} 件</dd></>}
      </dl>

      <div className="publish-options">
        <div className="segmented" role="radiogroup" aria-label="渡し方">
          <button role="radio" aria-checked={!scope.showCount} className={!scope.showCount ? 'on' : ''} onClick={() => setScope({ ...scope, showCount: false })}>状態だけ</button>
          <button role="radio" aria-checked={scope.showCount} className={scope.showCount ? 'on' : ''} onClick={() => setScope({ ...scope, showCount: true })}>数も渡す</button>
        </div>
        <label className="check"><input type="checkbox" checked={scope.price} onChange={(e) => setScope({ ...scope, price: e.target.checked })} />販売価格</label>
        <label className="check"><input type="checkbox" checked={scope.employeePrice} onChange={(e) => setScope({ ...scope, employeePrice: e.target.checked })} />社員価格</label>
      </div>

      <div className="publish-body">
        <div className="publish-items">
          <div className="publish-items-head">
            <span className="small">品目 {scope.itemIds.length} / {active.length}</span>
            <button className="link small" onClick={() => setScope({ ...scope, itemIds: active.map((i) => i.id) })}>すべて</button>
            <button className="link small" onClick={() => setScope({ ...scope, itemIds: [] })}>外す</button>
          </div>
          {categories.length > 1 && (
            <div className="publish-categories">
              {categories.map((c) => <button key={c} className="chip-btn small" onClick={() => selectCategory(c)}>{c}</button>)}
            </div>
          )}
          <ul>
            {active.map((i) => (
              <li key={i.id}>
                <label className="check">
                  <input type="checkbox" checked={chosen.has(i.id)} onChange={(e) => toggleItem(i.id, e.target.checked)} />
                  <span>{i.name}</span>
                  {i.category && <span className="muted small">{i.category}</span>}
                </label>
              </li>
            ))}
          </ul>
        </div>
        <div className="publish-preview" aria-label="見本">
          {preview && preview.length > 0 ? (
            <table className="table">
              <tbody>
                {preview.map((r) => (
                  <tr key={r.id}>
                    <td>{r.name}{r.code && <span className="muted small"> {r.code}</span>}</td>
                    {r.price !== undefined && <td className="num">{r.price ? `${r.price.amount.toLocaleString('ja-JP')}円${r.price.taxIncluded ? '（税込）' : '（税抜）'}` : '—'}</td>}
                    {r.employeePrice !== undefined && <td className="num">{r.employeePrice === null ? '—' : `社員 ${r.employeePrice.toLocaleString('ja-JP')}円`}</td>}
                    {r.available !== undefined && <td className="num">{r.available}{r.unit}</td>}
                    <td className={`publish-status ${r.status === 'in_stock' ? 'in' : r.status}`}>{STATUS_LABEL[r.status]}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : <p className="muted small">品目を選んでください</p>}
        </div>
      </div>


      <div className="publish-actions">
        <button className="btn" disabled={busy || unchanged || scope.itemIds.length === 0}
          onClick={() => void act(() => api.inventory.approveSalesLink(link.id, scope), '承認できませんでした')}>
          {unchanged ? '渡しています' : 'この内容で渡す'}
        </button>
        <button className="btn ghost" disabled={busy} onClick={() => void rekey()}>鍵を出し直す</button>
        {link.status === 'active'
          ? <button className="btn ghost danger" disabled={busy} onClick={() => void act(() => api.inventory.setSalesLinkStatus(link.id, false), '止められませんでした')}>止める</button>
          : <>
            <button className="btn ghost" disabled={busy} onClick={() => void act(() => api.inventory.setSalesLinkStatus(link.id, true), '動かせませんでした')}>動かす</button>
            <button className="btn ghost danger" disabled={busy} onClick={() => void remove()}>削除</button>
          </>}
      </div>

      <div className="publish-urls">
        <label className="small">商品の一覧（GET）
          <span className="copy-row"><input readOnly value={`${base}/items`} onFocus={(e) => e.currentTarget.select()} /></span>
        </label>
        <label className="small">販売の通知（POST）
          <span className="copy-row"><input readOnly value={`${base}/events`} onFocus={(e) => e.currentTarget.select()} /></span>
        </label>
        <a className="small" href="/admin/help/admin-developer-inventory-sales" target="_blank" rel="noreferrer">開発者向けの説明と API の定義</a>
      </div>
      {message && <p className="small muted" role="status">{message}</p>}
    </>
  );
}

/**
 * 照らせなかった販売。在庫管理を使う人が、行ごとに品目を選んで記録する。
 *
 * @param items 品目の一覧（止めた品目を含まない）
 * @param onChanged 記録したあと（一覧と数を読み直す）
 */
export function SalesUnmatchedPanel({ items, onChanged }: { items: InventoryItemView[]; onChanged: () => void }) {
  const [rows, setRows] = useState<InventorySaleUnmatched[] | null>(null);
  const [pick, setPick] = useState<Record<string, string>>({});
  const [message, setMessage] = useState<string | null>(null);
  const load = useCallback(() => {
    api.inventory.salesUnmatched().then((r) => setRows(r.items)).catch((e) => setMessage(describeError(e, '読み込めませんでした')));
  }, []);
  useEffect(() => { load(); }, [load]);
  const active = items.filter((i) => i.status === 'active');
  const record = async (row: InventorySaleUnmatched) => {
    const itemId = pick[row.id];
    if (!itemId) return;
    try {
      await api.inventory.resolveSalesUnmatched(row.id, itemId);
      setMessage(null);
      load();
      onChanged();
    } catch (e) {
      setMessage(describeError(e, '記録できませんでした'));
    }
  };
  if (!rows) return <div className="card">{message ? <p className="error">{message}</p> : <p className="muted">読み込み中…</p>}</div>;
  return (
    <div className="card sales-unmatched">
      {rows.length === 0 && <p className="muted small">照らせなかった販売はありません</p>}
      {rows.length > 0 && (
        <ul className="plain sales-unmatched-list">
          {rows.map((r) => (
            <li key={r.id}>
              <div><strong>{ACTION_LABEL[r.action]} {r.saleRef}</strong> <span className="muted small">{r.linkName}・{when(r.createdAt)}</span></div>
              <div className="small">{[r.itemRef && `品目の ID ${r.itemRef}`, r.code && `自社のコード ${r.code}`, r.barcode && `バーコード ${r.barcode}`].filter(Boolean).join('・')}　数 {r.qty}</div>
              <div className="muted small">{r.reason}</div>
              <div className="row wrap">
                <select value={pick[r.id] ?? ''} onChange={(e) => setPick({ ...pick, [r.id]: e.target.value })} aria-label="品目">
                  <option value="">品目を選ぶ</option>
                  {active.map((i) => <option key={i.id} value={i.id}>{i.name}{i.sku ? `（${i.sku}）` : ''}</option>)}
                </select>
                <button className="btn small" disabled={!pick[r.id]} onClick={() => void record(r)}>記録する</button>
              </div>
            </li>
          ))}
        </ul>
      )}
      {message && <p className="small error" role="status">{message}</p>}
    </div>
  );
}
