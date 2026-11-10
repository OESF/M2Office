/**
 * @file 申し込みのページ（仕様書 第23.3.1節）。名前が signup. のときだけ、必要なときに読み込む。
 *
 * Google でログインし、会社名とサブドメインを入れると、その場で 1 人の無料のスターターができる。
 * 支払いの方法は聞かない。`/billing/card` は管理者ページから来るカードの登録の入口で、`/billing/mock-card` はダミーの登録のページ。
 * カードの番号を入れる欄は、どこにも置かない（第23.4.5節）。
 */

import { useEffect, useRef, useState } from 'react';
import { Markdown } from './help.js';

interface SignupStatus {
  open: boolean;
  monthlyPriceJpy: number;
  annualPriceJpy: number;
  taxPercent: number;
  termsVersion: string;
  google: boolean;
  devLogin: boolean;
  applicant: { email: string; domain: string } | null;
}

/** 申し込みの口を呼ぶ。失敗は応答の文を載せて投げる。 */
async function call<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`/v1/signup${path}`, { ...init, credentials: 'same-origin', headers: { 'content-type': 'application/json', ...(init?.headers ?? {}) } });
  const body = await res.json().catch(() => ({})) as T & { error?: string; url?: string };
  if (!res.ok) throw Object.assign(new Error(body.error ?? '通信に失敗しました'), { url: body.url });
  return body;
}
const post = (body: unknown): RequestInit => ({ method: 'POST', body: JSON.stringify(body) });

/** ロボットよけの問題を解く（`SHA-256(salt + 数)` が答えになる数を探す。体験版の申し込みと同じ形）。 */
async function solveChallenge(): Promise<unknown> {
  const c = await call<{ algorithm: string; challenge: string; salt: string; signature: string; maxnumber?: number; max?: number }>('/challenge');
  const max = c.maxnumber ?? c.max ?? 100_000;
  const enc = new TextEncoder();
  for (let n = 0; n <= max; n++) {
    const hash = await crypto.subtle.digest('SHA-256', enc.encode(`${c.salt}${n}`));
    const hex = [...new Uint8Array(hash)].map((b) => b.toString(16).padStart(2, '0')).join('');
    if (hex === c.challenge) return { ...c, number: n };
  }
  throw new Error('確かめに失敗しました。画面を開き直してください');
}

/** 申し込みのページの入口。 */
export function SignupRoot() {
  if (location.pathname.startsWith('/billing/card')) return <CardStart />;
  if (location.pathname.startsWith('/billing/mock-card')) return <MockCard />;
  return <Apply />;
}

