/**
 * @file 管理者ページの枠と、参照の画面（利用状況・実行の一覧・監査ログ・接続）。
 *
 * @see 仕様書 第6.6節 管理者ページ
 */

import { useCallback, useEffect, useState } from 'react';
import type { AuditEvent } from '@m2office/shared';
import { api, type AdminRun, type Me } from './api.js';
import { statusLabel } from './components.js';
import {
  AgentSettings, CompanySettings, KnowledgeSettings, UserSettings,
} from './AdminSettings.js';
import { Dashboard } from './Dashboard.js';
import { ExtensionSettings } from './Extensions.js';
import { HelpCenter, useOpenHelp } from './help.js';

type Tab =
  | 'dashboard' | 'usage' | 'runs' | 'company' | 'agents' | 'extensions' | 'users' | 'knowledge' | 'audit'
  | 'connectors' | 'help';

const TABS: { id: Tab; label: string }[] = [
  { id: 'dashboard', label: 'ダッシュボード' },
  { id: 'usage', label: '利用状況' },
  { id: 'runs', label: '実行の一覧' },
  { id: 'company', label: '会社情報' },
  { id: 'agents', label: '業務と承認' },
  { id: 'extensions', label: '拡張機能' },
  { id: 'users', label: 'ユーザーと権限' },
  { id: 'knowledge', label: '知識' },
  { id: 'audit', label: '監査ログ' },
  { id: 'connectors', label: '接続' },
  { id: 'help', label: 'ヘルプ' },
];

/**
 * 管理者ページ（`/admin`。仕様書 第6.6節）。
 *
 * 会社情報・業務と承認・ユーザー・知識は編集できる。
 * LLM の設定（鍵の登録）とコネクタの設定は、秘匿情報の暗号化とあわせて追加する。
 *
 * @remarks
 * 管理者でも、他人の会話ログと実行の中身は見られない（不変則 I-10）。
 * 実行の一覧は状態と費用だけを表示する。
 */
export function Admin({ me, onLogout }: { me: Me; onLogout: () => void }) {
  const [tab, setTab] = useState<Tab>('dashboard');
  const [helpArticle, setHelpArticle] = useState<string | null>(null);
  useOpenHelp(useCallback((id: string | null) => { setHelpArticle(id); setTab('help'); }, []));
  const isAdmin = me.user.roles.includes('admin');

  return (
    <div className="app">
      <header className="topbar">
        <span className="brand">M2Office 管理</span>
        <span className="tenant">{me.tenant.name}</span>
        <span className="spacer" />
        <a className="link" href={`/${location.search}`}>ワークスペースへ戻る</a>
        <span className="badge">{me.user.displayName}</span>
        <button className="btn ghost small" onClick={onLogout}>ログアウト</button>
      </header>
      {!isAdmin ? (
        <main className="canvas"><p className="error">管理者ページは管理者のみが開けます。</p></main>
      ) : (
        <div className="panes">
          <nav className="left">
            <h2>管理</h2>
            {TABS.map((t) => (
              <button key={t.id} className={`item${tab === t.id ? ' active' : ''}`} onClick={() => setTab(t.id)}>
                {t.label}
              </button>
            ))}
          </nav>
          <main className="canvas">
            {tab === 'dashboard' && <Dashboard onGo={(t) => setTab(t as Tab)} />}
            {tab === 'help' && <HelpCenter initial={helpArticle} />}
            {tab === 'usage' && <Usage />}
            {tab === 'runs' && <Runs />}
            {tab === 'company' && <CompanySettings />}
            {tab === 'agents' && <AgentSettings />}
            {tab === 'extensions' && <ExtensionSettings />}
            {tab === 'users' && <UserSettings meId={me.user.id} />}
            {tab === 'knowledge' && <KnowledgeSettings />}
            {tab === 'audit' && <Audit />}
            {tab === 'connectors' && <Connectors />}
          </main>
        </div>
      )}
    </div>
  );
}

/** 読み込みと失敗の表示をまとめる。 */
function useLoad<T>(fn: () => Promise<T>): { data: T | null; error: string | null } {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    fn().then(setData).catch((err) => setError(err instanceof Error ? err.message : '取得できませんでした'));
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  return { data, error };
}

