/**
 * @file Web の振り返りの画面（仕様書 第34.18節）。いちばん新しい月の便り（4 つの見出しと数字の短い表）と、前の月の便りの一覧。
 *
 * 数字はプログラムが API の値から計算したもので、文は推論が書いたもの。取れなかった数字は「取得できませんでした」と出す。
 * つないでいなければ、管理者には設定への道、ほかの人には「管理者がつなぐと届きます」だけを出す。説明文は常には出さない（原則 u11）。
 */

import { useEffect, useState } from 'react';
import type { WebReviewNumber, WebReviewReport, WebReviewReportBrief, WebReviewStatus } from '@m2office/shared';
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

/**
 * Web の振り返りの画面。
 *
 * @param month 開く月（`YYYY-MM`）。`null` ならいちばん新しい便り
 */
export function WebReview({ month, onOpen }: { month: string | null; onOpen: (month: string | null) => void }) {
  const [data, setData] = useState<{ status: WebReviewStatus; latest: WebReviewReport | null; reports: WebReviewReportBrief[]; admin: boolean } | null>(null);
  const [shown, setShown] = useState<WebReviewReport | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    api.webReview.overview().then((r) => { setData(r); setError(null); }).catch((e) => setError(describeError(e, '読み込めませんでした')));
  }, []);
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
