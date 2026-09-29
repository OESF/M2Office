/**
 * @file 左ペインとアイコンの共通部品。アイコン、折りたためる左ペイン、項目、明るさの切り替えボタン。
 *
 * 項目は名前とアイコンだけを並べ、説明はマウスを重ねたときに出す（`title`）。画面の読み上げには名前と説明を渡す。
 * 左ペインを折りたたむとアイコンだけが並び、広げると名前も見える。折りたたんだかどうかは端末ごとに覚える。
 * ワークスペースと管理者ページの両方で使う。
 *
 * @see 仕様書 第6.1.1節 左ペインの表示
 * @see 仕様書 第6.1.2節 画面の明るさ（ライト・ダーク）
 */

import {
  createContext, useCallback, useContext, useEffect, useRef, useState, type CSSProperties, type ReactNode,
} from 'react';
import { AVATAR_PRESETS } from '@m2office/shared';
import { useTheme } from './theme.js';
import { keyLabel, useHotkey } from './keys.js';

/** アイコンの名前（public/icons.svg の symbol の id）。 */
export type IconName =
  | 'mail' | 'calendar' | 'knowledge' | 'meeting' | 'briefing' | 'research' | 'report' | 'sample' | 'agent'
  | 'approvals' | 'history' | 'notifications' | 'schedules' | 'help' | 'user' | 'settings'
  | 'dashboard' | 'usage' | 'runs' | 'company' | 'sliders' | 'extensions' | 'users' | 'audit' | 'connectors'
  | 'nav-collapse' | 'nav-expand' | 'caret-right' | 'caret-down' | 'back' | 'sun' | 'moon' | 'logout'
  | 'mic' | 'mic-off' | 'clip' | 'send' | 'tasks' | 'chat' | 'drive' | 'external'
  | 'doc' | 'sheet' | 'slides' | 'form' | 'video' | 'console' | 'apps' | 'pin' | 'cards' | 'inventory';

/** モノクロのアイコン。文字の色を引き継ぐ。飾りなので読み上げない。 */
export function Icon({ name, className }: { name: IconName; className?: string }) {
  return (
    <svg className={`icon${className ? ` ${className}` : ''}`} aria-hidden="true" focusable="false">
      <use href={`/icons.svg#${name}`} />
    </svg>
  );
}

/**
 * 秘書のアバター（仕様書 第6.1.3節）。
 *
 * @param avatar `preset:<id>` は同梱の線画、`file:<ID>` は本人が上げた画像。空なら人の形
 */
export function SecretaryAvatar({ avatar }: { avatar: string }) {
  // 画像が無いときは線画に落とす。同梱の画像をまだ置いていない場合にも壊れて見えない
  const [broken, setBroken] = useState(false);
  const preset = avatar.startsWith('preset:') ? avatar.slice('preset:'.length) : '';
  const src = avatar.startsWith('file:')
    // 本人が登録した画像だけを返す口を通す（任意のファイルは出せない）
    ? '/v1/me/avatar'
    : (AVATAR_PRESETS.some((a) => a.id === preset) ? `/avatars/${preset}.png` : '');

  if (!src || broken) return <Icon name="user" />;
  return <img src={src} alt="" className="avatar-img" onError={() => setBroken(true)} />;
}

/** 業務の分類（`category`）からアイコンを決める。対応が無ければ共通のアイコン。 */
export function agentIcon(category: string): IconName {
  const map: Record<string, IconName> = {
    mail: 'mail', calendar: 'calendar', knowledge: 'knowledge', meeting: 'meeting', briefing: 'briefing',
    research: 'research', report: 'report', sample: 'sample', document: 'doc',
  };
  return map[category] ?? 'agent';
}

const KEY = 'm2office.nav-collapsed';
const Collapsed = createContext(false);

/** 折りたたんだかどうか（端末ごとに覚える）。 */
/**
 * 開いているか閉じているかを、端末ごとに覚えておく（仕様書 第6.1.1節・第6.2節）。
 *
 * @param key 覚えておく先の鍵
 * @param initial まだ覚えていないときの値
 * @remarks 覚えられない環境（保存を禁じた設定）でも動く。そのときは毎回 `initial` から始まる
 */
export function useRemembered(key: string, initial: boolean): [boolean, (v: boolean) => void] {
  const [v, setV] = useState(() => {
    try {
      const raw = localStorage.getItem(key);
      return raw === null ? initial : raw === '1';
    } catch { return initial; }
  });
  useEffect(() => {
    try { localStorage.setItem(key, v ? '1' : '0'); } catch { /* 覚えられなくても動く */ }
  }, [key, v]);
  return [v, setV];
}

/**
 * 数（幅など）を、端末ごとに覚えておく（仕様書 第6.2節の秘書のキャンバスの幅）。
 *
 * @param key 覚えておく先の鍵
 * @param initial まだ覚えていないときの値
 * @remarks 覚えられない環境でも動く。そのときは毎回 `initial` から始まる。読めない値は `initial` とみなす
 */
