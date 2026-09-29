/**
 * @file 画面の入口。ログインの状態を確かめ、ワークスペース・管理者ページ・ログイン画面を出し分ける。
 *
 * @see 仕様書 第6章 ユーザー体験
 */

import { StrictMode, useCallback, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App.js';
import { Admin } from './Admin.js';
import { Board } from './Dashboard.js';
import { Login, takeReturnPath } from './Login.js';
import { MobileInventory } from './MobileInventory.js';
import { api, ApiError, setUnauthorizedHandler, type Me } from './api.js';
import './styles.css';
import { applyTheme } from './theme.js';
import { DebugOverlay } from './DebugPanel.js';
import { setDebugMode } from './debug.js';

// 読み込みの途中で明るさが変わらないよう、描画の前に反映する（仕様書 第6.1.2節）
applyTheme();

/**
 * 画面の入口。ログインの状態を確かめ、ワークスペースか管理者ページを出す。
 *
 * @remarks
 * 管理者ページはテナントのサブドメイン配下の `/admin` に置く（仕様書 第6.6節）。
 * 掛け通しの画面（眺めるだけのダッシュボード）は `/board`（第6.7.2.1節）。スマホ用の在庫のページは `/m/inventory`（第29.11.1節）。
 * 画面の出し分けは利便のためであり、権限の判定は API 側で行う。
 */
function Root() {
  const [me, setMe] = useState<Me | null>(null);
  const [state, setState] = useState<'loading' | 'login' | 'ready' | 'error'>('loading');
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const got = await api.me();
      // デバッグモード（仕様書 第20.4.1節「デバッグモード」）。画面から呼んだ API を記録し始める
      setDebugMode(!!got.debug);
      setMe(got);
      // ログインの前に開こうとしていたページ（スマホ用の在庫のページなど）へ戻す（仕様書 第29.11.1節）
      const back = takeReturnPath();
      if (back && location.pathname === '/') history.replaceState(null, '', back);
      setState('ready');
    } catch (err) {
      if (err instanceof ApiError && err.needsLogin) {
        setState('login');
      } else {
        setError(err instanceof Error ? err.message : '読み込みに失敗しました');
        setState('error');
      }
    }
  }, []);

  useEffect(() => {
    setUnauthorizedHandler(() => { setMe(null); setState('login'); });
    void load();
  }, [load]);

  if (state === 'loading') return <p className="muted center">読み込み中…</p>;
  if (state === 'error') return <p className="error center">{error}</p>;
  if (state === 'login' || !me) return <Login onLoggedIn={() => void load()} />;

  const logout = async () => {
    await api.logout().catch(() => undefined);
    setMe(null);
    setState('login');
  };
  // デバッグモードでは、どの画面にも上に「Debug mode」を出し、押すと記録を開く（仕様書 第20.4.1節「デバッグモード」）
  const withDebug = (page: JSX.Element) => (me.debug ? <>{page}<DebugOverlay /></> : page);
  // スマホ用の在庫のページ（仕様書 第29.11.1節）。ワークスペースの枠（左のメニュー・秘書の欄）を出さない
  if (location.pathname.startsWith('/m/inventory')) return withDebug(<MobileInventory me={me} />);
  if (location.pathname.startsWith('/board')) {
    // 権限の判定は API が行う。ここは案内だけ（仕様書 第6.7.2.1節）
    if (!me.user.roles.includes('admin')) {
      return <p className="error center">この画面は管理者だけが開けます。</p>;
    }
    return withDebug(<Board tenantName={me.tenant.name} />);
  }
  return withDebug(location.pathname.startsWith('/admin')
    ? <Admin me={me} onLogout={logout} />
    : <App me={me} onLogout={logout} />);
}

const root = document.getElementById('root');
if (!root) throw new Error('#root が見つかりません');
createRoot(root).render(
  <StrictMode>
    <Root />
  </StrictMode>,
);