/** 申し込みの本体。 */
function Apply() {
  const [status, setStatus] = useState<SignupStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [subdomain, setSubdomain] = useState('');
  const [check, setCheck] = useState<{ available: boolean; error: string | null } | null>(null);
  const [terms, setTerms] = useState(false);
  const [busy, setBusy] = useState(false);
  const [email, setEmail] = useState('');
  const [existing, setExisting] = useState<string | null>(null);

  // 利用規約の本文（M2Office が持つ。押したときに読み、ダイアログで出す。第23.3.1節）
  const termsDialog = useRef<HTMLDialogElement>(null);
  const [termsText, setTermsText] = useState<string | null>(null);
  const openTerms = async () => {
    termsDialog.current?.showModal();
    if (termsText === null) {
      await call<{ version: string; text: string }>('/terms').then((t) => setTermsText(t.text || '利用規約が見つかりませんでした')).catch((e: Error) => setTermsText(e.message));
    }
  };
  const load = () => call<SignupStatus>('/status').then(setStatus).catch((e: Error) => setError(e.message));
  // 別のアカウントで入り直す（会社がもうあるドメインで来たときなど。第23.3.1節）
  const logout = () => call('/auth/logout', post({}))
    .then(() => { setError(null); setExisting(null); setCheck(null); setName(''); setSubdomain(''); setTerms(false); return load(); })
    .catch((e: Error) => setError(e.message));
  useEffect(() => {
    const q = new URLSearchParams(location.search);
    const ticket = q.get('ticket');
    const login = q.get('login');
    if (login === 'personal') setError('会社の Google Workspace のアカウントで申し込んでください');
    if (login === 'failed') setError('Google でログインできませんでした。もう一度お試しください');
    history.replaceState(null, '', '/');
    if (ticket) void call('/auth/exchange', post({ ticket })).catch((e: Error) => setError(e.message)).finally(() => void load());
    else void load();
  }, []);

  // 入れるそばから空きを確かめる
  useEffect(() => {
    const v = subdomain.trim().toLowerCase();
    if (!v) { setCheck(null); return; }
    const t = setTimeout(() => {
      void call<{ available: boolean; error: string | null }>(`/subdomain?name=${encodeURIComponent(v)}`).then(setCheck).catch(() => setCheck(null));
    }, 300);
    return () => clearTimeout(t);
  }, [subdomain]);

  if (!status) return <div className="login"><p className={error ? 'error' : 'muted'}>{error ?? '読み込み中…'}</p></div>;
  const base = location.host.replace(/^signup\./, '');
  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      const challenge = await solveChallenge();
      const r = await call<{ url: string }>('/provision', post({ subdomain: subdomain.trim().toLowerCase(), name: name.trim(), termsVersion: status.termsVersion, challenge }));
      location.href = r.url;
    } catch (e) {
      setError(e instanceof Error ? e.message : '申し込めませんでした');
      setExisting((e as { url?: string }).url ?? null);
      setBusy(false);
    }
  };

  return (
    <div className="login">
      <div className="card signup-card">
        <h1>M2Office のお申し込み</h1>
        {/* 料金は紹介のサイトに書いてあるので、ここには出さない（仕様書 第23.3.1節「料金」） */}
        {!status.open && <p className="error">いまは申し込みを受け付けていません。</p>}
        {status.open && !status.applicant && <p className="muted">会社の Google Workspace のメールアドレスで申し込みます（gmail.com などの個人のアカウントでは申し込めません）。</p>}
        {status.open && !status.applicant && (
          <div className="row">
            {status.google && <a className="btn" href="/v1/signup/auth/google/start">Google で申し込む</a>}
            {status.devLogin && (
              <>
                <input aria-label="開発用のメールアドレス" placeholder="開発用のメールアドレス" value={email} onChange={(e) => setEmail(e.target.value)} />
                <button className="btn ghost" disabled={!email} onClick={() => void call('/auth/dev-login', post({ email })).then(load).catch((e: Error) => setError(e.message))}>開発用ログイン</button>
              </>
            )}
          </div>
        )}
        {status.open && status.applicant && (
          <>
            <div className="row signup-applicant">
              <p>{status.applicant.email} で申し込みます。この方が最初の管理者になります。</p>
              <button className="btn ghost small" disabled={busy} onClick={() => void logout()}>ログアウト</button>
            </div>
            <label className="field">会社名
              <input value={name} maxLength={200} onChange={(e) => setName(e.target.value)} />
            </label>
            <label className="field">サブドメイン
              <span className="signup-sub"><input value={subdomain} maxLength={63} onChange={(e) => setSubdomain(e.target.value)} /><span className="muted">.{base}</span></span>
            </label>
            {check && (check.available ? <p className="ok-msg small">使えます</p> : <p className="error small">{check.error}</p>)}
            <label className="check">
              <input type="checkbox" checked={terms} onChange={(e) => setTerms(e.target.checked)} />
              <span><button type="button" className="link" onClick={(e) => { e.preventDefault(); void openTerms(); }}>利用規約</button>に同意します</span>
            </label>
            <TermsDialog dialog={termsDialog} text={termsText} onClose={() => termsDialog.current?.close()} />
            <button className="btn" disabled={busy || !name.trim() || !check?.available || !terms} onClick={() => void submit()}>{busy ? '作っています…' : '申し込む'}</button>
          </>
        )}
        {error && <p className="error">{error}</p>}
        {existing && <p><a href={existing}>{existing}</a></p>}
      </div>
    </div>
  );
}

/** 管理者ページから来たカードの登録の入口。札を渡して支払いのページへ移る。 */
function CardStart() {
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    const ticket = new URLSearchParams(location.search).get('ticket') ?? '';
    history.replaceState(null, '', location.pathname);
    void call<{ url: string }>('/billing/card', post({ ticket })).then((r) => { location.href = r.url; }).catch((e: Error) => setError(e.message));
  }, []);
  return <div className="login"><p className={error ? 'error' : 'muted'}>{error ?? 'カードの登録のページへ移っています…'}</p></div>;
}

/** ダミーのカードの登録（開発だけ。カードの番号を入れる欄を置かない。第23.4.5節「ダミーの動き」）。 */
function MockCard() {
  const [error, setError] = useState<string | null>(null);
  const session = new URLSearchParams(location.search).get('session') ?? '';
  const done = (fails: boolean) => call<{ returnUrl: string }>('/billing/mock-card', post({ session, fails }))
    .then((r) => { location.href = r.returnUrl; }).catch((e: Error) => setError(e.message));
  return (
    <div className="login">
      <div className="card signup-card">
        <h1>ダミーのカードの登録</h1>
        <p className="muted">開発用のページです。本物のカードは使いません。</p>
        <div className="row">
          <button className="btn" onClick={() => void done(false)}>登録したことにする</button>
          <button className="btn ghost" onClick={() => void done(true)}>課金が失敗するカードとして登録する</button>
        </div>
        {error && <p className="error">{error}</p>}
      </div>
    </div>
  );
}

/**
 * 利用規約のダイアログ（仕様書 第23.3.1節「利用規約への同意」。第 0.542.0 版）。本文は運営がマスター管理画面で入れた Markdown。
 *
 * @param text 本文。読み込み中は `null`
 */
function TermsDialog({ dialog, text, onClose }: { dialog: React.RefObject<HTMLDialogElement>; text: string | null; onClose: () => void }) {
  return (
    <dialog ref={dialog} className="signup-terms" aria-label="利用規約">
      <div className="signup-terms-body">{text === null ? <p className="muted">読み込んでいます…</p> : <Markdown text={text} />}</div>
      <div className="row"><button type="button" className="btn" onClick={onClose}>閉じる</button></div>
    </dialog>
  );
}
