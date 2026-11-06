/**
 * @file 管理者ページの「ご利用料金」（仕様書 第23.4.5節「画面」）。クラスと人数・契約の形・支払いの方法・請求書・解約。
 *
 * カードの番号はここを通らない。カードは申し込みの口へ移り、Stripe の支払いのページで登録する。
 */

import { useCallback, useEffect, useState } from 'react';
import { BUSINESS_MAX_USERS, billingAmount, paidSeatCount, type BillingClass, type BillingView, type ContractTerm, type InvoiceView } from '@m2office/shared';
import { api, describeError } from './api.js';

const yen = (n: number) => `${n.toLocaleString('ja-JP')} 円`;
const monthText = (m: string) => `${m.slice(0, 4)} 年 ${Number(m.slice(5))} 月`;

const CLASS_LABEL: Record<BillingClass, string> = { starter: 'スターター', small_business: 'スモールビジネス', business: 'ビジネス', enterprise: 'エンタープライズ' };
const METHOD_LABEL: Record<BillingView['category'], string> = { starter: '未登録', card: 'カード', transfer: '銀行振込', none: '請求なし' };
const STATUS_LABEL = (i: InvoiceView): string => {
  if (i.status === 'paid') return '入金済み';
  if (i.status === 'void') return '取り消し';
  if (i.chargeState === 'failed') return 'カードの課金に失敗';
  if (i.chargeState === 'pending') return '課金の準備中';
  return '未入金';
};

/** 請求の対象（一覧と請求書の内容の行に使う）。 */
const invoiceSubject = (i: InvoiceView): string => {
  if (i.kind === 'monthly') return `${monthText(i.month)}分`;
  if (i.kind === 'annual_add') return `年間契約で増えた席（${i.termEnd} まで）`;
  return `年間契約（${i.termStart} から ${i.termEnd} まで）`;
};
/** 請求の数量。 */
const invoiceQuantity = (i: InvoiceView): string => {
  if (i.kind === 'fixed') return '一式';
  return i.months > 1 ? `有料 ${i.seats} 人 × ${i.months} か月` : `有料 ${i.seats} 人`;
};

