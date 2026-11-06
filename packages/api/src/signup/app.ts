/**
 * @file 申し込みの口の API（仕様書 第23.3.1節・第23.4.5節、ADR-0107・ADR-0123）。`signup.` のホストだけで受ける。
 *
 * 誰でも開けるページなので、顧客向けの API・運営の API と別のプロセスにする。データベースには専用のロールで接続し、
 * 決めた関数だけを使う。Google でログインした会社のアカウントだけが申し込め、送るとその場で 1 人の無料のスターターができる。
 * 支払いの方法は申し込みでは聞かない（2 人目を招くときに管理者ページから来る）。
 *
 * @remarks 危険度: 中（会社を作る）。ロボットよけ・送り元ごとの回数・1 ドメインに 1 社で抑える。カードの番号は通さない
 */

import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { Hono, type Context } from 'hono';
import { getCookie, setCookie, deleteCookie } from 'hono/cookie';
import {
  buildGoogleLoginUrl, checkNewTenant, createDemoChallenge, createPkce, exchangeGoogleLoginCode, googleUserInfo, MockPaymentProvider,
  tenantErrorText, verifyDemoChallenge, type Logger, type PaymentEvent, type PaymentProvider, type SignupStore,
} from '@m2office/core';
import { HandoffStore } from '../auth/handoff.js';
import { OAuthStateStore } from '../auth/oauth-state.js';
import { clientAddress } from '../client-address.js';

/** 申し込みのログイン状態の Cookie。 */
const COOKIE = 'm2o_signup';
/** ログイン状態の長さ（30 分。申し込むだけなので短くする）。 */
const SESSION_MS = 30 * 60_000;
/** 同じ送り元から 1 時間に作れる会社の数（第23.3.1節）。 */
const PROVISIONS_PER_HOUR = 5;

/** 個人のアカウントのドメイン。開発用ログインでも断る（Google では `hd` が無いことで分かる）。 */
const PERSONAL_DOMAINS = new Set(['gmail.com', 'googlemail.com']);

/** 申し込みの口の設定。 */
export interface SignupConfig {
  login: { clientId: string; clientSecret: string; redirectUri: string } | null;
  devLogin: boolean;
  cookieSecure: boolean;
  /** ログイン状態の署名・ロボットよけの問題の鍵。 */
  secret: string;
}

/** 名前が signup. で始まる要求か。 */
export function isSignupHost(host: string | undefined): boolean {
  return /^signup\./.test(host ?? '');
}

/**
 * 申し込みの口のページから見た、会社の画面の URL。
 *
 * @example `https://signup.example.jp` と `acme` → `https://acme.example.jp/`
 */
export function companyUrl(signupOrigin: string, subdomain: string): string {
  const u = new URL(signupOrigin);
  u.hostname = u.hostname.replace(/^signup\./, `${subdomain}.`);
  u.pathname = '/';
  return u.toString();
}

function originOf(c: Context): string {
  const host = c.req.header('host') ?? 'localhost';
  const o = c.req.header('origin');
  if (o) {
    try {
      const u = new URL(o);
      if (u.host === host) return u.origin;
    } catch { /* 読めない Origin は使わない */ }
  }
  const dev = /(^|\.)localhost(:\d+)?$/.test(host);
  return `${dev ? 'http' : 'https'}://${host}`;
}

/**
 * 支払いの口から届いた知らせを記録する。
 *
 * @param store 申し込みの口のデータベースの口
 * @param e 知らせ（署名を確かめた後のもの。中身は指示として扱わない。不変則 I-6）
 */
export async function applyPaymentEvent(store: Pick<SignupStore, 'cardDone' | 'chargeResult'>, e: PaymentEvent): Promise<void> {
  if (e.kind === 'card.registered') await store.cardDone(e.tenantId, e.customerId);
  else if (e.kind === 'charge.succeeded') await store.chargeResult(e.id, e.invoiceId, true, e.paymentId, null);
  else await store.chargeResult(e.id, e.invoiceId, false, null, e.error);
}

