/**
 * @file 販売品の相場と競合の比較（仕様書 第29.24節、Q-243）。
 *
 * 「価格の比較」のタブ（販売品ごとの自社の価格・相場・差・位置）と、品目の詳細の相場（出典の一覧・相場を調べる・月ごとの相場）。
 * 値付けを決めるのは会社で、ここは材料を出すだけ（価格は変えない）。説明文は常に出さない（原則 u11）。
 */
import { useCallback, useEffect, useState } from 'react';
import { INVENTORY_MARKET_POSITION_LABEL, type InventoryItemView, type InventoryMarketCheck } from '@m2office/shared';
import { api, describeError } from './api.js';

const yen = (n: number | null) => (n === null ? '—' : `${n.toLocaleString('ja-JP')} 円`);
const day = (iso: string) => new Date(iso).toLocaleDateString('ja-JP', { month: 'numeric', day: 'numeric' });
const ORDER: Record<string, number> = { high: 0, low: 1, fair: 2 };

/** 位置の印。 */
function Position({ c }: { c: InventoryMarketCheck | undefined }) {
  if (!c) return <span className="muted small">まだ調べていない</span>;
  if (c.status !== 'found') return <span className="muted small">{c.status === 'none' ? '見つからなかった' : '調べられなかった'}</span>;
  if (!c.position) return <span className="muted small">自社の価格が無い</span>;
  return <span className={`badge ${c.position === 'fair' ? 'ok' : 'warn'}`}>{INVENTORY_MARKET_POSITION_LABEL[c.position]}</span>;
}

/** 差の表記。 */
const diffText = (c: InventoryMarketCheck | undefined) => (c?.diffPct === null || c?.diffPct === undefined ? '' : `${c.diffPct > 0 ? '+' : ''}${c.diffPct}%`);

/**
 * 「価格の比較」のタブ。一覧の絞り込み（区分・分類・状態）に当たる販売品だけを出す。
 */
export function MarketPanel({ items, onOpenItem }: { items: InventoryItemView[]; onOpenItem: (id: string) => void }) {
  const [data, setData] = useState<{ available: boolean; reason?: string; checks: InventoryMarketCheck[]; running: boolean } | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const load = useCallback(() => { api.inventory.market().then(setData).catch((e) => setMessage(describeError(e, '読み込めませんでした'))); }, []);
  useEffect(() => { load(); }, [load]);
  // まとめて調べている間は読み直す
  useEffect(() => {
    if (!data?.running) return undefined;
    const t = setInterval(load, 8000);
    return () => clearInterval(t);
  }, [data?.running, load]);
  const by = new Map((data?.checks ?? []).map((c) => [c.itemId, c]));
  const sale = items.filter((i) => i.kind === 'sale' && i.status === 'active');
  const rank = (i: InventoryItemView) => { const c = by.get(i.id); return c?.status === 'found' && c.position ? ORDER[c.position]! : c ? 3 : 4; };
  const rows = [...sale].sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name, 'ja'));
  const checkAll = async () => {
    setMessage(null);
    try {
      const r = await api.inventory.checkMarket();
      setMessage(r.started ? `${r.started} 品目の相場を調べています。終わると表が新しくなります` : '調べる販売品がありません（販売価格のある販売品を調べます）');
      load();
    } catch (e) { setMessage(describeError(e, '調べられませんでした')); }
  };
  return (
    <div className="card inventory-market">
      {data && !data.available && <p className="muted small">{data.reason}</p>}
      {data?.available && (
        <div className="row">
          <button className="btn ghost small" disabled={data.running} onClick={() => void checkAll()}>{data.running ? '調べています…' : 'まとめて調べる'}</button>
        </div>
      )}
      {message && <p className="small muted" role="status">{message}</p>}
      {data && rows.length === 0 && <p className="muted small">当たる販売品はありません</p>}
      {rows.length > 0 && (
        <div className="table-scroll"><table className="table">
          <thead>
            <tr><th>品名</th><th className="num">自社の価格</th><th className="num">相場</th><th className="num">幅</th><th className="num">差</th><th>位置</th><th className="num">件数</th><th>調べた日</th></tr>
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
                  <td><Position c={c} /></td>
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

/**
 * 品目の詳細の相場（販売品だけ）。いちばん新しい結果の出典の一覧・相場を調べる・月ごとの相場。
 */
export function MarketSection({ item }: { item: InventoryItemView }) {
  const [checks, setChecks] = useState<InventoryMarketCheck[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(() => { api.inventory.itemMarket(item.id).then((r) => setChecks(r.checks)).catch(() => setChecks([])); }, [item.id]);
  useEffect(() => { load(); }, [load]);
  if (item.kind !== 'sale') return null;
  const latest = checks?.[0];
  // 月ごとの相場（その月のいちばん新しい見つかった結果）
  const monthly = new Map<string, number>();
  for (const c of checks ?? []) if (c.status === 'found' && c.median !== null && !monthly.has(c.checkedAt.slice(0, 7))) monthly.set(c.checkedAt.slice(0, 7), c.median);
  const check = async () => {
    setBusy(true); setError(null);
    try { await api.inventory.checkMarket([item.id]); load(); } catch (e) { setError(describeError(e, '調べられませんでした')); } finally { setBusy(false); }
  };
  return (
    <div className="market-section">
      <h3>相場</h3>
      <div className="row">
        {latest ? <><Position c={latest} /><span className="small">{latest.comment}</span><span className="muted small">（{day(latest.checkedAt)}）</span></> : <span className="muted small">まだ調べていません</span>}
        <button className="btn ghost small" disabled={busy} onClick={() => void check()}>{busy ? '調べています…' : '相場を調べる'}</button>
      </div>
      {error && <p className="error small">{error}</p>}
      {latest && latest.sources.length > 0 && (
        <ul className="plain small market-sources">
          {latest.sources.slice().sort((a, b) => a.price - b.price).map((s, k) => (
            <li key={k}>
              <strong>{s.price.toLocaleString('ja-JP')} 円</strong>{!s.taxIncluded && <span className="muted">（税抜 {s.listed.toLocaleString('ja-JP')} 円から）</span>}
              {' '}<a href={s.url} target="_blank" rel="noopener noreferrer">{s.shop}</a>{s.from === 'competitor' && <span className="badge">競合</span>}
            </li>
          ))}
        </ul>
      )}
      {monthly.size > 1 && (
        <p className="muted small">月ごとの相場: {[...monthly].reverse().map(([m, v]) => `${Number(m.slice(5))} 月 ${v.toLocaleString('ja-JP')} 円`).join('・')}</p>
      )}
    </div>
  );
}
