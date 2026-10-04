/**
 * @file 上の帯の小さなメニュー 2 つ。版の表示（「このアプリについて」）と、アプリの一覧（Google のサービスと本人が登録したリンク。仕様書 第6.1.1.1節・第6.1.1.2節）。
 */

import { useEffect, useRef, useState, type RefObject } from 'react';
import { checkLauncherUrl, LAUNCHER_LABEL_MAX, LAUNCHER_LINK_MAX, type UserSettings } from '@m2office/shared';
import { api, describeError } from './api.js';
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

/** 登録したリンクの ID を作る（一覧の中で見分けるだけ）。 */
const newLinkId = () => `l-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

/**
 * アプリの一覧。Google の画面の右上にある格子のメニューと同じ形（仕様書 第6.1.1.2節）。
 *
 * 「編集」で、Google のサービスを 1 つずつ出す・出さないを選び、Google 以外のサイトを登録できる（本人だけの設定）。
 *
 * @param email 本人の Google アカウント。開く先のアカウントの指定にだけ使う
 * @param admin 管理者なら管理コンソールも並べる
 * @param google 会社が Google につないでいるか。つないでいなければ Google のサービスは並べない（見本と本物が食い違うため）
 *
 * @remarks 開く先には参照元を渡さない（`noopener noreferrer`）。登録したサイトのアイコンは取りに行かない
 */
export function AppLauncher({ email, admin, google }: { email: string; admin: boolean; google: boolean }) {
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState(false);
  const [settings, setSettings] = useState<UserSettings['launcher'] | null>(null);
  const [label, setLabel] = useState('');
  const [url, setUrl] = useState('');
  const [error, setError] = useState<string | null>(null);
  const box = useRef<HTMLSpanElement>(null);
  const close = useRef(() => { setOpen(false); setEditing(false); setError(null); }).current;
  useDismiss(open, close, box);

  // 開いたときに、本人の設定を読む（ほかの端末で変えたものも映すため、開くたびに読み直す）
  useEffect(() => {
    if (!open) return;
    api.mySettings().then((s) => setSettings(s.launcher)).catch(() => setSettings({ hidden: [], links: [] }));
  }, [open]);

  const current = settings ?? { hidden: [], links: [] };
  const services = google ? googleLinks(email, { admin }) : [];
  const shown = services.filter((l) => !current.hidden.includes(l.id));

  /** 変えたらすぐ保存する。断られたら元に戻し、理由を出す。 */
  const save = (next: UserSettings['launcher']) => {
    const before = current;
    setSettings(next);
    setError(null);
    return api.saveMySettings('launcher', next).then(() => true).catch((e) => {
      setSettings(before);
      setError(describeError(e));
      return false;
    });
  };
  const toggle = (id: string) => save({
    ...current, hidden: current.hidden.includes(id) ? current.hidden.filter((x) => x !== id) : [...current.hidden, id],
  });
  const add = () => {
    const checked = checkLauncherUrl(url);
    if ('error' in checked) { setError(checked.error); return; }
    if ([...label.trim()].length > LAUNCHER_LABEL_MAX) { setError(`名前は ${LAUNCHER_LABEL_MAX} 字までにしてください`); return; }
    if (current.links.length >= LAUNCHER_LINK_MAX) { setError(`リンクは ${LAUNCHER_LINK_MAX} 件までです`); return; }
    const link = { id: newLinkId(), label: label.trim() || new URL(checked.url).hostname, url: checked.url };
    void save({ ...current, links: [...current.links, link] }).then((ok) => { if (ok) { setLabel(''); setUrl(''); } });
  };
  const remove = (id: string) => save({ ...current, links: current.links.filter((l) => l.id !== id) });

  return (
    <span className="topbar-menu" ref={box}>
      <button
        className="icon-btn" onClick={() => (open ? close() : setOpen(true))} aria-expanded={open}
        title="アプリ" aria-label="アプリ"
      >
        <Icon name="apps" />
      </button>
      {open && (
        <div className="topbar-popover launcher" role="menu" aria-label="アプリ">
          <div className="launcher-head">
            <p className="popover-title">アプリ（新しいタブで開きます）</p>
            <button className="link-btn" onClick={() => { setEditing(!editing); setError(null); }}>{editing ? '完了' : '編集'}</button>
          </div>
          {!editing && (
            <div className="launcher-grid">
              {shown.map((l) => (
                <a
                  key={l.id} role="menuitem" className="launcher-item" href={l.href}
                  target="_blank" rel="noopener noreferrer" title={l.description} onClick={close}
                >
                  <Icon name={l.icon} />
                  <span>{l.label}</span>
                </a>
              ))}
              {current.links.map((l) => (
                <a
                  key={l.id} role="menuitem" className="launcher-item" href={l.url}
                  target="_blank" rel="noopener noreferrer" title={l.url} onClick={close}
                >
                  <span className="launcher-letter" aria-hidden="true">{[...l.label][0] ?? '?'}</span>
                  <span className="launcher-label">{l.label}</span>
                </a>
              ))}
              {settings && shown.length === 0 && current.links.length === 0 && (
                <button className="launcher-item" onClick={() => setEditing(true)}>
                  <Icon name="apps" />
                  <span>リンクを足す</span>
                </button>
              )}
            </div>
          )}
          {editing && (
            <div className="launcher-edit">
              {services.length > 0 && (
                <div className="launcher-grid">
                  {services.map((l) => {
                    const on = !current.hidden.includes(l.id);
                    return (
                      <button
                        key={l.id} className={`launcher-item${on ? '' : ' off'}`} aria-pressed={on}
                        title={on ? `${l.label}を出さない` : `${l.label}を出す`} onClick={() => void toggle(l.id)}
                      >
                        <Icon name={l.icon} />
                        <span>{l.label}</span>
                      </button>
                    );
                  })}
                </div>
              )}
              {current.links.length > 0 && (
                <ul className="launcher-links">
                  {current.links.map((l) => (
                    <li key={l.id}>
                      <span className="launcher-letter small" aria-hidden="true">{[...l.label][0] ?? '?'}</span>
                      <span className="launcher-link-text">
                        <strong>{l.label}</strong>
                        <span className="muted small">{l.url}</span>
                      </span>
                      <button className="link-btn" onClick={() => void remove(l.id)}>削除</button>
                    </li>
                  ))}
                </ul>
              )}
              {current.links.length < LAUNCHER_LINK_MAX && (
                <form className="launcher-add" onSubmit={(e) => { e.preventDefault(); add(); }}>
                  <input value={label} onChange={(e) => setLabel(e.target.value)} placeholder="名前" maxLength={LAUNCHER_LABEL_MAX} aria-label="リンクの名前" />
                  <input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://" inputMode="url" aria-label="リンクの URL" />
                  <button className="btn small" type="submit" disabled={!url.trim()}>足す</button>
                </form>
              )}
            </div>
          )}
          {error && <p className="error small">{error}</p>}
        </div>
      )}
    </span>
  );
}
