/**
 * @file 上の帯の小さなメニュー 2 つ。版の表示（「このアプリについて」）と、Google のアプリの一覧（仕様書 第6.1.1.1節・第6.1.1.2節）。
 */

import { useEffect, useRef, useState, type RefObject } from 'react';
import { openHelp } from './help.js';
import { googleLinks } from './google-links.js';
import { Icon } from './nav.js';
import { APP_VERSION, versionMismatch } from './version.js';

/**
 * 開いている間だけ、外を押す・`Esc` で閉じる（仕様書 第6.11.1節 k3）。
 *
 * @param box メニューとボタンを包む要素。この中を押しても閉じない
 */
function useDismiss(open: boolean, close: () => void, box: RefObject<HTMLElement | null>): void {
  useEffect(() => {
    if (!open) return undefined;
    const away = (e: MouseEvent) => { if (!box.current?.contains(e.target as Node)) close(); };
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') close(); };
    // 開いたときの押下そのもので閉じないよう、次の周回から見る
    const timer = setTimeout(() => document.addEventListener('mousedown', away), 0);
    document.addEventListener('keydown', esc);
    return () => {
      clearTimeout(timer);
      document.removeEventListener('mousedown', away);
      document.removeEventListener('keydown', esc);
    };
  }, [open, close, box]);
}

/**
 * 「M2Office」の右に出す版。押すと「このアプリについて」を開く（仕様書 第6.1.1.1節）。
 *
 * @param serverVersion サーバーの版（`/v1/me`）。読めなければ `null`
 *
 * @remarks
 * 画面の版とサーバーの版が違えば、開いたままのタブが古い画面のままになっている。
 * 版の横に印を付け、メニューの中で再読み込みを促す。
 */
export function AppVersionBadge({ serverVersion }: { serverVersion: string | null }) {
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLSpanElement>(null);
  const close = useRef(() => setOpen(false)).current;
  useDismiss(open, close, box);
  const stale = versionMismatch(APP_VERSION, serverVersion);
  const shown = APP_VERSION ? `v${APP_VERSION}` : '版不明';

  return (
    <span className="topbar-menu" ref={box}>
      <button
        className={`version-badge${stale ? ' stale' : ''}`} onClick={() => setOpen(!open)} aria-expanded={open}
        aria-label={`このアプリについて（${shown}${stale ? '。新しい版があります' : ''}）`}
        title={stale ? '新しい版があります。押して確かめてください' : 'このアプリについて'}
      >
        {shown}{stale && <span className="version-dot" aria-hidden="true" />}
      </button>
      {open && (
        <div className="topbar-popover about" role="dialog" aria-label="このアプリについて">
          <p className="popover-title">このアプリについて</p>
          <dl className="about-list">
            <dt>画面の版</dt><dd>{APP_VERSION ?? '取得できませんでした'}</dd>
            <dt>サーバーの版</dt><dd>{serverVersion ?? '取得できませんでした'}</dd>
          </dl>
          {stale && (
            <div className="about-stale">
              <p>新しい版があります。再読み込みしてください。</p>
              <button className="btn small" onClick={() => location.reload()}>再読み込み</button>
            </div>
          )}
          <button className="link-btn" onClick={() => { setOpen(false); openHelp(); }}>更新情報を見る（ヘルプ）</button>
        </div>
      )}
    </span>
  );
}

/**
 * Google のアプリの一覧。Google の画面の右上にある格子のメニューと同じ形（仕様書 第6.1.1.2節）。
 *
 * @param email 本人の Google アカウント。開く先のアカウントの指定にだけ使う
 * @param admin 管理者なら管理コンソールも並べる
 *
 * @remarks 出す条件（会社が Google につないでいるとき）は、呼ぶ側で判断する。
 */
export function GoogleLauncher({ email, admin }: { email: string; admin: boolean }) {
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLSpanElement>(null);
  const close = useRef(() => setOpen(false)).current;
  useDismiss(open, close, box);
  const links = googleLinks(email, { admin });

  return (
    <span className="topbar-menu" ref={box}>
      <button
        className="icon-btn" onClick={() => setOpen(!open)} aria-expanded={open}
        title="Google のアプリ" aria-label="Google のアプリ"
      >
        <Icon name="apps" />
      </button>
      {open && (
        <div className="topbar-popover launcher" role="menu" aria-label="Google のアプリ">
          <p className="popover-title">Google のアプリ（新しいタブで開きます）</p>
          <div className="launcher-grid">
            {links.map((l) => (
              <a
                key={l.label} role="menuitem" className="launcher-item" href={l.href}
                target="_blank" rel="noopener noreferrer" title={l.description} onClick={() => setOpen(false)}
              >
                <Icon name={l.icon} />
                <span>{l.label}</span>
              </a>
            ))}
          </div>
        </div>
      )}
    </span>
  );
}
