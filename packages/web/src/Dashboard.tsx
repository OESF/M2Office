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

/** 畳まずに出す出来事の数（仕様書 第6.7.3.1節）。残りは押すと伸びる。 */
const EVENTS_FOLDED = 5;

/**
 * ダッシュボード（仕様書 第6.7節）。
 *
 * @remarks
 * **初期設定のチェックリストはここに置かない**（第6.10.3.1節）。初期設定は一度きりの作業であり、
 * 毎日見る画面の先頭を占めると、いまの状況が下へ押し下げられる。設定の 1 項目として出す。
 */
export function Dashboard() {
  const [tab, setTab] = useState<'live' | 'stats'>('live');
  return (
    <>
      <div className="dash-head">
        <h1>ダッシュボード <HelpTip article="admin-dashboard">業務の流れと承認の滞留を見る画面です。会話や業務の中身、個人の勤務時間は出ません。</HelpTip></h1>
        <div className="seg">
          <button className={tab === 'live' ? 'on' : ''} onClick={() => setTab('live')}>いま</button>
          <button className={tab === 'stats' ? 'on' : ''} onClick={() => setTab('stats')}>集計</button>
        </div>
        {/* 眺めるための画面は別の道に置く（仕様書 第6.7.2.1節） */}
        <a className="btn ghost small" href={`/board${location.search}`} target="_blank" rel="noreferrer"
          title="左のメニューや操作を出さない、眺めるための画面を新しいタブで開きます">
          別の画面で開く
        </a>
      </div>
      {tab === 'live' ? <Live /> : <Stats />}
    </>
  );
}

/**
 * 掛け通しの画面（`/board`。仕様書 第6.7.2.1節）。
 *
 * @remarks
 * **操作する画面ではない。眺める画面である。** 左のメニュー・上の帯・タブ・ヘルプの「？」を
 * 出さず、押すところを置かない。壁に掛けたモニターに映しておく使い方を想定する。
 *
 * @param tenantName 会社の名前。誰の画面かが離れて分かるように出す
 * @param namesShown 人の状態を個人名で出す設定か。**壁に映る以上、一度知らせる**
 */
export function Board({ tenantName }: { tenantName: string }) {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(t);
  }, []);
  return (
    <div className="board">
      <header className="board-head">
        <span className="board-brand">M2Office</span>
        <span className="board-tenant">{tenantName}</span>
        <span className="spacer" />
        <span className="board-clock">
          {now.toLocaleTimeString('ja-JP', { timeZone: 'Asia/Tokyo', hour: '2-digit', minute: '2-digit' })}
        </span>
      </header>
      <main className="board-body">
        <Live board />
      </main>
    </div>
  );
}

/**
 * 管理者の初期設定チェックリスト（仕様書 第6.10.3節・第6.10.3.1節）。
 *
 * @remarks
 * **設定の 1 項目として出す。** すべて済むと、左ペインからも消える。
 *
 * @param onGo 未了の項目から、管理者ページの別の画面へ移る
 */