/** 申し込みの口のアプリを作る。 */
export function signupApp(deps: { store: SignupStore; config: SignupConfig; provider: PaymentProvider | null; log: Logger }) {
  const { store, config, provider, log } = deps;
  const app = new Hono();
  const states = new OAuthStateStore();
  const handoffs = new HandoffStore();
  const provisions = new Map<string, number[]>();

  const mac = (v: string) => createHmac('sha256', config.secret).update(v).digest('base64url');
  const issue = (c: Context, email: string) => {
    const body = Buffer.from(JSON.stringify({ email, exp: Date.now() + SESSION_MS })).toString('base64url');
    setCookie(c, COOKIE, `${body}.${mac(body)}`, { httpOnly: true, sameSite: 'Lax', secure: config.cookieSecure, path: '/', maxAge: SESSION_MS / 1000 });
  };
  const applicant = (c: Context): { email: string; domain: string } | null => {
    const [body, sig] = (getCookie(c, COOKIE) ?? '').split('.');
    if (!body || !sig) return null;
    const a = Buffer.from(sig);
    const b = Buffer.from(mac(body));
    if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
    const v = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as { email: string; exp: number };
    if (v.exp < Date.now()) return null;
    return { email: v.email, domain: v.email.split('@')[1]! };
  };

  // 名前が signup. で始まる要求だけを受ける。Google からの戻りは、開発では localhost に戻るため例外にする。
  // Stripe の知らせも signup. へ届くので、この段で絞ってよい
  app.get('/health', (c) => c.json({ ok: true }));
  app.use('/v1/signup/*', async (c, next) => {
    if (c.req.path === '/v1/signup/auth/callback' || isSignupHost(c.req.header('host'))) return next();
    return c.json({ error: '見つかりません' }, 404);
  });
  // 書き換える要求は、同じ所のページからだけ受ける（Stripe の知らせは署名で確かめる）
  app.use('/v1/signup/*', async (c, next) => {
    if (c.req.method === 'GET' || c.req.path === '/v1/signup/stripe/webhook') return next();
    const o = c.req.header('origin');
    let same = false;
    try { same = !!o && new URL(o).host === c.req.header('host'); } catch { same = false; }
    return same ? next() : c.json({ error: 'このページからは受け付けられません' }, 403);
  });

  app.get('/v1/signup/status', async (c) => {
    c.header('Cache-Control', 'no-store');
    const s = await store.status();
    const me = applicant(c);
    return c.json({ ...s, google: !!config.login, devLogin: config.devLogin, applicant: me });
  });

  app.get('/v1/signup/challenge', (c) => {
    c.header('Cache-Control', 'no-store');
    return c.json(createDemoChallenge(config.secret));
  });

  // サブドメインの空き（入れるそばから確かめる）
  app.get('/v1/signup/subdomain', async (c) => {
    c.header('Cache-Control', 'no-store');
    const name = (c.req.query('name') ?? '').trim().toLowerCase();
    const checked = checkNewTenant({ subdomain: name, name: 'x', domain: 'example.jp', admin: 'a@example.jp' });
    if (!checked.ok) return c.json({ available: false, error: checked.error });
    const free = await store.subdomainFree(name);
    return c.json({ available: free, error: free ? null : tenantErrorText('subdomain_taken') });
  });

  // ---- ログイン（会社の Google Workspace のアカウントだけ） ----
  app.post('/v1/signup/auth/dev-login', async (c) => {
    if (!config.devLogin) return c.json({ error: '開発用ログインは無効です' }, 404);
    const { email } = await c.req.json<{ email?: string }>().catch(() => ({} as { email?: string }));
    const v = (email ?? '').trim().toLowerCase();
    const domain = v.split('@')[1];
    if (!domain || PERSONAL_DOMAINS.has(domain)) return c.json({ error: '会社の Google Workspace のアカウントで申し込んでください' }, 400);
    issue(c, v);
    return c.json({ ok: true });
  });

  app.get('/v1/signup/auth/google/start', (c) => {
    if (!config.login) return c.json({ error: 'Google でのログインは準備中です' }, 503);
    const { verifier, challenge } = createPkce();
    const state = states.issue({ tenantId: 'signup', userId: '', codeVerifier: verifier, returnTo: originOf(c) });
    return c.redirect(buildGoogleLoginUrl({ clientId: config.login.clientId, redirectUri: config.login.redirectUri, state, codeChallenge: challenge }));
  });

  app.get('/v1/signup/auth/callback', async (c) => {
    const pending = states.take(c.req.query('state') ?? '');
    if (!pending || pending.tenantId !== 'signup') return c.text('ログインの要求が無効か、期限が切れています。もう一度お試しください。', 400);
    const back = (result: string) => c.redirect(`${pending.returnTo}/?login=${result}`);
    const code = c.req.query('code');
    if (c.req.query('error') || !code || !config.login) return back('failed');
    try {
      const { accessToken } = await exchangeGoogleLoginCode({ ...config.login, code, codeVerifier: pending.codeVerifier });
      const { email, emailVerified, hostedDomain } = await googleUserInfo(accessToken);
      // Google Workspace のドメインが無いアカウント（gmail.com など）は断る
      if (!email || emailVerified === false || !hostedDomain || email.split('@')[1]?.toLowerCase() !== hostedDomain.toLowerCase()) return back('personal');
      return c.redirect(`${pending.returnTo}/?ticket=${encodeURIComponent(handoffs.issue({ tenantId: 'signup', userId: email.toLowerCase() }))}`);
    } catch (err) {
      log.warn('申し込みのログインに失敗しました', { err: err instanceof Error ? err.message : String(err) });
      return back('failed');
    }
  });

  app.post('/v1/signup/auth/exchange', async (c) => {
    const { ticket } = await c.req.json<{ ticket?: string }>().catch(() => ({} as { ticket?: string }));
    const got = ticket ? handoffs.take(ticket) : null;
    if (!got || got.tenantId !== 'signup') return c.json({ error: 'ログインをやり直してください' }, 400);
    issue(c, got.userId);
    return c.json({ ok: true });
  });

  app.post('/v1/signup/auth/logout', (c) => {
    deleteCookie(c, COOKIE, { path: '/' });
    return c.json({ ok: true });
  });

  // ---- 申し込み（その場でスターターを払い出す） ----
  app.post('/v1/signup/provision', async (c) => {
    const me = applicant(c);
    if (!me) return c.json({ error: 'ログインをやり直してください', needsLogin: true }, 401);
    const status = await store.status();
    if (!status.open) return c.json({ error: 'いまは申し込みを受け付けていません' }, 403);
    const address = clientAddress(c);
    const now = Date.now();
    const recent = (provisions.get(address) ?? []).filter((t) => now - t < 3_600_000);
    if (recent.length >= PROVISIONS_PER_HOUR) return c.json({ error: '試した回数が多すぎます。しばらく待ってから、もう一度お試しください' }, 429);
    const b = await c.req.json<Record<string, unknown>>().catch(() => ({} as Record<string, unknown>));
    if (!verifyDemoChallenge(config.secret, b['challenge'])) return c.json({ error: '確かめに失敗しました。画面を開き直して、もう一度お試しください' }, 400);
    if (b['termsVersion'] !== status.termsVersion) return c.json({ error: '利用規約が変わりました。画面を開き直して、確かめてください', code: 'terms_changed' }, 409);
    const checked = checkNewTenant({ subdomain: b['subdomain'], name: b['name'], domain: me.domain, admin: me.email });
    if (!checked.ok) return c.json({ error: checked.error }, 400);
    const v = checked.value;
    // 1 つのドメインに 1 社。すでにあれば、その会社のアドレスを示す
    const existing = await store.domainTenant(v.domain);
    if (existing) return c.json({ error: 'このドメインの会社はすでに使われています。管理者の方にご連絡ください', code: 'domain_taken', url: companyUrl(originOf(c), existing) }, 409);
    try {
      const tenantId = await store.provision({ subdomain: v.subdomain, name: v.name, domain: v.domain, admin: v.admin, termsVersion: status.termsVersion });
      provisions.set(address, [...recent, now]);
      log.info('申し込みを受け付け、会社を作りました', { tenantId });
      deleteCookie(c, COOKIE, { path: '/' });
      return c.json({ tenantId, url: companyUrl(originOf(c), v.subdomain) }, 201);
    } catch (err) {
      const code = err instanceof Error ? err.message : '';
      if (code === 'subdomain_taken' || code === 'subdomain_invalid' || code === 'domain_taken') return c.json({ error: tenantErrorText(code), code }, 409);
      if (code === 'signup_closed') return c.json({ error: 'いまは申し込みを受け付けていません' }, 403);
      if (code === 'terms_changed') return c.json({ error: '利用規約が変わりました。画面を開き直して、確かめてください', code }, 409);
      throw err;
    }
  });

  // ---- カードの登録（管理者ページから 1 回限りの札を持って来る） ----
  app.post('/v1/signup/billing/card', async (c) => {
    if (!provider) return c.json({ error: 'いまはカードを登録できません' }, 503);
    const { ticket } = await c.req.json<{ ticket?: string }>().catch(() => ({} as { ticket?: string }));
    if (!ticket) return c.json({ error: '管理者ページからやり直してください' }, 400);
    const got = await store.takeCardTicket(createHash('sha256').update(ticket).digest('hex'));
    if (!got) return c.json({ error: '期限が切れました。管理者ページからやり直してください' }, 400);
    const { url } = await provider.startCardSetup({ tenantId: got.tenantId, returnUrl: got.returnUrl, customerId: got.customerId });
    return c.json({ url });
  });

  // ダミーのカードの登録（開発だけ。カードの番号を受け取らない。第23.4.5節「ダミーの動き」）
  app.post('/v1/signup/billing/mock-card', async (c) => {
    if (!(provider instanceof MockPaymentProvider)) return c.json({ error: '見つかりません' }, 404);
    const b = await c.req.json<{ session?: string; fails?: boolean }>().catch(() => ({} as { session?: string; fails?: boolean }));
    const e = provider.completeCardSetup(b.session ?? '', b.fails === true);
    if (!e || e.kind !== 'card.registered') return c.json({ error: '期限が切れました。管理者ページからやり直してください' }, 400);
    await applyPaymentEvent(store, e);
    return c.json({ returnUrl: e.returnUrl });
  });

  // 支払いの口からの知らせ。署名を確かめ、同じ知らせは 1 度だけ扱う（不変則 I-6）
  app.post('/v1/signup/stripe/webhook', async (c) => {
    if (!provider) return c.json({ error: '見つかりません' }, 404);
    const body = await c.req.text();
    const e = provider.readEvent(body, c.req.header('stripe-signature') ?? null);
    if (!e) return c.json({ error: '確かめに失敗しました' }, 400);
    await applyPaymentEvent(store, e);
    return c.json({ ok: true });
  });

  app.onError((err, c) => {
    log.error('申し込みの口で想定外のエラーが発生しました', { path: c.req.path, err: err instanceof Error ? err.message : String(err) });
    return c.json({ error: '処理できませんでした。しばらく待ってから、もう一度お試しください' }, 500);
  });
  return app;
}

/**
 * 課金する請求を支払いの口へ渡す（1 回分）。
 *
 * @returns 渡した数
 * @remarks 渡せなかった請求は `pending` のまま残り、次の回に試し直す。結果の知らせを受ける側と同じ処理で記録する
 */
export async function chargeDueInvoices(store: Pick<SignupStore, 'chargesDue' | 'cardDone' | 'chargeResult'>, provider: PaymentProvider, log: Pick<Logger, 'warn'>): Promise<number> {
  let n = 0;
  for (const i of await store.chargesDue()) {
    try {
      const e = await provider.charge({ invoiceId: i.id, number: i.number, totalJpy: i.totalJpy, customerId: i.customerId });
      await applyPaymentEvent(store, e);
      n++;
    } catch (err) {
      log.warn('課金できませんでした。次の回に試し直します', { invoiceId: i.id, err: err instanceof Error ? err.message : String(err) });
    }
  }
  return n;
}
