/**
 * @file ワークスペースの画面。左にメニュー、中央にキャンバス、右に会話ペイン、下に秘書バーを置く。
 *
 * お知らせ・定時実行・個人設定もここから開く。
 *
 * @see 仕様書 第6.1節 ワークスペースの画面構造
 */

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { Approval, Notification } from '@m2office/shared';
import {
  api, describeError, type AgentSummary, type Lookup, type Me, type RunDetail, type ScheduleView, type SecretaryReply,
} from './api.js';
import { AgentHelpTip, HelpCenter, HelpTip, Markdown, Tour, openHelp, useOpenHelp } from './help.js';
import { startVoice, type VoiceCall } from './voice.js';
import { keyLabel, useHotkey, useNumberHotkeys } from './keys.js';
import { AgentForm, ApprovalTray, RunView, statusLabel, SuspendedBanner } from './components.js';
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
  connected: { ok: true, text: 'Google と接続しました。下の「Google 連携」で許可の状況を確かめられます。' },
  cancelled: { ok: false, text: 'Google との接続を取りやめました。' },
  failed: { ok: false, text: 'Google と接続できませんでした。もう一度試すか、管理者に設定を確かめてもらってください。' },
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

/**
 * ワークスペースの画面。
 *
 * 左にコマンドメニュー、中央にキャンバス、右に折りたためる会話ペイン、
 * 下部に常駐の秘書バーを置く（仕様書 第6.1節）。
 */
