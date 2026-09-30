/**
 * @file 店頭サイネージの画面の登録（`/m/signage/pair?code=…`。仕様書 第31.5.1節）。
 *
 * 端末に出た QR を管理者がスマホで読むと開く。**「登録する」だけを出し、名前と向きは尋ねない**（決まった計算で決める）。
 * 番号を URL で開いただけでは登録しない（押したときだけ）。登録した後は、名前・向き・回し方をその場で直せる（直さなくてよい）。
 * ワークスペースの枠（左のメニュー・秘書の欄）を出さない。説明文を常に出さない（原則 u11）。
 */

import { useState } from 'react';
import type { SignageScreen } from '@m2office/shared';
import { api, ApiError, describeError, type Me } from './api.js';

/**
 * 画面の登録のページ。
 *
 * @param me ログインしている人（管理者か・サイネージを使えるか）
 */
export function SignagePair({ me }: { me: Me }) {
  const code = new URLSearchParams(location.search).get('code') ?? '';
  const [screen, setScreen] = useState<SignageScreen | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const admin = me.user.roles.includes('admin');

  const claim = () => {
    setBusy(true);
    setError(null);
    api.admin.claimSignageScreen(code)
      .then((r) => setScreen(r.screen))
      .catch((e) => setError(e instanceof ApiError ? e.message : describeError(e, '登録できませんでした')))
      .finally(() => setBusy(false));
  };
  const patch = (p: { name?: string; orientation?: 'landscape' | 'portrait'; rotation?: number }) => {
    if (!screen) return;
    api.signage.updateScreen(screen.id, p).then((r) => setScreen(r.screen)).catch((e) => setError(describeError(e, '直せませんでした')));
  };

  return (
    <div className="m-inv signage-pair">
      <header className="m-head"><span className="m-title">サイネージ</span><span className="m-tenant">{me.tenant.name}</span></header>
      {!admin && <p className="error">画面の登録は管理者だけができます</p>}
      {admin && !screen && (
        <div className="signage-pair-body">
          <p className="signage-pair-code">{code.replace(/^(\d{3})(\d{3})$/, '$1 $2')}</p>
          <button className="btn m-big" disabled={busy || !/^\d{6}$/.test(code)} onClick={claim}>登録する</button>
        </div>
      )}
      {screen && (
        <div className="signage-pair-body">
          <p className="ok-msg">「{screen.name}」を登録しました</p>
          <label>名前 <input defaultValue={screen.name} maxLength={20} onBlur={(e) => { const v = e.target.value.trim(); if (v && v !== screen.name) patch({ name: v }); }} /></label>
          <label>向き <select value={screen.orientation} onChange={(e) => patch({ orientation: e.target.value as 'landscape' | 'portrait' })}>
            <option value="landscape">横</option><option value="portrait">縦</option>
          </select></label>
          <label>回し方 <select value={screen.rotation} onChange={(e) => patch({ rotation: Number(e.target.value) })}>
            {[0, 90, 180, 270].map((r) => <option key={r} value={r}>{r} 度</option>)}
          </select></label>
        </div>
      )}
      {error && <p className="error">{error}</p>}
    </div>
  );
}
