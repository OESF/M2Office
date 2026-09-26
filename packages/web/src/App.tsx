/**
 * @file ワークスペースの画面。左にメニュー、中央にキャンバス、右に会話ペイン、下に秘書バーを置く。
 *
 * お知らせ・定時実行・個人設定もここから開く。
 *
 * @see 仕様書 第6.1節 ワークスペースの画面構造
 */

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { Notification } from '@m2office/shared';
import {
  api, ApiError, describeError,
  type AgentSummary, type ApprovalView, type Lookup, type Me, type RunDetail, type ScheduleView, type SecretaryReply,
} from './api.js';
import { AgentHelpTip, HelpCenter, HelpTip, Markdown, PageTitle, Tour, openHelp, useOpenHelp } from './help.js';
import { AppVersionBadge, GoogleLauncher } from './launcher.js';
import { startVoice, type VoiceCall } from './voice.js';
import { keyLabel, useHotkey, useNumberHotkeys } from './keys.js';
import { timeGreeting } from './greeting.js';
import { AgentForm, ApprovalTray, RunView, statusLabel, SuspendedBanner } from './components.js';
import { Sources } from './sources.js';
import { parseRoute, routePath, syncUrl, type Route } from './route.js';
import {
  SETTINGS_SECTIONS, SETTINGS_SECTION_KEY, Settings, orderAgents, rememberedSection,
  type SettingsSection,
} from './Settings.js';
import {
  Icon, NavHeading, NavItem, NavUserCard, SecretaryAvatar, SideNavLayout, ThemeToggle, agentIcon, useRemembered,
} from './nav.js';

/**
 * Google との接続から戻ってきたときの結果（`?google=connected` など。仕様書 第14.3.3節）。
 * 一度だけ読み、アドレスから取り除く（再読み込みで同じ知らせを出さないため）。
 */
const googleReturn: string | null = (() => {
  const q = new URLSearchParams(location.search);
  const v = q.get('google');
  if (!v) return null;
  q.delete('google');
  history.replaceState(null, '', `${location.pathname}${q.toString() ? `?${q}` : ''}`);
  return v;
})();

const GOOGLE_RETURN_TEXT: Record<string, { ok: boolean; text: string }> = {
  connected: { ok: true, text: 'Google と接続しました' },
  cancelled: { ok: false, text: 'Google との接続を取りやめました。' },
  failed: { ok: false, text: 'Google と接続できませんでした。もう一度試すか、管理者に設定を確かめてもらってください。' },
  // 会社のクライアントの誤り。もう一度押しても直らないので、試し直しを勧めない（仕様書 第14.3.3節）
  client: { ok: false, text: '会社の Google 接続の設定に誤りがあるため、接続できませんでした。管理者に伝えてください（管理者ページ「接続」の「Google で確かめる」で確かめられます）。' },
};

/** 中央キャンバスに何を表示しているか。 */
type View =
  | { kind: 'home' }
  | { kind: 'agent'; agent: AgentSummary; fileId?: string }
  | { kind: 'run'; runId: string }
  | { kind: 'approvals' }
  | { kind: 'history' }
  | { kind: 'notifications' }
  | { kind: 'schedules' }
  | { kind: 'settings'; section: SettingsSection }
  | { kind: 'help'; articleId: string | null };

/** 画面の URL（仕様書 第6.1.6節）。 */
function viewPath(v: View): string {
  switch (v.kind) {
    case 'agent': return routePath({ kind: 'agent', agentId: v.agent.id });
    case 'run': return routePath({ kind: 'run', runId: v.runId });
    case 'settings': return routePath({ kind: 'settings', section: v.section });
    case 'help': return routePath({ kind: 'help', articleId: v.articleId });
    default: return routePath({ kind: v.kind });
  }
}

/**
 * URL から画面を決める。業務は一覧を読んでから引くため、ここでは決めない（`null`）。
 * 知らない URL も `null`（呼ぶ側が最初の画面に戻す）。
 */
function viewOf(r: Route): View | null {
  switch (r.kind) {
    case 'agent': case 'unknown': return null;
    case 'settings': {
      const known = SETTINGS_SECTIONS.some((x) => x.id === r.section);
      return { kind: 'settings', section: (known ? r.section : rememberedSection()) as SettingsSection };
    }
    case 'run': return { kind: 'run', runId: r.runId };
    case 'help': return { kind: 'help', articleId: r.articleId };
    default: return { kind: r.kind };
  }
}

/**
 * ワークスペースの画面。
 *
 * 左にコマンドメニュー、中央にキャンバス、右に折りたためる会話ペイン、
 * 下部に常駐の秘書バーを置く（仕様書 第6.1節）。
 */
