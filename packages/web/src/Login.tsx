/**
 * @file ログイン画面。Google ログインと、準備中の間だけ使う開発用ログインを出す。
 *
 * @see 仕様書 第16.1節 認証
 */

import { useEffect, useState } from 'react';
import { api, type LoginProviders } from './api.js';

/**
 * ログイン画面。
 *
 * 正式なログインは Google アカウントのみ（仕様書 第16.1節）。
 * Google の設定が整うまでは、開発用ログイン（利用者を選ぶ）を下に出す。
 * 開発用ログインは本番では API 側で無効になり、ここにも表示されない。
 */
export function Login({ onLoggedIn }: { onLoggedIn: () => void }) {
  const [providers, setProviders] = useState<LoginProviders | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api.providers().then(setProviders).catch((err) =>
      setError(err instanceof Error ? err.message : 'テナントを特定できません'));
  }, []);

  // Google から戻ってきたとき（仕様書 第16.1.2節）。
  // 引換券があれば、このホストでのログイン状態に換える
  useEffect(() => {
    const q = new URLSearchParams(location.search);
    const ticket = q.get('ticket');
    const result = q.get('login');
    // 券もしるしも URL に残さない。戻るボタンで再び使わせない
    if (ticket || result) history.replaceState(null, '', location.pathname);
    if (ticket) {
      setBusy(true);
      api.exchangeTicket(ticket)
        .then(onLoggedIn)
        .catch(() => setError('ログインできませんでした。もう一度お試しください。'))
        .finally(() => setBusy(false));
      return;
    }
    if (result === 'denied') setError('このアカウントではログインできません。管理者に招待を依頼してください。');
    if (result === 'cancelled') setError('ログインを取りやめました。');
    if (result === 'failed') setError('ログインできませんでした。もう一度お試しください。');
  }, [onLoggedIn]);

  /** Google の同意画面へ進む。 */
  async function googleLogin() {
    setBusy(true);
    setError(null);
    try {
      rememberReturnPath();
      location.href = (await api.googleLoginUrl()).url;
    } catch (err) {
      setError(err instanceof Error ? err.message : 'ログインを始められませんでした');
      setBusy(false);
    }
  }

  async function devLogin(email: string) {
    setBusy(true);
    setError(null);
    try {
      await api.devLogin(email);
      onLoggedIn();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'ログインできませんでした');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="login">
      <div className="card login-card">
        <h1>M2Office</h1>
        <p className="lead">{providers?.tenant.name ?? '読み込み中…'}</p>

        <button className="btn google" disabled={!providers?.google.enabled || busy}
          onClick={() => void googleLogin()}>
          {busy ? '…' : 'Google アカウントでログイン'}
        </button>
        {providers && !providers.google.enabled && (
          <p className="muted small">{providers.google.reason}</p>
        )}

        {providers?.dev.enabled && (
          <div className="dev-login">
            <h3>開発用ログイン</h3>
            {providers.dev.users.map((u) => (
              <button key={u.email} className="btn ghost wide" disabled={busy}
                onClick={() => void devLogin(u.email)}>
                {u.displayName}
                <span className="sub">{u.email}（{u.roles.join('・')}）</span>
              </button>
            ))}
          </div>
        )}
        {error && <p className="error">{error}</p>}
      </div>
    </div>
  );
}

/** ログインのあとに戻すページを覚えておく鍵（仕様書 第29.11.1節）。 */
const RETURN_KEY = 'm2o.after-login';

/**
 * 開こうとしたページを覚える。Google のログインは会社のトップに戻るため、戻ったあとで {@link takeReturnPath} で戻す。
 *
 * @remarks 覚えるのは同じ会社の中の道と問い合わせだけ（`/` で始まる）。保存できない端末では何もしない
 */
export function rememberReturnPath(): void {
  const path = `${location.pathname}${location.search}`;
  if (path === '/' || !path.startsWith('/')) return;
  try { sessionStorage.setItem(RETURN_KEY, path); } catch { /* 覚えられなくてもログインは続ける */ }
}

/** 覚えておいたページを取り出して消す。無ければ `null`。 */
export function takeReturnPath(): string | null {
  try {
    const path = sessionStorage.getItem(RETURN_KEY);
    sessionStorage.removeItem(RETURN_KEY);
    return path && path.startsWith('/') && !path.startsWith('//') ? path : null;
  } catch {
    return null;
  }
}
