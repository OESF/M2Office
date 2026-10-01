/**
 * @file ワークスペースの画面。左にメニュー、中央にキャンバス、右に会話ペイン、下に秘書バーを置く。
 *
 * お知らせ・定時実行・個人設定もここから開く。
 *
 * @see 仕様書 第6.1節 ワークスペースの画面構造
 */

import { Fragment, useCallback, useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from 'react';
import { CARDS_EXTENSION_ID, HR_EXTENSION_ID, INVENTORY_EXTENSION_ID, SIGNAGE_EXTENSION_ID, showsCaptions, type Notification, type UserSettings } from '@m2office/shared';
import {
  addCategory, assignCategory, checkCategoryName, groupMenu, removeCategory, togglePinned, type MenuSection,
} from './menu.js';
import { CategoryMenuActions, ItemMenuActions } from './MenuActions.js';
import { openDebugPanel } from './debug.js';
import {
  api, ApiError, describeError,
  type AgentSummary, type ApprovalView, type Lookup, type Me, type RunDetail, type SecretaryReply,
} from './api.js';
import { AgentHelpTip, HelpCenter, HelpTip, Markdown, PageTitle, Tour, openHelp, useOpenHelp } from './help.js';
import { AppVersionBadge, GoogleLauncher } from './launcher.js';
import { startVoice, type VoiceCall } from './voice.js';
import { keyLabel, useHotkey, useNumberHotkeys } from './keys.js';
import { timeGreeting } from './greeting.js';
import { AgentForm, ApprovalTray, RunView, statusLabel, SuspendedBanner } from './components.js';
import { Sources } from './sources.js';
import { Schedules } from './Schedules.js';
import { Cards } from './Cards.js';
import { Inventory } from './Inventory.js';
import { Signage } from './Signage.js';
import { Hr } from './Hr.js';
import { MyAttendance } from './MyAttendance.js';
import { isAttended, useAttention } from './attention.js';
import { parseRoute, routePath, syncUrl, type Route } from './route.js';
import {
  SETTINGS_SECTIONS, SETTINGS_SECTION_KEY, Settings, orderAgents, rememberedSection,
  type SettingsSection,
} from './Settings.js';
import {
  Icon, MenuNavItem, NavHeading, NavItem, NavUserCard, SecretaryAvatar, SideNavLayout, ThemeToggle, agentIcon, useRemembered,
  useRememberedNumber, useRememberedSet, type IconName,
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

/**
 * 会社の接続（Slack など）の許可から戻ってきたときの結果（`?connection=connected&id=slack`。仕様書 第12.11.6.3節）。
 * 一度だけ読み、アドレスから取り除く。
 */
const connectionReturn: { result: string; id: string } | null = (() => {
  const q = new URLSearchParams(location.search);
  const result = q.get('connection');
  if (!result) return null;
  const id = q.get('id') ?? '';
  q.delete('connection');
  q.delete('id');
  history.replaceState(null, '', `${location.pathname}${q.toString() ? `?${q}` : ''}`);
  return { result, id };
})();

const CONNECTION_RETURN_TEXT: Record<string, { ok: boolean; text: string }> = {
  connected: { ok: true, text: '接続しました' },
  cancelled: { ok: false, text: '接続を取りやめました。' },
  failed: { ok: false, text: '接続できませんでした。もう一度試すか、管理者に設定を確かめてもらってください。' },
};

const GOOGLE_RETURN_TEXT: Record<string, { ok: boolean; text: string }> = {
  connected: { ok: true, text: 'Google と接続しました' },
  cancelled: { ok: false, text: 'Google との接続を取りやめました。' },
  failed: { ok: false, text: 'Google と接続できませんでした。もう一度試すか、管理者に設定を確かめてもらってください。' },
  // 会社のクライアントの誤り。もう一度押しても直らないので、試し直しを勧めない（仕様書 第14.3.3節）
  client: { ok: false, text: '会社の Google 接続の設定に誤りがあるため、接続できませんでした。管理者に伝えてください（管理者ページ「接続」の「Google で確かめる」で確かめられます）。' },
};

/**
 * 左のメニューの業務の 1 項目（仕様書 第6.1.1節）。業務と、画面を持つ内蔵の拡張（名刺・在庫。第27.2節・第29.2節）を同じ並びで扱う。
 *
 * @remarks `agent` が `null` の項目は内蔵の拡張の画面（ID で名刺か在庫かを決める）。使えない人には項目を作らない
 */
type MenuItem = { id: string; name: string; description: string; icon: IconName; agent: AgentSummary | null };

/** 中央キャンバスに何を表示しているか。 */
type View =
  | { kind: 'home' }
  | { kind: 'agent'; agent: AgentSummary; fileId?: string }
  | { kind: 'run'; runId: string }
  | { kind: 'approvals' }
  | { kind: 'history' }
  | { kind: 'notifications' }
  | { kind: 'schedules' }
  | { kind: 'cards'; contactId: string | null }
  | { kind: 'inventory'; itemId: string | null }
  | { kind: 'hr'; employeeId: string | null }
  | { kind: 'attendance' }
  | { kind: 'signage' }
  | { kind: 'settings'; section: SettingsSection }
  | { kind: 'help'; articleId: string | null };

/** 画面の URL（仕様書 第6.1.6節）。 */
function viewPath(v: View): string {
  switch (v.kind) {
    case 'agent': return routePath({ kind: 'agent', agentId: v.agent.id });
    case 'run': return routePath({ kind: 'run', runId: v.runId });
    case 'settings': return routePath({ kind: 'settings', section: v.section });
    case 'cards': return routePath({ kind: 'cards', contactId: v.contactId });
    case 'inventory': return routePath({ kind: 'inventory', itemId: v.itemId });
    case 'hr': return routePath({ kind: 'hr', employeeId: v.employeeId });
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
    case 'cards': return { kind: 'cards', contactId: r.contactId };
    case 'inventory': return { kind: 'inventory', itemId: r.itemId };
    case 'hr': return { kind: 'hr', employeeId: r.employeeId };
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
  const [moreOpen, setMoreOpen] = useRemembered('m2office.nav-more-agents', false);
  // 開いているカテゴリー（端末ごとに覚える。仕様書 第6.1.1節「たたみ方」）
  const [openCategories, setCategoryOpen] = useRememberedSet('m2office.nav-open-categories');
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
    googleReturn ? { kind: 'settings', section: 'google' }
      : connectionReturn ? { kind: 'settings', section: 'services' }
      : (viewOf(initialRoute.current) ?? { kind: 'home' })
  ));
  const [pendingAgent, setPendingAgent] = useState<string | null>(
    !googleReturn && !connectionReturn && initialRoute.current.kind === 'agent' ? initialRoute.current.agentId : null,
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
  const [menu, setMenu] = useState<UserSettings['menu']>({ hidden: [], order: [], pinned: null, categories: [], categoryOf: {} });
  // 秘書のアバター（仕様書 第6.1.3節）。個人設定で変えたら読み直す
  const [avatar, setAvatar] = useState('');
  // 本人の呼ばれ方（仕様書 第6.5.3節）。最初の画面の呼びかけに使う（第6.1.5節）
  const [callMe, setCallMe] = useState('');
  // 個人設定「サービスとの接続」は、会社に利用者ごとに許可する接続があるときだけ出す（仕様書 第6.5.9節）
  const [hasServices, setHasServices] = useState(false);
  useEffect(() => {
    api.myConnections().then((r) => setHasServices(r.items.length > 0)).catch(() => setHasServices(false));
  }, []);
  const settingsSections = hasServices || view.kind === 'settings' && view.section === 'services'
    ? SETTINGS_SECTIONS : SETTINGS_SECTIONS.filter((x) => x.id !== 'services');
  // 音声の字幕を出すか（仕様書 第6.5.3節「会話を文字で出す」）。個人設定で変えたら読み直す
  const [captions, setCaptions] = useState(true);
  const loadMenu = useCallback(() => {
    api.mySettings().then((s) => {
      setMenu(s.menu);
      setAvatar(s.secretary.avatar ?? '');
      setCallMe(s.secretary.callMe ?? '');
      setCaptions(showsCaptions(s.secretary));
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
  // 秘書のキャンバスの幅（px。仕様書 第6.2節）。0 は既定の幅（左ペインを除いた残りの半分。これが最大）
  const [talkWidth, setTalkWidth] = useRememberedNumber('m2office.talk-width', 0);
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
      // 本人が見て操作している画面だけが受け取る。離れた画面・裏のタブが受け取ると、誰も見ないまま伝えたことになる（第10.11.7節、ADR-0047）
      if (!voiceOn.current && isAttended() && l.items.some((x) => !x.told && x.done)) {
        for (const x of (await api.claimLookups()).items) {
          // 秘書が自分で調べたものとして、秘書のキャンバスに出す（第6.2.0・10.11.7節）
          show({
            request: x.request,
            text: x.status === 'completed'
              ? (x.text || (x.agentName ? `「${x.agentName}」が終わりました。` : 'お調べしましたが、お伝えできる内容がありませんでした。'))
              : `${x.agentName ? `「${x.agentName}」で` : 'お調べ'}できませんでした。${x.failureReason ?? ''}`,
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
  // 離れていた画面に本人が戻ったら、待っていたもの（朝のブリーフなど）をすぐ受け取る
  useAttention(() => void refresh());

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
  // スキルの user-invocable: false の業務はメニューに出さない。秘書が取り次いだときだけ使う（仕様書 第12.12.2節）
  // 名刺（内蔵の拡張）も業務の 1 つとして並べる。ピン止め・たたみ・並び・押すキーはほかの業務と同じ（仕様書 第6.1.1節）
  const menuItems: MenuItem[] = [
    ...agents.filter((a) => a.menu !== false)
      .map((a) => ({ id: a.id, name: a.name, description: a.description, icon: agentIcon(a.category), agent: a })),
    ...(me.cards ? [{ id: CARDS_EXTENSION_ID, name: '名刺管理', description: '撮るだけで連絡先になる。会社で共有する名刺の置き場', icon: 'cards' as IconName, agent: null }] : []),
    ...(me.inventory ? [{ id: INVENTORY_EXTENSION_ID, name: '在庫管理', description: '品目・場所・入出庫を記録し、使える数を出す', icon: 'inventory' as IconName, agent: null }] : []),
    // 人事・給与は人事区画の人にだけ出す（仕様書 第30.2節）
    ...(me.hr ? [{ id: HR_EXTENSION_ID, name: '人事・給与', description: '従業員の台帳・雇用条件・入社と退職の手続き', icon: 'users' as IconName, agent: null }] : []),
    // 店頭サイネージ（仕様書 第31.2節）。会社で入れていて利用範囲の人にだけ出す
    ...(me.signage ? [{ id: SIGNAGE_EXTENSION_ID, name: 'サイネージ', description: '店頭や待合の画面に、画像と動画を流す', icon: 'signage' as IconName, agent: null }] : []),
  ];
  const allMenuAgents = orderAgents(menuItems, menu.order).filter((a) => !menu.hidden.includes(a.id));
  // ピン止めした業務だけを上に出し、ほかはカテゴリーごと・「ほかの業務」にたたむ（仕様書 第6.1.1節「業務の並び」）。
  // 並びはメニューの順のまま。使った回数では変えない。まだ一度も変えていなければ標準の組
  const { top: topAgents, sections } = groupMenu(allMenuAgents, menu);
  const openItem = (m: MenuItem) => (m.agent ? setView({ kind: 'agent', agent: m.agent })
    : m.id === INVENTORY_EXTENSION_ID ? setView({ kind: 'inventory', itemId: null })
      : m.id === HR_EXTENSION_ID ? setView({ kind: 'hr', employeeId: null })
        : m.id === SIGNAGE_EXTENSION_ID ? setView({ kind: 'signage' }) : setView({ kind: 'cards', contactId: null }));
  const isOpen = (m: MenuItem) => (m.agent ? view.kind === 'agent' && view.agent.id === m.id
    : m.id === INVENTORY_EXTENSION_ID ? view.kind === 'inventory' : m.id === HR_EXTENSION_ID ? view.kind === 'hr'
      : m.id === SIGNAGE_EXTENSION_ID ? view.kind === 'signage' : view.kind === 'cards');
  // ピン止めとカテゴリーは個人設定（メニュー）に保存し、端末をまたいで同じにする。保存に失敗したら読み直す
  const saveMenu = (saved: UserSettings['menu']) => {
    setMenu(saved);
    void api.saveMySettings('menu', saved).catch(() => loadMenu());
  };
  const togglePin = (id: string) => saveMenu({ ...menu, pinned: togglePinned(menu.pinned, id) });
  const setItemCategory = (id: string, categoryId: string | null) => saveMenu({ ...menu, categoryOf: assignCategory(menu.categoryOf, id, categoryId) });
  // カテゴリーを作ってその業務を入れ、中身が見えるよう開いておく
  const createCategoryFor = (id: string, name: string): string | null => {
    const made = addCategory(menu.categories, name);
    if ('error' in made) return made.error;
    saveMenu({ ...menu, categories: made.categories, categoryOf: assignCategory(menu.categoryOf, id, made.category.id) });
    setCategoryOpen(made.category.id, true);
    return null;
  };
  const renameCategory = (categoryId: string, name: string): string | null => {
    const checked = checkCategoryName(menu.categories, name, categoryId);
    if ('error' in checked) return checked.error;
    saveMenu({ ...menu, categories: (menu.categories ?? []).map((c) => (c.id === categoryId ? { ...c, name: checked.name } : c)) });
    return null;
  };
  const deleteCategory = (categoryId: string) => {
    saveMenu({ ...menu, ...removeCategory(menu, categoryId) });
    setCategoryOpen(categoryId, false);
  };
  // 業務の縦の三点のボタンで出す一覧（ピン止め・カテゴリーに入れる・入れない・作る）
  const itemMenu = (id: string, pinned: boolean) => (close: () => void) => (
    <ItemMenuActions
      pinned={pinned} categories={menu.categories ?? []} categoryId={menu.categoryOf?.[id] ?? null} close={close}
      onPin={() => togglePin(id)} onAssign={(c) => setItemCategory(id, c)} onCreate={(name) => createCategoryFor(id, name)}
    />
  );
  // たたんだ見出しは、押すと開く。いま開いている業務がたたんだ中にあれば開いておく
  const sectionOpen = (sec: MenuSection<MenuItem>) =>
    (sec.category ? openCategories.has(sec.category.id) : moreOpen) || sec.items.some(isOpen);
  const toggleSection = (sec: MenuSection<MenuItem>, open: boolean) =>
    (sec.category ? setCategoryOpen(sec.category.id, open) : setMoreOpen(open));
  // 押すキー（1〜9）は見えている順に割り当てる（たたんだ中の業務には割り当てない）
  const menuAgents = [...topAgents, ...sections.filter(sectionOpen).flatMap((sec) => sec.items)];
  const hotkeyIndex = new Map(menuAgents.map((a, i) => [a.id, i]));
  useHotkey('Mod+,', useCallback(() => openSettings(), [openSettings]));
  useHotkey('Mod+/', useCallback(() => openSettings('keys'), [openSettings]));
  useHotkey('Mod+I', useCallback(() => setTalkOpen(!talkOpen), [talkOpen, setTalkOpen]));
  useNumberHotkeys(useCallback((n: number) => {
    const item = menuAgents[n - 1];
    if (item) openItem(item);
    // openItem は描くたびに作り直すが、中で使うのは状態の設定関数だけ
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [menuAgents]));
  // たたんでいる間に出た結果には、まだ見ていない印を出す（第6.2節）
  const [seen, setSeen] = useState<string | null>(null);
  useEffect(() => { if (talkOpen && result) setSeen(result.id); }, [talkOpen, result]);
  // ブラウザのタブの名前は、会社の略称とプロダクトの名前（仕様書 第6.6.1節）
  useEffect(() => {
    document.title = `${me.tenant.shortName || me.tenant.name} | M2Office`;
  }, [me.tenant.shortName, me.tenant.name]);
  const unread = notifications.filter((n) => !n.readAt).length;
  const isAdmin = me.user.roles.includes('admin');

  return (
    <div className="app">
      <header className="topbar">
        {/* 会社のロゴがあれば、プロダクトの名前の代わりに出す（仕様書 第6.6.1節） */}
        {me.tenant.logo
          ? <img className="brand-logo" src={me.tenant.logo} alt={me.tenant.shortName ?? me.tenant.name} />
          : <span className="brand">M2Office</span>}
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
        style={talkWidth > 0 ? ({ '--talk-px': `${talkWidth}px` } as CSSProperties) : undefined}
        nav={(
          <>
            <NavHeading>業務</NavHeading>
            {topAgents.map((a, i) => (
              <MenuNavItem
                key={a.id} menu={itemMenu(a.id, true)}
                icon={a.icon} label={a.name} description={a.description}
                active={isOpen(a)}
                // 1〜9 番目には、押すキーを併記する（仕様書 第6.11.1節 k4）
                hint={i < 9 ? keyLabel(`Mod+Shift+${i + 1}`) : ''}
                onClick={() => openItem(a)}
              />
            ))}
            {/* カテゴリーごと（作った順）と、最後に「ほかの業務」。1 つずつたためる（仕様書 第6.1.1節） */}
            {sections.map((sec) => {
              const open = sectionOpen(sec);
              const key = sec.category?.id ?? 'others';
              const header = {
                icon: (sec.category ? 'folder' : 'apps') as IconName,
                label: `${sec.category?.name ?? 'ほかの業務'}（${sec.items.length}）`,
                expanded: open,
                onClick: () => toggleSection(sec, !open),
              };
              return (
                <Fragment key={key}>
                  {sec.category
                    ? (
                      <MenuNavItem
                        {...header}
                        menu={(close) => (
                          <CategoryMenuActions
                            category={sec.category!} close={close}
                            onRename={(name) => renameCategory(sec.category!.id, name)}
                            onRemove={() => deleteCategory(sec.category!.id)}
                          />
                        )}
                      />
                    )
                    : <NavItem {...header} />}
                  {open && sec.items.map((a) => {
                    const n = hotkeyIndex.get(a.id);
                    return (
                      <MenuNavItem
                        key={a.id} menu={itemMenu(a.id, false)}
                        icon={a.icon} label={a.name} description={a.description}
                        active={isOpen(a)}
                        hint={n !== undefined && n < 9 ? keyLabel(`Mod+Shift+${n + 1}`) : ''}
                        onClick={() => openItem(a)}
                        className="item nav-other"
                      />
                    );
                  })}
                </Fragment>
              );
            })}
            <NavHeading>自分の状況</NavHeading>
            <NavItem icon="approvals" label="承認トレイ" description="あなたが判断する承認と、操作の確認" count={approvals.length}
              active={view.kind === 'approvals'} onClick={() => setView({ kind: 'approvals' })} />
            <NavItem icon="history" label="実行履歴" description="過去の依頼と結果"
              active={view.kind === 'history'} onClick={() => setView({ kind: 'history' })} />
            <NavItem icon="notifications" label="お知らせ" description="あなた宛ての通知。朝のブリーフ・週次ブリーフもここに届きます" count={unread}
              active={view.kind === 'notifications'} onClick={() => setView({ kind: 'notifications' })} />
            <NavItem icon="schedules" label="定時実行" description="決まった時刻に、あなたの権限で業務を実行します"
              active={view.kind === 'schedules'} onClick={() => setView({ kind: 'schedules' })} />
            {/* 人事の台帳に結び付いた人だけ（仕様書 第30.25節） */}
            {me.hrSelf && (
              <NavItem icon="calendar" label="給与・勤怠" description="打刻・今月の勤怠・有給の残りと申請"
                active={view.kind === 'attendance'} onClick={() => setView({ kind: 'attendance' })} />
            )}
            <NavItem icon="help" label="ヘルプ" description="使い方の記事と検索"
              active={view.kind === 'help'} onClick={() => setView({ kind: 'help', articleId: null })} />
            {/* デバッグモードのときだけ（仕様書 第20.4.1節「デバッグモード」） */}
            {me.debug && (
              <NavItem icon="console" label="デバッグ" description="音声・秘書の振り分け・失敗した呼び出しの記録"
                onClick={openDebugPanel} />
            )}
          </>
        )}
        navFooter={(
          <NavUserCard
            name={me.user.displayName} role={primaryRole(me.user.roles)} photo={me.photo}
            active={view.kind === 'settings'} sections={settingsSections}
            current={view.kind === 'settings' ? view.section : undefined}
            onOpenSettings={openSettings}
          />
        )}
        footer={(
          <SecretaryBar
            lookups={lookups}
            avatar={avatar}
            captions={captions}
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
              <h1>承認トレイ <HelpTip article="start-approvals">承認すると業務が続きから進み、却下するとそこで終わります。社外に出るものとお金の確定は、承認のあとにだけ行います。</HelpTip></h1>
              <ApprovalTray items={approvals} onDecided={() => void refresh()} />
            </>
          )}
          {view.kind === 'notifications' && (
            <>
              <h1>お知らせ</h1>
              <Notifications items={notifications} onRead={() => void refresh()} />
            </>
          )}
          {view.kind === 'cards' && (
            <>
              <h1>名刺管理 <HelpTip article="start-cards">撮るかファイルを選ぶと、AI が読み取って登録します。秘書に「〇〇さんの電話番号は？」と聞けます。</HelpTip></h1>
              <Cards contactId={view.contactId} onOpen={(contactId) => setView({ kind: 'cards', contactId })}
                mailer={{ email: me.user.email, google: me.workspaceSource === 'google' }} admin={me.user.roles.includes('admin')}
                onApprovals={() => { void refresh(); setView({ kind: 'approvals' }); }} />
            </>
          )}
          {view.kind === 'inventory' && (
            <>
              <h1>在庫管理 <HelpTip article="start-inventory">品目と数を記録します。秘書に「〇〇の在庫は？」「〇〇を 2 箱入庫して」と頼めます。</HelpTip></h1>
              <Inventory itemId={view.itemId} onOpen={(itemId) => setView({ kind: 'inventory', itemId })} userId={me.user.id} />
            </>
          )}
          {view.kind === 'signage' && (
            <>
              <h1>サイネージ <HelpTip article="start-signage">店頭や待合の画面に、画像と動画を繰り返し流します。</HelpTip></h1>
              <Signage />
            </>
          )}
          {view.kind === 'attendance' && (
            <>
              <h1>給与・勤怠 <HelpTip article="start-attendance">打刻と今月の勤怠、有給の残りと申請。秘書に「出勤」「有給あと何日？」と言っても扱えます。</HelpTip></h1>
              <MyAttendance />
            </>
          )}
          {view.kind === 'hr' && (
            <>
              <h1>人事・給与 <HelpTip article="start-hr">従業員の台帳と雇用条件を持ち、入社・退職の手続きを期限つきで並べます。</HelpTip></h1>
              <Hr employeeId={view.employeeId} onOpen={(employeeId) => setView({ kind: 'hr', employeeId })} />
            </>
          )}
          {view.kind === 'schedules' && (
            <>
              <h1>定時実行 <HelpTip article="start-schedules">決まった時刻に、あなたの権限で業務を自動で実行します。「今すぐ実行」で動きを確かめられます。</HelpTip></h1>
              {/* 秘書が止めた・再開したことを一覧に映すため、秘書の答えが出るたびに読み直す（仕様書 第10.9.8節） */}
              <Schedules agents={agents} reloadKey={result?.id} />
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
              {connectionReturn && CONNECTION_RETURN_TEXT[connectionReturn.result] && (
                <p className={CONNECTION_RETURN_TEXT[connectionReturn.result]!.ok ? 'ok-msg' : 'error'}>{CONNECTION_RETURN_TEXT[connectionReturn.result]!.text}</p>
              )}
              {googleReturn && GOOGLE_RETURN_TEXT[googleReturn] && (
                <p className={GOOGLE_RETURN_TEXT[googleReturn]!.ok ? 'ok-msg' : 'error'}>{GOOGLE_RETURN_TEXT[googleReturn]!.text}</p>
              )}
              <Settings me={me} agents={menuItems} onChanged={loadMenu} section={view.section} />
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
          {talkOpen && <CanvasSash onChange={setTalkWidth} />}
          {/* 開け閉めのボタンと題を 1 行に置く。題のために 1 行を使わない（第6.2節） */}
          <div className="talk-head">
            <button
              className="talk-toggle" onClick={() => setTalkOpen(!talkOpen)}
              title={talkOpen ? '秘書のキャンバスを閉じる' : '秘書のキャンバスを開く'}
              aria-label={talkOpen ? '秘書のキャンバスを閉じる' : '秘書のキャンバスを開く'} aria-expanded={talkOpen}
            >
              <Icon name={talkOpen ? 'nav-collapse' : 'nav-expand'} />
              {!talkOpen && result && result.id !== seen && <span className="nav-dot" title="まだ見ていない結果があります">1</span>}
            </button>
            <h3>秘書のキャンバス</h3>
          </div>
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
            ) : null}
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
  cards: '名刺管理',
  inventory: '在庫管理',
  hr: '人事・給与',
  attendance: '給与・勤怠',
  signage: 'サイネージ',
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
  evidence?: { label: string; value: string; kind?: 'source'; cited?: boolean }[];
}

/** 秘書のキャンバスの幅の下限（px。仕様書 第6.2節）。これより狭いと答えが読めない。 */
const TALK_MIN_WIDTH = 280;
/** キーボードで幅を変えるときの 1 回の量（px）。 */
const TALK_WIDTH_STEP = 24;

/**
 * 秘書のキャンバスの左端の境目（仕様書 第6.2節）。つかんで左右に動かすと幅が変わる。
 *
 * @param onChange 新しい幅（px）。**0 は既定の幅**（左ペインを除いた残りの半分）を表す
 *
 * @remarks
 * 広げられるのは既定の幅まで。いちばん広くしたら 0（既定）として覚え、画面の広さが変わっても半分に追従させる。
 * ダブルクリックで既定の幅に戻す。キーボードでは、境目に移って左右の矢印で変える。
 * 狭い画面（キャンバスの下に積むとき）では CSS で隠す。
 */
function CanvasSash({ onChange }: { onChange: (px: number) => void }) {
  const sash = useRef<HTMLDivElement>(null);
  const dragging = useRef(false);

  /** いまの幅と、広げられる上限（左ペインを除いた残りの半分）。 */
  const measure = () => {
    const aside = sash.current?.parentElement;
    const nav = aside?.parentElement?.querySelector('.left');
    if (!aside || !nav) return null;
    const box = aside.getBoundingClientRect();
    return { right: box.right, width: box.width, max: (box.right - nav.getBoundingClientRect().right) / 2 };
  };
  /** 幅を下限と上限の間に収めて渡す。上限に届いたら既定（0）にする。 */
  const apply = (px: number, max: number) => {
    const w = Math.round(Math.max(TALK_MIN_WIDTH, Math.min(px, max)));
    onChange(w >= Math.floor(max) - 1 ? 0 : w);
  };

  return (
    <div
      ref={sash} className="talk-sash" role="separator" aria-orientation="vertical" tabIndex={0}
      aria-label="秘書のキャンバスの幅" title="ドラッグで幅を変える（ダブルクリックで元の幅）"
      onPointerDown={(e) => {
        e.preventDefault();
        e.currentTarget.setPointerCapture(e.pointerId);
        dragging.current = true;
        document.body.classList.add('resizing');
      }}
      onPointerMove={(e) => {
        if (!dragging.current) return;
        const m = measure();
        if (m) apply(m.right - e.clientX, m.max);
      }}
      onPointerUp={(e) => {
        dragging.current = false;
        e.currentTarget.releasePointerCapture(e.pointerId);
        document.body.classList.remove('resizing');
      }}
      onDoubleClick={() => onChange(0)}
      onKeyDown={(e) => {
        const m = measure();
        if (!m) return;
        // 境目は左端にある。左へ動かすと広がり、右へ動かすと狭まる
        if (e.key === 'ArrowLeft') apply(m.width + TALK_WIDTH_STEP, m.max);
        else if (e.key === 'ArrowRight') apply(m.width - TALK_WIDTH_STEP, m.max);
        else return;
        e.preventDefault();
      }}
    />
  );
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
      {/* 会話の画面には答えだけを出し、根拠は畳む（仕様書 第6.2節「会話の画面には答えだけを出す」）。結果が変わったら閉じ直す */}
      {(facts.length > 0 || sources.length > 0) && (
        <details className="fold evidence-fold" key={result.id}>
          <summary>根拠</summary>
          {sources.length > 0 && <Sources items={sources} reply={result.text} />}
          {facts.length > 0 && (
            <dl className="kv">
              {facts.map((e, i) => (
                <div key={i} style={{ display: 'contents' }}>
                  <dt>{e.label}</dt><dd>{e.value}</dd>
                </div>
              ))}
            </dl>
          )}
        </details>
      )}
      {result.note && <p className="muted small">{result.note}</p>}
    </div>
  );
}

/**
 * 常駐の秘書バー。どの画面からでも呼び出せる（仕様書 第10.4節）。
 * 音声でも話しかけられ（第10.5節）、手元のファイルを 1 つ渡せる（第10.10節）。
 */
function SecretaryBar({ lookups, avatar, captions, onResult, onVoice }: {
  /** 後ろで動いている調べもの。処理中であることを常に見せる（仕様書 第10.11.6節） */
  lookups: Lookup[];
  /** 秘書のアバター（個人設定。仕様書 第6.1.3節） */
  avatar: string;
  /** 音声の字幕を出すか（仕様書 第6.5.3節「会話を文字で出す」）。 */
  captions: boolean;
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
  const running = lookups.filter((x) => !x.done);

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
        // 応答の層・時間・トークンは会話の画面に出さない（仕様書 第6.2節）。ファイルの扱いの知らせだけを添える
        ...(reply.file?.note ? { note: reply.file.note } : {}),
        ...(reply.suggestedAgent
          ? { suggestedAgent: { id: reply.suggestedAgent.id, name: reply.suggestedAgent.name }, fileId: withFile?.id ?? null }
          : {}),
        ...(reply.helpArticles ? { helpArticles: reply.helpArticles } : {}),
        ...(reply.evidence.length > 0 ? { evidence: reply.evidence } : {}),
      });
      // どの層で答えたかは出さない（仕様書 第6.2節）。「考えています…」を消すだけ
      setHint(null);
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
        高さは決めてあり、長い文は新しい側を見せる。本人が「会話を文字で出す」を切っていれば出さない
      */}
      {call && captions && (
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

/**
 * 本人宛の通知の一覧。開くと既読になる。1 件ずつ、または選んだものをまとめて消せる（仕様書 第6.5.5節）。
 *
 * @remarks 本人の受け取り箱の整理なので、消す前に確認を挟まない（ADR-0028）
 */
function Notifications({ items, onRead }: { items: Notification[]; onRead: () => void }) {
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [error, setError] = useState<string | null>(null);
  // 一覧が変わったら、無くなったお知らせを選んだままにしない
  useEffect(() => {
    setSelected((cur) => new Set([...cur].filter((id) => items.some((n) => n.id === id))));
  }, [items]);
  if (items.length === 0) return <p className="muted">お知らせはありません</p>;
  const all = selected.size === items.length;
  const toggle = (id: string) => setSelected((cur) => {
    const next = new Set(cur);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });
  const remove = (fn: () => Promise<unknown>) => {
    setError(null);
    void fn().then(() => { setSelected(new Set()); onRead(); }).catch((e) => setError(describeError(e, '削除できませんでした')));
  };
  return (
    <>
      <div className="row notice-tools">
        <label className="check small"><input type="checkbox" checked={all} onChange={() => setSelected(all ? new Set() : new Set(items.map((n) => n.id)))} /> すべて選ぶ</label>
        {selected.size > 0 && <button className="btn small" onClick={() => remove(() => api.deleteNotifications([...selected]))}>選んだ {selected.size} 件を削除</button>}
      </div>
      {error && <p className="error">{error}</p>}
      {items.map((n) => (
        <NoticeRow key={n.id} notice={n} onRead={onRead} selected={selected.has(n.id)} onSelect={() => toggle(n.id)} onDelete={() => remove(() => api.deleteNotification(n.id))} />
      ))}
    </>
  );
}

/**
 * お知らせ 1 件（仕様書 第6.2.4節）。**その場で開く。**
 *
 * @remarks
 * 開いたときに読んだことにする。**閉じても読んだままにする**（開き直すたびに未読へ戻さない）。
 */
function NoticeRow({ notice, onRead, selected, onSelect, onDelete }: {
  notice: Notification; onRead: () => void; selected: boolean; onSelect: () => void; onDelete: () => void;
}) {
  const [open, setOpen] = useState(false);
  const unread = !notice.readAt;
  return (
    <div className={`card fold-row${open ? ' open' : ''}${unread ? ' unread' : ''}`}>
      <div className="notice-line">
        <input type="checkbox" className="notice-check" checked={selected} onChange={onSelect} aria-label={`「${notice.title}」を選ぶ`} />
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
        <button className="btn ghost small notice-delete" onClick={onDelete} aria-label={`「${notice.title}」を削除`}>削除</button>
      </div>
      {open && (
        <div className="fold-body">
          <div className="reply"><Markdown text={notice.body} lineBreaks /></div>
        </div>
      )}
    </div>
  );
}

function roleLabel(role: string): string {
  return ({ admin: '管理者', approver: '承認者', member: '一般', external: '外部協力者', developer: '開発者' } as Record<string, string>)[role] ?? role;
}

/** 利用者のカードに出す属性。ロールのうち最も強いもの（仕様書 第6.1.1節）。 */
function primaryRole(roles: readonly string[]): string {
  for (const r of ['admin', 'approver', 'member', 'external', 'developer']) if (roles.includes(r)) return roleLabel(r);
  return '一般';
}
