/**
 * @file 販売の書類と受注の画面（仕様書 第42.5.4節）。「受注」（注文書を置いて取り込む・一覧・1 件の直しと納品書・請求書づくり）と
 * 「書類」（発行した書類の一覧と、取引の日付・金額・取引先での検索・1 通の PDF・発行・送る・直す・取り消し）の 2 つの欄。
 *
 * 金額は API が決まった計算で出したものをそのまま出す。発行は本人が押して行う（番号が付き、書き換えられなくなる。第42.3.1節）。
 * 送る・直すは業務に頼む（送るのは承認の後）。説明の文は常に出さない（原則 u11）。
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  SALES_DOC_KIND_LABELS, SALES_DOC_STATUS_LABELS, SALES_ORDER_STATUS_LABELS,
  type SalesDocKind, type SalesDocStatus, type SalesDocument, type SalesOrder, type SalesOrderStatus, type SalesSuggestions,
} from '@m2office/shared';
import { api, describeError, type SalesDocDetail } from './api.js';
import { BackButton } from './back-button.js';

/** 書類の種類ごとの業務（送る・直すを頼む先）。 */
const AGENT_OF: Record<SalesDocKind, string> = {
  purchase_order: 'sales-docs:purchase-order', delivery: 'sales-docs:delivery-note', invoice: 'sales-docs:invoice', receipt: 'sales-docs:receipt',
};
const RECEIPT_AGENT = AGENT_OF.receipt;

const today = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Tokyo', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
const dayLabel = (d: string | null) => (d ? d.replace(/-/g, '/') : '—');
const yen = (n: number) => `${n.toLocaleString('ja-JP')} 円`;
const ORDER_BADGE: Record<SalesOrderStatus, string> = { open: 'badge', partial: 'badge warn', delivered: 'badge ok', invoiced: 'badge ok', cancelled: 'badge' };
const DOC_BADGE: Record<SalesDocStatus, string> = { draft: 'badge warn', issued: 'badge ok', cancelled: 'badge' };
const docNumber = (d: SalesDocument) => (d.number ? `${d.number}${d.version > 1 ? `（訂正版 ${d.version}）` : ''}` : '下書き');

type Note = { kind: 'ok' | 'error'; text: string } | null;
function NoteText({ note }: { note: Note }) {
  return note ? <span className={`contracts-note is-${note.kind}`} role={note.kind === 'error' ? 'alert' : 'status'}>{note.text}</span> : null;
}

/** 書類の状態の印（納品書は請求済みかも出す）。 */
function DocStatus({ d }: { d: SalesDocument }) {
  return (
    <>
      <span className={DOC_BADGE[d.status]}>{SALES_DOC_STATUS_LABELS[d.status]}</span>
      {d.kind === 'delivery' && d.status === 'issued' && <> <span className={d.invoiceId ? 'badge ok' : 'badge'}>{d.invoiceId ? '請求済み' : '未請求'}</span></>}
      {d.notices.length > 0 && <> <span className="badge warn" title={d.notices.join('\n')}>知らせ</span></>}
    </>
  );
}

/** 販売の書類と受注の画面（一覧か 1 件）。 */
export function SalesDocs({ itemId, onOpen, onOpenRun, changeKey }: {
  itemId: string | null;
  onOpen: (itemId: string | null) => void;
  onOpenRun: (runId: string) => void;
  /** 業務が書類や受注を作り終えるたびに変わる値。変わったら読み直す。 */
  changeKey: string;
}) {
  const [tab, setTab] = useState<'orders' | 'documents'>('orders');
  if (itemId?.startsWith('so-')) return <OrderView key={itemId} id={itemId} onBack={() => onOpen(null)} onOpen={onOpen} changeKey={changeKey} />;
  if (itemId?.startsWith('sd-')) return <DocView key={itemId} id={itemId} onBack={() => { setTab('documents'); onOpen(null); }} onOpen={onOpen} onOpenRun={onOpenRun} changeKey={changeKey} />;
  return (
    <div className="contracts sales">
      <div className="segmented" role="tablist">
        <button role="tab" aria-selected={tab === 'orders'} className={tab === 'orders' ? 'on' : ''} onClick={() => setTab('orders')}>受注</button>
        <button role="tab" aria-selected={tab === 'documents'} className={tab === 'documents' ? 'on' : ''} onClick={() => setTab('documents')}>書類</button>
      </div>
      {tab === 'orders' ? <OrderList onOpen={onOpen} changeKey={changeKey} /> : <DocList onOpen={onOpen} changeKey={changeKey} />}
    </div>
  );
}