export function useRememberedNumber(key: string, initial: number): [number, (v: number) => void] {
  const [v, setV] = useState(() => {
    try {
      const n = Number(localStorage.getItem(key));
      return localStorage.getItem(key) !== null && Number.isFinite(n) ? n : initial;
    } catch { return initial; }
  });
  useEffect(() => {
    try { localStorage.setItem(key, String(v)); } catch { /* 覚えられなくても動く */ }
  }, [key, v]);
  return [v, setV];
}

function useCollapsed(): [boolean, (v: boolean) => void] {
  return useRemembered(KEY, false);
}

/**
 * 折りたためる左ペインと、その右の領域。`panes` の格子の列の幅を、折りたたみに合わせて変える。
 * 左ペインは画面の下端まで伸ばし、`footer`（秘書バー）は左ペインの右側に置く（仕様書 第6.1節）。
 *
 * @param navFooter 左ペインの最下部に固定するもの（利用者のカード）
 * @param footer 右側の下端に置くもの（秘書バー）
 * @param extraClass `panes` に足すクラス（会話ペインを開くときの `talk-open` など）
 * @param style `panes` に渡す値（秘書のキャンバスの幅 `--talk-px` など）
 */
export function SideNavLayout({ nav, navFooter, footer, children, extraClass = '', style }: {
  nav: ReactNode; navFooter?: ReactNode; footer?: ReactNode; children: ReactNode; extraClass?: string; style?: CSSProperties;
}) {
  const [collapsed, setCollapsed] = useCollapsed();
  // メニューの開閉（仕様書 第6.11.3節）
  useHotkey('Mod+B', useCallback(() => setCollapsed(!collapsed), [collapsed, setCollapsed]));
  return (
    <div className={`panes${collapsed ? ' nav-collapsed' : ''}${extraClass ? ` ${extraClass}` : ''}`} style={style}>
      <nav className={`left${collapsed ? ' collapsed' : ''}`} aria-label="メニュー">
        <button
          className="nav-toggle" onClick={() => setCollapsed(!collapsed)}
          title={`${collapsed ? 'メニューを広げる' : 'メニューを狭くする（アイコンだけ）'}${
            keyLabel('Mod+B') ? `（${keyLabel('Mod+B')}）` : ''}`}
          aria-label={collapsed ? 'メニューを広げる' : 'メニューを狭くする'} aria-expanded={!collapsed}
        >
          <Icon name={collapsed ? 'nav-expand' : 'nav-collapse'} />
        </button>
        <Collapsed.Provider value={collapsed}>
          <div className="nav-scroll">{nav}</div>
          {navFooter && <div className="nav-footer">{navFooter}</div>}
        </Collapsed.Provider>
      </nav>
      {children}
      {footer && <div className="pane-footer">{footer}</div>}
    </div>
  );
}

/** 見出し。折りたたんだときは区切り線だけにする。 */
export function NavHeading({ children }: { children: string }) {
  // 表示の切り替えは CSS で行う（狭い画面では折りたたみを使わないため。仕様書 第6.1.1節）
  return <h2 className="nav-heading"><span>{children}</span></h2>;
}

/**
 * 左ペインの項目。名前とアイコンだけを並べ、説明はマウスを重ねたときに出す。
 *
 * @param description 説明。項目には並べず、`title` と読み上げに使う
 * @param count 件数（承認待ち・未読）。折りたたんだときはアイコンの右上に小さく出す
 * @param hint 押すキー（仕様書 第6.11.1節 k4）。**隠れたショートカットにしない**ため併記する
 * @param expanded 小分けを持つ区分のとき、開いているかどうか（第6.6.0節）。印を出す
 */
export function NavItem({
  icon, label, description, active, count, hint, expanded, onClick, className = 'item',
}: {
  icon: IconName; label: string; description?: string; active?: boolean; count?: number; hint?: string;
  expanded?: boolean;
  onClick: () => void; className?: string;
}) {
  const collapsed = useContext(Collapsed);
  const tip = [label, description, hint].filter(Boolean).join('\n');
  return (
    <button
      className={`${className}${active ? ' active' : ''}`} onClick={onClick}
      title={tip} aria-label={collapsed ? label : undefined} aria-description={description}
      aria-current={active ? 'page' : undefined}
      aria-expanded={expanded}
    >
      <span className="nav-icon">
        <Icon name={icon} />
        {count ? <span className="nav-dot">{count > 99 ? '99+' : count}</span> : null}
      </span>
      <span className="nav-label">{label}</span>
      {count ? <span className="count">{count}</span> : null}
      {!count && hint ? <kbd className="nav-key">{hint}</kbd> : null}
      {/* 小分けを持つ区分の、開いているかどうかの印（第6.6.0節） */}
      {expanded !== undefined && (
        <Icon name={expanded ? 'caret-down' : 'caret-right'} className="nav-caret" />
      )}
    </button>
  );
}

