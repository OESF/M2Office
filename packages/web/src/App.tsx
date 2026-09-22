import { useCallback, useEffect, useState } from 'react';
import type { Approval, Notification } from '@m2office/shared';
import {
  api, type AgentSummary, type Me, type RunDetail, type ScheduleView, type SecretaryReply,
} from './api.js';
import { AgentForm, ApprovalTray, Evidence, RunView, statusLabel } from './components.js';
import { Settings, orderAgents } from './Settings.js';

/** 中央キャンバスに何を表示しているか。 */
type View =
  | { kind: 'home' }
  | { kind: 'agent'; agent: AgentSummary }
  | { kind: 'run'; runId: string }
  | { kind: 'approvals' }
  | { kind: 'history' }
  | { kind: 'notifications' }
  | { kind: 'schedules' }
  | { kind: 'settings' };

/**
 * ワークスペースの画面。
 *
 * 左にコマンドメニュー、中央にキャンバス、右に必要時のサッシパネル、
 * 下部に常駐の秘書バーを置く（仕様書 第18.1節）。
 */
export function App({ me, onLogout }: { me: Me; onLogout: () => void }) {
  const [agents, setAgents] = useState<AgentSummary[]>([]);
  const [approvals, setApprovals] = useState<Approval[]>([]);
  const [history, setHistory] = useState<{ run: { id: string; status: string }; job: { agentId: string } | null }[]>([]);
  const [view, setView] = useState<View>({ kind: 'home' });
  const [detail, setDetail] = useState<RunDetail | null>(null);
  const [reply, setReply] = useState<SecretaryReply | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notifications, setNotifications] = useState<Notification[]>([]);
  const [menu, setMenu] = useState<{ hidden: string[]; order: string[] }>({ hidden: [], order: [] });
  const loadMenu = useCallback(() => {
    api.mySettings().then((s) => setMenu(s.menu)).catch(() => undefined);
  }, []);
  useEffect(loadMenu, [loadMenu]);

  const refresh = useCallback(async () => {
    try {
      const [a, p, j, n] = await Promise.all([
        api.agents(), api.approvals(), api.jobs(), api.notifications(),
      ]);
      setAgents(a.agents);
      setApprovals(p.items);
      setHistory(j.items as never);
      setNotifications(n.items);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : '読み込みに失敗しました');
    }
  }, []);

  useEffect(() => {
    void refresh();
    // 実行は非同期に進むため、一定間隔で状態を取り直す
    const timer = setInterval(() => void refresh(), 2000);
    return () => clearInterval(timer);
  }, [refresh]);

  // 実行を表示している間は詳細も追う
  useEffect(() => {
    if (view.kind !== 'run') { setDetail(null); return; }
    const load = () => api.run(view.runId).then(setDetail).catch(() => undefined);
    void load();
    const timer = setInterval(load, 1500);
    return () => clearInterval(timer);
  }, [view]);

  const showSash = view.kind === 'run' || reply !== null;
  const unread = notifications.filter((n) => !n.readAt).length;
  const isAdmin = me.user.roles.includes('admin');

  return (
    <div className="app">
      <header className="topbar">
        <span className="brand">M2Office</span>
        <span className="tenant">{me.tenant.name}</span>
        {me.workspaceSource === 'mock' && (
          <span className="badge warn" title="Google Workspace に未接続のため、予定・メール・タスクはダミーです">
            ダミーデータで動作中
          </span>
        )}
        <span className="spacer" />
        {isAdmin && <a className="link" href={`/admin${location.search}`}>管理者ページ</a>}
        <span className="badge">{me.user.displayName}</span>
        <button className="btn ghost small" onClick={onLogout}>ログアウト</button>
      </header>

      <div className={`panes${showSash ? ' with-sash' : ''}`}>
        <nav className="left">
          <h2>業務</h2>
          {orderAgents(agents, menu.order).filter((a) => !menu.hidden.includes(a.id)).map((a) => (
            <button
              key={a.id}
              className={`item${view.kind === 'agent' && view.agent.id === a.id ? ' active' : ''}`}
              onClick={() => setView({ kind: 'agent', agent: a })}
            >
              {a.name}
              <span className="sub">{a.description}</span>
            </button>
          ))}
          <h2>自分の状況</h2>
          <button
            className={`item${view.kind === 'approvals' ? ' active' : ''}`}
            onClick={() => setView({ kind: 'approvals' })}
          >
            承認トレイ
            {approvals.length > 0 && <span className="count">{approvals.length}</span>}
          </button>
          <button
            className={`item${view.kind === 'history' ? ' active' : ''}`}
            onClick={() => setView({ kind: 'history' })}
          >
            実行履歴
          </button>
          <button
            className={`item${view.kind === 'notifications' ? ' active' : ''}`}
            onClick={() => setView({ kind: 'notifications' })}
          >
            お知らせ
            {unread > 0 && <span className="count">{unread}</span>}
          </button>
          <button
            className={`item${view.kind === 'schedules' ? ' active' : ''}`}
            onClick={() => setView({ kind: 'schedules' })}
          >
            定時実行
          </button>
          <button
            className={`me-summary${view.kind === 'settings' ? ' active' : ''}`}
            onClick={() => setView({ kind: 'settings' })}
          >
            <strong>{me.user.displayName}</strong>
            <span className="sub">{me.user.roles.map(roleLabel).join('・')}</span>
            <span className="sub">使える業務 {agents.length} 件 ・ 個人設定</span>
          </button>
        </nav>

        <main className="canvas">
          {error && <p className="error">{error}</p>}
          {view.kind === 'home' && <Home approvals={approvals.length} agents={agents.length} />}
          {view.kind === 'agent' && (
            <>
              <h1>{view.agent.name}</h1>
              <p className="lead">必要な項目を入力して実行します。</p>
              <AgentForm agent={view.agent} onSubmitted={(runId) => setView({ kind: 'run', runId })} />
            </>
          )}
          {view.kind === 'run' && (
            <>
              <h1>実行の詳細</h1>
              <p className="lead">進捗は自動で更新されます。</p>
              {detail ? <RunView detail={detail} /> : <p className="muted">読み込み中…</p>}
            </>
          )}
          {view.kind === 'approvals' && (
            <>
              <h1>承認トレイ</h1>
              <p className="lead">内容を確認してから承認してください。</p>
              <ApprovalTray items={approvals} onDecided={() => void refresh()} />
            </>
          )}
          {view.kind === 'notifications' && (
            <>
              <h1>お知らせ</h1>
              <p className="lead">あなた宛ての通知です。週次ブリーフもここに届きます。</p>
              <Notifications items={notifications} onRead={() => void refresh()} />
            </>
          )}
          {view.kind === 'schedules' && (
            <>
              <h1>定時実行</h1>
              <p className="lead">決まった時刻に、あなたの権限で業務を実行します。</p>
              <Schedules agents={agents} />
            </>
          )}
          {view.kind === 'settings' && (
            <>
              <h1>個人設定</h1>
              <p className="lead">あなただけに関わる設定です。管理者も変更できません。</p>
              <Settings me={me} agents={agents} onChanged={loadMenu} />
            </>
          )}
          {view.kind === 'history' && (
            <>
              <h1>実行履歴</h1>
              <p className="lead">過去の依頼と結果を確認できます。</p>
              {history.length === 0 && <p className="muted">まだ履歴はありません。</p>}
              {history.map(({ run, job }) => (
                <div className="card" key={run.id}>
                  <h3>
                    {agents.find((a) => a.id === job?.agentId)?.name ?? '不明な業務'}{' '}
                    <span className={`status ${run.status}`}>{statusLabel(run.status)}</span>
                  </h3>
                  <button className="btn ghost" onClick={() => setView({ kind: 'run', runId: run.id })}>
                    詳細を見る
                  </button>
                </div>
              ))}
            </>
          )}
        </main>

        {showSash && (
          <aside className="sash">
            {reply && (
              <>
                <h3>秘書の応答</h3>
                <p className="reply">{reply.text}</p>
                <p className="muted" style={{ fontSize: 12 }}>
                  {layerLabel(reply.layer)} / {reply.elapsedMs}ms / {reply.tokensUsed} トークン
                </p>
                {reply.suggestedAgent && (
                  <button
                    className="btn"
                    onClick={() => {
                      const hit = agents.find((a) => a.id === reply.suggestedAgent?.id);
                      if (hit) setView({ kind: 'agent', agent: hit });
                      setReply(null);
                    }}
                  >
                    {reply.suggestedAgent.name} を開く
                  </button>
                )}
                {reply.evidence.length > 0 && (
                  <>
                    <h3 style={{ marginTop: 16 }}>根拠</h3>
                    <dl className="kv">
                      {reply.evidence.map((e, i) => (
                        <div key={i} style={{ display: 'contents' }}>
                          <dt>{e.label}</dt>
                          <dd>{e.value}</dd>
                        </div>
                      ))}
                    </dl>
                  </>
                )}
              </>
            )}
            {view.kind === 'run' && detail && (
              <>
                <h3 style={{ marginTop: reply ? 16 : 0 }}>実行した処理</h3>
                <Evidence steps={detail.steps} />
              </>
            )}
          </aside>
        )}
      </div>

      <SecretaryBar onReply={setReply} />
    </div>
  );
}

