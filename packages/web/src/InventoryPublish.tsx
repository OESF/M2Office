/**
 * @file 在庫管理のパソコンの画面の「Web へ公開」の欄（仕様書 第29.12節・第29.12.1節・第29.12.2節・第29.12.3節。段 5）。
 *
 * 公開は 1 社でいくつものまとまりに分けられる（Web サイトのページごとに違う品目を出すため）。まとまりはタブで切り替える。
 * 管理者が、まとまりごとに公開する品目（区分と分類で選べる）・分類で分けるか・販売価格を出すか・数か状態かを選び、見本で確かめて「この内容で公開する」を押す。
 * 押すことが承認である（社外に出るもの。第9.4.0節）。承認した範囲の数の変化は、承認なしに自動で流れる。
 * 公開したら、Web サイトに貼る iframe の 1 行と公開のデータの URL を出す。説明文を常に出さない（原則 u11）。
 */

import { copyText } from './clipboard.js';
import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  INVENTORY_PUBLIC_STATUS_LABELS, type InventoryItemView, type InventoryPublicationScope, type InventoryPublicField, type InventoryPublicSnapshot,
} from '@m2office/shared';
import { api, describeError, type InventoryPublicationView } from './api.js';
import { InventoryItemPicker, withRuleItems } from './InventoryItemPicker.js';

/** 承認する前のまとまりの、はじめの選び方（品目はすべて・分類と価格あり・状態だけ）。 */
function initialScope(items: InventoryItemView[]): InventoryPublicationScope {
  // はじめは区分が販売品の条件（第29.6.1節・第29.12.3節）。販売品が無ければ、条件なしで使っている品目すべて
  const active = items.filter((i) => i.status === 'active');
  const sale = active.filter((i) => i.kind === 'sale');
  if (sale.length === 0) return { itemIds: active.map((i) => i.id), fields: ['category', 'price'], showCount: false };
  return { itemIds: sale.map((i) => i.id), fields: ['category', 'price'], showCount: false, rule: { kinds: ['sale'], categories: [], excluded: [] } };
}

/** 2 つの中身が同じか（品目と条件の順は問わない）。 */
function sameScope(a: InventoryPublicationScope, b: InventoryPublicationScope): boolean {
  const set = (x: string[]) => [...x].sort().join('\u0000');
  const rule = (s: InventoryPublicationScope) => (s.rule ? [set(s.rule.kinds), set(s.rule.categories), set(s.rule.excluded)].join('\u0001') : '');
  return set(a.itemIds) === set(b.itemIds) && set(a.fields) === set(b.fields) && a.showCount === b.showCount && rule(a) === rule(b);
}

/** 日本時間の日時。 */
const when = (iso: string) => new Date(iso).toLocaleString('ja-JP', { dateStyle: 'medium', timeStyle: 'short' });

/** Web サイトに貼る 1 行。 */
const iframeTag = (url: string) => `<iframe src="${url}" title="在庫の状況" style="width:100%;height:480px;border:0" loading="lazy"></iframe>`;

/** タブに添える状態の印。 */
const STATUS_MARK: Record<'draft' | 'live' | 'stopped', string> = { draft: '未公開', live: '公開中', stopped: '止めています' };

/**
 * Web へ公開の欄。管理者にだけ出す（呼ぶ側で、管理者で「Web への公開」が入のときだけ出す）。
 *
 * @param items 品目の一覧（止めた品目を含まない）
 */
export function PublishPanel({ items }: { items: InventoryItemView[] }) {
  const [list, setList] = useState<InventoryPublicationView[] | null>(null);
  const [max, setMax] = useState(8);
  const [current, setCurrent] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  const load = useCallback(async (select?: string | null) => {
    try {
      const r = await api.inventory.publications();
      setMax(r.max);
      // まだ 1 つも無い会社には、サーバーが最初のまとまりを作って返す（「＋」を押さなくても始められる）
      const rows = r.items;
      if (rows.length === 0) return;
      setList(rows);
      setCurrent((cur) => {
        const want = select !== undefined ? select : cur;
        return want && rows.some((v) => v.publication.id === want) ? want : rows[0]!.publication.id;
      });
    } catch (e) {
      setMessage(describeError(e, '読み込めませんでした'));
    }
  }, []);
  useEffect(() => { void load(); }, [load]);

  const add = async () => {
    try {
      const v = await api.inventory.createPublication();
      await load(v.publication.id);
    } catch (e) {
      setMessage(describeError(e, '足せませんでした'));
    }
  };

  if (!list) return <div className="card inventory-publish">{message ? <p className="error">{message}</p> : <p className="muted">読み込み中…</p>}</div>;
  const view = list.find((v) => v.publication.id === current) ?? list[0]!;

  return (
    <div className="card inventory-publish">
      <div className="publish-tabs" role="tablist" aria-label="公開のまとまり">
        {list.map((v) => (
          <button key={v.publication.id} role="tab" aria-selected={v.publication.id === view.publication.id}
            className={`publish-tab${v.publication.id === view.publication.id ? ' on' : ''}`} onClick={() => setCurrent(v.publication.id)}>
            {v.publication.name}
            <span className={`publish-tab-mark ${v.publication.status}`}>{STATUS_MARK[v.publication.status]}</span>
          </button>
        ))}
        {list.length < max && <button className="publish-tab add" onClick={() => void add()} aria-label="公開のまとまりを足す">＋</button>}
      </div>
      {message && <p className="small muted" role="status">{message}</p>}
      <PublicationEditor key={view.publication.id} view={view} items={items} onChanged={(select) => void load(select)} />
    </div>
  );
}

