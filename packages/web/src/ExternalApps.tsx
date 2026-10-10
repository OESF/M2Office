/**
 * @file 管理者ページ「接続」の「外部のアプリ」（仕様書 第13.4.1節、ADR-0090）。
 *
 * 外のシステム（販売管理・M2Medical など）をアプリとして登録すると、鍵が一度だけ出る（M2Office はハッシュだけを持つ）。
 * アプリごとに使える機能を選び、機能ごとの設定（「商品の一覧を読む」で渡す品目など）を見本で確かめて「この内容で許す」を押す。
 * 押すことが承認である（社外への送信・社外からの書き込みを、範囲で一度承認する。第9.4.0節）。説明文を常に出さない（原則 u11）。
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import type { AppFunctionId, AppFunctionInfo, AppSettings, ExternalApp, InventoryCatalogScope, InventoryItemView } from '@m2office/shared';
import { api, describeError, type InventorySalesItemView } from './api.js';
import { copyText } from './clipboard.js';
import { PageTitle } from './help.js';

/** 日本時間の日時。 */
const when = (iso: string | null) => (iso ? new Date(iso).toLocaleString('ja-JP', { dateStyle: 'medium', timeStyle: 'short' }) : '—');

const STATUS_LABEL = { in_stock: '在庫あり', low: '残りわずか', out: '終了' } as const;

/** 承認する前の、商品の一覧のはじめの選び方（販売品に当たる分類があればその品目。社員価格は渡さない）。 */
function initialCatalog(items: InventoryItemView[]): InventoryCatalogScope {
  return { itemIds: items.filter((i) => i.status === 'active' && /販売/.test(i.category)).map((i) => i.id), showCount: true, price: true, employeePrice: false };
}

/** 2 つの承認の中身が同じか。 */
function sameApproval(a: { functions: AppFunctionId[]; settings: AppSettings }, b: { functions: AppFunctionId[]; settings: AppSettings }): boolean {
  const set = (x: string[]) => [...x].sort().join('\u0000');
  const ca = a.functions.includes('inventory.catalog') ? a.settings.catalog : undefined;
  const cb = b.functions.includes('inventory.catalog') ? b.settings.catalog : undefined;
  const sameCatalog = (!ca && !cb) || (!!ca && !!cb && set(ca.itemIds) === set(cb.itemIds) && ca.showCount === cb.showCount && ca.price === cb.price && ca.employeePrice === cb.employeePrice);
  return set(a.functions) === set(b.functions) && sameCatalog;
}

