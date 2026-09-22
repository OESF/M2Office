/**
 * @file ダッシュボードの画面。「いま」（数値・業務の流れ・承認の滞留・出来事）と「集計」を切り替えて見る。
 *
 * 「いま」は 5 秒ごとに取り直して自動で更新する（Phase 1。SSE は Phase 1 後半）。
 * 表示するのは状態・業務の名前・件数・時間までで、中身は表示しない。
 *
 * @see 仕様書 第6.7節 ダッシュボード
 */

import { useEffect, useState } from 'react';
import { api, describeError, type ChecklistItem, type DashboardLive, type DashboardStats } from './api.js';
import { HelpTip, openHelp } from './help.js';

/** 「いま」を取り直す間隔（ミリ秒）。 */
const LIVE_INTERVAL_MS = 5000;

/**
 * @param onGo 初期設定のチェックリストから、管理者ページの別のタブへ移る
 */
export function Dashboard({ onGo }: { onGo?: (tab: string) => void }) {
  const [tab, setTab] = useState<'live' | 'stats'>('live');
  return (
    <>
      <Checklist onGo={onGo} />
      <div className="dash-head">
        <h1>ダッシュボード <HelpTip article="admin-dashboard">業務の流れと承認の滞留を見る画面です。会話や業務の中身、個人の勤務時間は出ません。</HelpTip></h1>
        <div className="seg">
          <button className={tab === 'live' ? 'on' : ''} onClick={() => setTab('live')}>いま</button>
          <button className={tab === 'stats' ? 'on' : ''} onClick={() => setTab('stats')}>集計</button>
        </div>
      </div>
      {tab === 'live' ? <Live /> : <Stats />}
    </>
  );
}

/**
 * 管理者の初期設定チェックリスト（仕様書 第6.10.3節）。すべて済むと出さない。
 */
function Checklist({ onGo }: { onGo?: (tab: string) => void }) {
  const [items, setItems] = useState<ChecklistItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = () => api.onboarding.checklist()
    .then((r) => setItems(r.done ? null : r.items)).catch((e) => setError(describeError(e)));
  useEffect(() => { void load(); }, []);
  if (error) return <p className="error">{error}</p>;
  if (!items) return null;
  const done = items.filter((i) => i.done).length;
  return (
    <section className="card checklist">
      <h3>はじめに行う設定（{done} / {items.length}）</h3>
      <div className="hbar"><span style={{ width: `${(done / items.length) * 100}%` }} /></div>
      <ul>
        {items.map((i) => (
          <li key={i.id} className={i.done ? 'done' : i.important ? 'important' : ''}>
            <span className="mark" aria-hidden>{i.done ? '済' : '・'}</span>
            <span className="label">
              {i.label}
              {i.note && <span className="muted small">（{i.note}）</span>}
              {!i.done && i.important && <span className="small warn-text"> 空のままだと秘書が答えられません</span>}
            </span>
            {!i.done && i.go && <button className="btn ghost small" onClick={() => onGo?.(i.go!)}>設定する</button>}
            {!i.done && i.id === 'notify' && (
              <button className="btn ghost small" onClick={() => void api.onboarding.notified().then(load)}>知らせた</button>
            )}
            <button className="link-btn" onClick={() => openHelp(i.help)}>説明</button>
          </li>
        ))}
      </ul>
    </section>
  );
}