/** 受注の一覧と、注文書を取り込む。 */
function OrderList({ onOpen, changeKey }: { onOpen: (id: string) => void; changeKey: string }) {
  const [items, setItems] = useState<SalesOrder[] | null>(null);
  const [status, setStatus] = useState('');
  const [q, setQ] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [note, setNote] = useState<Note>(null);
  const [error, setError] = useState<string | null>(null);
  const [manual, setManual] = useState(false);
  const file = useRef<HTMLInputElement>(null);

  const load = useCallback(() => {
    api.sales.orders({ ...(status ? { status } : {}), ...(q.trim() ? { q: q.trim() } : {}) })
      .then((r) => { setItems(r.items); setError(null); })
      .catch((e) => setError(describeError(e, '読めませんでした')));
  }, [status, q]);
  useEffect(() => { const t = setTimeout(load, q ? 250 : 0); return () => clearTimeout(t); }, [load, q]);
  useEffect(() => { if (changeKey) load(); }, [changeKey]); // eslint-disable-line react-hooks/exhaustive-deps

  /** 注文書を取り込む（いくつも置けば、1 つずつ順に読む）。 */
  const importFiles = async (files: File[]) => {
    setNote(null);
    const done: string[] = [];
    const failed: string[] = [];
    for (const [i, f] of files.entries()) {
      setBusy(files.length > 1 ? `${i + 1} / ${files.length} 件目を読んでいます…` : '読んでいます…');
      try {
        const up = await api.uploadFile(f);
        const r = await api.sales.importOrder({ fileId: up.id });
        done.push(r.linked ? `${f.name}（手で入れた受注 ${r.order.number} につなぎました）` : r.duplicate ? `${f.name}（同じ注文が受注 ${r.order.number} にあります）` : `${r.order.party.name || '取引先不明'}の注文（${r.order.number}）`);
        if (files.length === 1 && !r.duplicate) { setBusy(null); onOpen(r.order.id); return; }
      } catch (e) {
        failed.push(`${f.name}（${describeError(e, '取り込めませんでした')}）`);
      }
      load();
    }
    setBusy(null);
    setNote({ kind: failed.length ? 'error' : 'ok', text: [done.length ? `取り込みました: ${done.join('、')}` : '', failed.length ? `取り込めなかったもの: ${failed.join('、')}` : ''].filter(Boolean).join('。') });
  };

  return (
    <>
      <div className="row wrap contracts-entry"
        onDragOver={(e) => e.preventDefault()}
        onDrop={(e) => { e.preventDefault(); const fs = Array.from(e.dataTransfer.files).slice(0, 20); if (fs.length) void importFiles(fs); }}>
        <button className="btn" disabled={!!busy} onClick={() => file.current?.click()}>{busy ?? '注文書を取り込む'}</button>
        <input ref={file} type="file" hidden multiple accept="application/pdf,image/png,image/jpeg,.xlsx,.xls,.csv,.docx"
          onChange={(e) => { const fs = Array.from(e.target.files ?? []).slice(0, 20); e.target.value = ''; if (fs.length) void importFiles(fs); }} />
        <button className={manual ? 'btn small' : 'btn ghost small'} onClick={() => setManual(!manual)}>手で入れる</button>
        <NoteText note={note} />
      </div>
      {manual && <ManualOrderForm onDone={(id) => { setManual(false); onOpen(id); }} />}
      <div className="row wrap contracts-filter">
        <select value={status} aria-label="状態" onChange={(e) => setStatus(e.target.value)}>
          <option value="">状態: すべて</option>
          {(Object.keys(SALES_ORDER_STATUS_LABELS) as SalesOrderStatus[]).map((s) => <option key={s} value={s}>{SALES_ORDER_STATUS_LABELS[s]}</option>)}
        </select>
        <input className="contracts-search" type="search" value={q} placeholder="取引先・注文番号・品名で探す" aria-label="探す" onChange={(e) => setQ(e.target.value)} />
      </div>
      {error && <p className="error">{error}</p>}
      {items && items.length === 0 && <p className="muted">{q || status ? '当たる受注はありません。' : 'まだ受注がありません。'}</p>}
      {items && items.length > 0 && (
        <div className="table-scroll"><table className="table contracts-table">
          <thead><tr><th>受注番号</th><th>取引先</th><th>注文番号</th><th>注文日</th><th>納期</th><th className="num">合計</th><th>状態</th></tr></thead>
          <tbody>
            {items.map((o) => {
              const late = !!o.dueOn && o.dueOn < today() && (o.status === 'open' || o.status === 'partial');
              return (
                <tr key={o.id}>
                  <td className="nowrap"><button className="link" onClick={() => onOpen(o.id)}>{o.number}</button></td>
                  <td>{o.party.name || '取引先不明'}{o.flags.length > 0 && <> <span className="badge warn" title={o.flags.map((f) => f.text).join('\n')}>確かめて</span></>}</td>
                  <td>{o.customerRef || '—'}</td>
                  <td className="nowrap">{dayLabel(o.orderedOn)}</td>
                  <td className="nowrap">{late ? <span className="badge danger">{dayLabel(o.dueOn)}</span> : dayLabel(o.dueOn)}</td>
                  <td className="num nowrap">{yen(o.total)}</td>
                  <td><span className={ORDER_BADGE[o.status]}>{SALES_ORDER_STATUS_LABELS[o.status]}</span></td>
                </tr>
              );
            })}
          </tbody>
        </table></div>
      )}
    </>
  );
}