/** 外部のアプリの画面（管理者ページ「接続」の「外部のアプリ」）。 */
export function ExternalApps() {
  const [list, setList] = useState<ExternalApp[] | null>(null);
  const [functions, setFunctions] = useState<AppFunctionInfo[]>([]);
  const [max, setMax] = useState(20);
  const [current, setCurrent] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [naming, setNaming] = useState<string | null>(null);
  const [shownKey, setShownKey] = useState<{ appId: string; key: string } | null>(null);
  const [items, setItems] = useState<InventoryItemView[]>([]);

  const load = useCallback(async (select?: string | null) => {
    try {
      const r = await api.admin.apps();
      setMax(r.max);
      setFunctions(r.functions);
      setList(r.items);
      setCurrent((cur) => {
        const want = select !== undefined ? select : cur;
        return want && r.items.some((a) => a.id === want) ? want : r.items[0]?.id ?? null;
      });
      // 在庫の機能を選べる会社だけ、品目を読む（商品の一覧で渡す品目を選ぶため）
      if (r.functions.some((f) => f.requires === 'inventory')) api.inventory.list({}).then((x) => setItems(x.items)).catch(() => setItems([]));
    } catch (e) {
      setMessage(describeError(e, '読み込めませんでした'));
    }
  }, []);
  useEffect(() => { void load(); }, [load]);

  const create = async () => {
    const name = (naming ?? '').trim();
    if (!name) return;
    try {
      const r = await api.admin.createApp(name);
      setNaming(null);
      setShownKey({ appId: r.app.id, key: r.key });
      await load(r.app.id);
    } catch (e) {
      setMessage(describeError(e, '登録できませんでした'));
    }
  };

  const app = list?.find((a) => a.id === current) ?? null;
  return (
    <>
      <PageTitle trail={['接続', '外部のアプリ']} help={{ article: 'admin-developer', text: '外のシステム（販売管理・M2Medical など）が M2Office を使うためのアプリです。鍵は登録したときに一度だけ出ます。' }} />
      <div className="card inventory-publish">
        {!list && (message ? <p className="error">{message}</p> : <p className="muted">読み込み中…</p>)}
        {list && (
          <>
            <div className="publish-tabs" role="tablist" aria-label="外部のアプリ">
              {list.map((a) => (
                <button key={a.id} role="tab" aria-selected={a.id === app?.id} className={`publish-tab${a.id === app?.id ? ' on' : ''}`} onClick={() => setCurrent(a.id)}>
                  {a.name}
                  <span className={`publish-tab-mark ${a.status === 'stopped' ? 'stopped' : a.functions.length ? 'live' : 'draft'}`}>{a.status === 'stopped' ? '止めています' : a.functions.length ? '許しています' : '未承認'}</span>
                </button>
              ))}
              {list.length < max && naming === null && <button className="publish-tab add" onClick={() => setNaming('')} aria-label="アプリを登録する">＋</button>}
            </div>
            {naming !== null && (
              <div className="row">
                <input value={naming} autoFocus maxLength={40} placeholder="レジ・M2Medical など" aria-label="アプリの名前"
                  onChange={(e) => setNaming(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') void create(); }} />
                <button className="btn small" disabled={!naming.trim()} onClick={() => void create()}>登録する</button>
                <button className="btn ghost small" onClick={() => setNaming(null)}>キャンセル</button>
              </div>
            )}
            {shownKey && shownKey.appId === app?.id && <KeyBanner value={shownKey.key} onClose={() => setShownKey(null)} />}
            {message && <p className="small muted" role="status">{message}</p>}
            {app
              ? <AppEditor key={app.id} app={app} functions={functions} items={items} onKey={(key) => setShownKey({ appId: app.id, key })} onChanged={(select) => void load(select)} />
              : naming === null && <p className="muted small">外部のアプリはまだありません</p>}
          </>
        )}
      </div>
    </>
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

/** アプリ 1 つの欄（名前・様子・機能・機能ごとの設定・承認・鍵・止める・削除）。 */
function AppEditor({ app: initial, functions, items, onKey, onChanged }: {
  app: ExternalApp; functions: AppFunctionInfo[]; items: InventoryItemView[]; onKey: (key: string) => void; onChanged: (select?: string | null) => void;
}) {
  const [app, setApp] = useState(initial);
  const [name, setName] = useState(initial.name);
  const [chosen, setChosen] = useState<AppFunctionId[]>(initial.functions);
  const [catalog, setCatalog] = useState<InventoryCatalogScope>(initial.settings.catalog ?? initialCatalog(items));
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => { if (!initial.settings.catalog && items.length) setCatalog(initialCatalog(items)); }, [items, initial.settings.catalog]);

  const draft = { functions: chosen, settings: chosen.includes('inventory.catalog') ? { catalog } : {} };
  const unchanged = app.functions.length > 0 && sameApproval({ functions: app.functions, settings: app.settings }, draft);
  const toggle = (id: AppFunctionId, on: boolean) => setChosen(on ? [...new Set([...chosen, id])] : chosen.filter((x) => x !== id));
  const base = location.origin;

  const act = async (fn: () => Promise<ExternalApp>, failed: string) => {
    setBusy(true);
    setMessage(null);
    try {
      const v = await fn();
      setApp(v);
      setChosen(v.functions);
      if (v.settings.catalog) setCatalog(v.settings.catalog);
      onChanged(v.id);
    } catch (e) {
      setMessage(describeError(e, failed));
    } finally {
      setBusy(false);
    }
  };
  const saveName = () => {
    const n = name.trim();
    if (!n || n === app.name) { setName(app.name); return; }
    void act(() => api.admin.renameApp(app.id, n), '名前を変えられませんでした');
  };
  const rekey = async () => {
    setBusy(true);
    try {
      const r = await api.admin.rekeyApp(app.id);
      onKey(r.key);
      setApp(r.app);
    } catch (e) {
      setMessage(describeError(e, '鍵を出し直せませんでした'));
    } finally {
      setBusy(false);
    }
  };
  const remove = async () => {
    setBusy(true);
    try {
      await api.admin.deleteApp(app.id);
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
          onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }} aria-label="アプリの名前" maxLength={40} />
        {app.approvedAt && <span className="muted small">{app.approvedByName ?? '管理者'}さんが {when(app.approvedAt)} に承認</span>}
      </div>
      <dl className="kv small">
        <dt>最後に呼ばれた</dt><dd>{when(app.lastUsedAt)}（この 7 日で {app.callsLast7Days} 回）</dd>
      </dl>

      <h4 className="app-section-title">機能</h4>
      <ul className="plain app-functions">
        {functions.map((f) => (
          <li key={f.id}>
            <label className="check">
              <input type="checkbox" checked={chosen.includes(f.id)} onChange={(e) => toggle(f.id, e.target.checked)} />
              <span>{f.label}</span>
              <span className="muted small">{f.routes.join('・')}</span>
            </label>
          </li>
        ))}
      </ul>
      {chosen.includes('inventory.catalog') && <CatalogEditor scope={catalog} items={items} onChange={setCatalog} />}

      <div className="publish-actions">
        <button className="btn" disabled={busy || unchanged || chosen.length === 0 || (chosen.includes('inventory.catalog') && catalog.itemIds.length === 0)}
          onClick={() => void act(() => api.admin.approveApp(app.id, draft.functions, draft.settings), '承認できませんでした')}>
          {unchanged ? '許しています' : 'この内容で許す'}
        </button>
        <button className="btn ghost" disabled={busy} onClick={() => void rekey()}>鍵を出し直す</button>
        {app.status === 'active'
          ? <button className="btn ghost danger" disabled={busy} onClick={() => void act(() => api.admin.setAppStatus(app.id, false), '止められませんでした')}>止める</button>
          : <>
            <button className="btn ghost" disabled={busy} onClick={() => void act(() => api.admin.setAppStatus(app.id, true), '動かせませんでした')}>動かす</button>
            <button className="btn ghost danger" disabled={busy} onClick={() => void remove()}>削除</button>
          </>}
      </div>
      <div className="publish-urls">
        <label className="small">呼ぶ先
          <span className="copy-row"><input readOnly value={`${base}/v1`} onFocus={(e) => e.currentTarget.select()} /></span>
        </label>
        <a className="small" href="/admin/help/admin-developer" target="_blank" rel="noreferrer">開発者向けの説明と API の定義</a>
      </div>
      {message && <p className="small muted" role="status">{message}</p>}
    </>
  );
}

/** 機能「商品の一覧を読む」の設定（渡す品目・数か状態か・販売価格・社員価格）と見本。 */
function CatalogEditor({ scope, items, onChange }: { scope: InventoryCatalogScope; items: InventoryItemView[]; onChange: (s: InventoryCatalogScope) => void }) {
  const active = useMemo(() => items.filter((i) => i.status === 'active'), [items]);
  const [preview, setPreview] = useState<InventorySalesItemView[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (scope.itemIds.length === 0) { setPreview(null); return undefined; }
    const t = setTimeout(() => {
      api.admin.previewCatalog(scope).then((r) => setPreview(r.items)).catch((e) => setError(describeError(e, '見本を作れませんでした')));
    }, 300);
    return () => clearTimeout(t);
  }, [scope]);
  const chosen = new Set(scope.itemIds);
  const categories = [...new Set(active.map((i) => i.category).filter(Boolean))];
  const toggleItem = (id: string, on: boolean) => onChange({ ...scope, itemIds: on ? [...scope.itemIds, id] : scope.itemIds.filter((x) => x !== id) });
  const selectCategory = (cat: string) => onChange({ ...scope, itemIds: [...new Set([...scope.itemIds, ...active.filter((i) => i.category === cat).map((i) => i.id)])] });
  return (
    <div className="app-setting">
      <h4 className="app-section-title">商品の一覧で渡すもの</h4>
      <div className="publish-options">
        <div className="segmented" role="radiogroup" aria-label="渡し方">
          <button role="radio" aria-checked={!scope.showCount} className={!scope.showCount ? 'on' : ''} onClick={() => onChange({ ...scope, showCount: false })}>状態だけ</button>
          <button role="radio" aria-checked={scope.showCount} className={scope.showCount ? 'on' : ''} onClick={() => onChange({ ...scope, showCount: true })}>数も渡す</button>
        </div>
        <label className="check"><input type="checkbox" checked={scope.price} onChange={(e) => onChange({ ...scope, price: e.target.checked })} />販売価格</label>
        <label className="check"><input type="checkbox" checked={scope.employeePrice} onChange={(e) => onChange({ ...scope, employeePrice: e.target.checked })} />社員価格</label>
      </div>
      <div className="publish-body">
        <div className="publish-items">
          <div className="publish-items-head">
            <span className="small">品目 {scope.itemIds.length} / {active.length}</span>
            <button className="link small" onClick={() => onChange({ ...scope, itemIds: active.map((i) => i.id) })}>すべて</button>
            <button className="link small" onClick={() => onChange({ ...scope, itemIds: [] })}>外す</button>
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
      {error && <p className="small error">{error}</p>}
    </div>
  );
}
