/**
 * @file Webの分析の画面（仕様書 第34.18節・第34.19節）。いちばん新しい月の便り（4 つの見出しと数字の短い表）・前の月の便りの一覧・
 * 直すべき所（理由と直し方・制作会社への依頼文の下書き・コラムなら書き直しを頼む・合う記事の無い言葉はコラムにする）。
 *
 * 数字はプログラムが API の値から計算したもので、文は推論が書いたもの。取れなかった数字は「取得できませんでした」と出す。
 * つないでいなければ、管理者には設定への道、ほかの人には「管理者がつなぐと届きます」だけを出す。説明文は常には出さない（原則 u11）。
 */

import { useEffect, useState } from 'react';
import {
  WEB_REVIEW_FINDING_LABELS,
  type WebReviewFinding, type WebReviewFindingStatus, type WebReviewNumber, type WebReviewReport, type WebReviewReportBrief, type WebReviewStatus,
} from '@m2office/shared';
import { api, describeError } from './api.js';

const monthLabel = (m: string) => `${m.slice(0, 4)} 年 ${Number(m.slice(5, 7))} 月`;
const num = (v: number | null, digits = 0) => (v === null ? '取得できませんでした' : v.toLocaleString('ja-JP', { maximumFractionDigits: digits }));
const pct = (v: number | null) => (v === null ? '取得できませんでした' : `${(v * 100).toFixed(1)}%`);
/** 前と比べた率（%）。前が無い・0 なら空。 */
const rate = (n: WebReviewNumber) => {
  if (n.value === null || n.previous === null || n.previous === 0) return '';
  const r = Math.round(((n.value - n.previous) / n.previous) * 1000) / 10;
  return `${r > 0 ? '+' : ''}${r}%`;
};

/** 数字の短い表（見る指標を AI が絞ったもの。第34.4節）。 */
function Figures({ r }: { r: WebReviewReport }) {
  const a = r.figures.analytics;
  const s = r.figures.search;
  const few = r.figures.few;
  const rows: [string, string, string][] = [];
  if (a) {
    rows.push(['サイトに来た人', `${num(a.users.value)} 人`, few ? '' : rate(a.users)]);
    rows.push(['新しく来た人', `${num(a.newUsers.value)} 人`, few ? '' : rate(a.newUsers)]);
    rows.push(['サイトに来た回数', `${num(a.sessions.value)} 回`, few ? '' : rate(a.sessions)]);
    rows.push(['じっくり読まれた割合', pct(a.engagementRate.value), '']);
    rows.push([a.inquiries.basis === 'keyEvents' ? '問い合わせ（キーイベント）' : '問い合わせのページを見た回数', `${num(a.inquiries.value)} 回`, few ? '' : rate(a.inquiries)]);
    if (a.mobileShare !== null) rows.push(['スマホの割合', pct(a.mobileShare), '']);
  }
  if (s) {
    rows.push(['検索で表示された回数', `${num(s.impressions.value)} 回`, few ? '' : rate(s.impressions)]);
    rows.push(['検索で押された回数', `${num(s.clicks.value)} 回`, few ? '' : rate(s.clicks)]);
    rows.push(['検索の平均の順位', `${num(s.position.value, 1)} 位`, '']);
  }
  return (
    <div className="web-review-figures">
      <table className="table">
        <thead><tr><th>{monthLabel(r.month)}</th><th>数</th><th>前の月と比べて</th></tr></thead>
        <tbody>{rows.map(([k, v, d]) => <tr key={k}><td>{k}</td><td>{v}</td><td>{d}</td></tr>)}</tbody>
      </table>
      <div className="web-review-lists">
        {a && a.sources.length > 0 && (
          <div><h4>どこから来たか</h4><ul>{a.sources.slice(0, 5).map((x) => <li key={x.label}>{x.label} <span className="muted">{num(x.sessions)} 回</span></li>)}</ul></div>
        )}
        {a && a.topPages.length > 0 && (
          <div><h4>よく見られたページ</h4><ul>{a.topPages.map((p) => <li key={p.path}>{p.title || p.path} <span className="muted">{num(p.views)} 回</span></li>)}</ul></div>
        )}
        {s && s.topQueries.length > 0 && (
          <div><h4>押された検索の言葉</h4><ul>{s.topQueries.map((q) => <li key={q.query}>{q.query} <span className="muted">{num(q.clicks)} 回</span></li>)}</ul></div>
        )}
      </div>
      {r.figures.inquiryRecords && (
        <p className="small">問い合わせの記録: {r.figures.inquiryRecords.value} 件（前の月 {r.figures.inquiryRecords.previous} 件）
          {r.figures.inquiryRecords.bySource.length > 0 && <span className="muted">　{r.figures.inquiryRecords.bySource.slice(0, 5).map((x) => `${x.label} ${x.count}`).join('・')}</span>}</p>
      )}
      {!!r.figures.closureDays && <p className="small">休業の期間: {r.figures.closureDays} 日</p>}
      {r.figures.competitors && r.figures.competitors.changes > 0 && (
        <p className="small">近くの同業の動き: {r.figures.competitors.changes} 件
          <span className="muted">　{r.figures.competitors.kinds.map((x) => `${x.label} ${x.count}`).join('・')}</span></p>
      )}
      {r.figures.missing.length > 0 && <p className="muted small">取得できなかったもの: {r.figures.missing.join('／')}</p>}
    </div>
  );
}

