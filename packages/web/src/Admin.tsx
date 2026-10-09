/**
 * @file 管理者ページの枠と、参照の画面（利用状況・実行の一覧・監査ログ・接続）。
 *
 * @see 仕様書 第6.6節 管理者ページ
 */

import { Fragment, useCallback, useEffect, useRef, useState } from 'react';
import { api, ApiError, describeError, type AdminRun, type AdminRunStatus, type AdminSchedule, type AiUsageView, type AuditFilter, type AuditRowView, type MachineView, type Me, type SupportGrant, type RunDetail } from './api.js';
import { RunView, statusLabel, SuspendedBanner } from './components.js';
import {
  AgentSettings, CompanySettings, KnowledgeSettings, UserSettings,
} from './AdminSettings.js';
import { Checklist, Dashboard } from './Dashboard.js';
import { ConnectorList } from './ConnectorList.js';
import { adminPath, parseAdminRoute, syncUrl } from './route.js';
import { ExtensionSettings } from './Extensions.js';
import { Connections } from './Connections.js';
import { HelpCenter, PageTitle, useOpenHelp } from './help.js';
import { AppVersionBadge } from './launcher.js';
import { Icon, NavHeading, NavItem, SideNavLayout, ThemeToggle, type IconName } from './nav.js';

type Tab =
  | 'dashboard' | 'usage' | 'runs' | 'schedules' | 'company' | 'agents' | 'extensions' | 'users' | 'knowledge' | 'audit'
  | 'connectors' | 'setup' | 'help' | 'helpReview' | 'machine' | 'support';

/**
 * 管理者ページの左ペインの項目。説明はマウスを重ねたときに出す（仕様書 第6.1.1節）。
 *
 * @remarks
 * 並びは仕様書 第6.6節の順（会社情報 → 接続 → ユーザーと権限 → 業務と承認 → 知識 →
 * 費用と契約 → 記録と監視）にそろえる。設定を上から順に済ませれば使い始められるようにするため。
 * ダッシュボードは最初の画面として先頭に置く（第6.6.8節）。
 * 「はじめに行う設定」は一度きりの作業なので、**設定のいちばん下**に置く（第6.10.3.1節）。
 * すべて済むと項目ごと消す。
 *
 * **保存を持つ区分は、小分けに割る**（第6.6.0節）。1 つの画面に保存を 1 つだけ置くため。
 */
const TABS: {
  id: Tab; label: string; icon: IconName; description: string; group: string;
  /** 小分け（第6.6.0.1節）。**1 つが 1 画面**で、保存は多くても 1 つ。 */
  pages?: { id: string; label: string }[];
}[] = [
  { id: 'dashboard', label: 'ダッシュボード', icon: 'dashboard', description: 'いまの状況と集計', group: '' },
  {
    id: 'company', label: '会社情報', icon: 'company', description: '会社の情報、文面の書き方、帳票の体裁', group: '設定',
    pages: [
      { id: 'basic', label: '基本情報' },
      { id: 'writing', label: '自社の書き方' },
      { id: 'invoice', label: '帳票の体裁' },
      { id: 'slides', label: 'スライドの見本' },
      { id: 'dashboard', label: 'ダッシュボードの見せ方' },
    ],
  },
  {
    id: 'connectors', label: '接続', icon: 'connectors', description: 'Gemini・Google Workspace・コネクタ（MCP）への接続', group: '設定',
    pages: [
      { id: 'gemini', label: 'Gemini' },
      { id: 'google', label: 'Google Workspace' },
      { id: 'retention', label: 'データを残す日数' },
      { id: 'permissions', label: '求める許可' },
      { id: 'people', label: '従業員の接続状況' },
      { id: 'mcp', label: 'コネクタ（MCP）' },
    ],
  },
  {
    id: 'users', label: 'ユーザーと権限', icon: 'users', description: '招待・ロール・グループ・権限区画', group: '設定',
    pages: [
      { id: 'list', label: 'ユーザー' },
      { id: 'invite', label: '招待する' },
      { id: 'groups', label: 'グループ' },
      { id: 'compartments', label: '権限区画' },
    ],
  },
  {
    id: 'agents', label: '業務と承認', icon: 'sliders', description: '使う業務、承認の決まり、利用できる人', group: '設定',
    pages: [
      { id: 'enabled', label: '使う業務' },
      { id: 'automation', label: '社内への書き込み' },
      { id: 'scope', label: '利用できる人' },
      { id: 'effect', label: '効果の推計' },
    ],
  },
  { id: 'extensions', label: '拡張機能', icon: 'extensions', description: '業務と、外部とのつながり（コネクタ）を追加する', group: '設定' },
  {
    id: 'knowledge', label: '知識', icon: 'knowledge', description: '社内規程・議事録と、秘書が学んだこと', group: '設定',
    pages: [
      { id: 'rules', label: '社内規程' },
      { id: 'minutes', label: '議事録' },
      { id: 'learned', label: '秘書が学んだこと' },
    ],
  },
  { id: 'setup', label: 'はじめに行う設定', icon: 'help', description: '導入の流れと、残っている設定', group: '設定' },
  { id: 'machine', label: '機械', icon: 'usage', description: '社内に置いた機械の様子と控え（ローカルの形だけ）', group: '記録' },
  { id: 'usage', label: '利用状況', icon: 'usage', description: '業務ごとの実行の件数と費用', group: '記録' },
  { id: 'runs', label: '実行の一覧', icon: 'runs', description: '全員の実行の状態と費用（中身は見られません）', group: '記録' },
  { id: 'schedules', label: '定時実行の一覧', icon: 'schedules', description: '全員の定時実行と、動かないものの理由（見るだけ）', group: '記録' },
  { id: 'audit', label: '監査ログ', icon: 'audit', description: '誰が何をしたかの記録', group: '記録' },
  { id: 'support', label: 'サポートの閲覧', icon: 'users', description: '運営のサポートが会社の画面を見ることを許す・断る・切る', group: '記録' },
  { id: 'helpReview', label: 'ヘルプの見直し', icon: 'help', description: '秘書が答えられなかった使い方の質問と、記事が役に立ったか', group: '記録' },
  { id: 'help', label: 'ヘルプ', icon: 'help', description: '管理者向けの記事と検索', group: '' },
];

/** その区分の最初の小分け。小分けを持たない区分は空文字。 */
function firstPage(tab: Tab): string {
  return TABS.find((t) => t.id === tab)?.pages?.[0]?.id ?? '';
}

