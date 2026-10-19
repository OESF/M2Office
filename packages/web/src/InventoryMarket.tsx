/**
 * @file 販売品の相場と競合の比較（仕様書 第29.24節、Q-243）と、仕入れの相場（第29.6.2節、Q-244）。
 *
 * 「価格の比較」のタブ（販売価格の相場と、管理者には仕入れの相場の切り替え）と、品目の詳細の相場（出典の一覧・相場を調べる・月ごとの相場）。
 * 値付けと仕入れを決めるのは会社で、ここは材料を出すだけ（価格は変えない）。仕入れの相場は自社の仕入価格を含むため、利用範囲の管理者にだけ出す。
 */
import { useCallback, useEffect, useState } from 'react';
import { INVENTORY_MARKET_POSITION_LABEL, INVENTORY_PURCHASE_POSITION_LABEL, type InventoryItemView, type InventoryMarketCheck } from '@m2office/shared';
import { api, describeError } from './api.js';

type Kind = 'sale' | 'purchase';
const yen = (n: number | null) => (n === null ? '—' : `${n.toLocaleString('ja-JP')} 円`);
const day = (iso: string) => new Date(iso).toLocaleDateString('ja-JP', { month: 'numeric', day: 'numeric' });
const ORDER: Record<string, number> = { high: 0, low: 1, fair: 2 };

/** 位置の印。 */
function Position({ c, kind }: { c: InventoryMarketCheck | undefined; kind: Kind }) {
  if (!c) return <span className="muted small">まだ調べていない</span>;
  if (c.status !== 'found') return <span className="muted small">{c.status === 'none' ? '見つからなかった' : '調べられなかった'}</span>;
  if (!c.position) return <span className="muted small">{kind === 'purchase' ? '仕入価格が無い' : '自社の価格が無い'}</span>;
  const label = (kind === 'purchase' ? INVENTORY_PURCHASE_POSITION_LABEL : INVENTORY_MARKET_POSITION_LABEL)[c.position];
  // 仕入れは「高く仕入れている」が注意、販売は「高め・安め」の両方が注意
  const warn = kind === 'purchase' ? c.position === 'high' : c.position !== 'fair';
  return <span className={`badge ${warn ? 'warn' : 'ok'}`}>{label}</span>;
}

/** 差の表記。 */
const diffText = (c: InventoryMarketCheck | undefined) => (c?.diffPct === null || c?.diffPct === undefined ? '' : `${c.diffPct > 0 ? '+' : ''}${c.diffPct}%`);

/**
 * 「価格の比較」のタブ。一覧の絞り込み（区分・分類・状態）に当たる品目だけを出す。
 *
 * @param admin 利用範囲の管理者か（仕入れの相場に切り替えられる）
 */
export function MarketPanel({ items, onOpenItem, admin = false }: { items: InventoryItemView[]; onOpenItem: (id: string) => void; admin?: boolean }) {
  const [kind, setKind] = useState<Kind>('sale');
  const [data, setData] = useState<{ available: boolean; reason?: string; checks: InventoryMarketCheck[]; running: boolean } | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const load = useCallback(() => { api.inventory.market(kind).then(setData).catch((e) => setMessage(describeError(e, '読み込めませんでした'))); }, [kind]);
  useEffect(() => { setData(null); load(); }, [load]);
  // まとめて調べている間は読み直す
  useEffect(() => {
    if (!data?.running) return undefined;
    const t = setInterval(load, 8000);
    return () => clearInterval(t);
  }, [data?.running, load]);
  const by = new Map((data?.checks ?? []).map((c) => [c.itemId, c]));
  const targets = items.filter((i) => i.status === 'active' && (kind === 'purchase' ? i.purchasePrice !== null && i.purchasePrice !== undefined : i.kind === 'sale'));
  const rank = (i: InventoryItemView) => { const c = by.get(i.id); return c?.status === 'found' && c.position ? ORDER[c.position]! : c ? 3 : 4; };
  const rows = [...targets].sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name, 'ja'));
  const checkAll = async () => {
    setMessage(null);
    try {
      const r = await api.inventory.checkMarket(undefined, kind);
      setMessage(r.started ? `${r.started} 品目の${kind === 'purchase' ? '仕入れの' : ''}相場を調べています。終わると表が新しくなります`
        : kind === 'purchase' ? '調べる品目がありません（仕入価格のある品目を調べます）' : '調べる販売品がありません（販売価格のある販売品を調べます）');
      load();
    } catch (e) { setMessage(describeError(e, '調べられませんでした')); }
  };
  return (
    <div className="card inventory-market">
      <div className="row">
        {admin && (
          <div className="seg" role="tablist" aria-label="比べる価格">
            <button role="tab" aria-selected={kind === 'sale'} className={kind === 'sale' ? 'on' : ''} onClick={() => setKind('sale')}>販売価格</button>
            <button role="tab" aria-selected={kind === 'purchase'} className={kind === 'purchase' ? 'on' : ''} onClick={() => setKind('purchase')}>仕入価格</button>
          </div>
        )}
        {data?.available && <button className="btn ghost small" disabled={data.running} onClick={() => void checkAll()}>{data.running ? '調べています…' : 'まとめて調べる'}</button>}
      </div>
      {data && !data.available && <p className="muted small">{data.reason}</p>}
      {message && <p className="small muted" role="status">{message}</p>}
      {data && rows.length === 0 && <p className="muted small">{kind === 'purchase' ? '仕入価格のある品目はありません' : '当たる販売品はありません'}</p>}
      {rows.length > 0 && (
        <div className="table-scroll"><table className="table">
          <thead>
            <tr><th>品名</th><th className="num">{kind === 'purchase' ? '自社の仕入価格（税抜）' : '自社の価格'}</th><th className="num">{kind === 'purchase' ? '仕入れの相場' : '相場'}</th><th className="num">幅</th><th className="num">差</th><th>位置</th><th className="num">件数</th><th>調べた日</th></tr>
          </thead>
          <tbody>
            {rows.map((i) => {
              const c = by.get(i.id);
              return (
                <tr key={i.id} className="clickable" onClick={() => onOpenItem(i.id)}>
                  <td><button className="link" onClick={(e) => { e.stopPropagation(); onOpenItem(i.id); }}>{i.name}</button></td>
                  <td className="num">{yen(c?.ourPrice ?? null)}</td>
                  <td className="num"><strong>{yen(c?.median ?? null)}</strong></td>
                  <td className="num small">{c?.min !== null && c?.min !== undefined ? `${c.min.toLocaleString('ja-JP')}〜${(c.max ?? c.min).toLocaleString('ja-JP')}` : ''}</td>
                  <td className="num">{diffText(c)}</td>
                  <td><Position c={c} kind={kind} /></td>
                  <td className="num">{c?.offers ? c.offers : ''}</td>
                  <td className="small">{c ? day(c.checkedAt) : ''}</td>
                </tr>
              );
            })}
          </tbody>
        </table></div>
      )}
    </div>
  );
}