/** 月の便り 1 つ。 */
function Report({ r }: { r: WebReviewReport }) {
  return (
    <div className="card web-review-report">
      <h2>{monthLabel(r.month)}の便り</h2>
      <p className="web-review-summary">{r.summary}</p>
      <div className="web-review-points">
        <div><h4>よかったこと</h4><p>{r.good}</p></div>
        <div><h4>気になること</h4><p>{r.concern}</p></div>
      </div>
      {r.next.length > 0 && (<><h4>次にやること</h4><ol>{r.next.map((x) => <li key={x}>{x}</li>)}</ol></>)}
      <Figures r={r} />
    </div>
  );
}

/** コラムの作成とのつなぎ（コラムの作成を使える人だけ）。 */
export interface WebReviewColumnLinks {
  /** その言葉をテーマにコラムを書き始めて開く */
  create(theme: string, memo: string): Promise<void>;
  /** コラムを開く */
  open(columnId: string): void;
}

const day = (iso: string) => new Date(iso).toLocaleDateString('ja-JP', { month: 'numeric', day: 'numeric' });

/** 直すべき所 1 つ。 */
function Finding({ f, columns, agency, onStatus, onError }: {
  f: WebReviewFinding; columns: WebReviewColumnLinks | null; agency: string; onStatus: (s: WebReviewFindingStatus) => void; onError: (text: string) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  // 制作会社の宛先（設定の宛先が既定。ここで変えてもよい。第34.21節）
  const [to, setTo] = useState(agency);
  const run = async (fn: () => Promise<unknown>, ok: string | null, fail: string) => {
    setBusy(true);
    try { await fn(); if (ok) setNote(ok); } catch (e) { onError(describeError(e, fail)); } finally { setBusy(false); }
  };
  const copy = (text: string) => run(() => navigator.clipboard.writeText(text), 'コピーしました', 'コピーできませんでした');
  return (
    <li className={`web-review-finding is-${f.status}`}>
      <div className="row wrap">
        <span className="badge">{WEB_REVIEW_FINDING_LABELS[f.kind]}</span>
        <strong>{f.title}</strong>
        {f.title !== f.target && <span className="muted small">{f.target}</span>}
      </div>
      <p className="web-review-advice">{f.advice}</p>
      {f.requestDraft && (
        <details>
          <summary>制作会社への依頼文（下書き）</summary>
          <p><strong>{f.requestDraft.subject}</strong></p>
          <pre className="web-review-draft">{f.requestDraft.body}</pre>
          <div className="row wrap">
            <button className="btn ghost small" disabled={busy} onClick={() => void copy(`${f.requestDraft!.subject}\n\n${f.requestDraft!.body}`)}>コピー</button>
            <input type="email" value={to} placeholder="制作会社のメールアドレス" aria-label="制作会社のメールアドレス" onChange={(e) => setTo(e.target.value)} />
            <button className="btn small" disabled={busy || !to.trim()}
              onClick={() => void run(() => api.webReview.sendRequest(f.id, to.trim()), '承認へ進めました。管理者が承認すると送ります', '承認へ進められませんでした')}>制作会社に送る</button>
          </div>
        </details>
      )}
      {f.requestSentAt && <p className="small muted">依頼を送りました（{day(f.requestSentAt)}）</p>}
      <div className="row wrap">
        {columns && f.columnId && (
          <>
            <button className="btn small" disabled={busy}
              onClick={() => void run(async () => { await api.columns.rewrite(f.columnId!, f.advice); onStatus('seen'); columns.open(f.columnId!); }, null, '書き直しを頼めませんでした')}>書き直しを頼む</button>
            <button className="btn ghost small" onClick={() => columns.open(f.columnId!)}>コラムを開く</button>
          </>
        )}
        {columns && f.kind === 'missingContent' && (
          <button className="btn small" disabled={busy}
            onClick={() => void run(async () => { await columns.create(f.target, '検索で探されているのに、合う記事が無い言葉です'); onStatus('done'); }, null, '書き始められませんでした')}>コラムにする</button>
        )}
        {(['seen', 'done', 'dismissed'] as const).map((s) => (
          <button key={s} className={`btn ghost small${f.status === s ? ' is-active' : ''}`} disabled={busy || f.status === s} onClick={() => onStatus(s)}>
            {s === 'seen' ? '見た' : s === 'done' ? '済んだ' : '見送り'}
          </button>
        ))}
        {note && <span className="inquiries-note is-ok" role="status">{note}</span>}
      </div>
    </li>
  );
}

/**
 * Webの分析の画面。
 *
 * @param month 開く月（`YYYY-MM`）。`null` ならいちばん新しい便り
 * @param columns コラムの作成とのつなぎ（使えない人には `null`）
 */
export function WebReview({ month, onOpen, columns = null }: { month: string | null; onOpen: (month: string | null) => void; columns?: WebReviewColumnLinks | null }) {
  const [data, setData] = useState<{
    status: WebReviewStatus; latest: WebReviewReport | null; reports: WebReviewReportBrief[]; admin: boolean;
    findings: WebReviewFinding[]; checkedAt: string | null; checkRequested: boolean; agency?: { email: string; name: string } | null;
  } | null>(null);
  const [shown, setShown] = useState<WebReviewReport | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = () => api.webReview.overview().then((r) => { setData(r); setError(null); }).catch((e) => setError(describeError(e, '読み込めませんでした')));
  useEffect(() => { void load(); }, []);
  const setStatus = (id: string, status: WebReviewFindingStatus) => {
    api.webReview.setFinding(id, status).then(() => setData((d) => (d ? { ...d, findings: d.findings.map((f) => (f.id === id ? { ...f, status } : f)) } : d)))
      .catch((e) => setError(describeError(e, '変えられませんでした')));
  };
  const check = () => {
    api.webReview.check().then(() => setData((d) => (d ? { ...d, checkRequested: true } : d))).catch((e) => setError(describeError(e, '頼めませんでした')));
  };
  useEffect(() => {
    if (!month) { setShown(null); return; }
    api.webReview.report(month).then((r) => setShown(r.report)).catch((e) => setError(describeError(e, 'その月の便りを読めませんでした')));
  }, [month]);
  if (error) return <p className="error">{error}</p>;
  if (!data) return <p className="muted">読み込んでいます…</p>;
  const report = month ? shown : data.latest;
  const st = data.status;
  return (
    <div className="web-review">
      {st.state !== 'ready' && (
        <div className="card">
          <p>{data.admin ? st.advice : '管理者が Google とつなぐと、毎月の便りが届きます'}</p>
          {data.admin && <a className="btn small" href={`/admin/extensions${location.search}`}>拡張機能の設定を開く</a>}
          {data.admin && st.requestDraft && (
            <details>
              <summary>制作会社への依頼文（下書き）</summary>
              <p><strong>{st.requestDraft.subject}</strong></p>
              <pre className="web-review-draft">{st.requestDraft.body}</pre>
            </details>
          )}
        </div>
      )}
      {st.state === 'ready' && (
        <div className="card">
          <div className="row wrap">
            <h2>直すべき所</h2>
            {data.checkedAt && <span className="muted small">{day(data.checkedAt)}に確かめました</span>}
            {data.admin && <button className="btn ghost small" disabled={data.checkRequested} onClick={check}>{data.checkRequested ? 'まもなく確かめます' : '今すぐチェック'}</button>}
          </div>
          {data.findings.length === 0
            ? <p className="muted">{data.checkedAt ? '直すべき所は見つかっていません' : 'まだ確かめていません'}</p>
            : <ul className="web-review-findings">{data.findings.map((f) => <Finding key={f.id} f={f} columns={columns} agency={data.agency?.email ?? ''} onStatus={(s) => setStatus(f.id, s)} onError={setError} />)}</ul>}
        </div>
      )}
      {report ? <Report r={report} /> : st.state === 'ready' && <div className="card"><p className="muted">まだ便りがありません。毎月 3 日の朝に、先月の分が届きます</p></div>}
      {data.reports.length > 1 && (
        <div className="card">
          <h3>これまでの便り</h3>
          <ul className="web-review-months">
            {data.reports.map((r) => (
              <li key={r.id}>
                <button className="link" onClick={() => onOpen(r.month === data.latest?.month ? null : r.month)} aria-current={report?.month === r.month ? 'true' : undefined}>{monthLabel(r.month)}</button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
