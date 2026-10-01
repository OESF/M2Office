/**
 * @file 在庫管理のパソコンの画面の「Web への公開」の欄（仕様書 第29.12節・第29.12.1節。段 5）。
 *
 * 管理者が、公開する品目・分類で分けるか・販売価格を出すか・数か状態かを選び、見本で確かめて「この内容で公開する」を押す。
 * 押すことが承認である（社外に出るもの。第9.4.0節）。承認した範囲の数の変化は、承認なしに自動で流れる。
 * 公開したら、Web サイトに貼る iframe の 1 行と公開のデータの URL を出す。説明文を常に出さない（原則 u11）。
 */

import { useEffect, useMemo, useState } from 'react';
import {
  INVENTORY_PUBLIC_STATUS_LABELS, type InventoryItemView, type InventoryPublicationScope, type InventoryPublicField, type InventoryPublicSnapshot,
} from '@m2office/shared';
import { api, describeError, type InventoryPublicationView } from './api.js';

/** 何も承認していない会社の、はじめの選び方（品目はすべて・分類と価格あり・状態だけ）。 */
function initialScope(items: InventoryItemView[]): InventoryPublicationScope {
  return { itemIds: items.filter((i) => i.status === 'active').map((i) => i.id), fields: ['category', 'price'], showCount: false };
}

/** 2 つの中身が同じか（品目の順は問わない）。 */
function sameScope(a: InventoryPublicationScope, b: InventoryPublicationScope): boolean {
  const set = (x: string[]) => [...x].sort().join('\u0000');
  return set(a.itemIds) === set(b.itemIds) && set(a.fields) === set(b.fields) && a.showCount === b.showCount;
}

/** 日本時間の日時。 */
const when = (iso: string) => new Date(iso).toLocaleString('ja-JP', { dateStyle: 'medium', timeStyle: 'short' });

/** Web サイトに貼る 1 行。 */
const iframeTag = (url: string) => `<iframe src="${url}" title="在庫の状況" style="width:100%;height:480px;border:0" loading="lazy"></iframe>`;

/**
 * Web への公開の欄。管理者にだけ出す（呼ぶ側で、管理者で「Web への公開」が入のときだけ出す）。
 *
 * @param items 品目の一覧（止めた品目を含まない）
 */