export function App({ me, onLogout }: { me: Me; onLogout: () => void }) {
  const [agents, setAgents] = useState<AgentSummary[]>([]);
  const [approvals, setApprovals] = useState<Approval[]>([]);
  const [history, setHistory] = useState<{ run: { id: string; status: string }; job: { agentId: string } | null }[]>([]);
  const [view, setView] = useState<View>(() => (
    // Google から戻ったときは、その場で結果が見えるよう連携の区分を開く（第6.5.0節）
    googleReturn ? { kind: 'settings', section: 'google' } : { kind: 'home' }
  ));
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
  useOpenHelp(useCallback((articleId: string | null) => setView({ kind: 'help', articleId }), []));
  const [menu, setMenu] = useState<{ hidden: string[]; order: string[] }>({ hidden: [], order: [] });
  // 秘書のアバター（仕様書 第6.1.3節）。個人設定で変えたら読み直す
  const [avatar, setAvatar] = useState('');
  const loadMenu = useCallback(() => {
    api.mySettings().then((s) => { setMenu(s.menu); setAvatar(s.secretary.avatar ?? ''); }).catch(() => undefined);
  }, []);
  useEffect(loadMenu, [loadMenu]);

  const refresh = useCallback(async () => {
    try {
      const [a, p, j, n, l] = await Promise.all([
        api.agents(), api.approvals(), api.jobs(), api.notifications(), api.lookups(),
      ]);
      setAgents(a.agents);
      setApprovals(p.items);
      setHistory(j.items as never);
      setNotifications(n.items);
      setLookups(l.items);
      // まだ伝えていない調べものを受け取り、秘書の応答として出す（仕様書 第10.11.7節）。
      // 伝えたことはサーバーが記録するため、画面を開き直しても二度は出ない。
      // 会話していない間に終わったものも、ここで持ち越して伝わる
      if (l.items.some((x) => !x.told && (x.status === 'completed' || x.status === 'failed'))) {
        for (const x of (await api.claimLookups()).items) {
          // 秘書が自分で調べたものとして、流れの一番下に足す（第6.2.1・10.11.7節）
          setTurns((t) => appendTurn(t, 'secretary',
            x.status === 'completed'
              ? (x.text || 'お調べしましたが、お伝えできる内容がありませんでした。')
              : `お調べできませんでした。${x.failureReason ?? ''}`,
            { evidence: [{ label: 'ご依頼', value: x.request }] }));
        }
      }
      setError(null);
    } catch (err) {
      setError(describeError(err, '読み込みに失敗しました'));
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

  // 秘書とのやり取り。文字も音声も 1 本の流れにし、古いものが上・新しいものが下に並ぶ（第6.2.1節）
  const [turns, setTurns] = useState<Turn[]>([]);
  /*
    会話ペインの開閉（仕様書 第6.2節、ADR-0020）。
    既定は折りたたみ。**新しいやり取りが届いたら開く**。話しかけたのに答えが見えない、を起こさない。
    閉じるのは本人だけで、画面を移っても閉じない
  */
  const [talkOpen, setTalkOpen] = useRemembered('m2office.talk-open', false);
  // 実行例から入れ直す値（仕様書 第6.10.5.1節）。業務を変えたら持ち越さない
  const [formFill, setFormFill] = useState<Record<string, string> | null>(null);
  /** 個人設定を開く。区分を省くと、最後に開いたものから始める（仕様書 第6.5.0節）。 */
  const openSettings = useCallback((section?: string) => {
    const id = (section ?? rememberedSection()) as SettingsSection;
    try { localStorage.setItem(SETTINGS_SECTION_KEY, id); } catch { /* 覚えられなくても動く */ }
    setView({ kind: 'settings', section: id });
  }, []);
  useEffect(() => { setFormFill(null); }, [view.kind === 'agent' ? view.agent.id : null]);

  // キーボードの割り当て（仕様書 第6.11.3節）。表は keys.ts に 1 つだけ置く
  const menuAgents = orderAgents(agents, menu.order).filter((a) => !menu.hidden.includes(a.id));
  useHotkey('Mod+,', useCallback(() => openSettings(), [openSettings]));
  useHotkey('Mod+/', useCallback(() => openSettings('keys'), [openSettings]));
  useHotkey('Mod+I', useCallback(() => setTalkOpen(!talkOpen), [talkOpen, setTalkOpen]));
  useNumberHotkeys(useCallback((n: number) => {
    const agent = menuAgents[n - 1];
    if (agent) setView({ kind: 'agent', agent });
  }, [menuAgents]));
  useEffect(() => {
    // 件数が増えたときだけ開く。本人が閉じても、次のやり取りまでは閉じたまま
    if (turns.length > 0) setTalkOpen(true);
    // setTalkOpen は状態の設定関数。依存に入れると毎回動いてしまう
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [turns.length]);
  const unread = notifications.filter((n) => !n.readAt).length;
  const isAdmin = me.user.roles.includes('admin');

  return (
    <div className="app">
      <header className="topbar">
        <span className="brand">M2Office</span>
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
            name={me.user.displayName} role={primaryRole(me.user.roles)}
            active={view.kind === 'settings'} sections={SETTINGS_SECTIONS}
            current={view.kind === 'settings' ? view.section : undefined}
            onOpenSettings={openSettings}
          />
        )}
        footer={(
          <SecretaryBar
            lookups={lookups}
            avatar={avatar}
            onSaid={(role, text, meta) => setTurns((t) => appendTurn(t, role, text, meta))}
          />
        )}
      >
        <main className="canvas">
          {error && <p className="error">{error}</p>}
          {view.kind === 'home' && <Home approvals={approvals.length} agents={agents.length} />}
          {view.kind === 'agent' && (
            <>
              {/* 説明は広げず、題名の「？」から出す（仕様書 第6.10.5.1節） */}
              <h1>
                {view.agent.name}{' '}
                <AgentHelpTip
                  agentId={view.agent.id}
                  onExample={(input) => setFormFill(
                    Object.fromEntries(Object.entries(input).map(([k, v]) => [k, String(v ?? '')])),
                  )}
                />
              </h1>
              <p className="lead">必要な項目を入力して実行します。</p>
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
              {/* 終わったら、案内も消す（仕様書 第6.2.2.2節） */}
              {detail && !['completed', 'failed', 'cancelled'].includes(detail.run.status) && (
                <p className="lead">進み具合は自動で更新されます。</p>
              )}
              {detail ? (
                <RunView detail={detail} viewerId={me.user.id} onCancelled={() => void api.run(view.runId).then(setDetail)} />
              ) : <p className="muted">読み込み中…</p>}
            </>
          )}
          {view.kind === 'approvals' && (
            <>
              <h1>承認トレイ <HelpTip article="start-approvals">承認すると業務が続きから進み、却下するとそこで終わります。送信や登録は承認のあとにだけ行います。</HelpTip></h1>
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
              <h1>定時実行 <HelpTip article="start-schedules">決まった時刻に、あなたの権限で業務を自動で実行します。「今すぐ実行」で動きを確かめられます。</HelpTip></h1>
              <p className="lead">決まった時刻に、あなたの権限で業務を実行します。</p>
              <Schedules agents={agents} />
            </>
          )}
          {view.kind === 'settings' && (
            <>
              {/* いまどの区分を見ているかを題名に出す（仕様書 第6.5.0節） */}
              <h1>
                個人設定 › {SETTINGS_SECTIONS.find((x) => x.id === view.section)?.label}{' '}
                <HelpTip article="start-settings">ここでの設定は、あなたにだけ効きます。管理者も変更できません。</HelpTip>
              </h1>
              <p className="lead">
                ほかの項目は、左下の歯車から選べます（{keyLabel('Mod+,') || '歯車'}）。
              </p>
              {googleReturn && GOOGLE_RETURN_TEXT[googleReturn] && (
                <p className={GOOGLE_RETURN_TEXT[googleReturn]!.ok ? 'ok-msg' : 'error'}>{GOOGLE_RETURN_TEXT[googleReturn]!.text}</p>
              )}
              <Settings me={me} agents={agents} onChanged={loadMenu} section={view.section} />
            </>
          )}
          {view.kind === 'help' && (
            <HelpCenter initial={view.articleId} onReplayTour={() => {
              void api.onboarding.resetTour().catch(() => undefined);
              setShowTour(true);
            }} />
          )}
          {view.kind === 'history' && (
            <>
              <h1>実行履歴</h1>
              <p className="lead">過去の依頼と結果を確認できます。</p>
              {history.length === 0 && <p className="muted">まだ履歴はありません。左のメニューから業務を選ぶか、秘書に頼んでみてください。</p>}
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

        {/* 秘書とのやり取り専用。ほかのものを入れない（仕様書 第6.2節、ADR-0020） */}
        <aside className={`talk${talkOpen ? '' : ' collapsed'}`} aria-label="秘書との会話">
          <button
            className="talk-toggle" onClick={() => setTalkOpen(!talkOpen)}
            title={talkOpen ? '秘書との会話を閉じる' : '秘書との会話を開く'}
            aria-label={talkOpen ? '秘書との会話を閉じる' : '秘書との会話を開く'} aria-expanded={talkOpen}
          >
            <Icon name={talkOpen ? 'nav-collapse' : 'nav-expand'} />
            {!talkOpen && turns.length > 0 && (
              <span className="nav-dot">{turns.length > 99 ? '99+' : turns.length}</span>
            )}
          </button>
          <div className="talk-body">
            {/* やり取りは 1 本の流れ。古いものが上、新しいものが下（仕様書 第6.2.1節） */}
            {turns.length > 0 ? (
              <TurnLog
                turns={turns}
                onOpenAgent={(agentId, fileId) => {
                  const hit = agents.find((a) => a.id === agentId);
                  // 秘書に渡したファイルを、そのまま業務の入力へ引き継ぐ（第10.10.3節）
                  if (hit) setView({ kind: 'agent', agent: hit, ...(fileId ? { fileId } : {}) });
                }}
              />
            ) : (
              <>
                <h3>秘書とのやり取り</h3>
                <p className="muted">下の欄から話しかけると、ここに並びます。</p>
              </>
            )}
          </div>
        </aside>
      </SideNavLayout>
      {showTour && <Tour onDone={finishTour} />}
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

/** やり取りの 1 件（仕様書 第6.2.1節）。 */
export interface Turn {
  id: string;
  role: 'user' | 'secretary';
  text: string;
  /** その応答に添えるもの。根拠・業務の提案・ヘルプの記事など。 */
  meta?: {
    note?: string;
    suggestedAgent?: { id: string; name: string };
    fileId?: string | null;
    helpArticles?: { id: string; title: string }[];
    evidence?: { label: string; value: string }[];
  };
}

/**
 * やり取りを 1 件足す（仕様書 第6.2.1節）。
 *
 * @remarks
 * **同じ話し手が続く間は 1 件にまとめる。** 音声では文字が細かく届くため、
 * そのまま並べると 1 文が何件にも割れる。話し手が変わったら次の 1 件にする。
 * 添えるもの（根拠など）を持つ応答は、いつでも新しい 1 件にする。
 */
export function appendTurn(
  turns: Turn[], role: Turn['role'], text: string, meta?: Turn['meta'],
): Turn[] {
  const last = turns[turns.length - 1];
  if (!meta && last && last.role === role && !last.meta) {
    return [...turns.slice(0, -1), { ...last, text: last.text + text }];
  }
  return [...turns, { id: `${Date.now()}-${turns.length}`, role, text, meta }];
}

/**
 * やり取りの記録（仕様書 第6.2.1節）。
 *
 * @remarks
 * 古いものが上、新しいものが下。新しく届いたら一番下まで送る。
 */
function TurnLog({ turns, onOpenAgent }: {
  turns: Turn[];
  onOpenAgent: (agentId: string, fileId: string | null) => void;
}) {
  const end = useRef<HTMLDivElement>(null);
  useEffect(() => { end.current?.scrollIntoView({ block: 'end' }); }, [turns]);

  return (
    <div className="turns">
      <h3>秘書とのやり取り</h3>
      {turns.map((t) => (
        <div key={t.id} className={`turn ${t.role}`}>
          <span className="muted small">{t.role === 'user' ? 'あなた' : '秘書'}</span>
          {/* 秘書の答えは見出しや箇条書きを使う。本人が書いた文は、書いたとおりに出す */}
          {t.role === 'user' ? <p>{t.text}</p> : <div className="md"><Markdown text={t.text} /></div>}
          {t.meta?.note && <p className="muted small">{t.meta.note}</p>}
          {t.meta?.suggestedAgent && (
            <button className="btn small"
              onClick={() => onOpenAgent(t.meta!.suggestedAgent!.id, t.meta!.fileId ?? null)}>
              {t.meta.suggestedAgent.name} を開く
            </button>
          )}
          {t.meta?.helpArticles?.map((a) => (
            <button key={a.id} className="help-item" onClick={() => openHelp(a.id)}>{a.title}</button>
          ))}
          {t.meta?.evidence && t.meta.evidence.length > 0 && (
            <dl className="kv">
              {t.meta.evidence.map((e, i) => (
                <div key={i} style={{ display: 'contents' }}>
                  <dt>{e.label}</dt><dd>{e.value}</dd>
                </div>
              ))}
            </dl>
          )}
        </div>
      ))}
      <div ref={end} />
    </div>
  );
}

/**
 * 常駐の秘書バー。どの画面からでも呼び出せる（仕様書 第10.4節）。
 * 音声でも話しかけられ（第10.5節）、手元のファイルを 1 つ渡せる（第10.10節）。
 */
function SecretaryBar({ lookups, avatar, onSaid }: {
  /** 後ろで動いている調べもの。処理中であることを常に見せる（仕様書 第10.11.6節） */
  lookups: Lookup[];
  /** 秘書のアバター（個人設定。仕様書 第6.1.3節） */
  avatar: string;
  /** やり取りを 1 件足す。帯ではなく会話ペインに出す（第6.1.3・6.2.1節） */
  onSaid: (role: Turn['role'], text: string, meta?: Turn['meta']) => void;
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
  // 音声の対話（第10.5.5節）。聞こえた文字と応答は、その場で画面にも出す（併記）
  const [call, setCall] = useState<VoiceCall | null>(null);


  async function toggleVoice() {
    if (call) {
      call.stop();
      setCall(null);
      return;
    }
    setHint('マイクの許可を確かめています…');
    const started = await startVoice({
      // 音声では文字が細かく届く。同じ話し手が続く間は 1 件にまとまる（第6.2.1節）
      onHeard: (t) => onSaid('user', t),
      onReply: (t) => onSaid('secretary', t),
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
      // 自分の発言を先に足す。送った直後に流れへ出る（第6.2.1節）
      onSaid('user', withFile ? `${asked}\n（渡した書類: ${withFile.name}）` : asked, { note: '' });
      setText('');
      setFile(null);
      const reply = await api.ask(asked, withFile?.id);
      onSaid('secretary', reply.text, {
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
      <div className="secretary-main">
      <div className="secretary-input">
        <textarea
          ref={box}
          value={text}
          rows={1}
          placeholder={`例: 今日の予定は？ / 会議の議事録をまとめて（Shift+Enter で改行${
            keyLabel('Mod+J') ? `、${keyLabel('Mod+J')} でここへ` : ''}）`}
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
        title={call ? '音声を終わります' : '音声で話しかけます。話した内容と応答は右側に出ます'}>
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

/** 本人宛の通知の一覧。開くと既読になる。 */
function Notifications({ items, onRead }: { items: Notification[]; onRead: () => void }) {
  const [open, setOpen] = useState<string | null>(null);
  if (items.length === 0) return <p className="muted">お知らせはありません。週次ブリーフや業務の結果が、ここに届きます。</p>;
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
            <div className="reply"><Markdown text={n.body} /></div>
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

/** どの層で応答したかを表示用の言葉にする（仕様書 第10.9.1節）。 */
function layerLabel(layer: SecretaryReply['layer']): string {
  return { direct: '直接応答', light: '取次', full: '対話' }[layer];
}

/** 利用者のカードに出す属性。ロールのうち最も強いもの（仕様書 第6.1.1節）。 */
function primaryRole(roles: readonly string[]): string {
  for (const r of ['admin', 'approver', 'member', 'external', 'developer']) if (roles.includes(r)) return roleLabel(r);
  return '一般';
}