/**
 * 管理者ページの URL（`/admin/{区分}/{小分け}`。仕様書 第6.1.6節）から、開く画面を決める。
 *
 * @remarks
 * 知らない区分は最初の画面（ダッシュボード）、知らない小分けはその区分の最初の小分けにする。
 * ヘルプの区分では、小分けの位置に記事の ID を置く（`/admin/help/{記事}`）
 */
function adminFromUrl(): { tab: Tab; page: string; article: string | null } {
  const r = parseAdminRoute(location.pathname) ?? { tab: null, page: null };
  const t = TABS.find((x) => x.id === r.tab);
  if (!t) return { tab: 'dashboard', page: '', article: null };
  if (t.id === 'help') return { tab: 'help', page: '', article: r.page };
  const ok = (t.pages ?? []).some((p) => p.id === r.page);
  return { tab: t.id, page: ok ? r.page! : firstPage(t.id), article: null };
}

/** 管理者ページの画面の URL。ダッシュボードは `/admin`。 */
function adminUrl(tab: Tab, page: string, article: string | null): string {
  if (tab === 'dashboard') return '/admin';
  return adminPath(tab, tab === 'help' ? (article ?? '') : page);
}

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
  // 開いたときの URL から区分と小分けを決める（仕様書 第6.1.6節）
  const initial = useRef(adminFromUrl());
  const [tab, setTabState] = useState<Tab>(initial.current.tab);
  /** いま開いている小分け（第6.6.0節）。小分けを持たない区分では空文字。 */
  const [page, setPage] = useState(initial.current.page);
  /** 区分を開く。小分けがあれば最初のものへ入る。 */
  const setTab = useCallback((id: Tab) => { setTabState(id); setPage(firstPage(id)); setExtFocus(null); }, []);
  /** 拡張機能の画面で、詳細を開いておく拡張機能（「接続 › コネクタ」から移ったとき）。 */
  const [extFocus, setExtFocus] = useState<string | null>(null);
  const [helpArticle, setHelpArticle] = useState<string | null>(initial.current.article);
  // 次に URL を合わせるとき、履歴に積まずに置き換える（最初に開いたとき・戻る・進むのあと）
  const replaceNext = useRef(true);
  useEffect(() => {
    syncUrl(adminUrl(tab, page, helpArticle), replaceNext.current);
    replaceNext.current = false;
  }, [tab, page, helpArticle]);
  // ブラウザの「戻る」「進む」（仕様書 第6.1.6節）
  useEffect(() => {
    const onPop = () => {
      const r = adminFromUrl();
      replaceNext.current = true;
      setTabState(r.tab);
      setPage(r.page);
      setHelpArticle(r.article);
    };
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);
  /*
    はじめに行う設定の進み具合（仕様書 第6.10.3.1節）。
    **左ペインに出すのが要である。** 画面から追い出しただけでは、途中であることに気づけなくなる。
    すべて済んだら null にし、項目ごと出さない。
  */
  const [setup, setSetup] = useState<{ done: number; total: number } | null>(null);
  useEffect(() => {
    api.onboarding.checklist()
      .then((r) => setSetup(r.done ? null : { done: r.items.filter((i) => i.done).length, total: r.items.length }))
      .catch(() => setSetup(null));
  }, [tab]);
  /* ヘルプを開く直前の画面（仕様書 第6.10.7.2節）。調べ終えたら、ここへ戻せる */
  const before = useRef<{ tab: Tab; page: string } | null>(null);
  useOpenHelp(useCallback((id: string | null) => {
    setHelpArticle(id);
    setTabState((t) => {
      if (t !== 'help') before.current = { tab: t, page: pageRef.current };
      return 'help';
    });
  }, []));
  // 小分けは状態としても持つが、合図の中から読むために控えておく
  const pageRef = useRef(page);
  useEffect(() => { pageRef.current = page; }, [page]);
  // ブラウザのタブの名前は、会社の略称とプロダクトの名前（仕様書 第6.6.1節）
  useEffect(() => { document.title = `${me.tenant.shortName || me.tenant.name} | M2Office 管理`; }, [me.tenant.shortName, me.tenant.name]);
  const isAdmin = me.user.roles.includes('admin');
  // 左のメニュー。上の段は設定まで、下の段は記録から（ワークスペースと同じく上下に分け、それぞれスクロールする。仕様書 第6.1節）
  // すべて済んだ会社では「はじめに行う設定」を出さない（仕様書 第6.10.3.1節）
  const navTabs = TABS.filter((t) => (t.id !== 'setup' || setup) && (t.id !== 'machine' || me.deployment === 'onsite') && (t.id !== 'support' || !me.proxy));
  const recordsAt = Math.max(0, navTabs.findIndex((t) => t.group === '記録'));
  const navList = (list: typeof navTabs) => (
    <>
      {list.map((t, i) => (
        <Fragment key={t.id}>
          {/* まとまりの変わり目に見出しを出す（仕様書 第6.6節の並び） */}
          {t.group && t.group !== list[i - 1]?.group && <NavHeading>{t.group}</NavHeading>}
          <NavItem icon={t.icon} label={t.label} description={t.description}
            hint={t.id === 'setup' && setup ? `${setup.done} / ${setup.total}` : ''}
            expanded={t.pages ? tab === t.id : undefined}
            active={tab === t.id} onClick={() => setTab(t.id)} />
          {/* 開いている区分の小分けだけを出す。1 つが 1 画面（第6.6.0節） */}
          {t.pages && tab === t.id && t.pages.map((x) => (
            <NavItem
              key={x.id} className="item nav-sub" icon={t.icon} label={x.label}
              active={page === x.id} onClick={() => setPage(x.id)}
            />
          ))}
        </Fragment>
      ))}
    </>
  );

  return (
    <div className="app">
      <header className="topbar">
        {me.tenant.logo
          ? <><img className="brand-logo" src={me.tenant.logo} alt={me.tenant.shortName ?? me.tenant.name} /><span className="brand">管理</span></>
          : <span className="brand">M2Office 管理</span>}
        <AppVersionBadge serverVersion={me.serverVersion} />
        <span className="tenant">{me.tenant.name}</span>
        <span className="spacer" />
        <a className="link" href={`/${location.search}`}>ワークスペースへ戻る</a>
        <ThemeToggle />
        <span className="badge">{me.user.displayName}</span>
        <button className="btn ghost small" onClick={onLogout}>ログアウト</button>
      </header>
      <SuspendedBanner status={me.tenant.status} suspendAt={me.tenant.suspendAt} />
      {/* 運営のサポートの代理アクセス（見るだけ。仕様書 第23.6.1節） */}
      {me.proxy && (
        <div className="suspended-banner" role="status">
          <strong>{me.user.displayName}が閲覧しています（見るだけ・{new Date(me.proxy.expiresAt).toLocaleString('ja-JP', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })} まで）</strong>
          {' '}<button className="link-btn" onClick={onLogout}>閲覧を終える</button>
        </div>
      )}
      {!isAdmin ? (
        <main className="canvas"><p className="error">管理者ページは管理者のみが開けます。</p></main>
      ) : (
        // 管理者ページには秘書との会話の列が無い。右端の列を取らない
        <SideNavLayout extraClass="no-talk" splitKey="m2o.admin-nav-bottom-px" nav={navList(navTabs.slice(0, recordsAt))} navBottom={navList(navTabs.slice(recordsAt))}>
          <main className="canvas">
            {tab === 'dashboard' && <Dashboard />}
            {tab === 'setup' && (
              <>
                <PageTitle trail={['はじめに行う設定']} help={{
                  article: 'admin-setup',
                  text: 'M2Office を使い始めるまでに済ませる設定の一覧です。済んだものには印が付き、すべて済むとメニューから消えます。',
                }} />
                <Checklist onGo={(t) => setTab(t as Tab)} />
              </>
            )}
            {tab === 'help' && (
              <HelpCenter
                initial={helpArticle}
                // 管理者ページのヘルプは管理者向けの記事だけ（仕様書 第6.10.7節）
                scope="admin"
                // 記事を開いたら URL も合わせる（/admin/help/{記事}。仕様書 第6.1.6節）
                onArticle={setHelpArticle}
                back={before.current ? {
                  label: TABS.find((t) => t.id === before.current!.tab)?.label ?? '前の画面',
                  go: () => { setTabState(before.current!.tab); setPage(before.current!.page); },
                } : undefined}
              />
            )}
            {tab === 'usage' && <Usage />}
            {tab === 'machine' && <Machine />}
            {tab === 'runs' && <Runs viewer={me.proxy?.scope === 'runs' ? me.user.id : null} />}
            {tab === 'support' && !me.proxy && <SupportAccess />}
            {tab === 'schedules' && <TenantSchedules />}
            {tab === 'company' && <CompanySettings page={page} />}
            {tab === 'agents' && <AgentSettings page={page} />}
            {tab === 'extensions' && <ExtensionSettings focus={extFocus} />}
            {tab === 'users' && <UserSettings meId={me.user.id} page={page} />}
            {tab === 'knowledge' && <KnowledgeSettings page={page} />}
            {tab === 'audit' && <Audit />}
            {tab === 'helpReview' && <HelpReview />}
            {tab === 'connectors' && (page === 'mcp'
              // 会社の接続の管理（仕様書 第6.6.3.0節、ADR-0037）
              ? <ConnectorList />
              : <Connections page={page} />)}
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
      <PageTitle trail={['利用状況']} help={{
        article: 'admin-usage',
        text: '今月の AI の利用と上限、業務ごとのこれまでの実行件数と推論の費用です。費用は概算で、請求額ではありません。',
      }} />
      <AiUsage />
      {error && <p className="error">{error}</p>}
      {data && (
        <>
          <h3>業務ごと（これまで）</h3>
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
          <p className="muted small">概算です（請求額ではありません）</p>
        </>
      )}
    </>
  );
}

/** 円の表し方。 */
const yen = (v: number) => `${Math.round(v).toLocaleString('ja-JP')} 円`;

/**
 * 今月の AI の利用と上限（仕様書 第6.6.2節、ADR-0079）。会社の月の上限と 1 人の割合を決め、用途ごと・人ごとの内訳を見る。
 */
function AiUsage() {
  const [data, setData] = useState<AiUsageView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(null);
  const [limit, setLimit] = useState('');
  const [share, setShare] = useState(4);
  const load = useCallback(() => {
    api.admin.aiUsage().then((d) => {
      setData(d);
      setLimit(d.settings.monthlyJpy === null ? '' : String(d.settings.monthlyJpy));
      setShare(Math.round(d.settings.perUserShare * 10));
    }).catch((e) => setError(describeError(e, '読み込めませんでした')));
  }, []);
  useEffect(load, [load]);
  const save = () => {
    setError(null);
    setSaved(null);
    api.admin.saveSettings('aiLimits', { monthlyJpy: limit.trim() === '' ? null : Number(limit), perUserShare: share / 10 })
      .then(() => { setSaved('保存しました'); load(); })
      .catch((e) => setError(describeError(e, '保存できませんでした')));
  };
  if (!data) return error ? <p className="error">{error}</p> : null;
  const ratio = data.monthlyJpy ? Math.min(1, data.usedJpy / data.monthlyJpy) : 0;
  return (
    <div className="card">
      <h3>今月の AI の利用（{Number(data.month.slice(5))} 月）</h3>
      <div className="stats">
        <div className="stat"><span>使った額</span><strong>{yen(data.usedJpy)}</strong></div>
        <div className="stat"><span>会社の上限</span><strong>{data.monthlyJpy === null ? '上限なし' : yen(data.monthlyJpy)}</strong></div>
        <div className="stat"><span>1 人の上限</span><strong>{data.userLimitJpy === null ? '—' : yen(data.userLimitJpy)}</strong></div>
      </div>
      {data.monthlyJpy !== null && (
        <div className={`meter${ratio >= 1 ? ' over' : ratio >= 0.8 ? ' warn' : ''}`} role="progressbar" aria-valuenow={Math.round(ratio * 100)} aria-valuemin={0} aria-valuemax={100}>
          <span style={{ width: `${ratio * 100}%` }} />
        </div>
      )}
      {data.monthlyJpy !== null && data.usedJpy >= data.monthlyJpy && <p className="warn-msg small">上限に達したため、新しい業務と AI を使う秘書への依頼を止めています</p>}
      <div className="row">
        <label className="field">月の上限（円）
          <input inputMode="numeric" value={limit} placeholder={data.platformCap !== null ? `${data.platformCap.toLocaleString('ja-JP')} まで` : '上限なし'}
            onChange={(e) => setLimit(e.target.value.replace(/[^0-9]/g, ''))} />
        </label>
        <label className="field">1 人の上限
          <select value={share} onChange={(e) => setShare(Number(e.target.value))}>
            {[1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map((n) => <option key={n} value={n}>会社の上限の {n} 割</option>)}
          </select>
        </label>
        <button className="btn" onClick={save}>保存</button>
      </div>
      {saved && <p className="ok-msg small">{saved}</p>}
      {error && <p className="error">{error}</p>}
      {data.byPurpose.length > 0 && (
        <div className="grid2">
          <table className="table">
            <thead><tr><th>用途</th><th className="num">回数</th><th className="num">額</th></tr></thead>
            <tbody>{data.byPurpose.map((p) => <tr key={p.purpose}><td>{p.label}</td><td className="num">{p.calls}</td><td className="num">{yen(p.costJpy)}</td></tr>)}</tbody>
          </table>
          <table className="table">
            <thead><tr><th>人</th><th className="num">回数</th><th className="num">額</th></tr></thead>
            <tbody>{data.byUser.map((u) => (
              <tr key={u.userId ?? 'system'}>
                <td>{u.name} {u.over && <span className="badge warn">上限</span>}</td><td className="num">{u.calls}</td><td className="num">{yen(u.costJpy)}</td>
              </tr>
            ))}</tbody>
          </table>
        </div>
      )}
    </div>
  );
}

/** バイトを GB・MB で表す。 */
const bytesText = (b: number) => (b >= 1e9 ? `${(b / 1e9).toFixed(1)} GB` : `${Math.round(b / 1e6)} MB`);
/** 日時を「10/7 2:03」の形で表す。 */
const whenText = (iso: string) => { const d = new Date(iso); return `${d.getMonth() + 1}/${d.getDate()} ${d.getHours()}:${String(d.getMinutes()).padStart(2, '0')}`; };

/**
 * ローカルの形の「機械」（仕様書 第8.6.7節）。版・各部の動き・ディスク・証明書・ローカル AI・控え。今すぐ控えを取れる。
 */
function Machine() {
  const [data, setData] = useState<MachineView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const load = useCallback(() => { api.admin.machine().then(setData).catch((e) => setError(describeError(e, '読み込めませんでした'))); }, []);
  useEffect(() => { load(); const t = window.setInterval(load, 30_000); return () => clearInterval(t); }, [load]);
  const backup = () => {
    setNote(null);
    api.admin.machineBackup().then(() => setNote('控えを取り始めました。1 分ほどで結果が出ます')).catch((e) => setError(describeError(e, '頼めませんでした')));
  };
  const state = (ok: boolean, okText: string, ngText: string) => <span className={`badge ${ok ? 'ok' : 'warn'}`}>{ok ? okText : ngText}</span>;
  const space = (d: { free: number; total: number } | null) => (d ? `空き ${bytesText(d.free)} / ${bytesText(d.total)}` : '分かりません');
  const st = data?.backup.status;
  const off = data?.backup.offsite.status;
  return (
    <>
      <PageTitle trail={['機械']} help={{ article: 'admin-machine', text: '社内に置いた機械の様子と控えです。業務の中身は出ません。' }} />
      {error && <p className="error">{error}</p>}
      {data && (
        <>
          <div className="card">
            <h3>各部の動き</h3>
            <dl className="kv">
              <dt>版</dt><dd>{data.version}</dd>
              <dt>データベース</dt><dd>{state(data.database.ok, '動いています', '止まっています')} {data.database.ms !== null && <span className="small muted">{data.database.ms} ms</span>} {data.database.error && <span className="small muted">{data.database.error}</span>}</dd>
              <dt>ワーカー</dt><dd>{state(data.worker.ok, '動いています', '止まっています')} {data.worker.lastSeen && <span className="small muted">最後の知らせ {whenText(data.worker.lastSeen)}</span>}</dd>
              <dt>入口と証明書</dt><dd>{data.entrance.host ? <>{data.entrance.host} {data.entrance.certExpires
                ? state((data.entrance.certDaysLeft ?? 0) > 14, `期限 ${whenText(data.entrance.certExpires)}（あと ${data.entrance.certDaysLeft} 日）`, `期限 ${whenText(data.entrance.certExpires)}（あと ${data.entrance.certDaysLeft} 日）`)
                : <span className="badge warn">確かめられません</span>} {data.entrance.error && <span className="small muted">{data.entrance.error}</span>}</> : <span className="muted">—</span>}</dd>
              <dt>ローカル AI</dt><dd>{data.localAi.configured ? <>{state(data.localAi.ok, '動いています', '答えません')} <span className="small muted">{data.localAi.models.join('、') || data.localAi.error}</span></> : <span className="muted">設定していません</span>}</dd>
              <dt>データのディスク</dt><dd>{space(data.disk.data)}</dd>
            </dl>
          </div>
          <div className="card">
            <h3>控え</h3>
            {!data.backup.configured ? <p className="muted">控えの置き場が設定されていません</p> : (
              <>
                <dl className="kv">
                  <dt>最後の控え</dt><dd>{st?.last ? <>{state(st.last.ok, whenText(st.last.at), `${whenText(st.last.at)} 失敗`)} {st.last.ok ? <span className="small muted">データベース {bytesText(st.last.dbBytes)}</span> : <span className="small muted">{st.last.error}</span>}</> : <span className="muted">まだありません</span>}</dd>
                  <dt>戻せるかの確かめ</dt><dd>{st?.restoreTest ? <>{state(st.restoreTest.ok, `${whenText(st.restoreTest.at)} 戻せました`, `${whenText(st.restoreTest.at)} 戻せませんでした`)} {st.restoreTest.error && <span className="small muted">{st.restoreTest.error}</span>}</> : <span className="muted">まだありません</span>}</dd>
                  <dt>控えのディスク</dt><dd>{space(data.disk.backup)}</dd>
                  <dt>社外の控え</dt><dd>{!data.backup.offsite.configured ? <span className="muted">設定していません</span> : off?.last
                    ? <>{state(off.last.ok, `${whenText(off.last.at)} 送りました`, `${whenText(off.last.at)} 送れませんでした`)} {off.last.ok ? <span className="small muted">新しく送った量 {bytesText(off.last.bytesAdded)}</span> : <span className="small muted">{off.last.error}</span>}</>
                    : <span className="muted">まだありません</span>}</dd>
                  {data.backup.offsite.configured && <><dt>社外の控えの確かめ</dt><dd>{off?.check ? <>{state(off.check.ok, `${whenText(off.check.at)} 壊れていません`, `${whenText(off.check.at)} 確かめに失敗`)} {off.check.error && <span className="small muted">{off.check.error}</span>}</> : <span className="muted">まだありません</span>}</dd></>}
                </dl>
                <button className="btn small" onClick={backup}>今すぐ控えを取る</button>
                {note && <p className="ok-msg small">{note}</p>}
              </>
            )}
          </div>
          <MachineUpdate data={data.update} onChanged={load} onError={setError} />
          <MachineMaintenance data={data.maintenance} heartbeat={data.heartbeat} onChanged={load} onError={setError} />
        </>
      )}
    </>
  );
}

/** 更新の結果の呼び名。 */
const UPDATE_RESULT: Record<string, string> = { updated: '入れました', 'rolled-back': '入れられず、前の版に戻しました', failed: '入れられませんでした', none: '新しい版はありませんでした' };

/**
 * 「機械」の更新（仕様書 第8.6.4節）。直近の結果と、夜の自動の更新を止める・延ばす。
 *
 * @remarks 更新そのものは機械の上で動く（導入した技術者が設定する）。ここからは止める・延ばすことだけができる
 */
function MachineUpdate({ data, onChanged, onError }: { data: MachineView['update']; onChanged: () => void; onError: (m: string) => void }) {
  const hold = (days: number | null) => void api.admin.machineUpdateHold(days).then(onChanged).catch((e) => onError(describeError(e, '変えられませんでした')));
  const s = data.settings;
  return (
    <div className="card">
      <h3>更新</h3>
      <dl className="kv">
        <dt>自動の更新</dt><dd>{!s ? <span className="muted">設定されていません</span> : s.auto ? `毎晩 ${s.hour} 時ごろ` : <span className="muted">切っています{s.signed ? '' : '（署名の鍵が入っていません）'}</span>}</dd>
        <dt>直近の更新</dt><dd>{data.last ? <>
          <span className={`badge ${data.last.result === 'updated' || data.last.result === 'none' ? 'ok' : 'warn'}`}>{whenText(data.last.at)} {UPDATE_RESULT[data.last.result] ?? data.last.result}</span>
          {' '}<span className="small muted">{data.last.result === 'none' ? data.last.from : `${data.last.from} → ${data.last.to}`}{data.last.error ? `（${data.last.error}）` : ''}</span>
        </> : <span className="muted">まだありません</span>}</dd>
        {data.heldUntil && <><dt>止めている</dt><dd>{whenText(data.heldUntil)} まで</dd></>}
      </dl>
      {s?.auto && (data.heldUntil
        ? <button className="btn ghost small" onClick={() => hold(null)}>止めるのをやめる</button>
        : <button className="btn ghost small" onClick={() => hold(7)}>7 日延ばす</button>)}
    </div>
  );
}

/**
 * 「機械」の遠隔の保守と、運営への稼働の知らせ（仕様書 第8.6.4節・第8.6.8節）。
 *
 * @remarks 遠隔の保守は、ふだん閉じておき、会社の管理者が時間を限って開ける（運営は自分で開けられない）。開けた回と、つないだ相手を出す。
 * 同じ機械の M2Medical が持つときは、開けるボタンを出さず、どちらが開けるかだけを出す（第8.6.9節）
 */
function MachineMaintenance({ data, heartbeat, onChanged, onError }: {
  data: MachineView['maintenance']; heartbeat: MachineView['heartbeat']; onChanged: () => void; onError: (m: string) => void;
}) {
  const [hours, setHours] = useState(4);
  const run = (p: Promise<unknown>) => void p.then(onChanged).catch((e) => onError(describeError(e, '変えられませんでした')));
  const managed = data.managedBy ?? null;
  if (!data.configured && !heartbeat.configured && !managed) return null;
  return (
    <div className="card">
      <h3>遠隔の保守と稼働の知らせ</h3>
      <dl className="kv">
        {managed && <><dt>遠隔の保守</dt><dd className="muted">{managed} の管理者が開けます</dd></>}
        {data.configured && (
          <>
            <dt>遠隔の保守</dt>
            <dd>{data.until ? <span className="badge warn">{whenText(data.until)} まで開けています{data.open ? '' : '（開けている途中）'}</span> : <span className="muted">閉じています</span>}</dd>
            {data.sessions.length > 0 && <><dt>これまで</dt><dd><ul className="plain small">{data.sessions.slice(0, 5).map((s) => (
              <li key={s.openedAt}>{whenText(s.openedAt)}〜{s.closedAt ? whenText(s.closedAt) : ''} {s.peers.length ? `つないだ相手: ${s.peers.join('、')}` : 'つないだ相手なし'}</li>
            ))}</ul></dd></>}
          </>
        )}
        {heartbeat.configured && (
          <>
            <dt>運営への稼働の知らせ</dt>
            <dd>{heartbeat.off ? <span className="muted">切っています</span> : <>送っています {heartbeat.lastAt && <span className="small muted">最後 {whenText(heartbeat.lastAt)} {heartbeat.lastOk ? '' : `届きませんでした${heartbeat.lastError ? `（${heartbeat.lastError}）` : ''}`}</span>}</>}</dd>
          </>
        )}
      </dl>
      <div className="row wrap">
        {data.configured && (data.until
          ? <button className="btn ghost small" onClick={() => run(api.admin.machineMaintenance(null))}>閉じる</button>
          : <>
            <select value={hours} onChange={(e) => setHours(Number(e.target.value))} aria-label="開けておく時間">
              {[1, 2, 4, 8, 24].map((h) => <option key={h} value={h}>{h} 時間</option>)}
            </select>
            <button className="btn small" onClick={() => run(api.admin.machineMaintenance(hours))}>遠隔の保守を開ける</button>
          </>)}
        {heartbeat.configured && <button className="btn ghost small" onClick={() => run(api.admin.machineHeartbeat(heartbeat.off))}>{heartbeat.off ? '稼働の知らせを送る' : '稼働の知らせを切る'}</button>}
      </div>
    </div>
  );
}

/**
 * @param viewer 代理アクセスで業務の結果まで許されたとき、許した管理者の ID（その人が依頼した実行だけ中身を開ける。第23.6.1節）
 */
function Runs({ viewer }: { viewer: string | null }) {
  const { data, error } = useLoad(api.admin.runs);
  const { data: users } = useLoad(api.admin.users);
  const nameOf = (id: string | null) => users?.items.find((u) => u.id === id)?.displayName ?? id ?? '—';
  return (
    <>
      <PageTitle trail={['実行の一覧']} help={{
        article: 'admin-runs',
        text: '直近 100 件の業務の状態です。行を押すと、段の進みと失敗の理由が出ます。入力や成果物の中身は出ません。',
      }} />
      {error && <p className="error">{error}</p>}
      {data?.items.map((r: AdminRun) => (
        <RunRow key={r.id} run={r} requester={nameOf(r.requestedBy)} contentFor={viewer && r.requestedBy === viewer ? viewer : null} />
      ))}
    </>
  );
}

/** 定時実行の状態の出し方。 */
const SCHEDULE_STATE: Record<AdminSchedule['state'], { label: string; className: string }> = {
  active: { label: '動く', className: 'succeeded' },
  paused: { label: '止めている', className: '' },
  blocked: { label: '動かない', className: 'failed' },
};

/**
 * 定時実行の一覧（仕様書 第6.6.8.2節）。会社の全員の定時実行を、人・業務・繰り返し・次回・前回・状態で並べる。
 *
 * @remarks
 * **見るだけで操作しない**（本人の権限で動くものを他人が変えない。第6.1.7節）。業務の入力は API も返さない（不変則 I-10）。
 * 次の回に動かないものは、起動役と同じ判定の理由を状態の下に出す
 */
/**
 * ヘルプの見直し（仕様書 第6.10.10節）。秘書がヘルプに見当たらなかった使い方の質問（同じものをまとめた件数。質問した人は出さない）と、
 * 記事ごとの役に立った・立たなかったの件数。
 */
function HelpReview() {
  // 補足を書いた・外したら読み直す
  const [key, setKey] = useState(0);
  const [data, setData] = useState<Awaited<ReturnType<typeof api.help.feedback>> | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    api.help.feedback().then((d) => { setData(d); setError(null); }).catch((e) => setError(describeError(e, '取得できませんでした')));
  }, [key]);
  const [open, setOpen] = useState<string | null>(null);
  return (
    <>
      <PageTitle trail={['ヘルプの見直し']} help={{
        article: 'admin-help-review',
        text: '秘書がヘルプで答えられなかった使い方の質問と、記事が役に立ったかの件数です。誰が聞いたか・押したかは出しません。',
      }} />
      {error && <p className="error">{error}</p>}
      {data && (
        <>
          <h2>答えられなかった質問（直近 {data.missDays} 日）</h2>
          {data.misses.length === 0
            ? <p className="muted">ありません</p>
            : (
              <table className="table">
                <thead><tr><th>質問</th><th>件数</th><th>最後</th><th /></tr></thead>
                <tbody>{data.misses.map((m) => (
                  <Fragment key={`${m.question}-${m.lastAt}`}>
                    <tr>
                      <td>{m.question}</td><td>{m.count}</td><td>{time(m.lastAt)}</td>
                      <td className="nowrap">
                        <button className="link small" onClick={() => setOpen(open === m.question ? null : m.question)}>補足の案</button>{' '}
                        <button className="link small" onClick={() => void api.help.dismissMiss(m.question).then(() => setKey((k) => k + 1))}>外す</button>
                      </td>
                    </tr>
                    {open === m.question && (
                      <tr><td colSpan={4}><NoteSuggestion question={m.question} onDone={() => { setOpen(null); setKey((k) => k + 1); }} onCancel={() => setOpen(null)} /></td></tr>
                    )}
                  </Fragment>
                ))}</tbody>
              </table>
            )}
          <h2>記事が役に立ったか</h2>
          {data.ratings.length === 0
            ? <p className="muted">まだありません</p>
            : (
              <table className="table">
                <thead><tr><th>記事</th><th>役に立った</th><th>役に立たなかった</th></tr></thead>
                <tbody>{data.ratings.map((r) => <tr key={r.articleId}><td>{r.title}</td><td>{r.helpful}</td><td>{r.notHelpful}</td></tr>)}</tbody>
              </table>
            )}
        </>
      )}
    </>
  );
}

