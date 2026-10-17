/**
 * @file 管理者ページ「稼働の報告」（仕様書 第16.11.3節 G-9）。
 *
 * 月ごとの稼働率（計画停止を除く）と、その月の障害・計画停止の経過を出す。続いている障害があれば上に出す。
 * 運営が出した知らせから組み立てる（会社に関わるものだけ）。説明文は常に出さない（原則 u11）。
 */
import { useEffect, useMemo, useState } from 'react';
import { api, describeError, type ServiceReportView } from './api.js';
import { PageTitle } from './help.js';

const IMPACT_LABEL = { down: '障害（止まった）', degraded: '一部の不具合', maintenance: '計画停止' } as const;
const when = (iso: string | null) => (iso ? new Date(iso).toLocaleString('ja-JP', { dateStyle: 'medium', timeStyle: 'short' }) : '');
/** 分を「◯ 時間 ◯ 分」にする。 */
const duration = (min: number) => (min >= 60 ? `${Math.floor(min / 60)} 時間${min % 60 ? ` ${min % 60} 分` : ''}` : `${min} 分`);

/** 稼働の報告。 */
export function ServiceReport() {
  // 今月から 12 か月さかのぼる（日本時間）
  const months = useMemo(() => {
    const now = new Date(Date.now() + 9 * 3_600_000);
    return Array.from({ length: 12 }, (_, i) => {
      const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - i, 1));
      return d.toISOString().slice(0, 7);
    });
  }, []);
  const [month, setMonth] = useState(months[0]!);
  const [data, setData] = useState<ServiceReportView | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    setData(null);
    api.admin.serviceReport(month).then(setData, (e) => setError(describeError(e)));
  }, [month]);
  const r = data?.report;
  return (
    <>
      <PageTitle trail={['稼働の報告']} help={{ article: 'admin-service-report', text: '月ごとの稼働率と、障害・計画停止の経過です。稼働率は計画停止を除いて数えます。' }} />
      {error && <p className="error">{error}</p>}
      {data && data.open.length > 0 && (
        <div className="suspended-banner" role="alert">
          {data.open.map((i) => <div key={i.id}><strong>{IMPACT_LABEL[i.impact]}: {i.title}</strong>（{when(i.startedAt)} から）{i.body}</div>)}
        </div>
      )}
      <div className="row">
        <select value={month} onChange={(e) => setMonth(e.target.value)}>
          {months.map((m) => <option key={m} value={m}>{m.replace('-', ' 年 ')} 月</option>)}
        </select>
      </div>
      {!data && !error && <p className="muted">読み込み中…</p>}
      {r && (
        <>
          <div className="stats">
            <div className="stat"><span>稼働率</span><strong>{r.uptime === null ? '—' : `${r.uptime}%`}</strong></div>
            <div className="stat"><span>止まった時間</span><strong>{duration(r.downMinutes)}</strong></div>
            <div className="stat"><span>計画停止</span><strong>{duration(r.maintenanceMinutes)}</strong></div>
          </div>
          {r.incidents.length === 0 && <p className="muted">この月の障害・計画停止はありません</p>}
          {r.incidents.map((i) => (
            <div className="card" key={i.id}>
              <div className="row">
                <span className={`badge ${i.endedAt ? 'ok' : 'warn'}`}>{i.endedAt ? '終わった' : '続いている'}</span>
                <strong>{IMPACT_LABEL[i.impact]}: {i.title}</strong>
                <span className="muted small">{when(i.startedAt)} 〜 {when(i.endedAt)}</span>
              </div>
              <ul className="small">{i.updates.map((u, k) => <li key={k}>{when(u.at)} {u.body}</li>)}</ul>
            </div>
          ))}
        </>
      )}
    </>
  );
}