export function PublishPanel({ items }: { items: InventoryItemView[] }) {
  const [view, setView] = useState<InventoryPublicationView | null>(null);
  const [scope, setScope] = useState<InventoryPublicationScope | null>(null);
  const [preview, setPreview] = useState<InventoryPublicSnapshot | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const active = useMemo(() => items.filter((i) => i.status === 'active'), [items]);

  useEffect(() => {
    api.inventory.publication().then((v) => {
      setView(v);
      setScope(v.publication ? v.publication.scope : initialScope(active));
    }).catch((e) => setMessage(describeError(e, '読み込めませんでした')));
    // 開いたときに 1 回だけ読む（品目の一覧が変わっても、選んでいる途中の中身は変えない）
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 選び方が変わったら、少し待って見本を取り直す
  useEffect(() => {
    if (!scope) return;
    if (scope.itemIds.length === 0) { setPreview(null); return; }
    const t = setTimeout(() => {
      api.inventory.previewPublication(scope).then((r) => setPreview(r.snapshot)).catch((e) => setMessage(describeError(e, '見本を作れませんでした')));
    }, 300);
    return () => clearTimeout(t);
  }, [scope]);

  if (!view || !scope) return <div className="card inventory-publish">{message ? <p className="error">{message}</p> : <p className="muted">読み込み中…</p>}</div>;

  const pub = view.publication;
  const live = pub?.status === 'live';
  const unchanged = !!pub && live && sameScope(pub.scope, scope);
  const chosen = new Set(scope.itemIds);
  const notInScope = pub ? active.filter((i) => !pub.scope.itemIds.includes(i.id)).length : 0;
  const setField = (f: InventoryPublicField, on: boolean) =>
    setScope({ ...scope, fields: on ? [...new Set([...scope.fields, f])] : scope.fields.filter((x) => x !== f) });
  const toggleItem = (id: string, on: boolean) =>
    setScope({ ...scope, itemIds: on ? [...scope.itemIds, id] : scope.itemIds.filter((x) => x !== id) });

  const approve = async () => {
    setBusy(true);
    setMessage(null);
    try {
      const v = await api.inventory.approvePublication(scope);
      setView(v);
      if (v.publication) setScope(v.publication.scope);
    } catch (e) {
      setMessage(describeError(e, '公開できませんでした'));
    } finally {
      setBusy(false);
    }
  };
  const stop = async () => {
    setBusy(true);
    setMessage(null);
    try {
      setView(await api.inventory.stopPublication());
    } catch (e) {
      setMessage(describeError(e, '止められませんでした'));
    } finally {
      setBusy(false);
    }
  };
  const copy = (text: string) => {
    void navigator.clipboard?.writeText(text).then(() => setMessage('写しました')).catch(() => setMessage('写せませんでした'));
  };

  return (
    <div className="card inventory-publish">
      <div className="publish-head">
        <h3>Web への公開</h3>
        {pub && (
          <span className={live ? 'chip current' : 'chip todo'}>
            {live ? '公開中' : '止めています'}
          </span>
        )}
        {pub && <span className="muted small">{pub.approvedByName ?? '管理者'}さんが {when(pub.approvedAt)} に承認</span>}
      </div>

      <div className="publish-options">
        <div className="segmented" role="radiogroup" aria-label="出し方">
          <button role="radio" aria-checked={!scope.showCount} className={!scope.showCount ? 'on' : ''} onClick={() => setScope({ ...scope, showCount: false })}>状態だけ</button>
          <button role="radio" aria-checked={scope.showCount} className={scope.showCount ? 'on' : ''} onClick={() => setScope({ ...scope, showCount: true })}>数も出す</button>
        </div>
        <label className="check"><input type="checkbox" checked={scope.fields.includes('category')} onChange={(e) => setField('category', e.target.checked)} />分類で分ける</label>
        <label className="check"><input type="checkbox" checked={scope.fields.includes('price')} onChange={(e) => setField('price', e.target.checked)} />販売価格</label>
      </div>

      <div className="publish-body">
        <div className="publish-items">
          <div className="publish-items-head">
            <span className="small">品目 {scope.itemIds.length} / {active.length}</span>
            <button className="link small" onClick={() => setScope({ ...scope, itemIds: active.map((i) => i.id) })}>すべて</button>
            <button className="link small" onClick={() => setScope({ ...scope, itemIds: [] })}>外す</button>
          </div>
          <ul>
            {active.map((i) => (
              <li key={i.id}>
                <label className="check">
                  <input type="checkbox" checked={chosen.has(i.id)} onChange={(e) => toggleItem(i.id, e.target.checked)} />
                  <span>{i.publicName || i.name}</span>
                  {i.category && <span className="muted small">{i.category}</span>}
                </label>
              </li>
            ))}
          </ul>
        </div>
        <div className="publish-preview" aria-label="見本">
          {preview && preview.items.length > 0 ? <PreviewTable snapshot={preview} /> : <p className="muted small">品目を選んでください</p>}
        </div>
      </div>

      {notInScope > 0 && live && <p className="small warn-text">承認のあとに足した品目 {notInScope} 件は、まだ出ていません</p>}
      {view.stoppedInScope > 0 && <p className="small muted">止めた品目 {view.stoppedInScope} 件は出ていません</p>}

      <div className="publish-actions">
        <button className="btn" disabled={busy || unchanged || scope.itemIds.length === 0} onClick={() => void approve()}>
          {unchanged ? '公開中' : 'この内容で公開する'}
        </button>
        {live && <button className="btn ghost danger" disabled={busy} onClick={() => void stop()}>公開を止める</button>}
      </div>

      {view.urls && (
        <div className="publish-urls">
          <label className="small">Web サイトに貼る
            <span className="copy-row">
              <input readOnly value={iframeTag(view.urls.page)} onFocus={(e) => e.currentTarget.select()} />
              <button className="btn ghost small" onClick={() => copy(iframeTag(view.urls!.page))}>写す</button>
            </span>
          </label>
          <label className="small">データ（JSON）
            <span className="copy-row">
              <input readOnly value={view.urls.data} onFocus={(e) => e.currentTarget.select()} />
              <button className="btn ghost small" onClick={() => copy(view.urls!.data)}>写す</button>
            </span>
          </label>
          {live && <a className="small" href={view.urls.page} target="_blank" rel="noreferrer">公開のページを開く</a>}
        </div>
      )}
      {message && <p className="small muted" role="status">{message}</p>}
    </div>
  );
}

/** 見本の表（公開のページと同じ並び・同じ項目）。 */
function PreviewTable({ snapshot }: { snapshot: InventoryPublicSnapshot }) {
  const groups = new Map<string, InventoryPublicSnapshot['items']>();
  for (const r of snapshot.items) groups.set(r.category ?? '', [...(groups.get(r.category ?? '') ?? []), r]);
  const named = [...groups.keys()].some((k) => k);
  return (
    <>
      {[...groups].map(([k, rows]) => (
        <div key={k}>
          {named && <h4>{k || 'その他'}</h4>}
          <table className="table">
            <tbody>
              {rows.map((r, n) => (
                <tr key={n}>
                  <td>{r.name}</td>
                  {r.price !== undefined && <td className="num">{r.price.toLocaleString('ja-JP')}円{r.priceTaxIncluded ? '（税込）' : '（税抜）'}</td>}
                  {r.available !== undefined && <td className="num">{r.available}{r.unit}</td>}
                  <td className={`publish-status ${r.status}`}>{INVENTORY_PUBLIC_STATUS_LABELS[r.status]}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ))}
    </>
  );
}
