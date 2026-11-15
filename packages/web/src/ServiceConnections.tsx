/**
 * @file 管理者ページ「接続」の、会社の外のサービスとのつなぎ（WordPress・LINE 公式アカウント・窓口のメール。仕様書 第6.6.2.1節）。
 *
 * いくつかの機能が使う接続なので、拡張機能の設定ではなく「接続」に置く（第 0.361.0 版）。
 * 預けた中身と API の道は、拡張機能の設定にあったときのまま使う。秘密の値は画面に戻さない。
 */

import { useEffect, useState } from 'react';
import type { InquirySettings, WebColumnSettings } from '@m2office/shared';
import { siteScopeTarget } from '@m2office/shared';
import { api, describeError, type AccessOptions, type McpConnectionView } from './api.js';
import { ScopeField, useAccessOptions } from './Scope.js';
import { copyText } from './clipboard.js';

/** 接続の小分けの ID。 */
export type ServiceConnectionPage = 'wordpress' | 'line' | 'mailbox';

/** 小分けの ID か。 */
export const isServiceConnectionPage = (p: string): p is ServiceConnectionPage => p === 'wordpress' || p === 'line' || p === 'mailbox';

/**
 * 会社の外のサービスとのつなぎ 1 つ。
 *
 * @remarks 預けた状態は拡張機能の一覧（`GET /v1/admin/extensions`）から読む。拡張機能を入れていなくてもつないでおける
 */
export function ServiceConnection({ page }: { page: ServiceConnectionPage }) {
  const [state, setState] = useState<{ webColumns: WebColumnSettings | null; inquiries: InquirySettings | null } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = () => api.admin.extensions().then((r) => setState({
    webColumns: r.items.find((x) => x.webColumns)?.webColumns ?? null,
    inquiries: r.items.find((x) => x.inquiries)?.inquiries ?? null,
  })).catch((e) => setError(describeError(e, '読み込めませんでした')));
  useEffect(() => { void load(); }, []);
  if (error) return <p className="error">{error}</p>;
  if (!state) return <p className="muted">読み込み中…</p>;
  if (page === 'wordpress') return state.webColumns ? <WordPressCard settings={state.webColumns} onChanged={load} /> : <Unavailable />;
  if (!state.inquiries) return <Unavailable />;
  return page === 'line' ? <LineCard settings={state.inquiries} onChanged={load} /> : <MailboxCard settings={state.inquiries} onChanged={load} />;
}

const Unavailable = () => <div className="card"><p className="muted">この環境では使えません。</p></div>;