/** 手で入れる品目の 1 行。 */
interface ManualLine { name: string; quantity: string; unit: string; unitPrice: string; reduced: boolean }
const emptyLine = (): ManualLine => ({ name: '', quantity: '1', unit: '', unitPrice: '', reduced: false });

/**
 * 手で入れる欄（電話などで受けた注文。仕様書 第42.5.1.1節）。取引先・品目・納期だけを出し、ほかは「詳しく」を開いたときだけ。
 * 取引先と品名は前の受注・書類・見積書から候補を出し、品名を選ぶと単位と単価が入る。品名は「いつもの」でもよい。
 */
function ManualOrderForm({ onDone }: { onDone: (orderId: string) => void }) {
  const [party, setParty] = useState('');
  const [lines, setLines] = useState<ManualLine[]>([emptyLine()]);
  const [dueOn, setDueOn] = useState('');
  const [more, setMore] = useState(false);
  const [extra, setExtra] = useState({ person: '', customerRef: '', orderedOn: '', deliverTo: '', terms: '', notes: '' });
  const [hints, setHints] = useState<SalesSuggestions>({ parties: [], items: [] });
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<Note>(null);
  // 取引先が決まったら、その取引先の前の品目を候補にする
  useEffect(() => {
    const t = setTimeout(() => { api.sales.suggestions(party.trim()).then(setHints).catch(() => undefined); }, party ? 300 : 0);
    return () => clearTimeout(t);
  }, [party]);
  const setLine = (i: number, patch: Partial<ManualLine>) => setLines((cur) => cur.map((l, k) => {
    if (k !== i) return l;
    const next = { ...l, ...patch };
    // 候補の品名を選んだら、単位と単価を入れる（入っていれば変えない）
    const hit = patch.name !== undefined ? hints.items.find((x) => x.name === patch.name) : undefined;
    return hit ? { ...next, unit: next.unit || hit.unit, unitPrice: next.unitPrice || (hit.unitPrice === null ? '' : String(hit.unitPrice)), reduced: hit.taxRate === 8 } : next;
  }));
  const save = () => {
    setBusy(true);
    setNote(null);
    api.sales.recordOrder({
      party: party.trim(), dueOn: dueOn || undefined, ...Object.fromEntries(Object.entries(extra).filter(([, v]) => v.trim())),
      items: lines.filter((l) => l.name.trim()).map((l) => ({
        name: l.name.trim(), quantity: l.quantity, unit: l.unit.trim(), unitPrice: l.unitPrice === '' ? null : l.unitPrice, taxRate: l.reduced ? 8 : 10,
      })),
    }).then((r) => {
      if (r.duplicate) setNote({ kind: 'error', text: `同じ注文がもう受注 ${r.order.number} にあります` });
      else onDone(r.order.id);
    }).catch((e) => setNote({ kind: 'error', text: describeError(e, '入れられませんでした') })).finally(() => setBusy(false));
  };
  return (
    <div className="card contracts-manual sales-manual">
      <datalist id="sales-parties">{hints.parties.map((p) => <option key={p} value={p} />)}</datalist>
      <datalist id="sales-items">{hints.items.map((x) => <option key={x.name} value={x.name} />)}</datalist>
      <div className="row wrap">
        <label className="grow">取引先<input list="sales-parties" value={party} maxLength={100} onChange={(e) => setParty(e.target.value)} /></label>
        <label>納期<input type="date" value={dueOn} onChange={(e) => setDueOn(e.target.value)} /></label>
      </div>
      {lines.map((l, i) => (
        <div className="row wrap sales-line" key={i}>
          <label className="grow">品名<input list="sales-items" value={l.name} maxLength={80} placeholder="いつもの" onChange={(e) => setLine(i, { name: e.target.value })} /></label>
          <label>数量<input type="number" min={0} className="num-input" value={l.quantity} onChange={(e) => setLine(i, { quantity: e.target.value })} /></label>
          <label>単位<input className="unit-input" value={l.unit} maxLength={10} onChange={(e) => setLine(i, { unit: e.target.value })} /></label>
          <label>単価<input type="number" min={0} className="num-input" value={l.unitPrice} onChange={(e) => setLine(i, { unitPrice: e.target.value })} /></label>
          {more && <label className="check"><input type="checkbox" checked={l.reduced} onChange={(e) => setLine(i, { reduced: e.target.checked })} />軽減税率</label>}
          {lines.length > 1 && <button className="btn ghost small" aria-label="この品目を外す" onClick={() => setLines(lines.filter((_, k) => k !== i))}>×</button>}
        </div>
      ))}
      <div className="row wrap">
        <button className="btn ghost small" onClick={() => setLines([...lines, emptyLine()])}>品目を足す</button>
        <button className="link small" onClick={() => setMore(!more)}>{more ? '閉じる' : '詳しく'}</button>
      </div>
      {more && (
        <div className="row wrap">
          <label>先方の担当<input value={extra.person} maxLength={40} onChange={(e) => setExtra({ ...extra, person: e.target.value })} /></label>
          <label>相手の注文番号<input value={extra.customerRef} maxLength={60} onChange={(e) => setExtra({ ...extra, customerRef: e.target.value })} /></label>
          <label>注文日<input type="date" value={extra.orderedOn} onChange={(e) => setExtra({ ...extra, orderedOn: e.target.value })} /></label>
          <label>納品先<input value={extra.deliverTo} maxLength={120} onChange={(e) => setExtra({ ...extra, deliverTo: e.target.value })} /></label>
          <label>支払い条件<input value={extra.terms} maxLength={80} onChange={(e) => setExtra({ ...extra, terms: e.target.value })} /></label>
          <label className="grow">備考<input value={extra.notes} maxLength={300} onChange={(e) => setExtra({ ...extra, notes: e.target.value })} /></label>
        </div>
      )}
      <div className="row">
        <button className="btn small" disabled={busy || !party.trim() || !lines.some((l) => l.name.trim())} onClick={save}>{busy ? '入れています…' : '入れる'}</button>
        <NoteText note={note} />
      </div>
    </div>
  );
}

