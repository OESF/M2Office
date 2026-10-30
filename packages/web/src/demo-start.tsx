/**
 * @file 体験版を自分で申し込む画面（`demo.<親のドメイン>/start`。仕様書 第23.3.2節「自分で申し込む」、ADR-0117）。
 *
 * メールアドレスと規約への同意だけで、その場で体験用の会社ができ、ログインした状態になる。メールアドレスは「同じ人は 1 回だけ」の
 * 確かめにだけ使い、文字のままは残さない（会社名・お名前は聞かない。第 0.491.0 版）。
 * ロボットよけは、画面を開いたときから裏で問題を解いておく（ALTCHA と同じ仕組み。利用者の操作は要らない）。
 * 次に入るためのゲスト ID とパスワードは、このときだけ出す。
 */

import { useEffect, useRef, useState } from 'react';
import { ApiError, api, type DemoChallenge, type DemoSignupResult } from './api.js';

/** 問題を解いた答え。 */
type Solved = DemoChallenge & { number: number };

/** 問題を解いてから使い直す前に取り直す時間（API の有効な時間 10 分より短くする）。 */
const SOLVED_TTL_MS = 8 * 60_000;

/**
 * ロボットよけの問題を解く（`SHA-256(salt + 数)` が問題と一致する数を探す）。
 */
async function solve(c: DemoChallenge): Promise<Solved> {
  const enc = new TextEncoder();
  for (let n = 0; n <= c.maxnumber; n++) {
    const buf = await crypto.subtle.digest('SHA-256', enc.encode(c.salt + n));
    const hex = Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, '0')).join('');
    if (hex === c.challenge) return { ...c, number: n };
  }
  throw new Error('確かめに失敗しました。画面を開き直してください');
}

/** 問題をもらって解く。 */
async function freshSolution(): Promise<{ at: number; value: Solved }> {
  return { at: Date.now(), value: await solve(await api.demoChallenge()) };
}

/** 期限（日本の日付と時刻）。 */
function endText(iso: string): string {
  return new Date(iso).toLocaleString('ja-JP', { month: 'long', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

/** 問い合わせ先を出す理由（同じ人がもう使った・受け付けを止めている）。 */
const ASK_US = new Set(['signup_email_used', 'signup_daily_limit', 'signup_budget', 'signup_closed']);

/**
 * 体験版を自分で申し込む画面。
 *
 * @param terms 体験版の利用規約（ログインの手段といっしょに届く）
 * @param onStarted 体験が始まったあと（ログインした状態になっている）
 */
export function DemoStart({ terms, onStarted }: { terms: string[]; onStarted: () => void }) {
  const [email, setEmail] = useState('');
  const [agree, setAgree] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<{ text: string; askUs: boolean } | null>(null);
  const [done, setDone] = useState<DemoSignupResult | null>(null);
  const [copied, setCopied] = useState(false);
  const pending = useRef<Promise<{ at: number; value: Solved }> | null>(null);

  // 入れている間に、裏で問題を解いておく
  useEffect(() => {
    const p = freshSolution();
    p.catch(() => undefined);
    pending.current = p;
  }, []);

  async function solution(): Promise<Solved> {
    const got = await (pending.current ?? freshSolution()).catch(() => null);
    pending.current = null;
    if (got && Date.now() - got.at < SOLVED_TTL_MS) return got.value;
    return (await freshSolution()).value;
  }

  async function submit() {
    setBusy(true);
    setError(null);
    try {
      const challenge = await solution();
      setDone(await api.demoSignup({ email: email.trim(), agree, challenge }));
    } catch (err) {
      const code = err instanceof ApiError ? String(err.body['code'] ?? '') : '';
      setError({ text: err instanceof Error ? err.message : '申し込めませんでした', askUs: ASK_US.has(code) });
    } finally {
      setBusy(false);
    }
  }

  function copy() {
    if (!done) return;
    void navigator.clipboard?.writeText(`${location.origin}/\nゲスト ID: ${done.loginId}\nパスワード: ${done.password}`)
      .then(() => setCopied(true)).catch(() => undefined);
  }

  function start() {
    history.replaceState(null, '', '/');
    onStarted();
  }

  // 紹介のページの問い合わせ（体験版の入口の親のドメイン）
  const contactUrl = `${location.protocol}//${location.hostname.replace(/^[^.]+\./, '')}/contact/`;

  if (done) {
    return (
      <div className="login">
        <div className="card login-card demo-start">
          <h1>M2Office</h1>
          <p className="lead">体験版・{endText(done.expiresAt)}まで</p>
          <dl className="demo-credentials">
            <dt>URL</dt><dd>{location.origin}/</dd>
            <dt>ゲスト ID</dt><dd><code>{done.loginId}</code></dd>
            <dt>パスワード</dt><dd><code>{done.password}</code></dd>
          </dl>
          <p className="small">次に入るときに使います。この画面を閉じると、もう出せません。</p>
          <button className="btn ghost wide" onClick={copy}>{copied ? 'コピーしました' : 'クリップボードにコピーする'}</button>
          <button className="btn wide" onClick={start}>始める</button>
        </div>
      </div>
    );
  }

  return (
    <div className="login">
      <div className="card login-card demo-start">
        <h1>M2Office</h1>
        <p className="lead">体験版</p>
        <form onSubmit={(e) => { e.preventDefault(); void submit(); }}>
          <div className="field"><label htmlFor="demo-email">メールアドレス</label>
            <input id="demo-email" type="email" autoComplete="email" maxLength={200} value={email} onChange={(e) => setEmail(e.target.value)} /></div>
          <ul className="demo-terms-list">{terms.map((t) => <li key={t}>{t}</li>)}</ul>
          <label className="demo-agree"><input type="checkbox" checked={agree} onChange={(e) => setAgree(e.target.checked)} /> 体験版の利用規約に同意する</label>
          <button className="btn wide" type="submit" disabled={busy || !agree || !email.trim()}>{busy ? '…' : '体験版を始める'}</button>
        </form>
        {error && <p className="error">{error.text}{error.askUs && <> <a href={contactUrl}>お問い合わせ</a></>}</p>}
        <p className="small login-machine"><a href="/">ゲスト ID でログイン</a></p>
      </div>
    </div>
  );
}