export function Checklist({ onGo }: { onGo?: (tab: string) => void }) {
  const [items, setItems] = useState<ChecklistItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = () => api.onboarding.checklist()
    .then((r) => setItems(r.done ? null : r.items)).catch((e) => setError(describeError(e)));
  useEffect(() => { void load(); }, []);
  if (error) return <p className="error">{error}</p>;
  if (!items) {
    return <p className="muted">はじめに行う設定は、すべて済んでいます。</p>;
  }
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
            {!i.done && i.go && <button className="btn ghost small" onClick={() => onGo?.(i.go!)}>設定へ</button>}
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

/**
 * 人の状態（仕様書 第6.7.4節）。会社の設定により、個人名か、人数と業務だけを出す（第6.7.4.1節）。
 *
 * @remarks
 * 出すのは状態・業務の名前・活動の表示名までである。会話や入力の中身、接続元の場所は出さない（第6.7.10節）。
 */
function People({ data, board = false }: { data: DashboardLive; board?: boolean }) {
  const tip = board ? null : (
    <HelpTip article="admin-dashboard">
      いま誰が何をしているかを、状態と業務の名前までで示します。会話や入力の中身、接続元の場所は出しません。
    </HelpTip>
  );

  if (data.peopleSummary) {
    const { counts, agents } = data.peopleSummary;
    return (
      <section className="card">
        <h3>人の状態 {tip}</h3>
        <p className="muted small">この会社は「人数と業務だけ」の表示にしています。</p>
        <div className="presence-row">
          {counts.filter((x) => x.n > 0).map((x) => (
            <span key={x.state} className={`chip presence-${x.state}`}>{x.label} {x.n} 人</span>
          ))}
        </div>
        {agents.length > 0 && <p className="muted small">動いている業務: {agents.join('、')}</p>}
      </section>
    );
  }
  const people = data.people ?? [];
  return (
    <section className="card">
      <h3>人の状態 {tip}</h3>
      {people.length === 0 && <p className="muted">利用者がいません。</p>}
      <div className="presence-row">
        {people.map((p) => (
          <span key={p.userId} className={`presence presence-${p.state}`} title={p.detail}>
            <strong>{p.name}</strong>
            <span className="small">{p.detail}</span>
            {(p.route || p.device) && (
              <span className="muted small">{[p.route, p.device].filter(Boolean).join('・')}</span>
            )}
          </span>
        ))}
      </div>
    </section>
  );
}

/** 「いま」の画面（第6.7.3節）。 */
/**
 * 「いま」の中身（仕様書 第6.7.3節）。
 *
 * @param board 掛け通しの画面（第6.7.2.1節）として出すか。押すところを減らし、文字を大きくする
 */
function Live({ board = false }: { board?: boolean }) {
  const [data, setData] = useState<DashboardLive | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [, setTick] = useState(0);

  // SSE で受け取り、受け取れないときだけ一定間隔の取り直しに戻す（仕様書 第6.7.9節）
  const [live, setLive] = useState(true);
  useEffect(() => {
    let alive = true;
    const load = () => api.admin.dashboardLive()
      .then((d) => { if (alive) { setData(d); setError(null); } })
      .catch((e) => { if (alive) setError(e.message); });
    void load();
    // 経過時間の表示を毎秒進める
    const clock = setInterval(() => setTick((t) => t + 1), 1000);

    let stop: (() => void) | null = null;
    let timer: ReturnType<typeof setInterval> | null = null;
    stop = api.admin.dashboardStream(
      (d) => { if (alive) { setData(d); setError(null); setLive(true); } },
      () => {
        if (!alive || timer) return;
        setLive(false);
        timer = setInterval(load, LIVE_INTERVAL_MS);
      },
    );
    return () => {
      alive = false;
      stop?.();
      clearInterval(clock);
      if (timer) clearInterval(timer);
    };
  }, []);

  if (error && !data) return <p className="error">{error}</p>;
  if (!data) return <p className="muted">読み込み中…</p>;
  const c = data.counts;

  return (
    <>
      {/*
        最終更新の時刻だけを片隅に出す（仕様書 第6.7.3.1節）。
        **更新が途切れたときは目立たせる。** 古い値を黙って映し続けない（第6.7.2.1節）
      */}
      <p className={`updated-at${error ? ' stale' : ''}`} title={error ?? (live ? '変化があるとすぐに更新します' : '5 秒ごとに取り直しています')}>
        {error ? '更新できていません ' : ''}{time(data.generatedAt)}
      </p>

      <People data={data} board={board} />

      <div className="tiles">
        <Tile label="ログイン中" value={c.activeUsers} unit="人" />
        <Tile label="実行中の業務" value={c.running} unit="件" tone={c.running > 0 ? 'active' : undefined} />
        <Tile label="承認待ち" value={c.awaitingApproval} unit="件" tone={c.awaitingApproval > 0 ? 'wait' : undefined} />
        <Tile label="今日の失敗" value={c.failedToday} unit="件" tone={c.failedToday > 0 ? 'fail' : undefined} />
        <Tile label="今日の実行" value={c.todayRuns} unit="件" />
        <Tile label="削減時間（推計）" value={hours(c.todaySavedMinutes)} unit="時間"
          title="今日の、手作業と比べた削減時間の推計です" />
        <Tile label="今日の費用" value={c.todayCostJpy} unit="円" />
      </div>

      <Agents data={data} board={board} />

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
            </div>
          ))}
          <Failures items={data.failures} />
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
          <Events items={data.events} />
        </section>
      </div>
    </>
  );
}