/** 受注 1 件。読み取りはその場で直す（欄を離れると保存）。 */
function OrderView({ id, onBack, onOpen, changeKey }: { id: string; onBack: () => void; onOpen: (id: string | null) => void; changeKey: string }) {
  const [r, setR] = useState<{ order: SalesOrder; documents: SalesDocument[] } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<Note>(null);
  const [busy, setBusy] = useState(false);
  const load = useCallback(() => {
    api.sales.order(id).then((x) => { setR(x); setError(null); }).catch((e) => setError(describeError(e, '読めませんでした')));
  }, [id]);
  useEffect(load, [load, changeKey]);
  if (error) return <div className="contracts"><BackButton label="受注の一覧" onClick={onBack} /><p className="error">{error}</p></div>;
  if (!r) return <div className="contracts"><p className="muted">読み込み中…</p></div>;
  const o = r.order;

  const save = (patch: Record<string, unknown>) => {
    api.sales.updateOrder(id, patch).then((x) => { setR(x); setNote({ kind: 'ok', text: '保存しました' }); }).catch((e) => setNote({ kind: 'error', text: describeError(e, '保存できませんでした') }));
  };
  const field = (key: 'customerRef' | 'orderedOn' | 'dueOn' | 'deliverTo' | 'terms', label: string, type: 'text' | 'date' = 'text') => (
    <label>{label}
      <input type={type} defaultValue={o[key] ?? ''} key={`${key}-${o[key] ?? ''}`} maxLength={120} disabled={o.status === 'cancelled'}
        onBlur={(e) => { const v = type === 'date' ? (e.target.value || null) : e.target.value; if (v !== (o[key] ?? (type === 'date' ? null : ''))) save({ [key]: v }); }} />
    </label>
  );
  const act = (p: Promise<unknown>, ok: string, fail: string, after?: (x: unknown) => void) => {
    setBusy(true);
    p.then((x) => { setNote({ kind: 'ok', text: ok }); load(); after?.(x); })
      .catch((e) => setNote({ kind: 'error', text: describeError(e, fail) })).finally(() => setBusy(false));
  };
  // 下書きの請求書に入っている納品書は除く（同じ納品書で下書きを重ねない）
  const inDraft = new Set(r.documents.filter((d) => d.kind === 'invoice' && d.status === 'draft').flatMap((d) => d.deliveryIds));
  const unbilled = r.documents.filter((d) => d.kind === 'delivery' && d.status === 'issued' && !d.invoiceId && !inDraft.has(d.id));
  return (
    <div className="contracts sales">
      <div className="row">
        <BackButton label="受注の一覧" onClick={onBack} />
        <NoteText note={note} />
      </div>
      <h2>{o.party.name || '取引先不明'} <span className={ORDER_BADGE[o.status]}>{SALES_ORDER_STATUS_LABELS[o.status]}</span> <span className="small muted">{o.number}</span></h2>
      {o.flags.length > 0 && <ul className="sales-flags">{o.flags.map((f, i) => <li key={i}><span className="badge warn">確かめて</span> {f.text}</li>)}</ul>}
      {o.cancelReason && <p className="small muted">取り消しの理由: {o.cancelReason}</p>}
      <div className="card contracts-detail">
        <div className="row wrap">{field('customerRef', '相手の注文番号')}{field('orderedOn', '注文日', 'date')}{field('dueOn', '納期', 'date')}</div>
        <div className="row wrap">{field('deliverTo', '納品先')}{field('terms', '支払い条件')}</div>
        {(o.party.person || o.party.address || o.party.email || o.party.phone) && (
          <p className="small muted">{[o.party.department, o.party.person, o.party.address, o.party.phone, o.party.email].filter(Boolean).join('　')}</p>
        )}
        <div className="table-scroll"><table className="table">
          <thead><tr><th>品名</th><th>品番</th><th className="num">数量</th><th className="num">納品済み</th><th className="num">単価</th></tr></thead>
          <tbody>{o.items.map((i, k) => (
            <tr key={k}>
              <td>{i.name}{i.taxRate === 8 && <span className="small muted">（軽減税率）</span>}</td><td>{i.code || '—'}</td>
              <td className="num">{i.quantity} {i.unit}</td><td className="num">{o.delivered[k] ?? 0}</td>
              <td className="num">{i.unitPrice === null ? <span className="badge warn">なし</span> : yen(i.unitPrice)}</td>
            </tr>
          ))}</tbody>
        </table></div>
        <p>合計 {yen(o.total)}（小計 {yen(o.subtotal)}・消費税 {yen(o.tax)}）{o.statedTotal !== null && o.statedTotal !== o.total && <span className="badge warn">注文書の合計 {yen(o.statedTotal)}</span>}</p>
        {o.quoteNumber && <p className="small muted">見積書: {o.quoteNumber}</p>}
      </div>
      <div className="row wrap">
        {o.sourceFileId && <a className="btn ghost small" href={api.sales.orderFileUrl(o.id)} target="_blank" rel="noopener noreferrer">注文書を開く</a>}
        {(o.status === 'open' || o.status === 'partial') && (
          <button className="btn small" disabled={busy} onClick={() => act(api.sales.deliver(o.id), '納品書を作りました', '納品書を作れませんでした', (x) => onOpen((x as { doc: SalesDocument }).doc.id))}>納品書を作る</button>
        )}
        {unbilled.length > 0 && (
          <button className="btn small" disabled={busy} onClick={() => act(api.sales.invoice(unbilled.map((d) => d.id)), '請求書の下書きを作りました', '請求書を作れませんでした', (x) => onOpen((x as { doc: SalesDocument }).doc.id))}>請求書を作る</button>
        )}
        {o.status !== 'cancelled' && (
          <button className="btn ghost small" disabled={busy} onClick={() => {
            const reason = window.prompt('取り消しの理由');
            if (reason?.trim()) act(api.sales.cancelOrder(o.id, reason.trim()), '取り消しました', '取り消せませんでした');
          }}>取り消し</button>
        )}
        <button className="btn ghost small danger" disabled={busy} onClick={() => {
          if (window.confirm('この受注を削除しますか（取り込み違いのとき）')) {
            api.sales.removeOrder(o.id).then(onBack).catch((e) => setNote({ kind: 'error', text: describeError(e, '削除できませんでした') }));
          }
        }}>削除</button>
      </div>
      {r.documents.length > 0 && (
        <>
          <h3>書類</h3>
          <DocTable docs={r.documents} onOpen={onOpen} />
        </>
      )}
      <BackButton label="受注の一覧" onClick={onBack} place="bottom" />
    </div>
  );
}