/**
 * ピン止めできる左ペインの項目（仕様書 第6.1.1節「業務の並び」）。項目の右端にピンのボタンを重ねる。
 *
 * @param pinned ピン止めしているか。しているときはピンの印を常に出し、していなければマウスを重ねたときだけ出す
 * @param onPin ピンのボタンを押したとき（止める・外す）
 * @remarks ボタンの中にボタンを入れられないため、項目とピンのボタンを並べて包む。折りたたんだ左ペインではピンを出さない
 */
export function PinnableNavItem({ pinned, onPin, ...item }: Parameters<typeof NavItem>[0] & { pinned: boolean; onPin: () => void }) {
  const collapsed = useContext(Collapsed);
  return (
    <div className={`nav-pin-row${pinned ? ' pinned' : ''}`}>
      <NavItem {...item} />
      {!collapsed && (
        <button
          className="nav-pin" onClick={onPin}
          title={pinned ? 'ピン止めを外す（「ほかの業務」に入ります）' : 'ピン止めする（いつも上に出します）'}
          aria-label={pinned ? `${item.label}のピン止めを外す` : `${item.label}をピン止めする`}
          aria-pressed={pinned}
        >
          <Icon name="pin" />
        </button>
      )}
    </div>
  );
}

/**
 * 左ペインの最下部の利用者のカード。名前と属性を並べ、右端の歯車のボタンで個人設定を開く（仕様書 第6.1.1節）。
 * 折りたたんだときは歯車のボタンだけを示す。
 *
 * @param role 属性（例: 管理者）
 */
export function NavUserCard({ name, role, photo = null, active, sections, current, onOpenSettings }: {
  name: string; role: string;
  /** 本人のアバター（Google のプロフィール写真。仕様書 第6.5.1.1節）。無ければ人の形のアイコン。 */
  photo?: string | null;
  active?: boolean;
  /** 歯車を押したときに出す区分の一覧（仕様書 第6.5.0節）。 */
  sections: readonly { id: string; label: string; hint: string }[];
  /** いま開いている区分。 */
  current?: string;
  onOpenSettings: (section: string) => void;
}) {
  const tip = `${name}（${role}）\n個人設定を開く`;
  const [open, setOpen] = useState(false);
  // 写真が読めなければ、アイコンに戻す（壊れた画像の印を出さない）
  const [broken, setBroken] = useState(false);
  useEffect(() => setBroken(false), [photo]);
  const box = useRef<HTMLDivElement>(null);
  // 外を押す・Esc で閉じる（仕様書 第6.5.0節・第6.11.1節 k3）
  useEffect(() => {
    if (!open) return undefined;
    const away = (e: MouseEvent) => { if (!box.current?.contains(e.target as Node)) setOpen(false); };
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    const timer = setTimeout(() => document.addEventListener('mousedown', away), 0);
    document.addEventListener('keydown', esc);
    return () => {
      clearTimeout(timer);
      document.removeEventListener('mousedown', away);
      document.removeEventListener('keydown', esc);
    };
  }, [open]);

  const choose = (id: string) => { setOpen(false); onOpenSettings(id); };

  return (
    <div className={`user-card${active ? ' active' : ''}`} ref={box}>
      <button className="user-card-main" onClick={() => setOpen(!open)} title={tip} tabIndex={-1} aria-hidden="true">
        <span className="avatar">
          {photo && !broken ? <img src={photo} alt="" onError={() => setBroken(true)} /> : <Icon name="user" />}
        </span>
        <span className="user-text">
          <strong>{name}</strong>
          <span className="role">{role}</span>
        </span>
      </button>
      <button
        className="gear" onClick={() => setOpen(!open)} title={tip} aria-label={`個人設定（${name}・${role}）`}
        aria-expanded={open} aria-current={active ? 'page' : undefined}
      >
        <Icon name="settings" />
      </button>
      {/* 設定の区分を選ぶ一覧。ここから直接その区分へ入る（仕様書 第6.5.0節） */}
      {open && (
        <div className="settings-menu" role="menu">
          <p className="settings-menu-title">個人設定</p>
          {sections.map((x) => (
            <button
              key={x.id} role="menuitem" className={`settings-menu-item${current === x.id ? ' active' : ''}`}
              // 何を設定するかは、マウスを重ねたときだけ出す（原則 u11）
              onClick={() => choose(x.id)} title={x.hint}
            >
              <span className="settings-menu-label">{x.label}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/** 上部の明るさの切り替えボタン。押すたびにライトとダークを切り替える。 */
export function ThemeToggle() {
  const { effective, set } = useTheme();
  const next = effective === 'dark' ? 'light' : 'dark';
  const label = next === 'dark' ? 'ダークに切り替える' : 'ライトに切り替える';
  return (
    <button className="icon-btn" onClick={() => set(next)} title={label} aria-label={label}>
      <Icon name={effective === 'dark' ? 'sun' : 'moon'} />
    </button>
  );
}
