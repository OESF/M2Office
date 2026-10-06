/**
 * @file 管理者ページの枠と、参照の画面（利用状況・実行の一覧・監査ログ・接続）。
 *
 * @see 仕様書 第6.6節 管理者ページ
 */

import { Fragment, useCallback, useEffect, useRef, useState } from 'react';
import { api, describeError, type AdminRun, type AdminRunStatus, type AdminSchedule, type AuditFilter, type AuditRowView, type Me } from './api.js';
import { statusLabel, SuspendedBanner } from './components.js';
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
  | 'connectors' | 'setup' | 'help' | 'helpReview';

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
  { id: 'usage', label: '利用状況', icon: 'usage', description: '業務ごとの実行の件数と費用', group: '記録' },
  { id: 'runs', label: '実行の一覧', icon: 'runs', description: '全員の実行の状態と費用（中身は見られません）', group: '記録' },
  { id: 'schedules', label: '定時実行の一覧', icon: 'schedules', description: '全員の定時実行と、動かないものの理由（見るだけ）', group: '記録' },
  { id: 'audit', label: '監査ログ', icon: 'audit', description: '誰が何をしたかの記録', group: '記録' },
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
      <SuspendedBanner status={me.tenant.status} />
      {!isAdmin ? (
        <main className="canvas"><p className="error">管理者ページは管理者のみが開けます。</p></main>
      ) : (
        // 管理者ページには秘書との会話の列が無い。右端の列を取らない
        <SideNavLayout extraClass="no-talk" nav={(
          <>
            {/* すべて済んだ会社では「はじめに行う設定」を出さない（仕様書 第6.10.3.1節） */}
            {TABS.filter((t) => t.id !== 'setup' || setup).map((t, i, shown) => (
              <Fragment key={t.id}>
                {/* まとまりの変わり目に見出しを出す（仕様書 第6.6節の並び） */}
                {t.group && t.group !== shown[i - 1]?.group && <NavHeading>{t.group}</NavHeading>}
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
        )}>
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
            {tab === 'runs' && <Runs />}
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
        text: '業務ごとの、これまでの実行件数と推論の費用です。費用は概算で、請求額ではありません。',
      }} />
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
          <p className="muted small">概算です（請求額ではありません）</p>
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
      <PageTitle trail={['実行の一覧']} help={{
        article: 'admin-runs',
        text: '直近 100 件の業務の状態です。行を押すと、段の進みと失敗の理由が出ます。入力や成果物の中身は出ません。',
      }} />
      {error && <p className="error">{error}</p>}
      {data?.items.map((r: AdminRun) => (
        <RunRow key={r.id} run={r} requester={nameOf(r.requestedBy)} />
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
  const { data, error } = useLoad(api.help.feedback);
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
                <thead><tr><th>質問</th><th>件数</th><th>最後</th></tr></thead>
                <tbody>{data.misses.map((m) => <tr key={`${m.question}-${m.lastAt}`}><td>{m.question}</td><td>{m.count}</td><td>{time(m.lastAt)}</td></tr>)}</tbody>
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
function RunRow({ run, requester }: { run: AdminRun; requester: string }) {
  const [open, setOpen] = useState(false);
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