/** 1 種類の相場（いちばん新しい結果・出典・調べる・月ごと）。 */
function MarketBlock({ item, kind, checks, onChecked }: { item: InventoryItemView; kind: Kind; checks: InventoryMarketCheck[]; onChecked: () => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const mine = checks.filter((c) => (c.kind ?? 'sale') === kind);
  const latest = mine[0];
  const monthly = new Map<string, number>();
  for (const c of mine) if (c.status === 'found' && c.median !== null && !monthly.has(c.checkedAt.slice(0, 7))) monthly.set(c.checkedAt.slice(0, 7), c.median);
  const check = async () => {
    setBusy(true); setError(null);
    try { await api.inventory.checkMarket([item.id], kind); onChecked(); } catch (e) { setError(describeError(e, '調べられませんでした')); } finally { setBusy(false); }
  };
  return (
    <>
      <div className="row">
        <strong className="small">{kind === 'purchase' ? '仕入れの相場' : '販売の相場'}</strong>
        {latest ? <><Position c={latest} kind={kind} /><span className="small">{latest.comment}</span><span className="muted small">（{day(latest.checkedAt)}）</span></> : <span className="muted small">まだ調べていません</span>}
        <button className="btn ghost small" disabled={busy} onClick={() => void check()}>{busy ? '調べています…' : kind === 'purchase' ? '仕入れの相場を調べる' : '相場を調べる'}</button>
      </div>
      {error && <p className="error small">{error}</p>}
      {latest && latest.sources.length > 0 && (
        <ul className="plain small market-sources">
          {latest.sources.slice().sort((a, b) => a.price - b.price).map((s, k) => (
            <li key={k}>
              <strong>{s.price.toLocaleString('ja-JP')} 円</strong>
              {kind === 'purchase'
                ? <span className="muted">（1 つあたり・税抜。{s.pack && s.pack > 1 ? `${s.pack} 個で ` : ''}{s.listed.toLocaleString('ja-JP')} 円{s.taxIncluded ? '（税込）' : ''}）</span>
                : !s.taxIncluded && <span className="muted">（税抜 {s.listed.toLocaleString('ja-JP')} 円から）</span>}
              {' '}<a href={s.url} target="_blank" rel="noopener noreferrer">{s.shop}</a>{s.from === 'competitor' && <span className="badge">競合</span>}
            </li>
          ))}
        </ul>
      )}
      {monthly.size > 1 && <p className="muted small">月ごとの{kind === 'purchase' ? '仕入れの' : ''}相場: {[...monthly].reverse().map(([m, v]) => `${Number(m.slice(5))} 月 ${v.toLocaleString('ja-JP')} 円`).join('・')}</p>}
    </>
  );
}

/**
 * 品目の詳細の相場。販売品には販売の相場、管理者で仕入価格のある品目には仕入れの相場も出す。
 */
export function MarketSection({ item, admin = false }: { item: InventoryItemView; admin?: boolean }) {
  const [checks, setChecks] = useState<InventoryMarketCheck[]>([]);
  const load = useCallback(() => { api.inventory.itemMarket(item.id).then((r) => setChecks(r.checks)).catch(() => setChecks([])); }, [item.id]);
  useEffect(() => { load(); }, [load]);
  const sale = item.kind === 'sale';
  const purchase = admin && item.purchasePrice !== null && item.purchasePrice !== undefined;
  if (!sale && !purchase) return null;
  return (
    <div className="market-section">
      <h3>相場</h3>
      {sale && <MarketBlock item={item} kind="sale" checks={checks} onChecked={load} />}
      {purchase && <MarketBlock item={item} kind="purchase" checks={checks} onChecked={load} />}
    </div>
  );
}