/** 「いま」の画面（第6.7.3節）。 */
function Live() {
  const [data, setData] = useState<DashboardLive | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [, setTick] = useState(0);

  useEffect(() => {
    let alive = true;
    const load = () => api.admin.dashboardLive()
      .then((d) => { if (alive) { setData(d); setError(null); } })
      .catch((e) => { if (alive) setError(e.message); });
    void load();
    const timer = setInterval(load, LIVE_INTERVAL_MS);
    // 経過時間の表示を毎秒進める
    const clock = setInterval(() => setTick((t) => t + 1), 1000);
    return () => { alive = false; clearInterval(timer); clearInterval(clock); };
  }, []);

  if (error && !data) return <p className="error">{error}</p>;
  if (!data) return <p className="muted">読み込み中…</p>;
  const c = data.counts;

  return (
    <>
      <p className="lead">
        自動で更新しています（最終更新 {time(data.generatedAt)}）
        {error && <span className="error-inline"> 更新に失敗しました: {error}</span>}
      </p>

      <div className="tiles">
        <Tile label="ログイン中" value={c.activeUsers} unit="人" />
        <Tile label="実行中の業務" value={c.running} unit="件" tone={c.running > 0 ? 'active' : undefined} />
        <Tile label="承認待ち" value={c.awaitingApproval} unit="件" tone={c.awaitingApproval > 0 ? 'wait' : undefined} />
        <Tile label="今日の失敗" value={c.failedToday} unit="件" tone={c.failedToday > 0 ? 'fail' : undefined} />
        <Tile label="今日の実行" value={c.todayRuns} unit="件" />
        <Tile label="今日の推計の削減時間" value={hours(c.todaySavedMinutes)} unit="時間" />
        <Tile label="今日の費用" value={c.todayCostJpy} unit="円" />
      </div>

      <div className="dash-grid">
        <section className="card">
          <h3>業務の流れ</h3>
          {data.flows.length === 0 && <p className="muted">いま動いている業務はありません。</p>}
          {data.flows.map((f) => (
            <div className={`flow ${f.status}`} key={f.runId}>
              <div className="flow-head">
                <strong>{f.agentName}</strong>
                <span className="muted small">
                  {f.requester}さん・{originLabel(f.origin)}・{ago(f.startedAt)}前に開始
                </span>
              </div>
              <div className="steps-line">
                {f.steps.map((s, i) => (
                  <span key={i} className="step-wrap">
                    {i > 0 && <span className="arrow" aria-hidden>›</span>}
                    <span className={`chip ${s.state}`} title={stateLabel(s.state)}>{s.label}</span>
                  </span>
                ))}
              </div>
              {f.waitingFor && (
                <p className="waiting">
                  {f.waitingFor.who}の{f.waitingFor.kind === 'confirm' ? '操作の確認' : '承認'}を待っています
                  （{ago(f.waitingFor.since)}）
                </p>
              )}
              {f.failureReason && <p className="failed-note">失敗: {f.failureReason}</p>}
            </div>
          ))}
        </section>

        <section className="card">
          <h3>承認の滞留</h3>
          {data.backlog.length === 0 && <p className="muted">判断待ちはありません。</p>}
          {data.backlog.map((b) => (
            <div className="backlog" key={b.approvalId}>
              <div>
                <strong>{b.agentName}</strong> <span className="muted small">— {b.what}</span>
                <div className="muted small">依頼: {b.requester}さん ／ 判断: {b.approver}</div>
              </div>
              <AgeBar since={b.since} />
            </div>
          ))}
          <h3 style={{ marginTop: 20 }}>出来事</h3>
          <ul className="events">
            {data.events.map((e, i) => (
              <li key={i} className={e.kind}>
                <span className="t">{time(e.at)}</span>
                <span>{e.text}</span>
              </li>
            ))}
          </ul>
        </section>
      </div>
    </>
  );
}

