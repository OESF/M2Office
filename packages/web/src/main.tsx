/**
 * @file 画面の入口。ログインの状態を確かめ、ワークスペース・管理者ページ・ログイン画面を出し分ける。
 *
 * @see 仕様書 第6章 ユーザー体験
 */

import { StrictMode, useCallback, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App.js';
import { Admin } from './Admin.js';
import { Login } from './Login.js';
import { api, ApiError, setUnauthorizedHandler, type Me } from './api.js';
import './styles.css';
import { applyTheme } from './theme.js';

// 読み込みの途中で明るさが変わらないよう、描画の前に反映する（仕様書 第6.1.2節）
applyTheme();

/**
 * 画面の入口。ログインの状態を確かめ、ワークスペースか管理者ページを出す。
 *
 * @remarks
 * 管理者ページはテナントのサブドメイン配下の `/admin` に置く（仕様書 第6.6節）。
 * 画面の出し分けは利便のためであり、権限の判定は API 側で行う。
 */
function Root() {
  const [me, setMe] = useState<Me | null>(null);
  const [state, setState] = useState<'loading' | 'login' | 'ready' | 'error'>('loading');
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setMe(await api.me());
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
  return location.pathname.startsWith('/admin')
    ? <Admin me={me} onLogout={logout} />
    : <App me={me} onLogout={logout} />;
}

const root = document.getElementById('root');
if (!root) throw new Error('#root が見つかりません');
createRoot(root).render(
  <StrictMode>
    <Root />
  </StrictMode>,
);