function Home({ approvals, agents }: { approvals: number; agents: number }) {
  return (
    <>
      <h1>何かお手伝いしましょうか</h1>
      <p className="lead">
        メニューから業務を選ぶか、下の入力欄で秘書に話しかけてください。
      </p>
      <div className="card">
        <h3>いまの状況</h3>
        <dl className="kv">
          <dt>使える業務</dt><dd>{agents} 件</dd>
          <dt>承認待ち</dt><dd>{approvals} 件</dd>
        </dl>
      </div>
    </>
  );
}

/** 常駐の秘書バー。どの画面からでも呼び出せる（仕様書 第8.4節）。 */
function SecretaryBar({ onReply }: { onReply: (r: SecretaryReply) => void }) {
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [hint, setHint] = useState<string | null>(null);

  async function send() {
    if (!text.trim() || busy) return;
    setBusy(true);
    try {
      const reply = await api.ask(text);
      onReply(reply);
      setHint(`${layerLabel(reply.layer)}・${reply.elapsedMs}ms`);
      setText('');
    } catch (err) {
      setHint(err instanceof Error ? err.message : '応答できませんでした');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="secretary">
      <span className="muted">秘書</span>
      <input
        value={text}
        placeholder="例: 今日の予定は？ / 承認待ちある？ / 会議の議事録をまとめて"
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          // 日本語入力の変換確定の Enter では送らない
          if (e.key === 'Enter' && !e.nativeEvent.isComposing) void send();
        }}
        disabled={busy}
      />
      <button className="btn" onClick={() => void send()} disabled={busy}>
        {busy ? '…' : '聞く'}
      </button>
      {hint && <span className="layer">{hint}</span>}
    </div>
  );
}