const time = (iso: string | null) =>
  iso ? new Date(iso).toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' }) : '—';

function Usage() {
  const { data, error } = useLoad(api.admin.usage);
  return (
    <>
      <h1>利用状況</h1>
      <p className="lead">エージェントごとの実行件数と費用です。</p>
      {error && <p className="error">{error}</p>}
      {data && (
        <>
          <div className="stats">
            <div className="stat"><span>実行件数</span><strong>{data.total.runs.toLocaleString()}</strong></div>
            <div className="stat"><span>推論の費用</span><strong>{data.total.costJpy.toLocaleString()} 円</strong></div>
          </div>
          <table className="table">
            <thead><tr><th>業務</th><th className="num">件数</th><th className="num">トークン</th><th className="num">費用</th></tr></thead>
            <tbody>
              {data.items.map((i) => (
                <tr key={i.agentId}>
                  <td>{i.name}</td><td className="num">{i.runs}</td>
                  <td className="num">{i.tokens.toLocaleString()}</td><td className="num">{i.costJpy} 円</td>
                </tr>
              ))}
            </tbody>
          </table>
          {data.note && <p className="muted small">{data.note}</p>}
          <p className="muted small">費用は暫定の係数による概算です。請求額ではありません。</p>
        </>
      )}
    </>
  );
}

function Runs() {
  const { data, error } = useLoad(api.admin.runs);
  const { data: users } = useLoad(api.admin.users);
  const nameOf = (id: string | null) => users?.items.find((u) => u.id === id)?.displayName ?? id ?? '—';
  return (
    <>
      <h1>実行の一覧</h1>
      <p className="lead">全利用者の実行の状態です。入力や成果物の中身は表示しません。</p>
      {error && <p className="error">{error}</p>}
      <table className="table">
        <thead><tr><th>開始</th><th>業務</th><th>依頼者</th><th>起動</th><th>状態</th><th className="num">費用</th></tr></thead>
        <tbody>
          {data?.items.map((r: AdminRun) => (
            <tr key={r.id}>
              <td>{time(r.startedAt)}</td><td>{r.agentName}</td><td>{nameOf(r.requestedBy)}</td>
              <td>{originLabel(r.origin)}</td>
              <td><span className={`status ${r.status}`}>{statusLabel(r.status)}</span></td>
              <td className="num">{r.costJpy} 円</td>
            </tr>
          ))}
        </tbody>
      </table>
    </>
  );
}

function Audit() {
  const { data, error } = useLoad(api.admin.audit);
  return (
    <>
      <h1>監査ログ</h1>
      <p className="lead">直近 200 件です。記録は追記のみで、変更や削除はできません。</p>
      {error && <p className="error">{error}</p>}
      <table className="table">
        <thead><tr><th>日時</th><th>主体</th><th>操作</th><th>対象</th></tr></thead>
        <tbody>
          {data?.items.map((e: AuditEvent) => (
            <tr key={e.id}>
              <td>{time(e.occurredAt)}</td><td>{e.actorType}: {e.actorId}</td>
              <td><code>{e.action}</code></td><td>{e.targetType}: {e.targetId.slice(0, 16)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </>
  );
}

function Connectors() {
  const { data, error } = useLoad(api.admin.connectors);
  return (
    <>
      <h1>接続</h1>
      <p className="lead">業務システムと LLM への接続の状態です。</p>
      {error && <p className="error">{error}</p>}
      {data && (
        <div className="card">
          <dl className="kv">
            <dt>Google Workspace</dt><dd>{data.workspace.label}</dd>
            <dt>LLM</dt><dd>{data.llm.provider === 'stub' ? 'スタブ（推論を行わない開発用）' : data.llm.provider}</dd>
          </dl>
        </div>
      )}
    </>
  );
}

function originLabel(origin: string | null): string {
  return ({ menu: 'メニュー', secretary: '秘書', schedule: '定時実行', api: 'API' } as Record<string, string>)[origin ?? ''] ?? '—';
}

function roleLabel(role: string): string {
  return ({ admin: '管理者', approver: '承認者', member: '一般', external: '外部協力者', developer: '開発者' } as Record<string, string>)[role] ?? role;
}
