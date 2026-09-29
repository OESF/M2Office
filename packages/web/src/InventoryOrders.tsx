/**
 * @file 在庫管理のパソコンの画面の、発注の案・仕入先・納品書から入庫・取り置きの欄（仕様書 第29.14節・第29.4.1節・第29.9節・第29.13節）。
 *
 * 発注の案は見張りの結果（無くなる見込みの早い順）を仕入先ごとにまとめ、数を直して発注を始められるようにする。
 * メールの仕入先は「発注の下書き」の業務がメールを作り、**本人が承認トレイで確かめたあとに送る**。
 * Web・電話の仕入先は、発注の画面か電話番号と、伝える内容を出す。説明文を常に出さない（原則 u11）。
 */

import { useCallback, useEffect, useState } from 'react';
import type { InventoryBooking, InventoryItemView, InventorySupplier } from '@m2office/shared';
import { api, describeError, type InventoryForecastRow, type InventoryOrderResult, type InventorySlipResult } from './api.js';

const METHOD_LABELS: Record<InventorySupplier['method'], string> = { mail: 'メール', web: 'Web', phone: '電話' };
const round = (n: number) => Math.round(n * 100) / 100;

/** 数の出し方（仕入れの単位があれば添える）。 */
function amount(r: { unit: string; packUnit: string; packSize: number | null }, qty: number): string {
  return r.packUnit && r.packSize ? `${qty} ${r.unit}（${round(qty / r.packSize)} ${r.packUnit}）` : `${qty} ${r.unit}`;
}

/** 品目 1 つの状況（あと何日・残りわずか）。 */
function status(r: InventoryForecastRow): string {
  if (r.runningOut && r.daysLeft !== null) return `あと ${r.daysLeft} 日で無くなる見込み（仕入れに ${r.leadDays} 日）`;
  if (r.low) return '残りわずか';
  return '';
}

/**
 * 発注の案。仕入先ごとにまとめ、数を直して発注を始める。
 *
 * @param onOpenItem 品目の詳細を開く（仕入先を選ぶため）
 */
