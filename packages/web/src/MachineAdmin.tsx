/**
 * @file ローカルの形の「機械の管理者」の画面（`/machine`。仕様書 第8.6.3節、Q-154）。
 *
 * ID・合言葉・確認コード（認証アプリの 6 桁）で入り、「機械」だけを出す。業務の画面・左のメニュー・秘書は出さない。
 * Google のログインとは別の入口で、インターネットや Google が止まっていても機械の様子を見られる。
 */

import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { api, ApiError, describeError, setUnauthorizedHandler, type MachineAdminSession } from './api.js';
import { MachinePanel } from './Machine.js';

/**
 * 機械の管理者の画面。ログインしていなければログインの欄を、していれば「機械」を出す。
 */
export function MachineAdminRoot() {
  const [session, setSession] = useState<MachineAdminSession | null>(null);
  const [state, setState] = useState<'loading' | 'login' | 'ready' | 'missing'>('loading');

  useEffect(() => {
    // ログイン状態が切れたら（8 時間）ログインの欄に戻す
    setUnauthorizedHandler(() => { setSession(null); setState('login'); });
    api.machineAdmin.me()
      .then((s) => { setSession(s); setState('ready'); })
      .catch((e) => setState(e instanceof ApiError && e.status === 404 ? 'missing' : 'login'));
  }, []);

  const logout = useCallback(async () => {
    await api.machineAdmin.logout().catch(() => undefined);
    setSession(null);
    setState('login');
  }, []);

  if (state === 'loading') return <p className="muted center">読み込み中…</p>;
  // ローカルの形でない・機械の管理者を作っていない機械には、この入口が無い
  if (state === 'missing') return <p className="muted center">このページはありません</p>;
  if (state === 'login' || !session) return <MachineLogin onLoggedIn={(s) => { setSession(s); setState('ready'); }} />;
  return (
    <div className="machine-admin">
      <header className="machine-admin-bar">
        <strong>M2Office</strong>
        <span className="muted">機械の管理</span>
        <span className="spacer" />
        <span className="small muted">{session.id}</span>
        <button className="btn ghost small" onClick={() => void logout()}>ログアウト</button>
      </header>
      <main className="machine-admin-main">
        <MachinePanel fns={api.machineAdmin} />
      </main>
    </div>
  );
}

/** ログインの欄（ID・合言葉・確認コード）。どれが違ったかは出さない。 */
function MachineLogin({ onLoggedIn }: { onLoggedIn: (s: MachineAdminSession) => void }) {
  const [id, setId] = useState('');
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      onLoggedIn(await api.machineAdmin.login(id, password, code));
    } catch (err) {
      setError(describeError(err, 'ログインできませんでした'));
      setCode('');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="login">
      <form className="card login-card machine-login" onSubmit={(e) => void submit(e)}>
        <h1>M2Office</h1>
        <p className="lead">機械の管理</p>
        <div className="field">
          <label htmlFor="ma-id">ID</label>
          <input id="ma-id" value={id} autoComplete="username" autoCapitalize="none" spellCheck={false} onChange={(e) => setId(e.target.value)} required />
        </div>
        <div className="field">
          <label htmlFor="ma-password">合言葉</label>
          <input id="ma-password" type="password" value={password} autoComplete="current-password" onChange={(e) => setPassword(e.target.value)} required />
        </div>
        <div className="field">
          <label htmlFor="ma-code">確認コード</label>
          <input id="ma-code" value={code} inputMode="numeric" autoComplete="one-time-code" maxLength={7} placeholder="認証アプリの 6 桁"
            onChange={(e) => setCode(e.target.value.replace(/[^\d ]/g, ''))} required />
        </div>
        <button className="btn wide" disabled={busy}>{busy ? '…' : 'ログイン'}</button>
        {error && <p className="error">{error}</p>}
      </form>
    </div>
  );
}