/** 書類の表。未請求の納品書を選べるようにすると、選んだ ID を返す。 */
function DocTable({ docs, onOpen, picked, onPick }: { docs: SalesDocument[]; onOpen: (id: string) => void; picked?: Set<string>; onPick?: (id: string) => void }) {
  return (
    <div className="table-scroll"><table className="table contracts-table">
      <thead><tr>{onPick && <th aria-label="選ぶ" />}<th>種類</th><th>番号</th><th>日付</th><th>宛先</th><th className="num">合計</th><th>状態</th></tr></thead>
      <tbody>
        {docs.map((d) => (
          <tr key={d.id}>
            {onPick && <td>{d.kind === 'delivery' && d.status === 'issued' && !d.invoiceId && <input type="checkbox" aria-label={`${d.number} を選ぶ`} checked={!!picked?.has(d.id)} onChange={() => onPick(d.id)} />}</td>}
            <td className="nowrap">{SALES_DOC_KIND_LABELS[d.kind]}</td>
            <td className="nowrap"><button className="link" onClick={() => onOpen(d.id)}>{docNumber(d)}</button></td>
            <td className="nowrap">{dayLabel(d.issuedOn)}</td>
            <td>{d.party.name || d.party.person || '—'}</td>
            <td className="num nowrap">{yen(d.total)}</td>
            <td><DocStatus d={d} /></td>
          </tr>
        ))}
      </tbody>
    </table></div>
  );
}

