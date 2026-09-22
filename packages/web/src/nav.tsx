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

import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import { useTheme } from './theme.js';

/** アイコンの名前（public/icons.svg の symbol の id）。 */
export type IconName =
  | 'mail' | 'calendar' | 'knowledge' | 'meeting' | 'briefing' | 'research' | 'report' | 'sample' | 'agent'
  | 'approvals' | 'history' | 'notifications' | 'schedules' | 'help' | 'user'
  | 'dashboard' | 'usage' | 'runs' | 'company' | 'sliders' | 'extensions' | 'users' | 'audit' | 'connectors'
  | 'nav-collapse' | 'nav-expand' | 'sun' | 'moon' | 'logout';

/** モノクロのアイコン。文字の色を引き継ぐ。飾りなので読み上げない。 */
export function Icon({ name, className }: { name: IconName; className?: string }) {
  return (
    <svg className={`icon${className ? ` ${className}` : ''}`} aria-hidden="true" focusable="false">
      <use href={`/icons.svg#${name}`} />
    </svg>
  );
}

/** 業務の分類（`category`）からアイコンを決める。対応が無ければ共通のアイコン。 */
export function agentIcon(category: string): IconName {
  const map: Record<string, IconName> = {
    mail: 'mail', calendar: 'calendar', knowledge: 'knowledge', meeting: 'meeting', briefing: 'briefing',
    research: 'research', report: 'report', sample: 'sample',
  };
  return map[category] ?? 'agent';
}

const KEY = 'm2office.nav-collapsed';
const Collapsed = createContext(false);

/** 折りたたんだかどうか（端末ごとに覚える）。 */
function useCollapsed(): [boolean, (v: boolean) => void] {
  const [v, setV] = useState(() => {
    try { return localStorage.getItem(KEY) === '1'; } catch { return false; }
  });
  useEffect(() => {
    try { localStorage.setItem(KEY, v ? '1' : '0'); } catch { /* 覚えられなくても動く */ }
  }, [v]);
  return [v, setV];
}

/**
 * 折りたためる左ペインと、その右の領域。`panes` の格子の列の幅を、折りたたみに合わせて変える。
 *
 * @param extraClass `panes` に足すクラス（サッシパネルを開くときの `with-sash` など）
 */
export function SideNavLayout({ nav, children, extraClass = '' }: { nav: ReactNode; children: ReactNode; extraClass?: string }) {
  const [collapsed, setCollapsed] = useCollapsed();
  return (
    <div className={`panes${collapsed ? ' nav-collapsed' : ''}${extraClass ? ` ${extraClass}` : ''}`}>
      <nav className={`left${collapsed ? ' collapsed' : ''}`} aria-label="メニュー">
        <button
          className="nav-toggle" onClick={() => setCollapsed(!collapsed)}
          title={collapsed ? 'メニューを広げる' : 'メニューを狭くする（アイコンだけ）'}
          aria-label={collapsed ? 'メニューを広げる' : 'メニューを狭くする'} aria-expanded={!collapsed}
        >
          <Icon name={collapsed ? 'nav-expand' : 'nav-collapse'} />
        </button>
        <Collapsed.Provider value={collapsed}>{nav}</Collapsed.Provider>
      </nav>
      {children}
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
 */
export function NavItem({ icon, label, description, active, count, onClick, className = 'item' }: {
  icon: IconName; label: string; description?: string; active?: boolean; count?: number;
  onClick: () => void; className?: string;
}) {
  const collapsed = useContext(Collapsed);
  const tip = description ? `${label}\n${description}` : label;
  return (
    <button
      className={`${className}${active ? ' active' : ''}`} onClick={onClick}
      title={tip} aria-label={collapsed ? label : undefined} aria-description={description}
      aria-current={active ? 'page' : undefined}
    >
      <span className="nav-icon">
        <Icon name={icon} />
        {count ? <span className="nav-dot">{count > 99 ? '99+' : count}</span> : null}
      </span>
      <span className="nav-label">{label}</span>
      {count ? <span className="count">{count}</span> : null}
    </button>
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
