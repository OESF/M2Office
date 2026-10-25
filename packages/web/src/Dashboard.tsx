/**
 * @file ダッシュボードの画面。「いま」（数値・業務の流れ・承認の滞留・出来事）と「集計」を切り替えて見る。
 *
 * 「いま」は 5 秒ごとに取り直して自動で更新する（Phase 1。SSE は Phase 1 後半）。
 * 表示するのは状態・業務の名前・件数・時間までで、中身は表示しない。
 *
 * @see 仕様書 第6.7節 ダッシュボード
 */

import { useEffect, useState, type ReactNode } from 'react';
import { api, describeError, type ChecklistItem, type DashboardLive, type DashboardStats, type SecurityWatchStatus } from './api.js';
import { HealthList } from './health.js';
import { EffectPanel } from './Effect.js';
import { HelpTip, openHelp } from './help.js';
import { Icon } from './nav.js';
import { busyOf, groupAgents, type AgentGroupView, type AgentLoad } from './agent-groups.js';
import { nodeSecurityText } from './runtime-card.js';

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
      {/* 「集計」の先頭に効果の欄（推計の削減時間と AI の費用。第6.7.13節） */}
      {tab === 'live' ? <Live /> : <><EffectPanel /><Stats /></>}
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
      {/* 本人と秘書を 1 組で並べる（仕様書 第6.7.4.4節）。本人がオフラインでも、秘書は業務を進めている */}
      <div className="pair-grid">
        {people.map((p) => (
          <div key={p.userId} className={`pair presence-${p.state}`}>
            <div className="pair-side">
              <PairAvatar src={p.photo} busy={false} />
              <span className="pair-text">
                <strong>{p.name}</strong>
                <span className="small">{p.self.detail}</span>
                {(p.route || p.device) && (
                  <span className="muted small">{[p.route, p.device].filter(Boolean).join('・')}</span>
                )}
              </span>
            </div>
            <span className="pair-link" aria-hidden="true" />
            <div className="pair-side">
              <PairAvatar src={p.secretary.avatar} busy={p.secretary.busy} />
              <span className="pair-text">
                <strong>
                  {p.secretary.name}
                  {/* 名前を付けていなければ名前が「秘書」になる。同じ言葉を二度並べない */}
                  {p.secretary.name !== '秘書' && <span className="muted small pair-role">秘書</span>}
                </strong>
                <span className={`small${p.secretary.busy ? ' pair-busy' : ''}`}>{p.secretary.detail}</span>
              </span>
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}

/**
 * 人の状態の 1 組に添える顔（本人のプロフィール写真、または秘書のアバター。仕様書 第6.7.4.4節）。
 *
 * @param src 画像の URL。無ければ人の形のアイコン
 * @param busy 秘書が動いているか。動いているあいだは輪で囲む（業務の絵と同じ手がかり。第6.7.4.3節）
 *
 * @remarks 読み上げには渡さない。顔が伝えることは、すぐ横の名前と状態が書いている
 */
function PairAvatar({ src, busy }: { src: string | null; busy: boolean }) {
  // 読めなければアイコンに戻す（壊れた画像の印を出さない）
  const [broken, setBroken] = useState(false);
  useEffect(() => setBroken(false), [src]);
  return (
    <span className={`pair-avatar${busy ? ' busy' : ''}`} aria-hidden="true">
      {src && !broken
        ? <img src={src} alt="" loading="lazy" onError={() => setBroken(true)} />
        : <span className="pair-avatar-icon"><Icon name="user" /></span>}
    </span>
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

      {/* ワーカーが止まっている（第8.6.7.1節「ワーカーが止まったら」）。依頼が始まらないので、いちばん先に出す */}
      {data.workerDown && !board && (
        <p className="error" role="status">業務を動かす仕組み（ワーカー）が 3 分以上止まっています。新しい依頼が始まりません。サーバーのワーカーを起動し直してください</p>
      )}
      {/* Node.js のセキュリティの修正がある（ローカルの形。第8.6.7.1節）。眺める画面では出さない */}
      {data.nodeSecurity && !board && (
        <p className="error" role="status">{nodeSecurityText(data.nodeSecurity)}。管理者ページの「機械」で確かめられます</p>
      )}
      {/* Node.js のサポートの終わりが近い・終わった（ローカルの形。第8.6.7.1節）。眺める画面では出さない */}
      {data.nodeWarn && !board && (
        <p className={data.nodeWarn.expired ? 'error' : 'warn-msg'} role="status">
          {data.nodeWarn.expired
            ? `Node.js（${data.nodeWarn.version}）のサポートが終わっています。管理者ページの「機械」で確かめ、新しい LTS の版へ更新してください`
            : `Node.js の更新が要ります（${data.nodeWarn.version} のサポートは ${data.nodeWarn.end ?? '近く'} まで）。管理者ページの「機械」で確かめられます`}
        </p>
      )}
      <Agents data={data} board={board} />

      <HealthList items={data.connections ?? []} />

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
          <Failures items={data.failures} board={board} />
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
 * 業務エージェントの受け持ち（仕様書 第6.7.4.2節）。拡張機能と業務の分野ごとのまとまりで並べる（第6.7.4.2.1節）。
 *
 * @remarks
 * **動いていない業務も「待機」として出す。** 動いているものだけを並べると、
 * 導入したのに誰にも使われていない業務があることに気づけない。
 * 業務が増えても並ぶ数を増やさないよう、まとまりに 1 つの囲みを出し、
 * 動いている業務と今日失敗した業務だけを囲みの中に出す。中の業務が 1 つだけなら、業務 1 つの囲みで出す。
 */
function Agents({ data, board = false }: { data: DashboardLive; board?: boolean }) {
  if (data.agents.length === 0 && !data.security) return null;
  return (
    <section className="card">
      <h3>
        業務の状態{' '}
        {!board && (
          <HelpTip article="admin-dashboard">
            業務を仕事の分野ごとにまとめて、いま何件を受け持っているかを出します。どれも 0 なら「待機」です。
          </HelpTip>
        )}
      </h3>
      <div className="agent-grid">
        {data.security && <SecurityWatchCard status={data.security} board={board} />}
        {groupAgents(data.agents).map((g) => (g.items.length === 1
          ? <AgentState key={g.id} name={g.items[0]!.name} load={g.items[0]!} face={g.face} />
          : <AgentGroup key={g.id} group={g} board={board} />))}
      </div>
    </section>
  );
}

/**
 * 不正の兆しの見張りの囲み（仕様書 第6.7.4.2.2節・第16.8節）。見張りが動いていることと、最後の見回り・この 24 時間の兆しの数を出す。
 *
 * @remarks 中身（誰が何をしたか）は出さない。眺める画面（受付などの画面）では、兆しの数も出さず「見張り中」だけにする。
 * 見回りが 15 分以上止まっていたら目立たせる（古い値を黙って映し続けない。第6.7.2.1節）
 */
function SecurityWatchCard({ status, board }: { status: SecurityWatchStatus; board: boolean }) {
  const watching = status.state === 'watching';
  return (
    <div className={`agent-state security-watch${watching ? ' busy' : status.state === 'stale' ? ' stale' : ''}`}>
      <span className={`agent-face security-face${watching ? ' busy' : ''}`} aria-hidden="true">
        <svg viewBox="0 0 24 24" width="36" height="36"><path d="M12 2 4 5v6c0 5 3.4 9.4 8 11 4.6-1.6 8-6 8-11V5l-8-3Z" fill="currentColor" opacity=".18" /><path d="M12 2 4 5v6c0 5 3.4 9.4 8 11 4.6-1.6 8-6 8-11V5l-8-3Zm-1.2 13.6-3.5-3.5 1.4-1.4 2.1 2.1 4.6-4.6 1.4 1.4-6 6Z" fill="currentColor" /></svg>
      </span>
      <div className="agent-body">
        <div className="agent-name">不正の兆しの見張り</div>
        <div className="agent-now">
          {watching ? <span className="chip current">見張り中</span>
            : status.state === 'stale' ? <span className="chip waiting">止まっています</span>
              : <span className="muted">まだ見回っていません</span>}
        </div>
        {status.lastScanAt && <div className="muted small">最後の見回り {ago(status.lastScanAt)}前</div>}
        {/* Google のログインの記録（段 3。第16.8.6節）。使えない会社では出さない */}
        {status.google && (
          <div className="muted small">
            Google のログイン: {status.google === 'connected' ? '接続中' : status.google === 'error' ? <span className="warn-text">読めていません</span> : '未接続'}
          </div>
        )}
        {!board && (
          <div className="small">
            この 24 時間の兆し {status.signals24h} 件
            {status.high24h > 0 && <span className="warn-text">（重い {status.high24h}）</span>}
            {status.last && <div className="muted small">新しいもの: {status.last.label}（{ago(status.last.at)}前）</div>}
          </div>
        )}
      </div>
    </div>
  );
}

/** 業務 1 つ、またはまとまり 1 つの囲み。 */
function AgentState({ name, load, face, children }: {
  name: ReactNode; load: Omit<AgentLoad, 'agentId' | 'name' | 'face'>; face: number; children?: ReactNode;
}) {
  const busy = busyOf(load) > 0;
  return (
    <div className={`agent-state${busy ? ' busy' : ''}`}>
      <AgentFace face={face} busy={busy} />
      <div className="agent-body">
        <div className="agent-name">{name}</div>
        <div className="agent-now"><LoadChips load={load} /></div>
        <div className="muted small">
          今日 {load.todayRuns} 件
          {load.todayFailed > 0 && <span className="warn-text">（失敗 {load.todayFailed}）</span>}
        </div>
        {children}
      </div>
    </div>
  );
}

/** 受け持ちの件数。どれも 0 なら「待機」。 */
function LoadChips({ load }: { load: { running: number; awaiting: number; queued: number } }) {
  if (busyOf(load) === 0) return <span className="muted">待機</span>;
  return (
    <>
      {load.running > 0 && <span className="chip current">実行中 {load.running}</span>}
      {load.awaiting > 0 && <span className="chip waiting">承認待ち {load.awaiting}</span>}
      {load.queued > 0 && <span className="chip todo">待ち行列 {load.queued}</span>}
    </>
  );
}

/**
 * まとまり 1 つの囲み（第6.7.4.2.1節）。
 *
 * @remarks
 * 動いている業務と今日失敗した業務は、開かなくても名前と受け持ちで出す。
 * 中の業務をすべて見る操作は、掛け通しの画面（`board`）では出さない（触らずに眺める画面のため）。
 */
function AgentGroup({ group, board }: { group: AgentGroupView; board: boolean }) {
  return (
    <AgentState name={<>{group.name} <span className="muted small">{group.items.length} 業務</span></>} load={group} face={group.face}>
      {group.active.length > 0 && <AgentMembers items={group.active} />}
      {!board && (
        <details className="agent-all">
          <summary>中の業務</summary>
          <AgentMembers items={group.items} />
        </details>
      )}
    </AgentState>
  );
}

/** まとまりの中の業務の行（名前・受け持ち・今日の失敗）。 */
function AgentMembers({ items }: { items: AgentLoad[] }) {
  return (
    <ul className="agent-members">
      {items.map((a) => (
        <li key={a.agentId}>
          <span className="agent-member-name">{a.name}</span>
          <span className="agent-now"><LoadChips load={a} /></span>
          {a.todayFailed > 0 && <span className="warn-text small">失敗 {a.todayFailed}</span>}
        </li>
      ))}
    </ul>
  );
}

/**
 * 業務エージェントの絵（仕様書 第6.7.4.3節）。
 *
 * @param face 同梱の画像の番号。API が業務ごとに返す
 * @param busy いま受け持ちがあるか
 *
 * @remarks
 * **動かすのは、受け持ちがあるあいだだけ。** 何も起きていないのに動き続けると、
 * 画面のどこを見ればよいか分からなくなる。動いていることは絵を囲む輪で示し、
 * **待機でも色は落とさない**（灰色にすると、何の絵なのか分からなくなる）。
 *
 * 読み上げには渡さない（`aria-hidden`）。絵が伝えることは、すぐ横の文字がすべて書いている。
 */
function AgentFace({ face, busy }: { face: number; busy: boolean }) {
  const [broken, setBroken] = useState(false);
  if (broken) return null;
  const n = String(face).padStart(2, '0');
  return (
    <span className={`agent-face${busy ? ' busy' : ''}`} aria-hidden="true">
      <img src={`/agents/agent${n}.png`} alt="" loading="lazy" onError={() => setBroken(true)} />
    </span>
  );
}

/**
 * 今日、失敗した業務（仕様書 第6.7.5.1節）。
 *
 * @remarks
 * **業務の流れとは分ける。** 流れはいま動いているものを見る区画であり、
 * 終わったものが混ざると、いま動いているのかどうかが読み取れない。既定は畳む。
 *
 * 管理者が「確認した」を押すと囲みから外す（実行の記録は残る）。確かめの画面は出さない。
 * 掛け通しの画面では押すところを減らすため、ボタンを出さない。
 */
function Failures({ items, board }: { items: DashboardLive['failures']; board: boolean }) {
  // 次の更新が届くまでのあいだも、押したものはすぐ消す
  const [hidden, setHidden] = useState<Set<string>>(() => new Set());
  const [error, setError] = useState<string | null>(null);
  const shown = items.filter((f) => !hidden.has(f.runId));
  if (shown.length === 0) return null;
  const dismiss = (ids: string[] | null) => {
    setError(null);
    setHidden((h) => new Set([...h, ...(ids ?? shown.map((f) => f.runId))]));
    api.admin.dismissFailures(ids ?? undefined).catch((e) => {
      setHidden(new Set());
      setError(describeError(e));
    });
  };
  return (
    <details className="fold">
      <summary>今日、失敗した業務（{shown.length} 件）</summary>
      {!board && shown.length > 1 && (
        <p><button className="btn ghost small" onClick={() => dismiss(null)}>すべて確認した</button></p>
      )}
      {error && <p className="error">{error}</p>}
      {shown.map((f) => (
        <div className="failed-note" key={f.runId}>
          <strong>{f.agentName}</strong>{' '}
          <span className="muted small">{f.requester}さん・{time(f.at)}</span>
          {!board && <> <button className="link small" onClick={() => dismiss([f.runId])}>確認した</button></>}
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
      <h3 style={{ marginTop: 'calc(20px * var(--space-scale))' }}>出来事</h3>
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
            <div className="table-scroll"><table className="table">
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
            </table></div>
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
          <p className="muted small">削減時間は推計です</p>
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

/**
 * 縦の目盛り（0 から上までを 4 つほどに区切る、切りのよい値）。
 *
 * @param integer 件数のように整数だけで区切るか
 */
function niceScale(max: number, integer: boolean): { top: number; ticks: number[] } {
  if (max <= 0) return { top: integer ? 4 : 1, ticks: integer ? [0, 1, 2, 3, 4] : [0, 0.25, 0.5, 0.75, 1] };
  const raw = max / 4;
  const mag = 10 ** Math.floor(Math.log10(raw));
  let step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((x) => x >= raw) ?? raw;
  if (integer) step = Math.max(1, Math.ceil(step));
  const top = Math.ceil(max / step - 1e-9) * step;
  const ticks: number[] = [];
  for (let v = 0; v <= top + step / 1000; v += step) ticks.push(Math.round(v * 100) / 100);
  return { top, ticks };
}

/** 目盛りの数の書き方（桁区切り・小数は 2 桁まで）。 */
const tickText = (v: number) => v.toLocaleString('ja-JP', { maximumFractionDigits: 2 });

/** 日ごとの実行件数（棒。左の目盛り）と削減時間（折れ線。右の目盛り）。 */
function DailyChart({ daily }: { daily: DashboardStats['daily'] }) {
  const W = 520, H = 210, L = 44, R = 48, T = 40, B = 26;
  const ph = H - T - B;
  const runs = niceScale(Math.max(0, ...daily.map((d) => d.runs)), true);
  const saved = niceScale(Math.max(0, ...daily.map((d) => hours(d.savedMinutes))), false);
  const failed = daily.some((d) => d.failed > 0);
  const bw = (W - L - R) / Math.max(1, daily.length);
  const x = (i: number) => L + i * bw;
  const yRuns = (n: number) => T + ph - (n / runs.top) * ph;
  const ySaved = (h: number) => T + ph - (h / saved.top) * ph;
  const line = daily.map((d, i) => `${x(i) + bw / 2},${ySaved(hours(d.savedMinutes))}`).join(' ');
  const every = Math.ceil(daily.length / 7);
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="chart" role="img" aria-label="日ごとの実行件数と削減時間">
      {/* 凡例 */}
      <g className="legend">
        <rect x={L} y={6} width={10} height={10} className="bar" /><text x={L + 14} y={15}>実行（件）</text>
        {failed && <><rect x={L + 86} y={6} width={10} height={10} className="bar fail" /><text x={L + 100} y={15}>うち失敗（件）</text></>}
        <line x1={W - R - 128} y1={11} x2={W - R - 112} y2={11} className="line" /><text x={W - R - 108} y={15}>推計の削減時間（時間）</text>
      </g>
      {/* 縦の目盛り。左が実行の件数、右が削減時間 */}
      <text x={L - 6} y={T - 8} className="tick end-axis">件</text>
      <text x={W - R + 6} y={T - 8} className="tick start-axis saved">時間</text>
      {runs.ticks.map((v) => (
        <g key={`r${v}`}>
          <line x1={L} y1={yRuns(v)} x2={W - R} y2={yRuns(v)} className={v === 0 ? 'axis' : 'grid'} />
          <text x={L - 6} y={yRuns(v) + 4} className="tick end-axis">{tickText(v)}</text>
        </g>
      ))}
      {saved.ticks.map((v) => <text key={`s${v}`} x={W - R + 6} y={ySaved(v) + 4} className="tick start-axis saved">{tickText(v)}</text>)}
      {daily.map((d, i) => {
        const h = (d.runs / runs.top) * ph;
        const fh = (d.failed / runs.top) * ph;
        return (
          <g key={d.day}>
            <rect x={x(i) + bw * 0.15} y={T + ph - h} width={bw * 0.7} height={h} className="bar">
              <title>{`${d.day} 実行 ${d.runs} 件・削減 ${hours(d.savedMinutes)} 時間`}</title>
            </rect>
            {fh > 0 && <rect x={x(i) + bw * 0.15} y={T + ph - fh} width={bw * 0.7} height={fh} className="bar fail" />}
            {i % every === 0 && <text x={x(i) + bw / 2} y={H - 8} className="tick">{d.day.slice(5)}</text>}
          </g>
        );
      })}
      {daily.length > 1 && <polyline points={line} className="line" />}
    </svg>
  );
}

/** 時間帯別の実行件数（0〜23 時）。 */
function HourlyChart({ hourly }: { hourly: number[] }) {
  const W = 520, H = 210, L = 44, R = 16, T = 40, B = 26;
  const ph = H - T - B;
  const runs = niceScale(Math.max(0, ...hourly), true);
  const bw = (W - L - R) / 24;
  const y = (n: number) => T + ph - (n / runs.top) * ph;
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="chart" role="img" aria-label="時間帯別の実行件数">
      <g className="legend">
        <rect x={L} y={6} width={10} height={10} className="bar" /><text x={L + 14} y={15}>実行（件）</text>
        <text x={W - R} y={15} className="end">横は時刻（時台）</text>
      </g>
      <text x={L - 6} y={T - 8} className="tick end-axis">件</text>
      {runs.ticks.map((v) => (
        <g key={v}>
          <line x1={L} y1={y(v)} x2={W - R} y2={y(v)} className={v === 0 ? 'axis' : 'grid'} />
          <text x={L - 6} y={y(v) + 4} className="tick end-axis">{tickText(v)}</text>
        </g>
      ))}
      {hourly.map((n, h) => {
        const bh = (n / runs.top) * ph;
        return (
          <g key={h}>
            <rect x={L + h * bw + 2} y={T + ph - bh} width={bw - 4} height={bh} className="bar">
              <title>{`${h} 時台 ${n} 件`}</title>
            </rect>
            {h % 3 === 0 && <text x={L + h * bw + bw / 2} y={H - 8} className="tick">{h}</text>}
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
      <dl className="kv" style={{ marginTop: 'calc(8px * var(--space-scale))' }}>
        {parts.map((p) => (
          <div key={p.key} style={{ display: 'contents' }}>
            <dt><i className={`dot ${p.key}`} />{p.label}</dt><dd>{p.n} 回（{Math.round((p.n / total) * 100)}%）</dd>
          </div>
        ))}
      </dl>
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