/** WordPress（コラムの作成・お知らせの作成が使う。第32.10節）。つながるかを確かめてから預ける。 */
function WordPressCard({ settings, onChanged }: { settings: WebColumnSettings; onChanged: () => void }) {
  const [wp, setWp] = useState({ siteUrl: settings.wordpress?.siteUrl ?? '', username: settings.wordpress?.username ?? '', password: '' });
  const [working, setWorking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const connect = () => {
    setWorking(true);
    api.admin.saveWordPress(wp).then(() => { setError(null); setWp({ ...wp, password: '' }); onChanged(); })
      .catch((e) => setError(describeError(e, 'WordPress につなげませんでした'))).finally(() => setWorking(false));
  };
  const remove = () => {
    if (!window.confirm('WordPress を外しますか。コラムとお知らせを WordPress に入れなくなります（入れた記事とコラムは消えません）')) return;
    setWorking(true);
    api.admin.removeWordPress().then(() => { setError(null); onChanged(); })
      .catch((e) => setError(describeError(e, '外せませんでした'))).finally(() => setWorking(false));
  };
  // REST API の WordPress のサイトの名前（公開のページの題名。読めなければ URL の名前）
  const [restName, setRestName] = useState<string | null>(null);
  useEffect(() => {
    if (!settings.wordpress) return;
    api.admin.contentSites().then((r) => setRestName(r.sites.find((s) => s.key === 'rest')?.name ?? null)).catch(() => setRestName(null));
  }, [settings.wordpress]);
  // サイトごとの利用できる人（仕様書 第47.6節）
  const access = useAccessOptions();
  return (
    <div className="card service-connection">
      {settings.wordpress ? (
        <SiteRow
          scope={access.options ? { target: siteScopeTarget('rest'), options: access.options, onSaved: () => void access.reload() } : null}
          name={restName ?? hostOf(settings.wordpress.siteUrl)} state="接続中" kind="REST API" url={settings.wordpress.siteUrl}
          account={`WordPress の利用者: ${settings.wordpress.username}`}
          action={<button className="btn ghost small" disabled={working} onClick={remove}>切断</button>}
        >
          <WordPressUsers />
        </SiteRow>
      ) : (
        <div className="service-connection-form">
          <input value={wp.siteUrl} placeholder="https://www.example.jp" aria-label="WordPress のサイトの URL" onChange={(e) => setWp({ ...wp, siteUrl: e.target.value })} />
          <input value={wp.username} placeholder="利用者名" aria-label="WordPress の利用者名" autoComplete="off" onChange={(e) => setWp({ ...wp, username: e.target.value })} />
          <input value={wp.password} type="password" placeholder="アプリケーションパスワード" aria-label="WordPress のアプリケーションパスワード" autoComplete="new-password"
            onChange={(e) => setWp({ ...wp, password: e.target.value })} />
          <div className="row"><button className="btn small" disabled={working || !wp.siteUrl.trim() || !wp.username.trim() || !wp.password.trim()} onClick={connect}>{working ? '接続しています…' : '接続'}</button></div>
        </div>
      )}
      {error && <p className="error">{error}</p>}
      <McpSites options={access.options} onScopeSaved={() => void access.reload()} />
    </div>
  );
}

/**
 * MCP でつないだサイト（仕様書 第47.3節）。「接続 › コネクタ（MCP）」で登録した接続のうち、推論が会社のサイトを扱うとしたもの。
 * 秘書が、頼みと話の流れから対象のサイトを選ぶ（第47.6節）。
 */
function McpSites({ options, onScopeSaved }: { options: AccessOptions | null; onScopeSaved: () => void }) {
  const [items, setItems] = useState<McpConnectionView[] | null>(null);
  useEffect(() => {
    api.admin.mcpConnections().then((r) => setItems(r.items.filter((c) => c.profile?.site))).catch(() => setItems([]));
  }, []);
  if (!items || items.length === 0) return null;
  return (
    <>
      {items.map((c) => (
        <SiteRow
          key={c.id} name={c.profile?.siteName || c.name} kind="MCP" url={c.profile?.siteUrl ?? null}
          // 役割を確かめるまでは使えない（「接続 › コネクタ（MCP）」で確かめる。第47.4.1節）
          state={c.profile?.agentId ? '接続中' : '役割を確かめていません'} warn={!c.profile?.agentId}
          account={`コネクタ: ${c.name}（${c.authState.text}）`} title={c.profile?.summary ?? ''}
          scope={options ? { target: siteScopeTarget(`mcp:${c.id}`), options, onSaved: onScopeSaved } : null}
        >
          {c.authState.type === 'oauth' && <McpUsers id={c.id} />}
        </SiteRow>
      ))}
    </>
  );
}

/**
 * MCP のサイトを自分のアカウントで許可している人（仕様書 第47.3節）。REST API の WordPress の利用者の表と同じ形。
 * 許可している人がいるときだけ出す。認可の中身は出さない
 */
function McpUsers({ id }: { id: string }) {
  const [items, setItems] = useState<{ userId: string; name: string; account: string | null; connectedAt: string }[]>([]);
  useEffect(() => { api.admin.mcpConnectionUsers(id).then((r) => setItems(r.items)).catch(() => setItems([])); }, [id]);
  if (!items.length) return null;
  return (
    <table className="table small">
      <thead><tr><th>M2Office の利用者</th><th>サイトのアカウント</th><th>つないだ日時</th></tr></thead>
      <tbody>
        {items.map((u) => (
          <tr key={u.userId}>
            <td>{u.name}</td><td>{u.account ?? '—'}</td>
            <td>{new Date(u.connectedAt).toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' })}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/**
 * つないでいるサイト 1 つ（仕様書 第47.3節）。REST API でつないだ WordPress も、MCP でつないだサイトも、同じ形で並べる:
 * サイトの名前・状態・つなぎ方・URL・つないでいる利用者かコネクタ。
 */
function SiteRow({ name, state, warn = false, kind, url, account, title, action, scope, children }: {
  name: string; state: string; warn?: boolean; kind: 'REST API' | 'MCP'; url: string | null; account: string;
  /** 指し示すと出る説明（MCP のサイトでできること）。 */
  title?: string;
  action?: React.ReactNode;
  /** このサイトを使える人（利用範囲。第47.6節）。読み込めるまでは `null` */
  scope: { target: string; options: AccessOptions; onSaved: () => void } | null;
  children?: React.ReactNode;
}) {
  return (
    <div className="site-row">
      <div className="row wrap">
        <strong title={title}>{name}</strong>
        <span className={`badge ${warn ? 'warn' : 'ok'}`}>{state}</span>
        <span className="muted small">{kind}</span>
        {action && <span className="site-row-action">{action}</span>}
      </div>
      {url && <a className="small" href={url} target="_blank" rel="noreferrer">{url}</a>}
      <span className="small muted">{account}</span>
      {scope && (
        <div className="site-row-scope small">
          <span className="muted">利用できる人</span>
          <ScopeField target={scope.target} options={scope.options} onSaved={scope.onSaved} />
        </div>
      )}
      {children}
    </div>
  );
}

/** URL の名前の部分（読めなければそのまま）。 */
function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

/**
 * 一人ひとりの WordPress の接続をしている人（仕様書 第45.16節、Q-337）。サイトの更新を入れている会社で、つないでいる人がいるときだけ出す。
 * WordPress の利用者名と役割だけで、パスワードは出さない。
 */
function WordPressUsers() {
  const [items, setItems] = useState<{ userId: string; name: string; username: string; displayName: string; roles: string[]; connectedAt: string }[]>([]);
  useEffect(() => {
    api.admin.siteUpdatesWordPressUsers().then((r) => setItems(r.items)).catch(() => setItems([]));
  }, []);
  if (!items.length) return null;
  return (
    <table className="table small">
      <thead><tr><th>M2Office の利用者</th><th>WordPress の利用者</th><th>役割</th><th>つないだ日時</th></tr></thead>
      <tbody>
        {items.map((u) => (
          <tr key={u.userId}>
            <td>{u.name}</td><td>{u.displayName && u.displayName !== u.username ? `${u.displayName}（${u.username}）` : u.username}</td>
            <td>{u.roles.join('・')}</td><td>{new Date(u.connectedAt).toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' })}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/**
 * LINE 公式アカウント（問い合わせの記録・お知らせの作成・会員とポイントが使う。第33.19節）。
 * チャネルのシークレットとアクセストークンを入れて接続すると、受け口の URL を 1 度だけ出す。その URL を LINE の管理画面の Webhook に入れる。
 */
function LineCard({ settings, onChanged }: { settings: InquirySettings; onChanged: () => void }) {
  const [secret, setSecret] = useState('');
  const [token, setToken] = useState('');
  const [url, setUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [working, setWorking] = useState(false);
  const [copied, setCopied] = useState(false);
  const connect = () => {
    setWorking(true);
    api.admin.connectInquiryLine(secret.trim(), token.trim()).then((r) => { setUrl(r.webhookUrl); setSecret(''); setToken(''); setError(null); onChanged(); })
      .catch((e) => setError(describeError(e, '接続できませんでした'))).finally(() => setWorking(false));
  };
  const disconnect = () => {
    if (!window.confirm('LINE 公式アカウントを切断しますか。メッセージを受け取らなくなり、LINE での返事・お知らせの配信・会員証も使えなくなります（問い合わせは消えません）')) return;
    setWorking(true);
    api.admin.disconnectInquiryLine().then(() => { setUrl(null); setError(null); onChanged(); })
      .catch((e) => setError(describeError(e, '切断できませんでした'))).finally(() => setWorking(false));
  };
  return (
    <div className="card service-connection">
      {settings.line ? (
        <div className="row wrap">
          <span className="badge ok">接続中</span>
          <span>{settings.line.botName}{settings.line.basicId ? <span className="muted">（{settings.line.basicId}）</span> : null}</span>
          <button className="btn ghost small" disabled={working} onClick={disconnect}>切断</button>
        </div>
      ) : (
        <div className="service-connection-form">
          <input type="password" value={secret} autoComplete="off" placeholder="チャネルのシークレット" aria-label="チャネルのシークレット" onChange={(e) => setSecret(e.target.value)} />
          <input type="password" value={token} autoComplete="off" placeholder="チャネルのアクセストークン（長期）" aria-label="チャネルのアクセストークン" onChange={(e) => setToken(e.target.value)} />
          <div className="row"><button className="btn small" disabled={working || !secret.trim()} onClick={connect}>{working ? '接続しています…' : '接続'}</button></div>
        </div>
      )}
      {url && (
        <div className="row wrap">
          <span className="muted">受け口の URL（LINE の管理画面の Webhook に入れてください。いまだけ出ます）:</span>
          <code className="ext-line-url">{url}</code>
          <button className="btn ghost small" onClick={() => void copyText(url).then((ok) => { if (ok) { setCopied(true); setTimeout(() => setCopied(false), 1500); } })}>{copied ? 'コピーしました' : 'コピー'}</button>
        </div>
      )}
      {error && <p className="error">{error}</p>}
    </div>
  );
}

/**
 * 窓口のメール（問い合わせの記録・名刺管理のまとめてのメールが使う。第33.18節）。接続で Google の認可の画面へ移り、窓口のアカウント（info@ など）を選ぶ。
 * 戻ってきたら結果（`?mailbox=`）を出す。
 */
function MailboxCard({ settings, onChanged }: { settings: InquirySettings; onChanged: () => void }) {
  const [error, setError] = useState<string | null>(null);
  const [working, setWorking] = useState(false);
  const [result] = useState(() => {
    const r = new URLSearchParams(location.search).get('mailbox');
    if (r) history.replaceState(null, '', location.pathname);
    return r;
  });
  const RESULT_TEXT: Record<string, string> = {
    connected: '窓口のアカウントを接続しました', cancelled: '接続をキャンセルしました', scopes: 'メールを読む・送るの許可が足りません。もう一度接続して、すべて許可してください',
    domain: '会社のドメインのアカウントではありません。会社の Google Workspace の窓口のアカウントを選んでください',
    user: 'M2Office の利用者のアカウントは窓口にできません。窓口専用のアカウントを作って、それを選んでください', client: '会社の Google 接続の設定に誤りがあります', failed: '接続できませんでした',
  };
  const connect = () => {
    setWorking(true);
    api.admin.connectInquiryMailbox().then((r) => { if (r.url) location.href = r.url; else { setError(null); onChanged(); } })
      .catch((e) => setError(describeError(e, '接続できませんでした'))).finally(() => setWorking(false));
  };
  const disconnect = () => {
    if (!window.confirm('窓口のアカウントを切断しますか。問い合わせのメールを読まなくなり、返事も送れなくなります（問い合わせは消えません）')) return;
    setWorking(true);
    api.admin.disconnectInquiryMailbox().then(() => { setError(null); onChanged(); })
      .catch((e) => setError(describeError(e, '切断できませんでした'))).finally(() => setWorking(false));
  };
  return (
    <div className="card service-connection">
      <div className="row wrap">
        {settings.mailbox
          ? <><span className="badge ok">接続中</span><strong>{settings.mailbox.email}</strong><button className="btn ghost small" disabled={working} onClick={disconnect}>切断</button></>
          : <><span className="muted">未接続</span><button className="btn small" disabled={working} onClick={connect}>{working ? '接続しています…' : '接続'}</button></>}
        {result && <span className={`inquiries-note is-${result === 'connected' ? 'ok' : 'error'}`}>{RESULT_TEXT[result] ?? '接続できませんでした'}</span>}
      </div>
      {error && <p className="error">{error}</p>}
    </div>
  );
}