/** 「集計」の画面（第6.7.8節）。 */
function Stats() {
  const [days, setDays] = useState<1 | 7 | 30>(7);
  const [data, setData] = useState<DashboardStats | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    setData(null);
    api.admin.dashboardStats(days).then(setData).catch((e) => setError(e.message));
  }, [days]);

  return (
    <>
      <div className="seg small-seg">
        {([1, 7, 30] as const).map((d) => (
          <button key={d} className={days === d ? 'on' : ''} onClick={() => setDays(d)}>
            {d === 1 ? '今日' : `${d} 日間`}
          </button>
        ))}
      </div>
      {error && <p className="error">{error}</p>}
      {!data ? <p className="muted">読み込み中…</p> : (
        <>
          <div className="tiles">
            <Tile label="実行" value={data.totals.runs} unit="件" />
            <Tile label="成功率" value={data.totals.successRate ?? '—'} unit={data.totals.successRate === null ? '' : '%'} />
            <Tile label="平均所要時間" value={data.totals.avgDurationSec ?? '—'} unit={data.totals.avgDurationSec === null ? '' : '秒'} />
            <Tile label="推計の削減時間" value={hours(data.totals.savedMinutes)} unit="時間" />
            <Tile label="費用" value={data.totals.costJpy} unit="円" />
          </div>

          <div className="dash-grid">
            <section className="card">
              <h3>日ごとの実行件数と削減時間</h3>
              <DailyChart daily={data.daily} />
            </section>
            <section className="card">
              <h3>時間帯別の利用</h3>
              <HourlyChart hourly={data.hourly} />
            </section>
          </div>

          <section className="card">
            <h3>業務ごとの状況</h3>
            <table className="table">
              <thead>
                <tr>
                  <th>業務</th><th className="num">実行</th><th className="num">成功率</th>
                  <th className="num">平均所要</th><th>推計の削減時間</th><th className="num">費用</th>
                </tr>
              </thead>
              <tbody>
                {data.byAgent.map((a) => {
                  const max = Math.max(1, ...data.byAgent.map((x) => x.savedMinutes));
                  return (
                    <tr key={a.agentId} className={a.enabled ? '' : 'muted'}>
                      <td>{a.name}{!a.enabled && '（無効）'}</td>
                      <td className="num">{a.runs}</td>
                      <td className="num">{a.successRate === null ? '—' : `${a.successRate}%`}</td>
                      <td className="num">{a.avgDurationSec === null ? '—' : `${a.avgDurationSec} 秒`}</td>
                      <td>
                        <div className="hbar"><span style={{ width: `${(a.savedMinutes / max) * 100}%` }} /></div>
                        <span className="small">{hours(a.savedMinutes)} 時間</span>
                      </td>
                      <td className="num">{a.costJpy} 円</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </section>

          <div className="dash-grid three">
            <section className="card">
              <h3>秘書</h3>
              <LayerBar s={data.secretary} />
            </section>
            <section className="card">
              <h3>滞留と知識</h3>
              <dl className="kv">
                <dt>承認待ち</dt><dd>{data.backlog.pending} 件{data.backlog.oldestSince && `（最長 ${ago(data.backlog.oldestSince)}）`}</dd>
                <dt>組織知識</dt><dd>{data.knowledge.items} 件</dd>
                <dt>知識の参照</dt><dd>{data.knowledge.searches} 回</dd>
              </dl>
            </section>
            <section className="card">
              <h3>健全性</h3>
              <dl className="kv">
                <dt>Google</dt><dd>{data.health.workspace}</dd>
                <dt>LLM</dt><dd>{data.health.llm}</dd>
              </dl>
            </section>
          </div>
          <p className="muted small">
            削減時間は「完了した実行の件数 × 手作業での標準所要時間」による推計です。
            標準所要時間は「業務と承認」で会社ごとに変えられます。
          </p>
        </>
      )}
    </>
  );
}

function Tile({ label, value, unit, tone }: {
  label: string; value: number | string; unit: string; tone?: 'active' | 'wait' | 'fail';
}) {
  return (
    <div className={`tile ${tone ?? ''}`}>
      <span>{label}</span>
      <strong>{typeof value === 'number' ? value.toLocaleString() : value}<small> {unit}</small></strong>
    </div>
  );
}

/** 待っている時間の長さを、色の付いた帯で示す（1 時間で満杯）。 */
function AgeBar({ since }: { since: string }) {
  const min = (Date.now() - Date.parse(since)) / 60_000;
  const pct = Math.min(100, (min / 60) * 100);
  const tone = min >= 60 ? 'fail' : min >= 15 ? 'wait' : 'ok';
  return (
    <div className="age">
      <div className={`hbar ${tone}`}><span style={{ width: `${Math.max(4, pct)}%` }} /></div>
      <span className="small">{ago(since)}</span>
    </div>
  );
}

/** 日ごとの実行件数（棒）と削減時間（折れ線）。 */
function DailyChart({ daily }: { daily: DashboardStats['daily'] }) {
  const W = 520, H = 180, P = 28;
  const maxRuns = Math.max(1, ...daily.map((d) => d.runs));
  const maxSaved = Math.max(1, ...daily.map((d) => d.savedMinutes));
  const bw = (W - P * 2) / daily.length;
  const x = (i: number) => P + i * bw;
  const line = daily.map((d, i) => `${x(i) + bw / 2},${H - P - (d.savedMinutes / maxSaved) * (H - P * 2)}`).join(' ');
  const every = Math.ceil(daily.length / 7);
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="chart" role="img" aria-label="日ごとの実行件数と削減時間">
      <line x1={P} y1={H - P} x2={W - P} y2={H - P} className="axis" />
      {daily.map((d, i) => {
        const h = (d.runs / maxRuns) * (H - P * 2);
        const fh = (d.failed / maxRuns) * (H - P * 2);
        return (
          <g key={d.day}>
            <rect x={x(i) + bw * 0.15} y={H - P - h} width={bw * 0.7} height={h} className="bar">
              <title>{`${d.day} 実行 ${d.runs} 件・削減 ${hours(d.savedMinutes)} 時間`}</title>
            </rect>
            {fh > 0 && <rect x={x(i) + bw * 0.15} y={H - P - fh} width={bw * 0.7} height={fh} className="bar fail" />}
            {i % every === 0 && <text x={x(i) + bw / 2} y={H - 8} className="tick">{d.day.slice(5)}</text>}
          </g>
        );
      })}
      {daily.length > 1 && <polyline points={line} className="line" />}
      <text x={P} y={14} className="tick start">実行（最大 {maxRuns} 件）</text>
      <text x={W - P} y={14} className="tick end">— 削減時間</text>
    </svg>
  );
}

/** 時間帯別の実行件数（0〜23 時）。 */
function HourlyChart({ hourly }: { hourly: number[] }) {
  const W = 520, H = 180, P = 28;
  const max = Math.max(1, ...hourly);
  const bw = (W - P * 2) / 24;
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="chart" role="img" aria-label="時間帯別の実行件数">
      <line x1={P} y1={H - P} x2={W - P} y2={H - P} className="axis" />
      {hourly.map((n, h) => {
        const bh = (n / max) * (H - P * 2);
        return (
          <g key={h}>
            <rect x={P + h * bw + 2} y={H - P - bh} width={bw - 4} height={bh} className="bar">
              <title>{`${h} 時台 ${n} 件`}</title>
            </rect>
            {h % 3 === 0 && <text x={P + h * bw + bw / 2} y={H - 8} className="tick">{h}</text>}
          </g>
        );
      })}
    </svg>
  );
}

/** 秘書の応答の層の比率（第10.9節）。 */
function LayerBar({ s }: { s: DashboardStats['secretary'] }) {
  const total = s.direct + s.route + s.chat;
  if (total === 0) return <p className="muted">この期間の依頼はありません。</p>;
  const parts = [
    { key: 'direct', label: '直接応答', n: s.direct },
    { key: 'route', label: '取次', n: s.route },
    { key: 'chat', label: '対話', n: s.chat },
  ];
  return (
    <>
      <div className="stack">
        {parts.map((p) => p.n > 0 && <span key={p.key} className={p.key} style={{ width: `${(p.n / total) * 100}%` }} />)}
      </div>
      <dl className="kv" style={{ marginTop: 8 }}>
        {parts.map((p) => (
          <div key={p.key} style={{ display: 'contents' }}>
            <dt><i className={`dot ${p.key}`} />{p.label}</dt><dd>{p.n} 回（{Math.round((p.n / total) * 100)}%）</dd>
          </div>
        ))}
      </dl>
      <p className="muted small">直接応答は AI を使わずに答えたもの。多いほど速く、費用がかからない。</p>
    </>
  );
}

function stateLabel(s: string): string {
  return ({ done: '完了', current: '実行中', waiting: '判断待ち', failed: '失敗', todo: 'これから' } as Record<string, string>)[s] ?? s;
}

function originLabel(o: string): string {
  return ({ menu: 'メニュー', secretary: '秘書', schedule: '定時実行', api: 'API' } as Record<string, string>)[o] ?? o;
}

const time = (iso: string) =>
  new Date(iso).toLocaleTimeString('ja-JP', { timeZone: 'Asia/Tokyo', hour: '2-digit', minute: '2-digit' });

/** 経過時間を短い言葉にする。 */
function ago(iso: string): string {
  const sec = Math.max(0, Math.floor((Date.now() - Date.parse(iso)) / 1000));
  if (sec < 60) return `${sec} 秒`;
  if (sec < 3600) return `${Math.floor(sec / 60)} 分`;
  if (sec < 86400) return `${Math.floor(sec / 3600)} 時間`;
  return `${Math.floor(sec / 86400)} 日`;
}

const hours = (minutes: number) => Math.round((minutes / 60) * 10) / 10;