/** 本人宛の通知の一覧。開くと既読になる。 */
function Notifications({ items, onRead }: { items: Notification[]; onRead: () => void }) {
  const [open, setOpen] = useState<string | null>(null);
  if (items.length === 0) return <p className="muted">お知らせはありません。</p>;
  return (
    <>
      {items.map((n) => (
        <div key={n.id} className={`card notice${n.readAt ? '' : ' unread'}`}>
          <h3>
            {n.title}{' '}
            <span className="muted small">
              {new Date(n.createdAt).toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' })}
            </span>
          </h3>
          {open === n.id ? (
            <p className="reply">{n.body}</p>
          ) : (
            <button className="btn ghost small" onClick={() => {
              setOpen(n.id);
              if (!n.readAt) void api.readNotification(n.id).then(onRead);
            }}>
              開く
            </button>
          )}
        </div>
      ))}
    </>
  );
}

/** 定時実行の一覧。停止・再開と、動作確認のための「今すぐ実行」。 */
function Schedules({ agents }: { agents: AgentSummary[] }) {
  const [items, setItems] = useState<ScheduleView[]>([]);
  const [message, setMessage] = useState<string | null>(null);
  const load = useCallback(() => {
    api.schedules().then((r) => setItems(r.items)).catch((err) => setMessage(String(err.message ?? err)));
  }, []);
  useEffect(load, [load]);

  if (items.length === 0) return <p className="muted">定時実行はありません。</p>;
  return (
    <>
      {message && <p className="muted">{message}</p>}
      {items.map((s) => (
        <div key={s.id} className="card">
          <h3>
            {agents.find((a) => a.id === s.agentId)?.name ?? s.agentId}{' '}
            <span className={`status ${s.enabled ? 'succeeded' : ''}`}>{s.enabled ? '有効' : '停止中'}</span>
          </h3>
          <dl className="kv">
            <dt>繰り返し</dt><dd>{s.label}</dd>
            <dt>次回</dt>
            <dd>{s.enabled ? new Date(s.nextRunAt).toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' }) : '—'}</dd>
            <dt>前回</dt>
            <dd>{s.lastRunAt ? new Date(s.lastRunAt).toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' }) : 'まだ実行していません'}</dd>
          </dl>
          <div className="row">
            <button className="btn ghost small" onClick={() =>
              void api.updateSchedule(s.id, { enabled: !s.enabled }).then(load)}>
              {s.enabled ? '停止する' : '再開する'}
            </button>
            <button className="btn ghost small" onClick={() =>
              void api.triggerSchedule(s.id).then(() => {
                setMessage('次の見回りで実行します。結果は「お知らせ」と「実行履歴」に出ます。');
                load();
              })}>
              今すぐ実行
            </button>
          </div>
        </div>
      ))}
    </>
  );
}

function roleLabel(role: string): string {
  return ({ admin: '管理者', approver: '承認者', member: '一般', external: '外部協力者', developer: '開発者' } as Record<string, string>)[role] ?? role;
}

/** どの層で応答したかを表示用の言葉にする（仕様書 第8.9.1節）。 */
function layerLabel(layer: SecretaryReply['layer']): string {
  return { direct: '直接応答', light: '取次', full: '対話' }[layer];
}
