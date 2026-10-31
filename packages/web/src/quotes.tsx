/**
 * @file 作った見積書の部品（仕様書 第42.14節、Q-278）。業務「見積書の作成」の画面の下の一覧（`QuoteList`）と、見積書 1 通（`QuoteView`）。
 *
 * 見積書 1 通では PDF を見て、再見積（「直したいこと」を業務に頼む。同じ番号の新しい版）・受注にする・失注・取り消しを行う。
 * 受注にするのは、販売の書類と受注を使える人だけ（使えなければボタンを出さない）。販売の書類と受注の画面の「書類」から開いても同じ部品を使う。
 * 説明の文は常に出さない（原則 u11）。
 */

import { useCallback, useEffect, useState } from 'react';
import {
  SALES_QUOTE_STATE_LABELS, salesQuoteLabel, salesQuoteState, taxRateLabel,
  type SalesDocument, type SalesQuoteState,
} from '@m2office/shared';
import { api, describeError, type SalesDocDetail } from './api.js';
import { BackButton } from './back-button.js';

/** 業務「見積書の作成」の ID。 */
export const QUOTE_AGENT_ID = 'quote';

const today = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Tokyo', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
const dayLabel = (d: string | null) => (d ? d.replace(/-/g, '/') : '—');
const yen = (n: number) => `${n.toLocaleString('ja-JP')} 円`;
const STATE_BADGE: Record<SalesQuoteState, string> = { submitted: 'badge', won: 'badge ok', lost: 'badge', expired: 'badge warn', cancelled: 'badge' };
const STATES = Object.keys(SALES_QUOTE_STATE_LABELS) as SalesQuoteState[];

/** 見積書の状態の印。 */
export function QuoteState({ d }: { d: SalesDocument }) {
  const s = salesQuoteState(d, today());
  return <span className={STATE_BADGE[s]} title={d.outcomeNote || undefined}>{SALES_QUOTE_STATE_LABELS[s]}</span>;
}

/**
 * 作った見積書の一覧（業務「見積書の作成」の画面の下）。開くと同じ場所に見積書 1 通を出す。
 */
export function QuoteList({ onOpenRun, onOpenSales }: { onOpenRun: (runId: string) => void; onOpenSales: (itemId: string) => void }) {
  const [items, setItems] = useState<SalesDocument[] | null>(null);
  const [party, setParty] = useState('');
  const [state, setState] = useState('');
  const [open, setOpen] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(() => {
    api.quotes.list({ ...(party.trim() ? { party: party.trim() } : {}), ...(state ? { state } : {}) })
      .then((r) => { setItems(r.items); setError(null); })
      .catch((e) => setError(describeError(e, '一覧を読めませんでした')));
  }, [party, state]);
  useEffect(() => { const t = setTimeout(load, party ? 250 : 0); return () => clearTimeout(t); }, [load, party]);
  if (open) return <section className="slide-decks"><QuoteView id={open} onBack={() => { setOpen(null); load(); }} onOpen={setOpen} onOpenRun={onOpenRun} onOpenSales={onOpenSales} /></section>;
  if (error) return <p className="error">{error}</p>;
  // 一度も作っていなければ何も出さない
  if (!items || (items.length === 0 && !party && !state)) return null;
  return (
    <section className="slide-decks contracts">
      <h2>作った見積書</h2>
      <div className="row wrap contracts-filter">
        <select value={state} aria-label="状態" onChange={(e) => setState(e.target.value)}>
          <option value="">状態: すべて</option>
          {STATES.map((s) => <option key={s} value={s}>{SALES_QUOTE_STATE_LABELS[s]}</option>)}
        </select>
        <input className="contracts-search" type="search" value={party} placeholder="宛先で探す" aria-label="宛先で探す" onChange={(e) => setParty(e.target.value)} />
      </div>
      {items.length === 0 ? <p className="muted">当たる見積書はありません。</p> : <QuoteTable docs={items} onOpen={setOpen} />}
    </section>
  );
}