/**
 * まとまり 1 つの欄（名前・出し方・品目・見本・承認・止める・削除・貼る URL）。
 *
 * @param onChanged 状態が変わったとき（削除したら `null` を渡し、別のまとまりを選ぶ）
 */
function PublicationEditor({ view: initial, items, onChanged }: {
  view: InventoryPublicationView; items: InventoryItemView[]; onChanged: (select?: string | null) => void;
}) {
  const [view, setView] = useState(initial);
  const active = useMemo(() => items.filter((i) => i.status === 'active'), [items]);
  // 条件で選んでいれば、承認のあとに足した品目で条件に当たるものを選んだ状態で並べる（出すのは承認し直したとき。第29.12.3節）
  const [scope, setScope] = useState<InventoryPublicationScope>(() =>
    (initial.publication.scope ? withRuleItems(initial.publication.scope, active).picked : initialScope(items)));
  // 品目が読み直されたら、条件に当たる品目を選び直す（条件なしなら何もしない）
  useEffect(() => { setScope((s) => withRuleItems(s, active).picked); }, [active]);
  const [name, setName] = useState(initial.publication.name);
  const [preview, setPreview] = useState<InventoryPublicSnapshot | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // 選び方が変わったら、少し待って見本を取り直す
  useEffect(() => {
    if (scope.itemIds.length === 0) { setPreview(null); return undefined; }
    const t = setTimeout(() => {
      api.inventory.previewPublication(scope).then((r) => setPreview(r.snapshot)).catch((e) => setMessage(describeError(e, '見本を作れませんでした')));
    }, 300);
    return () => clearTimeout(t);
  }, [scope]);

  const pub = view.publication;
  const live = pub.status === 'live';
  const unchanged = live && !!pub.scope && sameScope(pub.scope, scope);
  // 承認のあとに足した品目のうち、まだ出ていないもの（条件で選んでいれば条件に当たるものだけ）
  const notInScope = !pub.scope ? 0 : pub.scope.rule ? withRuleItems(pub.scope, active).added
    : active.filter((i) => !pub.scope!.itemIds.includes(i.id)).length;
  const setField = (f: InventoryPublicField, on: boolean) =>
    setScope({ ...scope, fields: on ? [...new Set([...scope.fields, f])] : scope.fields.filter((x) => x !== f) });

  const act = async (fn: () => Promise<InventoryPublicationView>, failed: string) => {
    setBusy(true);
    setMessage(null);
    try {
      const v = await fn();
      setView(v);
      if (v.publication.scope) setScope(v.publication.scope);
      onChanged(v.publication.id);
    } catch (e) {
      setMessage(describeError(e, failed));
    } finally {
      setBusy(false);
    }
  };
  const saveName = () => {
    const n = name.trim();
    if (!n || n === pub.name) { setName(pub.name); return; }
    void act(() => api.inventory.renamePublication(pub.id, n), '名前を変えられませんでした');
  };
  const remove = async () => {
    setBusy(true);
    try {
      await api.inventory.deletePublication(pub.id);
      onChanged(null);
    } catch (e) {
      setMessage(describeError(e, '削除できませんでした'));
      setBusy(false);
    }
  };
  const copy = (text: string) => {
    void copyText(text).then((ok) => setMessage(ok ? 'コピーしました' : 'コピーできませんでした'));
  };

  return (
    <>
      <div className="publish-head">
        <input className="publish-name" value={name} onChange={(e) => setName(e.target.value)} onBlur={saveName}
          onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }} aria-label="公開の名前" maxLength={40} />
        {pub.approvedAt && <span className="muted small">{pub.approvedByName ?? '管理者'}さんが {when(pub.approvedAt)} に承認</span>}
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
        <InventoryItemPicker items={active} value={scope} onChange={setScope} nameOf={(i) => i.publicName || i.name} />
        <div className="publish-preview" aria-label="見本">
          {preview && preview.items.length > 0 ? <PreviewTable snapshot={preview} /> : <p className="muted small">品目を選んでください</p>}
        </div>
      </div>

      {notInScope > 0 && live && <p className="small warn-text">承認のあとに足した品目 {notInScope} 件は、まだ出ていません</p>}
      {view.stoppedInScope > 0 && <p className="small muted">止めた品目 {view.stoppedInScope} 件は出ていません</p>}

      <div className="publish-actions">
        <button className="btn" disabled={busy || unchanged || scope.itemIds.length === 0}
          onClick={() => void act(() => api.inventory.approvePublication(pub.id, scope), '公開できませんでした')}>
          {unchanged ? '公開中' : 'この内容で公開する'}
        </button>
        {live && <button className="btn ghost danger" disabled={busy} onClick={() => void act(() => api.inventory.stopPublication(pub.id), '止められませんでした')}>公開を止める</button>}
        {!live && <button className="btn ghost danger" disabled={busy} onClick={() => void remove()}>削除</button>}
      </div>

      {view.urls && (
        <div className="publish-urls">
          <label className="small">Web サイトに貼る
            <span className="copy-row">
              <input readOnly value={iframeTag(view.urls.page)} onFocus={(e) => e.currentTarget.select()} />
              <button className="btn ghost small" onClick={() => copy(iframeTag(view.urls!.page))}>コピー</button>
            </span>
          </label>
          <label className="small">データ（JSON）
            <span className="copy-row">
              <input readOnly value={view.urls.data} onFocus={(e) => e.currentTarget.select()} />
              <button className="btn ghost small" onClick={() => copy(view.urls!.data)}>コピー</button>
            </span>
          </label>
          {live && <a className="small" href={view.urls.page} target="_blank" rel="noreferrer">公開のページを開く</a>}
        </div>
      )}
      {message && <p className="small muted" role="status">{message}</p>}
    </>
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