export function App({ me, onLogout }: { me: Me; onLogout: () => void }) {
  const [agents, setAgents] = useState<AgentSummary[]>([]);
  const [approvals, setApprovals] = useState<ApprovalView[]>([]);
  const [history, setHistory] = useState<
    { run: { id: string; status: string; startedAt: string }; job: { agentId: string } | null }[]
  >([]);
  /*
    画面の URL（仕様書 第6.1.6節）。開いたときの URL から画面を決める。
    業務の画面は、業務の一覧を読むまで決められないため、読み終えてから開く（pendingAgent）
  */
  const initialRoute = useRef<Route>(parseRoute(location.pathname));
  const [view, setView] = useState<View>(() => (
    // Google から戻ったときは、その場で結果が見えるよう連携の区分を開く（第6.5.0節）
    googleReturn ? { kind: 'settings', section: 'google' } : (viewOf(initialRoute.current) ?? { kind: 'home' })
  ));
  const [pendingAgent, setPendingAgent] = useState<string | null>(
    !googleReturn && initialRoute.current.kind === 'agent' ? initialRoute.current.agentId : null,
  );
  // 開こうとした画面が無い・見られないとき、最初の画面に知らせる（使えない業務があることは示さない）
  const [notFound, setNotFound] = useState(initialRoute.current.kind === 'unknown');
  // 次に URL を合わせるとき、履歴に積まずに置き換える（最初に開いたとき・戻る・進むのあと・見つからずに戻すとき）
  const replaceNext = useRef(true);
  const [agentsLoaded, setAgentsLoaded] = useState(false);
  const [detail, setDetail] = useState<RunDetail | null>(null);
  // 後ろへ回した調べもの（仕様書 第10.11節）。動いているものは処理中として見せる
  const [lookups, setLookups] = useState<Lookup[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [notifications, setNotifications] = useState<Notification[]>([]);
  const [showTour, setShowTour] = useState(false);
  // 初回の案内（仕様書 第6.10.3節）。見終えていなければ出す
  useEffect(() => {
    api.onboarding.tour().then((t) => setShowTour(t.completedAt === null)).catch(() => undefined);
  }, []);
  const finishTour = () => { setShowTour(false); void api.onboarding.finishTour().catch(() => undefined); };
  // 画面のどこからでもヘルプの記事を開けるようにする
  /*
    ヘルプを開く直前の画面（仕様書 第6.10.7.2節）。調べ終えたら、ここへ戻せる。
    ヘルプからヘルプを開いたときは上書きしない（戻り先が消える）
  */
  const before = useRef<View | null>(null);
  useOpenHelp(useCallback((articleId: string | null) => {
    setView((v) => {
      if (v.kind !== 'help') before.current = v;
      return { kind: 'help', articleId };
    });
  }, []));
  const [menu, setMenu] = useState<{ hidden: string[]; order: string[] }>({ hidden: [], order: [] });
  // 秘書のアバター（仕様書 第6.1.3節）。個人設定で変えたら読み直す
  const [avatar, setAvatar] = useState('');
  // 本人の呼ばれ方（仕様書 第6.5.3節）。最初の画面の呼びかけに使う（第6.1.5節）
  const [callMe, setCallMe] = useState('');
  const loadMenu = useCallback(() => {
    api.mySettings().then((s) => {
      setMenu(s.menu);
      setAvatar(s.secretary.avatar ?? '');
      setCallMe(s.secretary.callMe ?? '');
    }).catch(() => undefined);
  }, []);
  useEffect(loadMenu, [loadMenu]);

  /*
    秘書のキャンバス（仕様書 第6.2節、ADR-0026）。**いちばん新しい結果 1 つだけ**を持つ。履歴は並べない。
    画面を移っても残り、再読み込みで消える
  */
  const [result, setResult] = useState<CanvasResult | null>(null);
  /*
    秘書のキャンバスの開閉。既定は折りたたみ。**結果を出したら開く**（声だけで返したときは開かない）。
    閉じるのは本人だけで、画面を移っても閉じない
  */
  const [talkOpen, setTalkOpen] = useRemembered('m2office.talk-open', false);
  /** 音声で話している間か。その間に終わった調べものは、中継が声で伝える（第6.2.0節）。 */
  const voiceOn = useRef(false);
  /** 秘書のキャンバスに結果を出す。前の結果は置き換える（第6.2.0節）。 */
  const show = useCallback((r: Omit<CanvasResult, 'id'>) => {
    setResult({ ...r, id: `${Date.now()}` });
    setTalkOpen(true);
    // setTalkOpen は状態の設定関数。依存に入れると毎回作り直してしまう
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const refresh = useCallback(async () => {
    try {
      const [a, p, j, n, l] = await Promise.all([
        api.agents(), api.approvals(), api.jobs(), api.notifications(), api.lookups(),
      ]);
      setAgents(a.agents);
      setAgentsLoaded(true);
      setApprovals(p.items);
      setHistory(j.items as never);
      setNotifications(n.items);
      setLookups(l.items);
      // まだ伝えていない調べものを受け取り、秘書の応答として出す（仕様書 第10.11.7節）。
      // 伝えたことはサーバーが記録するため、画面を開き直しても二度は出ない。
      // 会話していない間に終わったものも、ここで持ち越して伝わる
      // 音声で話している間は受け取らない。中継が声で伝え、大きければ秘書のキャンバスに出す（第6.2.0節）
      if (!voiceOn.current && l.items.some((x) => !x.told && (x.status === 'completed' || x.status === 'failed'))) {
        for (const x of (await api.claimLookups()).items) {
          // 秘書が自分で調べたものとして、秘書のキャンバスに出す（第6.2.0・10.11.7節）
          show({
            request: x.request,
            text: x.status === 'completed'
              ? (x.text || 'お調べしましたが、お伝えできる内容がありませんでした。')
              : `お調べできませんでした。${x.failureReason ?? ''}`,
          });
        }
      }
      setError(null);
    } catch (err) {
      setError(describeError(err, '読み込みに失敗しました'));
    }
  }, [show]);

  useEffect(() => {
    void refresh();
    // 実行は非同期に進むため、一定間隔で状態を取り直す
    const timer = setInterval(() => void refresh(), 2000);
    return () => clearInterval(timer);
  }, [refresh]);

  // 実行を表示している間は詳細も追う
  useEffect(() => {
    if (view.kind !== 'run') { setDetail(null); return; }
    const load = () => api.run(view.runId).then(setDetail).catch((err: unknown) => {
      // 無い・見られない実行（URL を直接開いた場合など）は、最初の画面に戻して知らせる（仕様書 第6.1.6節）
      if (err instanceof ApiError && (err.status === 404 || err.status === 403)) {
        replaceNext.current = true;
        setNotFound(true);
        setView({ kind: 'home' });
      }
    });
    void load();
    const timer = setInterval(load, 1500);
    return () => clearInterval(timer);
  }, [view]);


  // 実行例から入れ直す値（仕様書 第6.10.5.1節）。業務を変えたら持ち越さない
  const [formFill, setFormFill] = useState<Record<string, string> | null>(null);
  /** 個人設定を開く。区分を省くと、最後に開いたものから始める（仕様書 第6.5.0節）。 */
  const openSettings = useCallback((section?: string) => {
    const id = (section ?? rememberedSection()) as SettingsSection;
    try { localStorage.setItem(SETTINGS_SECTION_KEY, id); } catch { /* 覚えられなくても動く */ }
    setView({ kind: 'settings', section: id });
  }, []);
  useEffect(() => { setFormFill(null); }, [view.kind === 'agent' ? view.agent.id : null]);

  // 画面を切り替えたら URL を合わせる（仕様書 第6.1.6節）。業務の一覧を待っている間は触らない
  useEffect(() => {
    if (pendingAgent) return;
    syncUrl(viewPath(view), replaceNext.current);
    replaceNext.current = false;
    if (view.kind !== 'home') setNotFound(false);
  }, [view, pendingAgent]);

  // 開いたときの URL が業務の画面なら、一覧を読み終えてから開く。使えない業務なら最初の画面に戻す
  useEffect(() => {
    if (!pendingAgent || !agentsLoaded) return;
    const hit = agents.find((a) => a.id === pendingAgent);
    replaceNext.current = true;
    if (hit) setView({ kind: 'agent', agent: hit });
    else { setNotFound(true); setView({ kind: 'home' }); }
    setPendingAgent(null);
  }, [pendingAgent, agentsLoaded, agents]);

  // ブラウザの「戻る」「進む」（仕様書 第6.1.6節）
  const agentsRef = useRef(agents);
  agentsRef.current = agents;
  useEffect(() => {
    const onPop = () => {
      const r = parseRoute(location.pathname);
      replaceNext.current = true;
      if (r.kind === 'agent') {
        const hit = agentsRef.current.find((a) => a.id === r.agentId);
        if (hit) { setView({ kind: 'agent', agent: hit }); return; }
        setNotFound(true);
        setView({ kind: 'home' });
        return;
      }
      const v = viewOf(r);
      if (!v) setNotFound(true);
      setView(v ?? { kind: 'home' });
    };
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);

  // キーボードの割り当て（仕様書 第6.11.3節）。表は keys.ts に 1 つだけ置く
  const menuAgents = orderAgents(agents, menu.order).filter((a) => !menu.hidden.includes(a.id));
  useHotkey('Mod+,', useCallback(() => openSettings(), [openSettings]));
  useHotkey('Mod+/', useCallback(() => openSettings('keys'), [openSettings]));
  useHotkey('Mod+I', useCallback(() => setTalkOpen(!talkOpen), [talkOpen, setTalkOpen]));
  useNumberHotkeys(useCallback((n: number) => {
    const agent = menuAgents[n - 1];
    if (agent) setView({ kind: 'agent', agent });
  }, [menuAgents]));
  // たたんでいる間に出た結果には、まだ見ていない印を出す（第6.2節）
  const [seen, setSeen] = useState<string | null>(null);
  useEffect(() => { if (talkOpen && result) setSeen(result.id); }, [talkOpen, result]);
  const unread = notifications.filter((n) => !n.readAt).length;
  const isAdmin = me.user.roles.includes('admin');

  return (
    <div className="app">
      <header className="topbar">
        <span className="brand">M2Office</span>
        <AppVersionBadge serverVersion={me.serverVersion} />
        <span className="tenant">{me.tenant.name}</span>
        {me.workspaceSource === 'mock' && (
          <span
            className="badge warn"
            title="Google Workspace につないでいないため、予定・メール・ToDo・ドライブ・Chat はダミーです。組織知識・書類の読み取り・承認・記録は本物です"
          >
            予定・メールはダミー
          </span>
        )}
        <span className="spacer" />
        {isAdmin && <a className="link" href={`/admin${location.search}`}>管理者ページ</a>}
        {/* 見本のデータの会社では出さない。見本と開いた先の本物が食い違うため（仕様書 第6.1.1.2節） */}
        {me.workspaceSource === 'google' && <GoogleLauncher email={me.user.email} admin={isAdmin} />}
        <ThemeToggle />
        <span className="badge">{me.user.displayName}</span>
        <button className="btn ghost small" onClick={onLogout}>ログアウト</button>
      </header>
      <SuspendedBanner status={me.tenant.status} />

      <SideNavLayout
        extraClass={talkOpen ? 'talk-open' : ''}
        nav={(
          <>
            <NavHeading>業務</NavHeading>
            {menuAgents.map((a, i) => (
              <NavItem
                key={a.id} icon={agentIcon(a.category)} label={a.name} description={a.description}
                active={view.kind === 'agent' && view.agent.id === a.id}
                // 1〜9 番目には、押すキーを併記する（仕様書 第6.11.1節 k4）
                hint={i < 9 ? keyLabel(`Mod+Shift+${i + 1}`) : ''}
                onClick={() => setView({ kind: 'agent', agent: a })}
              />
            ))}
            <NavHeading>自分の状況</NavHeading>
            <NavItem icon="approvals" label="承認トレイ" description="あなたが判断する承認と、操作の確認" count={approvals.length}
              active={view.kind === 'approvals'} onClick={() => setView({ kind: 'approvals' })} />
            <NavItem icon="history" label="実行履歴" description="過去の依頼と結果"
              active={view.kind === 'history'} onClick={() => setView({ kind: 'history' })} />
            <NavItem icon="notifications" label="お知らせ" description="あなた宛ての通知。週次ブリーフもここに届きます" count={unread}
              active={view.kind === 'notifications'} onClick={() => setView({ kind: 'notifications' })} />
            <NavItem icon="schedules" label="定時実行" description="決まった時刻に、あなたの権限で業務を実行します"
              active={view.kind === 'schedules'} onClick={() => setView({ kind: 'schedules' })} />
            <NavItem icon="help" label="ヘルプ" description="使い方の記事と検索"
              active={view.kind === 'help'} onClick={() => setView({ kind: 'help', articleId: null })} />
          </>
        )}
        navFooter={(
          <NavUserCard
            name={me.user.displayName} role={primaryRole(me.user.roles)} photo={me.photo}
            active={view.kind === 'settings'} sections={SETTINGS_SECTIONS}
            current={view.kind === 'settings' ? view.section : undefined}
            onOpenSettings={openSettings}
          />
        )}
        footer={(
          <SecretaryBar
            lookups={lookups}
            avatar={avatar}
            onResult={show}
            onVoice={(on) => { voiceOn.current = on; }}
          />
        )}
      >
        <main className="canvas">
          {error && <p className="error">{error}</p>}
          {view.kind === 'home' && <Home callMe={callMe || `${me.user.displayName}さん`} notFound={notFound} />}
          {view.kind === 'agent' && (
            <>
              {/* 説明は広げず、題名の「？」から出す（仕様書 第6.10.5.1節） */}
              <h1>
                {view.agent.name}{' '}
                <AgentHelpTip
                  agentId={view.agent.id}
                  extension={view.agent.extension}
                  onExample={(input) => setFormFill(
                    Object.fromEntries(Object.entries(input).map(([k, v]) => [k, String(v ?? '')])),
                  )}
                />
              </h1>
              <AgentForm
                key={view.agent.id} agent={view.agent} fill={formFill}
                initial={view.fileId ? { fileId: view.fileId } : undefined}
                onSubmitted={(runId) => setView({ kind: 'run', runId })}
              />
            </>
          )}
          {view.kind === 'run' && (
            <>
              <h1>実行の詳細</h1>
              {detail ? (
                <RunView detail={detail} viewerId={me.user.id} onCancelled={() => void api.run(view.runId).then(setDetail)} />
              ) : <p className="muted">読み込み中…</p>}
            </>
          )}
          {view.kind === 'approvals' && (
            <>
              <h1>承認トレイ <HelpTip article="start-approvals">承認すると業務が続きから進み、却下するとそこで終わります。送信や登録は承認のあとにだけ行います。</HelpTip></h1>
              <ApprovalTray items={approvals} onDecided={() => void refresh()} />
            </>
          )}
          {view.kind === 'notifications' && (
            <>
              <h1>お知らせ</h1>
              <Notifications items={notifications} onRead={() => void refresh()} />
            </>
          )}
          {view.kind === 'schedules' && (
            <>
              <h1>定時実行 <HelpTip article="start-schedules">決まった時刻に、あなたの権限で業務を自動で実行します。「今すぐ実行」で動きを確かめられます。</HelpTip></h1>
              <Schedules agents={agents} />
            </>
          )}
          {view.kind === 'settings' && (
            <>
              {/* いまどの区分を見ているかを題名に出す（仕様書 第6.5.0節） */}
              {(() => {
                const section = SETTINGS_SECTIONS.find((x) => x.id === view.section);
                // 開いている区分のことを先に書く（仕様書 第6.10.4.4節）
                return (
                  <PageTitle trail={['個人設定', section?.label ?? '']} help={{
                    article: 'start-settings',
                    text: `${section ? `${section.hint}の設定です。` : ''}ここでの設定は、あなたにだけ効きます。管理者も変更できません。`,
                  }} />
                );
              })()}
              {googleReturn && GOOGLE_RETURN_TEXT[googleReturn] && (
                <p className={GOOGLE_RETURN_TEXT[googleReturn]!.ok ? 'ok-msg' : 'error'}>{GOOGLE_RETURN_TEXT[googleReturn]!.text}</p>
              )}
              <Settings me={me} agents={agents} onChanged={loadMenu} section={view.section} />
            </>
          )}
          {view.kind === 'help' && (
            <HelpCenter
              initial={view.articleId} back={backTo(before.current, (v) => setView(v))}
              // 記事を開いたら URL も合わせる（/help/{記事}。仕様書 第6.1.6節）
              onArticle={(id) => setView((v) => (v.kind === 'help' && v.articleId === id ? v : { kind: 'help', articleId: id }))}
              onReplayTour={() => {
              void api.onboarding.resetTour().catch(() => undefined);
              setShowTour(true);
            }} />
          )}
          {view.kind === 'history' && (
            <>
              <h1>実行履歴</h1>
              {history.length === 0 && <p className="muted">まだ履歴はありません</p>}
              {history.map(({ run, job }) => (
                <HistoryRow
                  key={run.id} run={run} viewerId={me.user.id}
                  agentName={agents.find((a) => a.id === job?.agentId)?.name ?? '不明な業務'}
                />
              ))}
            </>
          )}
        </main>

        {/* 秘書のキャンバス。秘書が結果を見せる場所で、会話の履歴は並べない（仕様書 第6.2節、ADR-0026） */}
        <aside className={`talk${talkOpen ? '' : ' collapsed'}`} aria-label="秘書のキャンバス">
          <button
            className="talk-toggle" onClick={() => setTalkOpen(!talkOpen)}
            title={talkOpen ? '秘書のキャンバスを閉じる' : '秘書のキャンバスを開く'}
            aria-label={talkOpen ? '秘書のキャンバスを閉じる' : '秘書のキャンバスを開く'} aria-expanded={talkOpen}
          >
            <Icon name={talkOpen ? 'nav-collapse' : 'nav-expand'} />
            {!talkOpen && result && result.id !== seen && <span className="nav-dot" title="まだ見ていない結果があります">1</span>}
          </button>
          <div className="talk-body">
            {result ? (
              <CanvasView
                result={result}
                onOpenAgent={(agentId, fileId) => {
                  const hit = agents.find((a) => a.id === agentId);
                  // 秘書に渡したファイルを、そのまま業務の入力へ引き継ぐ（第10.10.3節）
                  if (hit) setView({ kind: 'agent', agent: hit, ...(fileId ? { fileId } : {}) });
                }}
              />
            ) : (
              <h3>秘書のキャンバス</h3>
            )}
          </div>
        </aside>
      </SideNavLayout>
      {showTour && <Tour onDone={finishTour} />}
    </div>
  );
}

/**
 * 最初の画面（仕様書 第6.1.5節）。
 *
 * @remarks
 * **呼びかけから始める。** 件数の表は出さない。使える業務は左のメニューに、
 * 承認待ちは承認トレイに出ている。同じことを二度出さない。
 *
 * @param callMe 本人の呼ばれ方（第6.5.3節）。設定が無ければ表示名に「さん」
 */
/**
 * 実行履歴の 1 行（仕様書 第6.2.4節）。
 *
 * @remarks
 * **画面を移らず、その場で開く。** 別の画面へ飛ばすと、戻る道が無く一覧を見失う
 * （2026-09-25 に実機で確認）。開いたときにだけ中身を取りに行く。
 */
function HistoryRow({ run, agentName, viewerId }: {
  run: { id: string; status: string; startedAt: string };
  agentName: string;
  viewerId: string;
}) {
  const [open, setOpen] = useState(false);
  const [detail, setDetail] = useState<RunDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(() => {
    api.run(run.id).then((d) => { setDetail(d); setError(null); })
      .catch((e) => setError(describeError(e, '読み込めませんでした')));
  }, [run.id]);
  useEffect(() => { if (open && !detail) load(); }, [open, detail, load]);

  return (
    <div className={`card fold-row${open ? ' open' : ''}`}>
      <button className="fold-head" onClick={() => setOpen(!open)} aria-expanded={open}>
        <Icon name={open ? 'caret-down' : 'caret-right'} className="nav-caret" />
        <strong>{agentName}</strong>
        <span className={`status ${run.status}`}>{statusLabel(run.status)}</span>
        <span className="muted small tail">
          {new Date(run.startedAt).toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' })}
        </span>
      </button>
      {open && (
        <div className="fold-body">
          {error && <p className="error">{error}</p>}
          {!error && !detail && <p className="muted">読み込み中…</p>}
          {detail && <RunView detail={detail} viewerId={viewerId} onCancelled={load} />}
        </div>
      )}
    </div>
  );
}

/** ヘルプを開く前の画面へ戻す道（仕様書 第6.10.7.2節）。名前で示す。 */
function backTo(view: View | null, go: (v: View) => void): { label: string; go: () => void } | undefined {
  if (!view) return undefined;
  const label = VIEW_LABELS[view.kind] ?? (view.kind === 'agent' ? view.agent.name : '前の画面');
  return { label, go: () => go(view) };
}

/** 画面の名前。戻る先を名前で示すために使う。 */
const VIEW_LABELS: Record<string, string> = {
  home: 'ホーム',
  run: '実行の詳細',
  approvals: '承認トレイ',
  history: '実行履歴',
  notifications: 'お知らせ',
  schedules: '定時実行',
  settings: '個人設定',
};

function Home({ callMe, notFound = false }: {
  callMe: string;
  /** 開こうとした画面が無い・見られなかった（仕様書 第6.1.6節）。 */
  notFound?: boolean;
}) {
  // 日をまたいでも、時刻が変わっても、開いたままで正しい挨拶になるようにする
  const [greeting, setGreeting] = useState(() => timeGreeting());
  useEffect(() => {
    const t = setInterval(() => setGreeting(timeGreeting()), 60_000);
    return () => clearInterval(t);
  }, []);
  return (
    <div className="home">
      {notFound && (
        <p className="warn-msg small">お探しの画面は見つかりませんでした</p>
      )}
      <p className="home-greeting">{callMe}、{greeting}。</p>
      <h1>何かお手伝いしましょうか</h1>
    </div>
  );
}

/** 秘書のキャンバスに出す結果（仕様書 第6.2.0節）。いちばん新しいもの 1 つだけを持つ。 */
export interface CanvasResult {
  id: string;
  /** 依頼の言葉。結果の見出しに小さく出す。 */
  request: string;
  /** 秘書の答え（Markdown）。 */
  text: string;
  /** どこから来た依頼か。声の依頼を画面に出したときは、そう添える。 */
  via?: 'voice';
  /** 応答の層や時間など、小さく添える注記。 */
  note?: string;
  suggestedAgent?: { id: string; name: string };
  fileId?: string | null;
  helpArticles?: { id: string; title: string }[];
  evidence?: { label: string; value: string; kind?: 'source' }[];
}

/**
 * 秘書のキャンバスの中身（仕様書 第6.2.0節）。
 *
 * @remarks
 * 見出しに依頼の言葉を小さく出し、その下に答えを書式として出す。根拠・出典・業務を開くボタン・ヘルプの記事は、
 * この結果に添える。新しい結果が来たら、先頭から読めるように上へ戻す。
 */
function CanvasView({ result, onOpenAgent }: {
  result: CanvasResult;
  onOpenAgent: (agentId: string, fileId: string | null) => void;
}) {
  const top = useRef<HTMLDivElement>(null);
  useEffect(() => { top.current?.scrollIntoView({ block: 'start' }); }, [result.id]);
  const facts = result.evidence?.filter((e) => e.kind !== 'source') ?? [];
  const sources = result.evidence?.filter((e) => e.kind === 'source') ?? [];

  return (
    <div className="canvas-result" ref={top}>
      <p className="canvas-request">
        <span className="muted small">{result.via === 'voice' ? '声でのご依頼' : 'ご依頼'}</span>
        <span>{result.request}</span>
      </p>
      <div className="md"><Markdown text={result.text} lineBreaks /></div>
      {result.suggestedAgent && (
        <button className="btn small" onClick={() => onOpenAgent(result.suggestedAgent!.id, result.fileId ?? null)}>
          {result.suggestedAgent.name} を開く
        </button>
      )}
      {result.helpArticles?.map((a) => (
        <button key={a.id} className="help-item" onClick={() => openHelp(a.id)}>{a.title}</button>
      ))}
      {facts.length > 0 && (
        <dl className="kv">
          {facts.map((e, i) => (
            <div key={i} style={{ display: 'contents' }}>
              <dt>{e.label}</dt><dd>{e.value}</dd>
            </div>
          ))}
        </dl>
      )}
      {sources.length > 0 && <Sources items={sources} reply={result.text} />}
      {result.note && <p className="muted small">{result.note}</p>}
    </div>
  );
}

/**
 * 常駐の秘書バー。どの画面からでも呼び出せる（仕様書 第10.4節）。
 * 音声でも話しかけられ（第10.5節）、手元のファイルを 1 つ渡せる（第10.10節）。
 */
function SecretaryBar({ lookups, avatar, onResult, onVoice }: {
  /** 後ろで動いている調べもの。処理中であることを常に見せる（仕様書 第10.11.6節） */
  lookups: Lookup[];
  /** 秘書のアバター（個人設定。仕様書 第6.1.3節） */
  avatar: string;
  /** 秘書のキャンバスに結果を出す（第6.2.0節）。帯には出さない */
  onResult: (result: Omit<CanvasResult, 'id'>) => void;
  /** 音声を始めた・終えた。その間の調べものは声で伝わる（第6.2.0節） */
  onVoice: (on: boolean) => void;
}) {
  const box = useRef<HTMLTextAreaElement>(null);
  // どの画面からでも、秘書の入力欄へ移る（仕様書 第6.11.3節）
  useHotkey('Mod+J', useCallback(() => box.current?.focus(), []));
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [hint, setHint] = useState<string | null>(null);
  // 渡すファイルは 1 つだけ（第10.10.2節）。選んだ時点で上げ、ID を持っておく
  const [file, setFile] = useState<{ id: string; name: string } | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  async function attach(chosen: File | undefined) {
    if (!chosen) return;
    setBusy(true);
    setHint(`「${chosen.name}」を渡しています…`);
    try {
      const up = await api.uploadFile(chosen);
      setFile({ id: up.id, name: up.name });
      setHint(`「${up.name}」を渡しました。この書類について聞いてください`);
    } catch (err) {
      setHint(describeError(err, 'ファイルを渡せませんでした'));
    } finally {
      setBusy(false);
      if (fileInput.current) fileInput.current.value = '';
    }
  }
  // 音声の対話（第10.5.5節）
  const [call, setCall] = useState<VoiceCall | null>(null);
  /*
    音声の字幕（第6.2.0節・10.5.2節）。**直近の 1 往復だけ**を帯に出す。聞き間違いに気づけるように。
    秘書が答えたあとに本人が話し始めたら、前の往復は消す（残さない）
  */
  const [caption, setCaption] = useState<{ heard: string; reply: string }>({ heard: '', reply: '' });
  useEffect(() => { onVoice(call !== null); }, [call, onVoice]);

  async function toggleVoice() {
    if (call) {
      call.stop();
      setCall(null);
      setCaption({ heard: '', reply: '' });
      return;
    }
    setHint('マイクの許可を確かめています…');
    const started = await startVoice({
      // 音声では文字が細かく届く。同じ話し手が続く間はつなげ、秘書の答えのあとに話し始めたら新しい往復にする
      onHeard: (t) => setCaption((c) => (c.reply ? { heard: t, reply: '' } : { ...c, heard: c.heard + t })),
      onReply: (t) => setCaption((c) => ({ ...c, reply: c.reply + t })),
      // 大きい答えと「画面に出して」と頼まれたものだけが届く。画面の入力と同じ形で出す（仕様書 第6.2.0節）
      onAnswer: ({ request, reply }) => onResult({
        request, text: reply.text, via: 'voice',
        ...(reply.suggestedAgent ? { suggestedAgent: { id: reply.suggestedAgent.id, name: reply.suggestedAgent.name }, fileId: null } : {}),
        ...(reply.helpArticles ? { helpArticles: reply.helpArticles } : {}),
        ...(reply.evidence.length > 0 ? { evidence: reply.evidence } : {}),
      }),
      onState: (state, note) => {
        setHint(note ?? { connecting: 'つないでいます…', listening: '聞いています（もう一度押すと終わります）', closed: '音声を終わりました' }[state]);
        if (state === 'closed') setCall(null);
      },
    });
    setCall(started);
  }

  // 終わったものは出さない。終わったことは秘書が応答として伝える（第10.11.7節）
  const running = lookups.filter((x) => x.status !== 'completed' && x.status !== 'failed');

  // 入力に合わせて高さを伸ばす。上限を超えたら中で送る（仕様書 第6.1.3節）
  const fitBox = useCallback(() => {
    const el = box.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 180)}px`;
  }, []);
  // 書いている間は、描く前に合わせる。待たせると入力欄が一拍遅れて動く
  useLayoutEffect(fitBox, [text, fitBox]);
  // 最初の 1 回だけ、**配置が決まってから**測り直す。決まる前の値（親に引き伸ばされた
  // 高さ）を拾うと、そのまま張り付いてしまう
  useEffect(() => {
    const id = requestAnimationFrame(fitBox);
    return () => cancelAnimationFrame(id);
  }, [fitBox]);

  async function send() {
    if (!text.trim() || busy) return;
    setBusy(true);
    const asked = text;
    const withFile = file;
    try {
      setText('');
      setFile(null);
      setHint('考えています…');
      // 書いた依頼には、文字で秘書のキャンバスに返す。音声で話している最中でも読み上げない（第6.2.0節）
      const reply = await api.ask(asked, withFile?.id);
      onResult({
        request: withFile ? `${asked}（渡した書類: ${withFile.name}）` : asked,
        text: reply.text,
        note: [
          layerLabel(reply.layer), `${reply.elapsedMs}ms`,
          reply.tokensUsed > 0 ? `${reply.tokensUsed} トークン` : '',
          reply.file?.note ?? '',
        ].filter(Boolean).join(' / '),
        ...(reply.suggestedAgent
          ? { suggestedAgent: { id: reply.suggestedAgent.id, name: reply.suggestedAgent.name }, fileId: withFile?.id ?? null }
          : {}),
        ...(reply.helpArticles ? { helpArticles: reply.helpArticles } : {}),
        ...(reply.evidence.length > 0 ? { evidence: reply.evidence } : {}),
      });
      setHint(layerLabel(reply.layer));
    } catch (err) {
      setHint(describeError(err, '応答できませんでした'));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="secretary">
      {/* アバターが音声の入口（仕様書 第6.1.3節）。帯の高さいっぱいに置く */}
      <button
        className={`secretary-avatar${call ? ' on' : ''}`}
        onClick={() => void toggleVoice()}
        aria-pressed={call !== null}
        title={call ? '音声を終わります' : '押すと、秘書と音声で話せます'}
      >
        <SecretaryAvatar avatar={avatar} />
        <span className="sr-only">{call ? '秘書との音声を終わる' : '秘書と音声で話す'}</span>
      </button>

      <div className="secretary-right">
      {/*
        音声の字幕（第6.2.0節・10.5.2節）。話している間だけ、直近の 1 往復を出す。
        高さは決めてあり、長い文は新しい側を見せる
      */}
      {call && (
        <div className="secretary-caption" aria-live="polite">
          <p><span className="muted">あなた</span>{tail(caption.heard) || '…'}</p>
          <p><span className="muted">秘書</span>{tail(caption.reply) || '…'}</p>
        </div>
      )}
      <div className="secretary-main">
      <div className="secretary-input">
        <textarea
          ref={box}
          value={text}
          rows={1}
          placeholder="例: 今日の予定は？"
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            // Enter で送り、Shift+Enter で改行する。変換確定の Enter では送らない（第6.1.3節）
            if (e.key !== 'Enter' || e.shiftKey || e.nativeEvent.isComposing) return;
            e.preventDefault();
            void send();
          }}
          disabled={busy}
        />
        {file && (
          <span className="attached">
            {file.name}
            <button className="link" onClick={() => setFile(null)} title="渡すのをやめる">×</button>
          </span>
        )}
      </div>

      <input ref={fileInput} type="file" hidden
        accept=".pdf,.xlsx,.csv,.docx,.png,.jpg,.jpeg"
        onChange={(e) => void attach(e.target.files?.[0])} />
      <button className="icon-btn" disabled={busy} onClick={() => fileInput.current?.click()}
        title="書類を渡して、それについて聞けます（PDF・Word・Excel・CSV・画像。10 MB まで）">
        <Icon name="clip" />
        <span className="sr-only">書類を渡す</span>
      </button>
      <button className={`icon-btn${call ? ' on' : ''}`} onClick={() => void toggleVoice()}
        title={call ? '音声を終わります' : '音声で話しかけます。声で答え、大きい答えは右の秘書のキャンバスに出します'}>
        <Icon name={call ? 'mic-off' : 'mic'} />
        <span className="sr-only">{call ? '音声を終わる' : '音声で話す'}</span>
      </button>
      <button className="icon-btn send" onClick={() => void send()} disabled={busy || !text.trim()}
        title="送ります（Enter）">
        <Icon name="send" />
        <span className="sr-only">送る</span>
      </button>

      </div>

      {/*
        状態の知らせ。**高さの決まった場所**に出す（第6.1.3節）。
        長さで帯の高さを変えない。変わると、書いている最中に入力欄が動く
      */}
      <div className="secretary-status">
        {/* 秘書が黙り込んだように見せない。動いているものを必ず出す（第10.11.6節） */}
        {running.map((x) => (
          <span key={x.runId} className="lookup" title={x.request}>
            <span className="spin" aria-hidden="true" />
            {x.progress ?? 'お調べしています'}
          </span>
        ))}
        {hint && <span className="layer">{hint}</span>}
      </div>
      </div>
    </div>
  );
}

/** 字幕に出す長さ。長い文は新しい側（末尾）を見せる。 */
const CAPTION_MAX = 60;
const tail = (text: string) => (text.length > CAPTION_MAX ? `…${text.slice(-CAPTION_MAX)}` : text).trim();

/** 本人宛の通知の一覧。開くと既読になる。 */
function Notifications({ items, onRead }: { items: Notification[]; onRead: () => void }) {
  if (items.length === 0) return <p className="muted">お知らせはありません</p>;
  return (
    <>
      {items.map((n) => <NoticeRow key={n.id} notice={n} onRead={onRead} />)}
    </>
  );
}

/**
 * お知らせ 1 件（仕様書 第6.2.4節）。**その場で開く。**
 *
 * @remarks
 * 開いたときに読んだことにする。**閉じても読んだままにする**（開き直すたびに未読へ戻さない）。
 */
function NoticeRow({ notice, onRead }: { notice: Notification; onRead: () => void }) {
  const [open, setOpen] = useState(false);
  const unread = !notice.readAt;
  return (
    <div className={`card fold-row${open ? ' open' : ''}${unread ? ' unread' : ''}`}>
      <button
        className="fold-head" aria-expanded={open}
        onClick={() => {
          setOpen(!open);
          if (!open && unread) void api.readNotification(notice.id).then(onRead);
        }}
      >
        <Icon name={open ? 'caret-down' : 'caret-right'} className="nav-caret" />
        <strong>{notice.title}</strong>
        {unread && <span className="chip waiting">未読</span>}
        <span className="muted small tail">
          {new Date(notice.createdAt).toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' })}
        </span>
      </button>
      {open && (
        <div className="fold-body">
          <div className="reply"><Markdown text={notice.body} lineBreaks /></div>
        </div>
      )}
    </div>
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

/** どの層で応答したかを表示用の言葉にする（仕様書 第10.9.1節）。 */
function layerLabel(layer: SecretaryReply['layer']): string {
  return { direct: '直接応答', light: '取次', full: '対話' }[layer];
}

/** 利用者のカードに出す属性。ロールのうち最も強いもの（仕様書 第6.1.1節）。 */
function primaryRole(roles: readonly string[]): string {
  for (const r of ['admin', 'approver', 'member', 'external', 'developer']) if (roles.includes(r)) return roleLabel(r);
  return '一般';
}