/** 見積書の表。 */
export function QuoteTable({ docs, onOpen }: { docs: SalesDocument[]; onOpen: (id: string) => void }) {
  return (
    <div className="table-scroll"><table className="table contracts-table">
      <thead><tr><th>番号</th><th>発行日</th><th>宛先</th><th className="num">合計</th><th>有効期限</th><th>状態</th></tr></thead>
      <tbody>
        {docs.map((d) => (
          <tr key={d.id}>
            <td className="nowrap"><button className="link" onClick={() => onOpen(d.id)}>{salesQuoteLabel(d)}</button></td>
            <td className="nowrap">{dayLabel(d.issuedOn)}</td>
            <td>{d.party.name || d.party.person || '—'}</td>
            <td className="num nowrap">{yen(d.total)}</td>
            <td className="nowrap">{dayLabel(d.validUntil)}</td>
            <td><QuoteState d={d} /></td>
          </tr>
        ))}
      </tbody>
    </table></div>
  );
}

/**
 * 見積書 1 通。PDF を見て、再見積・受注にする・失注・取り消し。
 *
 * @param onOpen 版を開く（ほかの版の見積書の ID）
 * @param onOpenSales 受注を開く（受注にしたあと・この見積書に対する受注）
 */
export function QuoteView({ id, onBack, onOpen, onOpenRun, onOpenSales, backLabel = '見積書の一覧', changeKey = '' }: {
  id: string; onBack: () => void; onOpen: (id: string) => void; onOpenRun: (runId: string) => void; onOpenSales: (itemId: string) => void;
  backLabel?: string; changeKey?: string;
}) {
  const [r, setR] = useState<SalesDocDetail | null>(null);
  const [orders, setOrders] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [fix, setFix] = useState('');
  const [sendTo, setSendTo] = useState('');
  const [stamp, setStamp] = useState(0);
  const load = useCallback(() => {
    api.quotes.get(id).then((x) => { setR(x); setError(null); setStamp(Date.now()); }).catch((e) => setError(describeError(e, '読めませんでした')));
  }, [id]);
  useEffect(load, [load, changeKey]);
  // 受注にできるか（販売の書類と受注を使えるか）
  useEffect(() => { api.quotes.list({ state: 'won' }).then((x) => setOrders(x.orders)).catch(() => setOrders(false)); }, []);
  if (error) return <div className="contracts"><BackButton label={backLabel} onClick={onBack} /><p className="error">{error}</p></div>;
  if (!r) return <div className="contracts"><p className="muted">読み込み中…</p></div>;
  const d = r.doc;
  const state = salesQuoteState(d, today());
  const latest = !d.superseded;
  const live = latest && d.status !== 'cancelled';
  const act = (p: Promise<unknown>, ok: string, fail: string) => {
    setBusy(true);
    p.then(() => { setNote({ kind: 'ok', text: ok }); load(); }).catch((e) => setNote({ kind: 'error', text: describeError(e, fail) })).finally(() => setBusy(false));
  };
  const requote = () => {
    setBusy(true);
    api.createJob(QUOTE_AGENT_ID, { request: fix.trim(), documentId: d.id, ...(sendTo.trim() ? { sendTo: sendTo.trim() } : {}) }).then(({ runId }) => onOpenRun(runId))
      .catch((e) => setNote({ kind: 'error', text: describeError(e, '頼めませんでした') })).finally(() => setBusy(false));
  };
  return (
    <div className="contracts sales">
      <div className="row">
        <BackButton label={backLabel} onClick={onBack} />
        {note && <span className={`contracts-note is-${note.kind}`} role={note.kind === 'error' ? 'alert' : 'status'}>{note.text}</span>}
      </div>
      <h2>見積書 {salesQuoteLabel(d)} <QuoteState d={d} /></h2>
      {d.outcomeNote && <p className="small muted">失注の理由: {d.outcomeNote}</p>}
      {d.cancelReason && <p className="small muted">取り消しの理由: {d.cancelReason}</p>}
      {!latest && <p className="small"><span className="badge">古い版</span> {r.versions[0] && <button className="link" onClick={() => onOpen(r.versions[0]!.id)}>新しい版を開く</button>}</p>}
      {r.diff.length > 0 && (
        <ul className="sales-flags">{r.diff.map((x, i) => <li key={i}><span className="badge">前の版から</span> {x}</li>)}</ul>
      )}
      <div className="sales-doc">
        <iframe className="sales-pdf" title="PDF" src={`${api.quotes.pdfUrl(d.id)}?v=${stamp}`} />
        <div className="card sales-side">
          <p><strong>{d.party.name || d.party.person || '宛先なし'}</strong>{d.party.name && d.party.person && <> {d.party.person} 様</>}</p>
          <p className="small">発行日 {dayLabel(d.issuedOn)}　有効期限 {dayLabel(d.validUntil)}</p>
          <p>合計 <strong>{yen(d.total)}</strong></p>
          <p className="small muted">{d.taxLines.map((x) => (x.rate === 0 ? `対象外 ${yen(x.base)}` : `${taxRateLabel(x.rate)} ${yen(x.base)}・消費税 ${yen(x.tax)}`)).join('　')}</p>
          {r.taxNotes.map((n) => <p key={n} className="small"><span className="badge warn">予定</span> {n}</p>)}
          <div className="row wrap">
            <a className="btn ghost small" href={api.quotes.pdfUrl(d.id, true)}>PDF をダウンロード</a>
            {live && orders && (state === 'submitted' || state === 'expired' || state === 'lost') && (
              <button className="btn small" disabled={busy} onClick={() => {
                setBusy(true);
                api.quotes.toOrder(d.id).then((x) => onOpenSales(x.order.id))
                  .catch((e) => setNote({ kind: 'error', text: describeError(e, '受注にできませんでした') })).finally(() => setBusy(false));
              }}>受注にする</button>
            )}
          </div>
          {live && state !== 'won' && (
            <div className="sales-ask">
              <label>直したいこと<textarea rows={2} value={fix} maxLength={1000} placeholder="合計から 5 万円値引き" onChange={(e) => setFix(e.target.value)} /></label>
              <label>送り先<input type="email" value={sendTo} placeholder="yamada@example.co.jp" onChange={(e) => setSendTo(e.target.value)} /></label>
              <button className="btn ghost small" disabled={busy || !fix.trim() || (!!sendTo.trim() && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(sendTo.trim()))} onClick={requote}>再見積</button>
            </div>
          )}
          <div className="row wrap">
            {live && state !== 'won' && state !== 'lost' && (
              <button className="btn ghost small" disabled={busy} onClick={() => {
                const reason = window.prompt('失注の理由（空でもかまいません）');
                if (reason !== null) act(api.quotes.lost(d.id, reason.trim()), '失注にしました', '失注にできませんでした');
              }}>失注</button>
            )}
            {live && state !== 'won' && (
              <button className="btn ghost small" disabled={busy} onClick={() => {
                const reason = window.prompt('取り消しの理由');
                if (reason?.trim()) act(api.quotes.cancel(d.id, reason.trim()), '取り消しました', '取り消せませんでした');
              }}>取り消し</button>
            )}
          </div>
        </div>
      </div>
      {(r.orders.length > 0 || r.versions.length > 1) && (
        <div className="card sales-links">
          {r.orders.length > 0 && <p>受注: {r.orders.map((o, i) => <span key={o.id}>{i > 0 && '、'}<button className="link" onClick={() => onOpenSales(o.id)}>{o.number}</button></span>)}</p>}
          {r.versions.length > 1 && <p>版: {r.versions.map((x, i) => <span key={x.id}>{i > 0 && '、'}{x.id === d.id ? <strong>{x.version > 1 ? `再見積 ${x.version}` : '最初の版'}</strong> : <button className="link" onClick={() => onOpen(x.id)}>{x.version > 1 ? `再見積 ${x.version}` : '最初の版'}</button>}</span>)}</p>}
        </div>
      )}
      <BackButton label={backLabel} onClick={onBack} place="bottom" />
    </div>
  );
}