/**
 * 業務エージェントごとの受け持ち（仕様書 第6.7.4.2節）。
 *
 * @remarks
 * **動いていない業務も「待機」として出す。** 動いているものだけを並べると、
 * 導入したのに誰にも使われていない業務があることに気づけない。
 */
function Agents({ data, board = false }: { data: DashboardLive; board?: boolean }) {
  if (data.agents.length === 0) return null;
  return (
    <section className="card">
      <h3>
        業務の状態{' '}
        {!board && (
          <HelpTip article="admin-dashboard">
            使える業務ごとに、いま何件を受け持っているかを出します。どれも 0 なら「待機」です。
          </HelpTip>
        )}
      </h3>
      <div className="agent-grid">
        {data.agents.map((a) => {
          const busy = a.running + a.awaiting + a.queued;
          return (
            <div className={`agent-state${busy > 0 ? ' busy' : ''}`} key={a.agentId}>
              <div className="agent-name">{a.name}</div>
              <div className="agent-now">
                {busy === 0 ? <span className="muted">待機</span> : (
                  <>
                    {a.running > 0 && <span className="chip current">実行中 {a.running}</span>}
                    {a.awaiting > 0 && <span className="chip waiting">承認待ち {a.awaiting}</span>}
                    {a.queued > 0 && <span className="chip todo">待ち行列 {a.queued}</span>}
                  </>
                )}
              </div>
              <div className="muted small">
                今日 {a.todayRuns} 件
                {a.todayFailed > 0 && <span className="warn-text">（失敗 {a.todayFailed}）</span>}
              </div>
            </div>
          );
        })}
      </div>
    </section>
  );
}

/**
 * 今日、失敗した業務（仕様書 第6.7.5.1節）。
 *
 * @remarks
 * **業務の流れとは分ける。** 流れはいま動いているものを見る区画であり、
 * 終わったものが混ざると、いま動いているのかどうかが読み取れない。既定は畳む。
 */
function Failures({ items }: { items: DashboardLive['failures'] }) {
  if (items.length === 0) return null;
  return (
    <details className="fold">
      <summary>今日、失敗した業務（{items.length} 件）</summary>
      <p className="muted small">日本時間の 0 時以降に失敗したものです。日が変わると消えます。</p>
      {items.map((f) => (
        <div className="failed-note" key={f.runId}>
          <strong>{f.agentName}</strong>{' '}
          <span className="muted small">{f.requester}さん・{time(f.at)}</span>
          <div>{f.reason}</div>
        </div>
      ))}
    </details>
  );
}

/** 直近の出来事（仕様書 第6.7.3.1節）。**既定では畳む。** 縦を使いすぎない。 */
function Events({ items }: { items: DashboardLive['events'] }) {
  const shown = items.slice(0, EVENTS_FOLDED);
  return (
    <>
      <h3 style={{ marginTop: 20 }}>出来事</h3>
      {items.length === 0 && <p className="muted">まだありません。</p>}
      <ul className="events">
        {shown.map((e, i) => (
          <li key={i} className={e.kind}>
            <span className="t">{time(e.at)}</span>
            <span>{e.text}</span>
          </li>
        ))}
      </ul>
      {items.length > EVENTS_FOLDED && (
        <details className="fold">
          <summary>さらに {items.length - EVENTS_FOLDED} 件</summary>
          <ul className="events">
            {items.slice(EVENTS_FOLDED).map((e, i) => (
              <li key={i} className={e.kind}>
                <span className="t">{time(e.at)}</span>
                <span>{e.text}</span>
              </li>
            ))}
          </ul>
        </details>
      )}
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

function Tile({ label, value, unit, tone, title }: {
  label: string; value: number | string; unit: string; tone?: 'active' | 'wait' | 'fail';
  /** 見出しだけでは足りないときの補足。**折り返さないために短くした分を、ここで補う** */
  title?: string;
}) {
  return (
    <div className={`tile ${tone ?? ''}`} title={title}>
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
