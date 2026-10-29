/**
 * @file 体験版の最初のログインで出す利用規約への同意（仕様書 第23.3.2節「最初のログイン」）と、体験の期限の帯。
 */

import { useState } from 'react';
import { api, type DemoTrialView } from './api.js';

/** 期限（日本の日付と時刻）。 */
function endText(iso: string): string {
  return new Date(iso).toLocaleString('ja-JP', { month: 'long', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

/**
 * 体験版の利用規約。同意するまで、ほかの画面を出さない。
 */
export function DemoTerms({ demo, onAccepted, onLogout }: { demo: DemoTrialView; onAccepted: () => void; onLogout: () => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const accept = () => {
    setBusy(true); setError(null);
    api.acceptDemoTerms().then(onAccepted).catch((e) => setError(e instanceof Error ? e.message : '同意を記録できませんでした')).finally(() => setBusy(false));
  };
  return (
    <div className="login">
      <div className="card login-card demo-terms">
        <h1>M2Office</h1>
        <p className="lead">体験版・{endText(demo.expiresAt)}まで</p>
        <ul>{demo.terms.map((t) => <li key={t}>{t}</li>)}</ul>
        {error && <p className="error">{error}</p>}
        <button className="btn wide" disabled={busy} onClick={accept}>{busy ? '…' : '同意して始める'}</button>
        <p className="small"><button className="link-btn" onClick={onLogout}>ログアウト</button></p>
      </div>
    </div>
  );
}

/** 体験の期限の帯（どの画面でも上に出す）。 */
export function DemoBanner({ demo }: { demo?: DemoTrialView | null }) {
  if (!demo) return null;
  const days = Math.max(0, Math.ceil((Date.parse(demo.expiresAt) - Date.now()) / 86_400_000));
  return (
    <div className="demo-banner" role="status">
      体験版・{endText(demo.expiresAt)}まで（残り {days} 日）
    </div>
  );
}
