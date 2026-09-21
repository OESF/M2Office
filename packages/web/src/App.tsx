import { useCallback, useEffect, useState } from 'react';
import type { Approval, Tenant, User } from '@m2office/shared';
import { api, type AgentSummary, type RunDetail, type SecretaryReply } from './api.js';
import { AgentForm, ApprovalTray, Evidence, RunView, statusLabel } from './components.js';

/** 中央キャンバスに何を表示しているか。 */
type View =
  | { kind: 'home' }
  | { kind: 'agent'; agent: AgentSummary }
  | { kind: 'run'; runId: string }
  | { kind: 'approvals' }
  | { kind: 'history' };

/**
 * ワークスペースの画面。
 *
 * 左にコマンドメニュー、中央にキャンバス、右に必要時のサッシパネル、
 * 下部に常駐の秘書バーを置く（仕様書 第18.1節）。
 */
export function App() {
  const [me, setMe] = useState<{ tenant: Tenant; user: User } | null>(null);
  const [agents, setAgents] = useState<AgentSummary[]>([]);
  const [approvals, setApprovals] = useState<Approval[]>([]);
  const [history, setHistory] = useState<{ run: { id: string; status: string }; job: { agentId: string } | null }[]>([]);
  const [view, setView] = useState<View>({ kind: 'home' });
  const [detail, setDetail] = useState<RunDetail | null>(null);
  const [reply, setReply] = useState<SecretaryReply | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const [a, p, j] = await Promise.all([api.agents(), api.approvals(), api.jobs()]);
      setAgents(a.agents);
      setApprovals(p.items);
      setHistory(j.items as never);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : '読み込みに失敗しました');
    }
  }, []);

  useEffect(() => {
    api.me().then(setMe).catch(() => setError('テナントを特定できません。サブドメインを確認してください。'));
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

  return (
    <div className="app">
      <header className="topbar">
        <span className="brand">M2Office</span>
        <span className="tenant">{me?.tenant.name ?? '読み込み中…'}</span>
        <span className="spacer" />
        {me && <span className="badge">{me.user.displayName}</span>}
      </header>

      <div className={`panes${showSash ? ' with-sash' : ''}`}>
        <nav className="left">
          <h2>業務</h2>
          {agents.map((a) => (
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
        placeholder="例: 承認待ちある？ / 会議の議事録をまとめて"
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => { if (e.key === 'Enter') void send(); }}
        disabled={busy}
      />
      <button className="btn" onClick={() => void send()} disabled={busy}>
        {busy ? '…' : '聞く'}
      </button>
      {hint && <span className="layer">{hint}</span>}
    </div>
  );
}

/** どの層で応答したかを表示用の言葉にする（仕様書 第8.9.1節）。 */
function layerLabel(layer: SecretaryReply['layer']): string {
  return { direct: '直接応答', light: '取次', full: '対話' }[layer];
}