/** 書類の一覧（取引の日付・金額・取引先で探す。第42.6節）。未請求の納品書を選んで請求書にまとめる。 */
function DocList({ onOpen, changeKey }: { onOpen: (id: string) => void; changeKey: string }) {
  const [items, setItems] = useState<SalesDocument[] | null>(null);
  const [f, setF] = useState({ kind: '', status: '', party: '', from: '', to: '', min: '', max: '' });
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [note, setNote] = useState<Note>(null);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(() => {
    const { status, ...rest } = f;
    api.sales.documents({ ...rest, ...(status === 'unbilled' ? { unbilled: '1' } : status ? { status } : {}) })
      .then((r) => { setItems(r.items); setError(null); })
      .catch((e) => setError(describeError(e, '読めませんでした')));
  }, [f]);
  useEffect(() => { const t = setTimeout(load, 250); return () => clearTimeout(t); }, [load]);
  useEffect(() => { if (changeKey) load(); }, [changeKey]); // eslint-disable-line react-hooks/exhaustive-deps
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value });
  const pick = (id: string) => setPicked((cur) => { const n = new Set(cur); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  return (
    <>
      <div className="row wrap contracts-filter">
        <select value={f.kind} aria-label="種類" onChange={set('kind')}>
          <option value="">種類: すべて</option>
          {(Object.keys(SALES_DOC_KIND_LABELS) as SalesDocKind[]).map((k) => <option key={k} value={k}>{SALES_DOC_KIND_LABELS[k]}</option>)}
        </select>
        <select value={f.status} aria-label="状態" onChange={set('status')}>
          <option value="">状態: すべて</option>
          {(Object.keys(SALES_DOC_STATUS_LABELS) as SalesDocStatus[]).map((s) => <option key={s} value={s}>{SALES_DOC_STATUS_LABELS[s]}</option>)}
          <option value="unbilled">未請求の納品書</option>
        </select>
        <input className="contracts-search" type="search" value={f.party} placeholder="取引先" aria-label="取引先" onChange={set('party')} />
        <label className="sales-range">日付<input type="date" value={f.from} onChange={set('from')} />〜<input type="date" value={f.to} onChange={set('to')} /></label>
        <label className="sales-range">金額<input type="number" min={0} className="num-input" value={f.min} onChange={set('min')} />〜<input type="number" min={0} className="num-input" value={f.max} onChange={set('max')} /></label>
      </div>
      {picked.size > 0 && (
        <div className="row wrap">
          <button className="btn small" onClick={() => {
            api.sales.invoice([...picked]).then((r) => { setPicked(new Set()); onOpen(r.doc.id); }).catch((e) => setNote({ kind: 'error', text: describeError(e, '請求書を作れませんでした') }));
          }}>選んだ納品書で請求書を作る（{picked.size}）</button>
          <NoteText note={note} />
        </div>
      )}
      {error && <p className="error">{error}</p>}
      {items && items.length === 0 && <p className="muted">当たる書類はありません。</p>}
      {items && items.length > 0 && <DocTable docs={items} onOpen={onOpen} picked={picked} onPick={pick} />}
    </>
  );
}

/** 書類 1 通。PDF を見て、発行・送る・直す・取り消し。 */
function DocView({ id, onBack, onOpen, onOpenRun, changeKey }: {
  id: string; onBack: () => void; onOpen: (id: string | null) => void; onOpenRun: (runId: string) => void; changeKey: string;
}) {
  const [r, setR] = useState<SalesDocDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<Note>(null);
  const [busy, setBusy] = useState(false);
  const [sendTo, setSendTo] = useState('');
  const [fix, setFix] = useState('');
  const [stamp, setStamp] = useState(0);
  const load = useCallback(() => {
    api.sales.document(id).then((x) => { setR(x); setError(null); setStamp(Date.now()); }).catch((e) => setError(describeError(e, '読めませんでした')));
  }, [id]);
  useEffect(load, [load, changeKey]);
  if (error) return <div className="contracts"><BackButton label="書類の一覧" onClick={onBack} /><p className="error">{error}</p></div>;
  if (!r) return <div className="contracts"><p className="muted">読み込み中…</p></div>;
  const d = r.doc;
  const ask = (input: Record<string, unknown>) => {
    setBusy(true);
    api.createJob(AGENT_OF[d.kind], input).then(({ runId }) => onOpenRun(runId))
      .catch((e) => setNote({ kind: 'error', text: describeError(e, '頼めませんでした') })).finally(() => setBusy(false));
  };
  const act = (p: Promise<unknown>, ok: string, fail: string) => {
    setBusy(true);
    p.then(() => { setNote({ kind: 'ok', text: ok }); load(); }).catch((e) => setNote({ kind: 'error', text: describeError(e, fail) })).finally(() => setBusy(false));
  };
  const latest = !d.superseded;
  return (
    <div className="contracts sales">
      <div className="row">
        <BackButton label="書類の一覧" onClick={onBack} />
        <NoteText note={note} />
      </div>
      <h2>{SALES_DOC_KIND_LABELS[d.kind]} {docNumber(d)} <DocStatus d={d} /></h2>
      {d.notices.length > 0 && <ul className="sales-flags">{d.notices.map((n, i) => <li key={i}><span className="badge warn">知らせ</span> {n}</li>)}</ul>}
      {d.cancelReason && <p className="small muted">取り消しの理由: {d.cancelReason}</p>}
      {!latest && <p className="small"><span className="badge">古い版</span> {r.versions[0] && <button className="link" onClick={() => onOpen(r.versions[0]!.id)}>新しい版を開く</button>}</p>}
      <div className="sales-doc">
        <iframe className="sales-pdf" title="PDF" src={`${api.sales.pdfUrl(d.id)}?v=${stamp}`} />
        <div className="card sales-side">
          <p><strong>{d.party.name || d.party.person || '宛先なし'}</strong></p>
          <p className="small">日付 {dayLabel(d.issuedOn)}{d.dueOn && <>　{d.kind === 'invoice' ? '支払期限' : '納期'} {dayLabel(d.dueOn)}</>}</p>
          <p>合計 <strong>{yen(d.total)}</strong></p>
          <p className="small muted">{d.taxLines.map((x) => `${x.rate}% 対象 ${yen(x.base)}・消費税 ${yen(x.tax)}`).join('　')}</p>
          <div className="row wrap">
            <a className="btn ghost small" href={api.sales.pdfUrl(d.id, true)}>PDF を保存</a>
            {d.status === 'draft' && latest && (
              <button className="btn small" disabled={busy} onClick={() => {
                if (window.confirm(`この内容で${SALES_DOC_KIND_LABELS[d.kind]}を発行しますか。番号が付き、書き換えられなくなります`)) act(api.sales.issue(d.id), '発行しました', '発行できませんでした');
              }}>発行</button>
            )}
            {d.kind === 'delivery' && d.status === 'issued' && !d.invoiceId && latest && (
              <button className="btn small" disabled={busy} onClick={() => api.sales.invoice([d.id]).then((x) => onOpen(x.doc.id)).catch((e) => setNote({ kind: 'error', text: describeError(e, '請求書を作れませんでした') }))}>請求書を作る</button>
            )}
            {d.kind === 'invoice' && d.status === 'issued' && latest && (
              <button className="btn ghost small" disabled={busy} onClick={() => {
                setBusy(true);
                api.createJob(RECEIPT_AGENT, { request: `請求書 ${d.number} の入金があったので領収書を作って` }).then(({ runId }) => onOpenRun(runId))
                  .catch((e) => setNote({ kind: 'error', text: describeError(e, '頼めませんでした') })).finally(() => setBusy(false));
              }}>領収書を作る</button>
            )}
          </div>
          {d.status !== 'cancelled' && latest && (
            <div className="sales-ask">
              <label>送り先<input type="email" value={sendTo} placeholder="yamada@example.co.jp" onChange={(e) => setSendTo(e.target.value)} /></label>
              <button className="btn ghost small" disabled={busy || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(sendTo.trim())}
                onClick={() => ask({ request: d.status === 'draft' ? 'この書類を発行して送って' : 'この書類を送って', documentId: d.id, sendTo: sendTo.trim() })}>{d.status === 'draft' ? '発行して送る' : '送る'}</button>
              <label>直したいこと<textarea rows={2} value={fix} maxLength={1000} onChange={(e) => setFix(e.target.value)} /></label>
              <button className="btn ghost small" disabled={busy || !fix.trim()} onClick={() => ask({ request: fix.trim(), documentId: d.id })}>{d.status === 'draft' ? '直す' : '訂正版を作る'}</button>
            </div>
          )}
          <div className="row wrap">
            {d.status === 'issued' && latest && (
              <button className="btn ghost small" disabled={busy} onClick={() => {
                const reason = window.prompt('取り消しの理由');
                if (reason?.trim()) act(api.sales.cancel(d.id, reason.trim()), '取り消しました', '取り消せませんでした');
              }}>取り消し</button>
            )}
            {d.status === 'draft' && (
              <button className="btn ghost small danger" disabled={busy} onClick={() => {
                if (window.confirm('この下書きを削除しますか')) api.sales.remove(d.id).then(onBack).catch((e) => setNote({ kind: 'error', text: describeError(e, '削除できませんでした') }));
              }}>削除</button>
            )}
          </div>
        </div>
      </div>
      {(r.order || r.invoice || r.deliveries.length > 0 || r.receipts.length > 0 || r.versions.length > 1) && (
        <div className="card sales-links">
          {r.order && <p>受注: <button className="link" onClick={() => onOpen(r.order!.id)}>{r.order.number}（{r.order.party.name}）</button></p>}
          {r.invoice && <p>{d.kind === 'receipt' ? '元の請求書' : '請求書'}: <button className="link" onClick={() => onOpen(r.invoice!.id)}>{docNumber(r.invoice)}</button></p>}
          {r.deliveries.length > 0 && <p>まとめた納品書: {r.deliveries.map((x, i) => <span key={x.id}>{i > 0 && '、'}<button className="link" onClick={() => onOpen(x.id)}>{docNumber(x)}</button></span>)}</p>}
          {r.receipts.length > 0 && <p>領収書: {r.receipts.map((x, i) => <span key={x.id}>{i > 0 && '、'}<button className="link" onClick={() => onOpen(x.id)}>{docNumber(x)}</button></span>)}</p>}
          {r.versions.length > 1 && <p>版: {r.versions.map((x, i) => <span key={x.id}>{i > 0 && '、'}{x.id === d.id ? <strong>版 {x.version}</strong> : <button className="link" onClick={() => onOpen(x.id)}>版 {x.version}</button>}</span>)}</p>}
        </div>
      )}
      <BackButton label="書類の一覧" onClick={onBack} place="bottom" />
    </div>
  );
}
