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
import { Connections } from './Connections.js';
import { HelpCenter, useOpenHelp } from './help.js';
import { NavHeading, NavItem, SideNavLayout, ThemeToggle, type IconName } from './nav.js';

type Tab =
  | 'dashboard' | 'usage' | 'runs' | 'company' | 'agents' | 'extensions' | 'users' | 'knowledge' | 'audit'
  | 'connectors' | 'help';

/** 管理者ページの左ペインの項目。説明はマウスを重ねたときに出す（仕様書 第6.1.1節）。 */
const TABS: { id: Tab; label: string; icon: IconName; description: string }[] = [
  { id: 'dashboard', label: 'ダッシュボード', icon: 'dashboard', description: 'いまの状況と集計、はじめに行う設定' },
  { id: 'usage', label: '利用状況', icon: 'usage', description: '業務ごとの実行の件数と費用' },
  { id: 'runs', label: '実行の一覧', icon: 'runs', description: '全員の実行の状態と費用（中身は見られません）' },
  { id: 'company', label: '会社情報', icon: 'company', description: '会社の情報、自社の書き方、スライドのテンプレート' },
  { id: 'agents', label: '業務と承認', icon: 'sliders', description: '使う業務、承認の決まり、利用できる人' },
  { id: 'extensions', label: '拡張機能', icon: 'extensions', description: '業務や外部とのつながりを追加する' },
  { id: 'users', label: 'ユーザーと権限', icon: 'users', description: '招待・ロール・グループ・権限区画' },
  { id: 'knowledge', label: '知識', icon: 'knowledge', description: '就業規則などの社内の規程' },
  { id: 'audit', label: '監査ログ', icon: 'audit', description: '誰が何をしたかの記録' },
  { id: 'connectors', label: '接続', icon: 'connectors', description: 'Google と LLM への接続、業務が求める Google の権限' },
  { id: 'help', label: 'ヘルプ', icon: 'help', description: '管理者向けの記事と検索' },
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
        <ThemeToggle />
        <span className="badge">{me.user.displayName}</span>
        <button className="btn ghost small" onClick={onLogout}>ログアウト</button>
      </header>
      {!isAdmin ? (
        <main className="canvas"><p className="error">管理者ページは管理者のみが開けます。</p></main>
      ) : (
        <SideNavLayout nav={(
          <>
            <NavHeading>管理</NavHeading>
            {TABS.map((t) => (
              <NavItem key={t.id} icon={t.icon} label={t.label} description={t.description}
                active={tab === t.id} onClick={() => setTab(t.id)} />
            ))}
          </>
        )}>
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
            {tab === 'connectors' && <><Connections /><Connectors /></>}
          </main>
        </SideNavLayout>
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

/** Google の権限の段階の表示（仕様書 第14.3.1節）。 */
const LEVEL_LABEL: Record<string, { text: string; className: string }> = {
  restricted: { text: '制限付き（公開の前に CASA が必要）', className: 'badge warn' },
  sensitive: { text: '機密（公開の前に Google の審査）', className: 'badge' },
  'non-sensitive': { text: '機密でない', className: 'badge muted-badge' },
};

function Connectors() {
  const { data, error } = useLoad(api.admin.connectors);
  const perms = useLoad(api.admin.googlePermissions);
  return (
    <>
      {error && <p className="error">{error}</p>}
      {data && (
        <div className="card">
          <h3>接続の状態</h3>
          <dl className="kv">
            <dt>Google Workspace</dt><dd>{data.workspace.label}</dd>
            <dt>LLM（既定）</dt><dd>{data.llm.provider === 'stub' ? 'スタブ（推論を行わない開発用）' : data.llm.provider}</dd>
          </dl>
        </div>
      )}
      <div className="card">
        <h3>この会社の業務が求める Google の権限</h3>
        <p className="small">
          使える業務のツールから集めた一覧です。Google との接続では、使う業務の分だけ許可を求めます。
          「制限付き」の権限は、一般公開の前に第三者のセキュリティ評価（CASA）が必要です。段階は見込みで、申請の前に Google の一覧で確かめます。
        </p>
        {perms.error && <p className="error">{perms.error}</p>}
        {perms.data && (
          <table className="table">
            <thead><tr><th>権限</th><th>段階</th><th>ツール</th><th>業務</th></tr></thead>
            <tbody>
              {perms.data.items.map((p) => (
                <tr key={p.scope}>
                  <td><code>{p.scope}</code></td>
                  <td><span className={LEVEL_LABEL[p.level]?.className ?? 'badge'}>{LEVEL_LABEL[p.level]?.text ?? p.level}</span></td>
                  <td className="small">{p.tools.join('、')}</td>
                  <td className="small">{p.agents.join('、')}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </>
  );
}

function originLabel(origin: string | null): string {
  return ({ menu: 'メニュー', secretary: '秘書', schedule: '定時実行', api: 'API' } as Record<string, string>)[origin ?? ''] ?? '—';
}

function roleLabel(role: string): string {
  return ({ admin: '管理者', approver: '承認者', member: '一般', external: '外部協力者', developer: '開発者' } as Record<string, string>)[role] ?? role;
}