/**
 * 答えられなかった質問から、会社の補足の案を出して書く（第6.10.10節）。AI が記事を選び文の案を書き、管理者が直して「この記事に書く」を押す。
 * 書いたら、その質問を「ヘルプの見直し」から外す。会社のやり方は推測で作らず、空けた所（「（当社のやり方を書いてください）」）を管理者が埋める。
 */
function NoteSuggestion({ question, onDone, onCancel }: { question: string; onDone: () => void; onCancel: () => void }) {
  const [articles, setArticles] = useState<{ id: string; title: string }[]>([]);
  const [articleId, setArticleId] = useState('');
  const [text, setText] = useState('');
  const [reason, setReason] = useState<string | null>(null);
  // 案を出せなかったときの知らせ（推論が使えない会社などで起きる。誤りではないので、問い合わせ番号は出さない）
  const [notice, setNotice] = useState<string | null>(null);
  const [state, setState] = useState<'loading' | 'ready'>('loading');
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    api.help.list('workspace').then((r) => setArticles(r.items.filter((a) => a.category !== 'updates').map((a) => ({ id: a.id, title: a.title })))).catch(() => undefined);
    api.help.suggestNote(question)
      .then((s) => { setArticleId(s.articleId ?? ''); setText(s.existing ? `${s.existing}\n${s.note}` : s.note); setReason(s.reason); })
      .catch((e) => (e instanceof ApiError && e.status === 422
        ? setNotice('補足の案を出せませんでした。記事を選んで、ご自身で書いてください')
        : setError(describeError(e, '補足の案を出せませんでした'))))
      .finally(() => setState('ready'));
  }, [question]);
  const save = () => api.help.saveNote(articleId, text)
    .then(() => api.help.dismissMiss(question))
    .then(onDone)
    .catch((e) => setError(describeError(e, '書けませんでした')));
  if (state === 'loading') return <p className="muted small">補足の案を考えています…</p>;
  return (
    <div className="note-suggestion">
      {reason && <p className="small muted">{reason}</p>}
      {notice && <p className="small muted">{notice}</p>}
      <select value={articleId} aria-label="補足を書く記事" onChange={(e) => setArticleId(e.target.value)}>
        <option value="">記事を選ぶ</option>
        {articles.map((a) => <option key={a.id} value={a.id}>{a.title}</option>)}
      </select>
      <textarea value={text} maxLength={1000} rows={4} aria-label="補足の文" onChange={(e) => setText(e.target.value)} />
      <div className="row">
        <button className="btn small" disabled={!articleId || !text.trim() || text.includes('（当社のやり方を書いてください）')} onClick={() => void save()}
          title={text.includes('（当社のやり方を書いてください）') ? '「（当社のやり方を書いてください）」を当社のやり方に書き換えてから書きます' : undefined}>この記事に書く</button>
        <button className="btn ghost small" onClick={onCancel}>キャンセル</button>
      </div>
      {error && <p className="error">{error}</p>}
    </div>
  );
}