/** ご利用料金の画面。 */
export function BillingSettings() {
  const [view, setView] = useState<BillingView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [name, setName] = useState('');
  const [term, setTerm] = useState<ContractTerm>('monthly');
  const [invoice, setInvoice] = useState<InvoiceView | null>(null);

  const load = useCallback(() => api.admin.billing().then((v) => { setView(v); setName((n) => n || v.billingName); }).catch((e) => setError(describeError(e, '読み込めませんでした'))), []);
  useEffect(() => { void load(); }, [load]);

  if (!view) return <p className={error ? 'error' : 'muted'}>{error ?? '読み込み中…'}</p>;
  const run = async (f: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await f();
      await load();
    } catch (e) {
      setError(describeError(e, 'できませんでした'));
    } finally {
      setBusy(false);
    }
  };
  const starter = view.category === 'starter';
  const small = view.billingClass === 'small_business';
  const fixed = view.billingClass === 'business' || view.billingClass === 'enterprise';
  const annual = view.contractTerm === 'annual';
  // スターターは支払いの方法を選ぶときに、契約の形も一緒に決める
  const chosen = starter ? term : undefined;
  const toCard = () => run(async () => { location.href = (await api.admin.billingCard(name, chosen)).url; });
  const atLimit = view.seatLimit !== null && !starter && view.seats + view.invited >= view.seatLimit;
  const nextClass = view.billingClass === 'small_business' ? `ビジネス（${BUSINESS_MAX_USERS} 人まで）` : 'エンタープライズ';

  const paid = paidSeatCount(view.peak);
  const figures: { label: string; value: string }[] = [
    { label: 'クラス', value: CLASS_LABEL[view.billingClass] },
    { label: '人数', value: view.seatLimit === null ? `${view.seats} 人` : `${view.seats} / ${view.seatLimit} 人` },
  ];
  if (fixed) {
    if (view.fixedAnnualJpy !== null) figures.push({ label: '年額（税込）', value: yen(view.fixedAnnualJpy + Math.floor((view.fixedAnnualJpy * view.taxPercent) / 100)) });
    if (view.termEnd) figures.push({ label: '契約の終わり', value: view.termEnd });
  } else if (annual && small && !starter) {
    figures.push({ label: '有料の席', value: `${view.paidSeats} 人` });
    if (view.termEnd) figures.push({ label: '契約の終わり', value: view.termEnd });
  } else if (small && !starter) {
    figures.push({ label: '今月の見込み（税込）', value: `${yen(billingAmount(paid, view.monthlyPriceJpy, view.taxPercent).totalJpy)}（有料 ${paid} 人）` });
  }
  if (!starter) figures.push({ label: '支払いの方法', value: METHOD_LABEL[view.category] });

  return (
    <>
      <div className="card">
        <h3>いまの契約</h3>
        <div className="stats">
          {figures.map((f) => <div className="stat" key={f.label}><span className="stat-label">{f.label}</span><strong>{f.value}</strong></div>)}
        </div>
        {atLimit && (
          <p>人数の上限に達しています。これより増やすには{nextClass}のご契約が必要です。{view.contact ? `お問い合わせ先: ${view.contact}` : 'お問い合わせ先を準備中です。'}</p>
        )}
      </div>

      {small && !starter && (
        <div className="card">
          <h3>契約の形</h3>
          {annual ? (
            <>
              <p>年間契約（1 人 1 か月 {yen(view.annualUnitJpy ?? view.annualPriceJpy)}・税別）{view.termStart && ` ${view.termStart} から ${view.termEnd} まで`}</p>
              {view.nextTerm === 'monthly' ? (
                <div className="row">
                  <span className="muted">更新のときに月間契約へ移ります</span>
                  <button className="btn ghost" disabled={busy} onClick={() => void run(() => api.admin.billingTerm('annual'))}>取り下げる</button>
                </div>
              ) : (
                <button className="btn ghost" disabled={busy} onClick={() => void run(() => api.admin.billingTerm('monthly'))}>
                  {view.termStart ? '更新のときに月間契約へ移る' : '月間契約に戻す'}
                </button>
              )}
            </>
          ) : (
            <>
              <p>月間契約（1 人 1 か月 {yen(view.monthlyPriceJpy)}・税別）</p>
              {view.annualStartOn ? (
                <div className="row">
                  <span className="muted">{view.annualStartOn} から年間契約に移ります</span>
                  <button className="btn ghost" disabled={busy} onClick={() => void run(() => api.admin.billingTerm('monthly'))}>取り下げる</button>
                </div>
              ) : (
                <button className="btn ghost" disabled={busy} onClick={() => {
                  const total = billingAmount(paidSeatCount(view.seats), view.annualPriceJpy, view.taxPercent, 12).totalJpy;
                  if (confirm(`翌月 1 日から 12 か月の年間契約に移ります。1 人 1 か月 ${yen(view.annualPriceJpy)}（税別）で、いまの人数なら ${yen(total)}（税込）を一括で請求します。よろしいですか。`)) void run(() => api.admin.billingTerm('annual'));
                }}>年間契約へ移る（1 人 1 か月 {yen(view.annualPriceJpy)}・税別）</button>
              )}
            </>
          )}
        </div>
      )}

      <div className="card">
        <h3>支払いの方法</h3>
        {starter && (
          <div className="row">
            <label className="check"><input type="radio" name="billing-term" checked={term === 'monthly'} onChange={() => setTerm('monthly')} /> 月間契約（1 人 1 か月 {yen(view.monthlyPriceJpy)}・税別）</label>
            <label className="check"><input type="radio" name="billing-term" checked={term === 'annual'} onChange={() => setTerm('annual')} /> 年間契約（1 人 1 か月 {yen(view.annualPriceJpy)}・税別。12 か月分を一括）</label>
          </div>
        )}
        <label className="field">請求書の宛名
          <input value={name} maxLength={200} onChange={(e) => setName(e.target.value)} />
        </label>
        <div className="row">
          {view.cardReady && <button className="btn" disabled={busy} onClick={() => void toCard()}>{view.category === 'card' ? 'カードを登録し直す' : 'カードで払う'}</button>}
          {view.transferReady && view.category !== 'transfer' && <button className="btn ghost" disabled={busy} onClick={() => void run(() => api.admin.billingTransfer(name, chosen))}>銀行振込で払う</button>}
        </div>
        {!view.cardReady && !view.transferReady && <p className="muted small">いまは支払いの方法を準備中です。</p>}
      </div>

      <div className="card">
        <h3>請求書</h3>
        {view.invoices.length === 0 ? <p className="muted small">まだありません</p> : (
          <table className="table">
            <thead><tr><th>対象</th><th>数量</th><th>金額（税込）</th><th>支払いの期限</th><th>状態</th><th /></tr></thead>
            <tbody>
              {view.invoices.map((i) => (
                <tr key={i.id}>
                  <td>{invoiceSubject(i)}</td><td>{invoiceQuantity(i)}</td><td>{yen(i.totalJpy)}</td><td>{i.dueDate}</td><td>{STATUS_LABEL(i)}</td>
                  <td><button className="btn ghost small" onClick={() => setInvoice(i)}>{i.status === 'paid' ? '請求書・領収書' : '請求書'}</button></td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {!fixed && (
        <div className="card">
          <h3>解約</h3>
          {view.cancelOn ? (
            <>
              <p>{view.cancelOn} で終わります。終わった後の 90 日はエクスポートだけができ、その後データを削除します。</p>
              <button className="btn ghost" disabled={busy} onClick={() => void run(() => api.admin.billingCancel(false))}>解約を取り下げる</button>
            </>
          ) : (
            <button className="btn ghost danger" disabled={busy} onClick={() => {
              const text = annual && view.termEnd
                ? `${view.termEnd} で解約します。それまでは使えます。返金はありません。よろしいですか。`
                : `${monthText(view.month)}の末で解約します。今月分は請求します。よろしいですか。`;
              if (confirm(text)) void run(() => api.admin.billingCancel(true));
            }}>解約する</button>
          )}
        </div>
      )}
      {error && <p className="error">{error}</p>}
      {invoice && <InvoiceSheet invoice={invoice} onClose={() => setInvoice(null)} />}
    </>
  );
}

/** 請求書（適格請求書の記載の要件。第15.1節）。ブラウザの印刷で PDF にできる。領収書は入金済みのときだけ添える。 */
function InvoiceSheet({ invoice: i, onClose }: { invoice: InvoiceView; onClose: () => void }) {
  return (
    <div className="invoice-overlay" role="dialog" aria-label={`請求書 ${i.number}`}>
      <div className="invoice-sheet">
        <h2>{i.status === 'paid' ? '請求書 兼 領収書' : '請求書'}</h2>
        <p>{i.recipient.name} 御中</p>
        <p className="small">請求書番号 {i.number}<br />発行日 {i.issuedAt.slice(0, 10)}</p>
        <table className="table">
          <thead><tr><th>内容</th><th>数量</th><th>単価</th><th>金額</th></tr></thead>
          <tbody>
            <tr><td>M2Office 利用料 {invoiceSubject(i)}</td><td>{invoiceQuantity(i)}</td><td>{yen(i.unitPriceJpy)}</td><td>{yen(i.subtotalJpy)}</td></tr>
            <tr><td colSpan={3}>{i.taxPercent}% 対象</td><td>{yen(i.subtotalJpy)}</td></tr>
            <tr><td colSpan={3}>消費税（{i.taxPercent}%）</td><td>{yen(i.taxJpy)}</td></tr>
            <tr><td colSpan={3}><strong>合計（税込）</strong></td><td><strong>{yen(i.totalJpy)}</strong></td></tr>
          </tbody>
        </table>
        {i.method === 'transfer' ? (
          <p>お支払いの期限 {i.dueDate}<br />お振込先 {i.issuer.bankAccount}<br />振込の名前に請求書番号を添えてください。振込手数料はご負担ください。</p>
        ) : <p>登録のカードに課金します。</p>}
        {i.status === 'paid' && i.paidAt && <p>{i.paidAt.slice(0, 10)} に上記の金額を領収しました。</p>}
        <p className="small">{i.issuer.name}<br />{i.issuer.postalCode && `〒${i.issuer.postalCode} `}{i.issuer.address}<br />登録番号 {i.issuer.registrationNo}{i.issuer.contact && <><br />{i.issuer.contact}</>}</p>
        <div className="row invoice-actions">
          <button className="btn" onClick={() => window.print()}>印刷</button>
          <button className="btn ghost" onClick={onClose}>閉じる</button>
        </div>
      </div>
    </div>
  );
}