export function OrderPanel({ onOpenItem }: { onOpenItem: (id: string) => void }) {
  const [rows, setRows] = useState<InventoryForecastRow[] | null>(null);
  const [qty, setQty] = useState<Record<string, string>>({});
  const [result, setResult] = useState<Record<string, InventoryOrderResult | string>>({});
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api.inventory.forecast().then((r) => setRows(r.rows)).catch((e) => setError(describeError(e, '読み込めませんでした')));
  }, []);
  if (!rows) return <div className="card inventory-new">{error ?? '読み込んでいます…'}</div>;

  const short = rows.filter((r) => r.runningOut || r.low);
  const expiring = rows.filter((r) => r.expiring.length > 0);
  const groups = new Map<string, InventoryForecastRow[]>();
  for (const r of short) {
    const key = r.proposal?.supplierId ?? '';
    groups.set(key, [...(groups.get(key) ?? []), r]);
  }
  const start = async (supplierId: string, list: InventoryForecastRow[]) => {
    const lines = list.map((r) => ({ itemId: r.itemId, qty: Number(qty[r.itemId] ?? r.proposal?.qty ?? 0) })).filter((l) => l.qty > 0);
    try {
      const r = await api.inventory.order(supplierId, lines);
      setResult((m) => ({ ...m, [supplierId]: r }));
    } catch (e) {
      setResult((m) => ({ ...m, [supplierId]: describeError(e, '発注を始められませんでした') }));
    }
  };

  return (
    <div className="card inventory-new order-panel">
      {short.length === 0 && expiring.length === 0 && <p className="muted small">足りなくなりそうなもの・期限の近いものはありません</p>}
      {[...groups].map(([supplierId, list]) => {
        const p = list[0]?.proposal;
        const res = result[supplierId];
        return (
          <div key={supplierId || 'none'} className="order-group">
            <div className="order-head">
              <strong>{p?.supplierName ?? '仕入先が決まっていない品目'}</strong>
              {p?.method && <span className="muted small"> {METHOD_LABELS[p.method]}{p.contact ? `・${p.contact}` : ''}</span>}
            </div>
            <table className="table">
              <tbody>
                {list.map((r) => (
                  <tr key={r.itemId}>
                    <td><button className="link" onClick={() => onOpenItem(r.itemId)}>{r.name}</button>
                      <div className="small muted">使える数 {amount(r, r.available)}</div>
                      {/* 案の理由（無くなる見込みの日数か、目安）。案が無ければ状況だけ */}
                      <div className="small muted">{r.proposal ? r.proposal.reason : status(r)}</div>
                    </td>
                    <td className="num order-qty">
                      {r.proposal && (
                        <><input type="number" min={0} className="num-input" value={qty[r.itemId] ?? String(r.proposal.qty)}
                          onChange={(e) => setQty((m) => ({ ...m, [r.itemId]: e.target.value }))} aria-label={`${r.name}の発注の数`} /> {r.unit}
                          {r.packUnit && r.packSize ? <div className="small muted">{round(Number(qty[r.itemId] ?? r.proposal.qty) / r.packSize)} {r.packUnit}</div> : null}</>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {supplierId
              ? <button className="btn small" onClick={() => void start(supplierId, list)}>
                {p?.method === 'mail' ? '発注のメールを作る' : '発注の内容を出す'}
              </button>
              : <p className="small muted">品目を開いて仕入先を選ぶと、発注の案を出せます</p>}
            {typeof res === 'string' && <p className="error small">{res}</p>}
            {res && typeof res !== 'string' && res.method === 'mail' && (
              <p className="small">発注のメールを作っています。送る前に承認トレイで宛先と本文を確かめてください。</p>
            )}
            {res && typeof res !== 'string' && res.method !== 'mail' && (
              <div className="small order-contact">
                {res.method === 'web'
                  ? <a href={res.contact} target="_blank" rel="noreferrer noopener">{res.supplier} の発注の画面を開く</a>
                  : <a href={`tel:${res.contact}`}>{res.supplier} に電話する（{res.contact}）</a>}
                <pre>{res.text}</pre>
              </div>
            )}
          </div>
        );
      })}
      {expiring.length > 0 && (
        <div className="order-group">
          <div className="order-head"><strong>使用期限の近いもの</strong></div>
          <ul className="plain">
            {expiring.flatMap((r) => r.expiring.map((e) => (
              <li key={`${r.itemId}:${e.lot ?? ''}`} className={e.days < 0 ? 'danger' : ''}>
                {r.name}{e.lot ? `（${e.lot}）` : ''}: {amount(r, e.qty)}・{e.days < 0 ? `${-e.days} 日前に期限切れ` : e.days === 0 ? '今日が期限' : `あと ${e.days} 日（${e.expiresOn}）`}
              </li>
            )))}
          </ul>
        </div>
      )}
    </div>
  );
}

/** 仕入先（発注の方法・連絡先・仕入れにかかる日数）の一覧と、足す・直す。 */
export function SuppliersPanel() {
  const [list, setList] = useState<InventorySupplier[] | null>(null);
  const [draft, setDraft] = useState<Partial<InventorySupplier>>({ method: 'mail' });
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(() => {
    api.inventory.suppliers().then((r) => setList(r.suppliers)).catch((e) => setError(describeError(e, '読み込めませんでした')));
  }, []);
  useEffect(load, [load]);
  const save = async () => {
    try {
      await api.inventory.saveSupplier(draft);
      setDraft({ method: 'mail' });
      setError(null);
      load();
    } catch (e) {
      setError(describeError(e, '保存できませんでした'));
    }
  };
  const placeholder = draft.method === 'web' ? '発注の画面の URL（https://…）' : draft.method === 'phone' ? '電話番号' : 'メールアドレス';
  return (
    <div className="card inventory-places">
      <ul className="plain">
        {(list ?? []).map((s) => (
          <li key={s.id} className="row">
            <span className="grow">{s.name}<span className="muted small"> {METHOD_LABELS[s.method]}{s.contact ? `・${s.contact}` : ''}{s.leadDays !== null ? `・${s.leadDays} 日` : ''}</span></span>
            <button className="link small" onClick={() => setDraft(s)}>直す</button>
          </li>
        ))}
      </ul>
      <div className="row wrap">
        <input className="short" placeholder="仕入先の名前" value={draft.name ?? ''} onChange={(e) => setDraft({ ...draft, name: e.target.value })} aria-label="仕入先の名前" />
        <select value={draft.method ?? 'mail'} onChange={(e) => setDraft({ ...draft, method: e.target.value as InventorySupplier['method'] })} aria-label="発注の方法">
          <option value="mail">メール</option><option value="web">Web</option><option value="phone">電話</option>
        </select>
        <input className="grow" placeholder={placeholder} value={draft.contact ?? ''} onChange={(e) => setDraft({ ...draft, contact: e.target.value })} aria-label="連絡先" />
        <input className="num-input" type="number" min={0} placeholder="日数" value={draft.leadDays ?? ''} aria-label="仕入れにかかる日数"
          onChange={(e) => setDraft({ ...draft, leadDays: e.target.value === '' ? null : Number(e.target.value) })} />
        <button className="btn small" disabled={!draft.name?.trim()} onClick={() => void save()}>{draft.id ? '保存' : '足す'}</button>
        {draft.id && <button className="btn ghost small" onClick={() => setDraft({ method: 'mail' })}>やめる</button>}
      </div>
      {error && <p className="error small">{error}</p>}
    </div>
  );
}

/**
 * 納品書から入庫した結果。入庫にした行と、照らせなかった行（候補を選んで入庫にできる）。
 *
 * @param onRecorded 入庫にしたあと（一覧を読み直す）
 */
export function SlipResultPanel({ result, items, onRecorded, onClose }: {
  result: InventorySlipResult; items: InventoryItemView[]; onRecorded: () => void; onClose: () => void;
}) {
  const [picked, setPicked] = useState<Record<number, string>>({});
  const [done, setDone] = useState<Record<number, string>>({});
  if (!result.read.ok) {
    return <div className="card inventory-new"><p className="error small">{result.read.reason}</p><button className="btn ghost small" onClick={onClose}>閉じる</button></div>;
  }
  const record = async (i: number) => {
    const u = result.unmatched[i]!;
    const itemId = picked[i] ?? u.candidates[0]?.id;
    if (!itemId || u.line.qty === null) return;
    try {
      const r = await api.inventory.move({ kind: 'in', itemId, qty: u.line.qty, reason: '納品書', ...(u.line.lot ? { lot: u.line.lot } : {}), ...(u.line.expiresOn ? { expiresOn: u.line.expiresOn } : {}) });
      setDone((m) => ({ ...m, [i]: `${r.item.name} に入庫しました` }));
      onRecorded();
    } catch (e) {
      setDone((m) => ({ ...m, [i]: describeError(e, '入庫できませんでした') }));
    }
  };
  return (
    <div className="card inventory-new slip-result">
      <div className="order-head"><strong>納品書{result.read.supplier ? `（${result.read.supplier}${result.read.date ? `・${result.read.date}` : ''}）` : ''}</strong></div>
      {result.recorded.length > 0 && <ul className="plain">{result.recorded.map((r, i) => <li key={i}>入庫: {r.text}</li>)}</ul>}
      {result.unmatched.map((u, i) => (
        <div key={i} className="row wrap">
          <span className="grow small">{u.line.name || u.line.sku || u.line.code}{u.line.qty !== null ? `・${u.line.qty} ${u.line.unit}` : ''}<span className="muted">（{u.reason}）</span></span>
          {done[i] ? <span className="small">{done[i]}</span> : u.line.qty !== null && (
            <>
              <select value={picked[i] ?? u.candidates[0]?.id ?? ''} onChange={(e) => setPicked((m) => ({ ...m, [i]: e.target.value }))} aria-label="入庫する品目">
                <option value="">品目を選ぶ</option>
                {(u.candidates.length ? u.candidates : items.map((x) => ({ id: x.id, name: x.name }))).map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
              </select>
              <button className="btn small" disabled={!(picked[i] ?? u.candidates[0]?.id)} onClick={() => void record(i)}>入庫</button>
            </>
          )}
        </div>
      ))}
      <button className="btn ghost small" onClick={onClose}>閉じる</button>
    </div>
  );
}

/** 予約の日時の出し方（日本時間）。今年でなければ年も出す。 */
function when(iso: string | null): string {
  if (!iso) return '日時なし';
  const d = new Date(iso);
  const year = (x: Date) => x.toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo', year: 'numeric' });
  return d.toLocaleString('ja-JP', {
    timeZone: 'Asia/Tokyo', ...(year(d) === year(new Date()) ? {} : { year: 'numeric' }), month: 'numeric', day: 'numeric', weekday: 'short', hour: '2-digit', minute: '2-digit',
  });
}

/**
 * 取り置き（予約との引き当て。仕様書 第29.13節）。今日から先の予約と、日を過ぎた取り置き・品目の分からないメニュー。
 * 画面で取り置き、予約の人が来たら「使った」、来なかったら「取り消し」を押す。
 *
 * @param onChanged 取り置き・使用のあと（一覧の使える数を読み直す）
 */
export function BookingsPanel({ items, onChanged }: { items: InventoryItemView[]; onChanged: () => void }) {
  const [data, setData] = useState<{ bookings: InventoryBooking[]; overdue: InventoryBooking[]; unmapped: InventoryBooking[] } | null>(null);
  const [draft, setDraft] = useState({ itemId: '', qty: '1', startsAt: '', externalId: '' });
  const [teach, setTeach] = useState<Record<string, { itemId: string; qty: string }>>({});
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(() => {
    api.inventory.bookings().then(setData).catch((e) => setError(describeError(e, '読み込めませんでした')));
  }, []);
  useEffect(load, [load]);
  const act = async (fn: () => Promise<unknown>, fail: string) => {
    try {
      await fn();
      setError(null);
      load();
      onChanged();
    } catch (e) {
      setError(describeError(e, fail));
    }
  };
  if (!data) return <div className="card inventory-new">{error ?? '読み込んでいます…'}</div>;
  const menus = [...new Set(data.unmapped.map((b) => b.menu))];
  // 済んだ予約（使った・取り消し）は出さない
  const upcoming = data.bookings.filter((b) => b.status === 'booked');
  const row = (b: InventoryBooking, past = false) => {
    const held = b.lines.filter((l) => l.status === 'held');
    return (
      <li key={b.id} className={`row booking ${past ? 'danger' : ''}`}>
        <span className="grow small">
          <strong>{when(b.startsAt)}</strong> 予約 {b.externalId}{b.menu ? `・${b.menu}` : ''}{b.sourceName ? <span className="muted">（{b.sourceName}）</span> : null}
          <span className="muted"> {held.length ? held.map((l) => `${l.itemName ?? ''} ${l.qty} ${l.unit ?? ''}`).join('・') : b.mapped ? '在庫を使わない' : '品目が分かりません'}</span>
        </span>
        {held.length > 0 && <button className="btn small" onClick={() => void act(() => api.inventory.useBooking(b.id), '記録できませんでした')}>使った</button>}
        {held.length > 0 && <button className="btn ghost small" onClick={() => void act(() => api.inventory.cancelBooking(b.id), '取り消せませんでした')}>取り消し</button>}
      </li>
    );
  };
  return (
    <div className="card inventory-new bookings-panel">
      {data.overdue.length > 0 && (
        <>
          <div className="order-head"><strong>予約の日を過ぎた取り置き</strong></div>
          <ul className="plain">{data.overdue.map((b) => row(b, true))}</ul>
        </>
      )}
      {menus.length > 0 && (
        <>
          <div className="order-head"><strong>使う品目の分からないメニュー</strong></div>
          {menus.map((m) => {
            const t = teach[m] ?? { itemId: '', qty: '1' };
            return (
              <div key={m} className="row wrap">
                <span className="grow small">{m}</span>
                <select value={t.itemId} onChange={(e) => setTeach((x) => ({ ...x, [m]: { ...t, itemId: e.target.value } }))} aria-label={`${m}で使う品目`}>
                  <option value="">在庫を使わない</option>
                  {items.map((i) => <option key={i.id} value={i.id}>{i.name}</option>)}
                </select>
                {t.itemId && <input className="num-input" type="number" min={1} value={t.qty} onChange={(e) => setTeach((x) => ({ ...x, [m]: { ...t, qty: e.target.value } }))} aria-label="数" />}
                <button className="btn small" onClick={() => void act(() => api.inventory.teachMenu(m, t.itemId ? [{ itemId: t.itemId, qty: Number(t.qty) || 1 }] : []), '覚えられませんでした')}>覚える</button>
              </div>
            );
          })}
        </>
      )}
      <div className="order-head"><strong>これからの予約</strong></div>
      {upcoming.length === 0 ? <p className="muted small">取り置きはありません</p> : <ul className="plain">{upcoming.map((b) => row(b))}</ul>}
      <div className="row wrap">
        <input type="datetime-local" value={draft.startsAt} onChange={(e) => setDraft({ ...draft, startsAt: e.target.value })} aria-label="予約の日時" />
        <select value={draft.itemId} onChange={(e) => setDraft({ ...draft, itemId: e.target.value })} aria-label="取り置く品目">
          <option value="">品目を選ぶ</option>
          {items.map((i) => <option key={i.id} value={i.id}>{i.name}</option>)}
        </select>
        <input className="num-input" type="number" min={1} value={draft.qty} onChange={(e) => setDraft({ ...draft, qty: e.target.value })} aria-label="数" />
        <input className="short" placeholder="予約番号" value={draft.externalId} onChange={(e) => setDraft({ ...draft, externalId: e.target.value })} aria-label="予約番号" />
        <button className="btn small" disabled={!draft.itemId || !draft.startsAt}
          onClick={() => void act(async () => {
            await api.inventory.hold({ itemId: draft.itemId, qty: Number(draft.qty) || 1, startsAt: draft.startsAt, ...(draft.externalId ? { externalId: draft.externalId } : {}) });
            setDraft({ itemId: '', qty: '1', startsAt: '', externalId: '' });
          }, '取り置けませんでした')}>取り置く</button>
      </div>
      {error && <p className="error small">{error}</p>}
    </div>
  );
}