function TenantSchedules() {
  const { data, error } = useLoad(api.admin.schedules);
  return (
    <>
      <PageTitle trail={['定時実行の一覧']} help={{
        article: 'admin-schedules',
        text: '会社の全員の定時実行です。見るだけで、変えるのは本人の画面です。動かないものは理由が出ます。',
      }} />
      {error && <p className="error">{error}</p>}
      {data && data.items.length === 0 && <p className="muted">定時実行はありません</p>}
      {data && data.items.length > 0 && (
        <table className="table schedule-table">
          <thead><tr><th>人</th><th>業務</th><th>繰り返し</th><th>次回</th><th>前回</th><th>状態</th></tr></thead>
          <tbody>
            {data.items.map((s) => (
              <tr key={s.id}>
                <td>{s.userName}</td><td>{s.agentName}</td><td>{s.label}</td>
                <td>{s.state === 'paused' ? '—' : time(s.nextRunAt)}</td><td>{time(s.lastRunAt)}</td>
                <td>
                  <span className={`status ${SCHEDULE_STATE[s.state].className}`}>{SCHEDULE_STATE[s.state].label}</span>
                  {s.blockedReason && <div className="small muted">{s.blockedReason}</div>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </>
  );
}

/**
 * 実行の一覧の 1 行（仕様書 第6.2.4節）。**その場で開く。**
 *
 * @remarks
 * 開いても出すのは**状態だけ**である（段の進み・失敗の理由・費用・削減時間）。
 * 業務の入力・段の入出力・成果物は返らない。管理者が見られるのは状態・費用・
 * 起動経路までである（第6.6.8節、不変則 I-10）。
 */
function RunRow({ run, requester, contentFor }: { run: AdminRun; requester: string; contentFor?: string | null }) {
  const [open, setOpen] = useState(false);
  // 代理アクセスの業務の結果（許した管理者が依頼した実行の中身。第23.6.1節）
  const [content, setContent] = useState<RunDetail | null>(null);
  const [detail, setDetail] = useState<AdminRunStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!open || detail) return;
    api.admin.runStatus(run.id).then(setDetail).catch((e) => setError(describeError(e, '読み込めませんでした')));
  }, [open, detail, run.id]);

  return (
    <div className={`card fold-row${open ? ' open' : ''}`}>
      <button className="fold-head" onClick={() => setOpen(!open)} aria-expanded={open}>
        <Icon name={open ? 'caret-down' : 'caret-right'} className="nav-caret" />
        <strong>{run.agentName}</strong>
        <span className={`status ${run.status}`}>{statusLabel(run.status)}</span>
        <span className="muted small">{requester}さん・{originLabel(run.origin)}</span>
        <span className="muted small tail">{time(run.startedAt)}</span>
      </button>
      {open && (
        <div className="fold-body">
          {error && <p className="error">{error}</p>}
          {!error && !detail && <p className="muted">読み込み中…</p>}
          {contentFor && !content && <button className="btn ghost small" onClick={() => void api.run(run.id).then(setContent).catch((e) => setError(describeError(e, '読み込めませんでした')))}>中身を見る</button>}
          {content && <RunView detail={content} viewerId="" onCancelled={() => undefined} />}
          {detail && (
            <>
              {detail.failureReason && <p className="error">{detail.failureReason}</p>}
              <ul className="steps">
                {detail.steps.map((st) => (
                  <li key={st.seq}>
                    <span className="seq">{st.seq + 1}</span>
                    <span className="name">
                      {st.label}
                      <span className="muted">（{st.kind === 'approval' ? '承認' : '処理'}）</span>
                    </span>
                    <span className={`status ${st.status}`}>{statusLabel(st.status)}</span>
                  </li>
                ))}
              </ul>
              <dl className="kv">
                <dt>終わり</dt><dd>{detail.endedAt ? time(detail.endedAt) : '—'}</dd>
                <dt>消費</dt><dd>{detail.tokensUsed} トークン（{detail.costJpy} 円）</dd>
                <dt>削減時間の推計</dt><dd>{detail.savedMinutes} 分</dd>
                <dt>実行 ID</dt><dd className="small">{detail.id}</dd>
              </dl>
            </>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * 監査ログ（仕様書 第6.6.8.1節）。誰が（人の名前）・何をしたか（業務の言葉）・何に対して（名前）を並べる。
 * 期間・人・操作の種類で絞り、行を押すとその場で詳細を開く。絞った結果を CSV で保存できる。
 */
function Audit() {
  const today = new Date(Date.now() + 9 * 3_600_000).toISOString().slice(0, 10);
  const weekAgo = new Date(Date.now() + 9 * 3_600_000 - 6 * 86_400_000).toISOString().slice(0, 10);
  const [filter, setFilter] = useState<AuditFilter>({ from: weekAgo, to: today });
  const [rows, setRows] = useState<AuditRowView[]>([]);
  const [choices, setChoices] = useState<{ people: { id: string; name: string }[]; categories: { id: string; label: string }[] }>({ people: [], categories: [] });
  const [hasMore, setHasMore] = useState(false);
  const [open, setOpen] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  /** 絞り込みで読み直す。`more` なら続きを足す。 */
  const load = useCallback(async (f: AuditFilter, more = false) => {
    setBusy(true);
    setError(null);
    try {
      const r = await api.admin.audit({ ...f, offset: more ? rows.length : 0 });
      setRows((x) => (more ? [...x, ...r.items] : r.items));
      setHasMore(r.hasMore);
      setChoices({ people: r.people, categories: r.categories });
    } catch (e) {
      setError(describeError(e, '読み込めませんでした'));
    } finally {
      setBusy(false);
    }
  }, [rows.length]);
  // 絞り込みを変えたら読み直す（続きの件数には依らない）
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { void load(filter); }, [filter]);

  const set = (k: keyof AuditFilter, v: string) => setFilter((f) => ({ ...f, [k]: v || undefined }));

  return (
    <>
      <PageTitle trail={['監査ログ']} help={{
        article: 'admin-audit',
        text: '「いつ・誰が・何をしたか」の記録です。変えることも消すこともできません。会話や成果物の中身は残しません。',
      }} />
      <div className="card audit-filter">
        <div className="field"><label>期間</label>
          <div className="row small">
            <input type="date" value={filter.from ?? ''} onChange={(e) => set('from', e.target.value)} />
            <span>〜</span>
            <input type="date" value={filter.to ?? ''} onChange={(e) => set('to', e.target.value)} />
          </div>
        </div>
        <div className="field"><label>人</label>
          <select value={filter.user ?? ''} onChange={(e) => set('user', e.target.value)}>
            <option value="">全員</option>
            {choices.people.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
        </div>
        <div className="field"><label>操作の種類</label>
          <select value={filter.category ?? ''} onChange={(e) => set('category', e.target.value)}>
            <option value="">すべて</option>
            {choices.categories.map((x) => <option key={x.id} value={x.id}>{x.label}</option>)}
          </select>
        </div>
        <button className="btn ghost small" disabled={rows.length === 0}
          onClick={() => void api.admin.downloadAudit(filter).catch((e) => setError(describeError(e, '出力できませんでした')))}>
          CSV で保存
        </button>
      </div>
      {error && <p className="error">{error}</p>}
      {!busy && rows.length === 0 && !error && <p className="muted">この条件の記録はありません</p>}
      {rows.length > 0 && (
        <table className="table audit-table">
          <thead><tr><th>日時</th><th>誰が</th><th>何をしたか</th><th>何に対して</th></tr></thead>
          <tbody>
            {rows.map((r) => (
              <Fragment key={r.id}>
                <tr className="clickable" onClick={() => setOpen(open === r.id ? null : r.id)} aria-expanded={open === r.id}>
                  <td>{time(r.occurredAt)}</td><td>{r.who}</td><td>{r.what}</td><td>{r.target}</td>
                </tr>
                {open === r.id && (
                  <tr className="audit-detail">
                    <td colSpan={4}>
                      <dl className="kv">
                        <dt>種類</dt><dd>{r.category}</dd>
                        {Object.entries(r.detail).map(([k, v]) => (
                          <Fragment key={k}><dt>{k}</dt><dd>{typeof v === 'string' ? v : JSON.stringify(v)}</dd></Fragment>
                        ))}
                        <dt>記録の名前</dt><dd><code>{r.action}</code></dd>
                        <dt>記録の主体</dt><dd><code>{r.actor}</code></dd>
                        <dt>記録の対象</dt><dd><code>{r.targetRaw}</code></dd>
                      </dl>
                    </td>
                  </tr>
                )}
              </Fragment>
            ))}
          </tbody>
        </table>
      )}
      {hasMore && (
        <button className="btn ghost small" disabled={busy} onClick={() => void load(filter, true)}>
          {busy ? '読み込んでいます…' : 'さらに読む'}
        </button>
      )}
    </>
  );
}

/** Google の権限の段階の表示（仕様書 第14.3.1節）。 */
function originLabel(origin: string | null): string {
  return ({ menu: 'メニュー', secretary: '秘書', schedule: '定時実行', api: 'API' } as Record<string, string>)[origin ?? ''] ?? '—';
}

function roleLabel(role: string): string {
  return ({ admin: '管理者', approver: '承認者', member: '一般', external: '外部協力者', developer: '開発者' } as Record<string, string>)[role] ?? role;
}

/** 申請の状態の呼び名。 */
const SUPPORT_STATE: Record<SupportGrant['state'], string> = {
  requested: '許すか待ち', approved: '閲覧できる', denied: '断った', revoked: '切った', ended: '運営が終えた', withdrawn: '取り下げられた', expired: '期限で終わった',
};

/**
 * サポートの閲覧（仕様書 第23.6.1節）。運営のサポートからの代理アクセスの申請を、許す（期限を選ぶ）・断る・切る。
 *
 * @remarks 見るだけで、書き換え・依頼・承認はできない。見た画面は監査ログに残る
 */
function SupportAccess() {
  const [items, setItems] = useState<SupportGrant[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [hours, setHours] = useState<Record<string, number>>({});
  const load = useCallback(() => { api.admin.supportAccess().then((r) => setItems(r.items)).catch((e) => setError(describeError(e, '読み込めませんでした'))); }, []);
  useEffect(() => { load(); }, [load]);
  const act = (p: Promise<unknown>) => { setError(null); p.then(load).catch((e) => setError(describeError(e, '扱えませんでした'))); };
  const when = (iso: string | null) => (iso ? new Date(iso).toLocaleString('ja-JP', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '—');
  return (
    <>
      <PageTitle trail={['サポートの閲覧']} help={{
        article: 'admin-support-access',
        text: '運営のサポートが、問い合わせの調べのために会社の画面を見ることを、許すか断ります。見るだけで、見た画面は監査ログに残ります。',
      }} />
      {error && <p className="error">{error}</p>}
      {items && items.length === 0 && <p className="muted">申請はありません</p>}
      {items?.map((g) => (
        <div key={g.id} className="card">
          <p><strong>{g.operatorLabel}</strong> <span className="muted small">{when(g.requestedAt)}</span> <span className="badge">{SUPPORT_STATE[g.state]}</span></p>
          <p>{g.scope === 'runs' ? '管理者ページと、許した方が依頼した業務の結果' : '管理者ページ'}を見る。理由: {g.reason}</p>
          {g.state === 'approved' && <p className="small">{when(g.expiresAt)} まで閲覧できます（閲覧 {g.views} 回）</p>}
          {g.state !== 'requested' && g.state !== 'approved' && g.views > 0 && <p className="small muted">閲覧 {g.views} 回</p>}
          {g.state === 'requested' && (
            <p>
              <select value={hours[g.id] ?? 24} onChange={(e) => setHours({ ...hours, [g.id]: Number(e.target.value) })}>
                <option value={1}>1 時間</option><option value={4}>4 時間</option><option value={24}>1 日</option><option value={72}>3 日</option>
              </select>{' '}
              <button className="btn small" onClick={() => act(api.admin.approveSupport(g.id, hours[g.id] ?? 24))}>許す</button>{' '}
              <button className="btn ghost small" onClick={() => act(api.admin.denySupport(g.id))}>断る</button>
            </p>
          )}
          {g.state === 'approved' && <button className="btn ghost small" onClick={() => act(api.admin.revokeSupport(g.id))}>切る</button>}
        </div>
      ))}
    </>
  );
}
