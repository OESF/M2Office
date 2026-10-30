/**
 * @file 体験版（仕様書 第23.3.2節）のアプリの側のデータベースの口。アプリのロールで、決めた関数（移行 172）だけを呼ぶ。
 *
 * ゲストの表は運営のスキーマにあり、アプリのロールは直接読めない。ログインのための引き当て・結果の記録・見本のデータを入れる番・
 * ログイン状態からの会社の決め方・体験の様子・期限の来た会社の削除だけを、関数を通して行う。
 */

import type pg from 'pg';
import { createPool } from '../repository/pool.js';

/** ログインのために引いたゲスト。 */
export interface DemoLoginRecord {
  guestId: string;
  tenantId: string;
  userId: string;
  passwordHash: string;
  expiresAt: string;
  lockedUntil: string | null;
  /** 見本のデータを入れ終えたか。 */
  seeded: boolean;
}

/** 体験の様子。 */
export interface DemoTrialInfo {
  aiCapJpy: number;
  startedAt: string;
  expiresAt: string;
  termsAcceptedAt: string | null;
}

/** アプリの側の口。 */
export interface DemoStore {
  /** 使える状態のゲストを ID で引く。無ければ `null`。 */
  lookup(loginId: string): Promise<DemoLoginRecord | null>;
  /** ログインの結果を残す（5 回続けて間違えたら 15 分止める）。 */
  loginResult(guestId: string, ok: boolean): Promise<void>;
  /** 見本のデータを入れる番を取る。取れたら `true`。 */
  claimSeed(tenantId: string): Promise<boolean>;
  markSeeded(tenantId: string): Promise<void>;
  /** ログイン状態（Cookie のハッシュ）から体験用の会社を決める。使えなければ `null`。 */
  sessionTenant(sessionId: string): Promise<string | null>;
  /** 体験の様子。体験用の会社でなければ `null`。 */
  trial(tenantId: string): Promise<DemoTrialInfo | null>;
  acceptTerms(tenantId: string): Promise<void>;
  /** 期限の来た体験の会社を消す（相手の情報は終えて 90 日で消す）。消した会社の ID を返す。 */
  purgeDue(): Promise<string[]>;
  /** `since` から後に消した体験の会社（運営者が早く終えたものを含む。ファイルの置き場を消すため）。 */
  deletedSince(since: Date): Promise<string[]>;
  /**
   * 自分で申し込んだ体験を作る（既定の日数と上限。規約には同意済み）。歯止めはデータベースの関数の中で見る。
   *
   * @param source 送り元（そろえた形）
   * @throws 断ったときは `signup_…` の理由を含む失敗（`demoSignupRefusalOf` で読む）
   */
  selfSignup(p: DemoSelfSignup): Promise<{ guestId: string; tenantId: string; userId: string; expiresAt: string }>;
}

/** 自分で申し込んだ体験を作る入力。 */
export interface DemoSelfSignup {
  loginId: string;
  passwordHash: string;
  /** そろえた形のメールアドレス（データベースの関数が控えにするだけで、文字のままは残さない）。 */
  emailKey: string;
  source: string;
  /** 体験用の会社の名前（見本の会社名）。 */
  companyName: string;
}

const iso = (v: unknown) => (v instanceof Date ? v.toISOString() : v == null ? null : String(v));

/** PostgreSQL の口。 */
export class PostgresDemoStore implements DemoStore {
  private readonly pool: pg.Pool;

  constructor(connectionString: string) {
    this.pool = createPool(connectionString, { max: 2, name: 'demo' });
  }

  async lookup(loginId: string): Promise<DemoLoginRecord | null> {
    const { rows } = await this.pool.query('select * from m2o_demo_login_lookup($1)', [loginId]);
    const r = rows[0];
    return r ? {
      guestId: r.guest_id, tenantId: r.tenant_id, userId: r.user_id, passwordHash: r.password_hash,
      expiresAt: iso(r.expires_at)!, lockedUntil: iso(r.locked_until), seeded: !!r.seeded,
    } : null;
  }

  async loginResult(guestId: string, ok: boolean): Promise<void> {
    await this.pool.query('select m2o_demo_login_result($1, $2)', [guestId, ok]);
  }

  async claimSeed(tenantId: string): Promise<boolean> {
    const { rows } = await this.pool.query('select m2o_demo_claim_seed($1) as ok', [tenantId]);
    return !!rows[0]?.ok;
  }

  async markSeeded(tenantId: string): Promise<void> {
    await this.pool.query('select m2o_demo_mark_seeded($1)', [tenantId]);
  }

  async sessionTenant(sessionId: string): Promise<string | null> {
    const { rows } = await this.pool.query('select m2o_demo_session_tenant($1) as t', [sessionId]);
    return rows[0]?.t ?? null;
  }

  async trial(tenantId: string): Promise<DemoTrialInfo | null> {
    const { rows } = await this.pool.query('select * from m2o_demo_trial($1)', [tenantId]);
    const r = rows[0];
    return r ? { aiCapJpy: Number(r.ai_cap_jpy), startedAt: iso(r.started_at)!, expiresAt: iso(r.expires_at)!, termsAcceptedAt: iso(r.terms_accepted_at) } : null;
  }

  async acceptTerms(tenantId: string): Promise<void> {
    await this.pool.query('select m2o_demo_accept_terms($1)', [tenantId]);
  }

  async purgeDue(): Promise<string[]> {
    const { rows } = await this.pool.query('select m2o_demo_purge_due() as t');
    return rows.map((r) => String(r.t));
  }

  async deletedSince(since: Date): Promise<string[]> {
    const { rows } = await this.pool.query('select m2o_demo_storage_due($1) as t', [since]);
    return rows.map((r) => String(r.t));
  }

  async selfSignup(p: DemoSelfSignup) {
    const { rows } = await this.pool.query('select * from m2o_demo_self_signup($1,$2,$3,$4,$5)',
      [p.loginId, p.passwordHash, p.emailKey, p.source, p.companyName]);
    const r = rows[0];
    return { guestId: r.guest_id, tenantId: r.tenant_id, userId: r.user_id, expiresAt: iso(r.expires_at)! };
  }
}

/** 記憶上の口（単体テスト用）。 */
export class MemoryDemoStore implements DemoStore {
  readonly guests = new Map<string, DemoLoginRecord & { loginId: string; failed: number; logins: number; trial: DemoTrialInfo; sessions: Set<string>; deleted: boolean }>();
  private seeding = new Set<string>();

  add(g: { loginId: string; guestId: string; tenantId: string; userId: string; passwordHash: string; expiresAt: string; seeded?: boolean; aiCapJpy?: number }): void {
    this.guests.set(g.loginId, {
      ...g, lockedUntil: null, seeded: g.seeded ?? true, failed: 0, logins: 0, deleted: false, sessions: new Set(),
      trial: { aiCapJpy: g.aiCapJpy ?? 1000, startedAt: new Date().toISOString(), expiresAt: g.expiresAt, termsAcceptedAt: null },
    });
  }

  private live(g: { expiresAt: string; deleted: boolean }) { return !g.deleted && Date.parse(g.expiresAt) > Date.now(); }

  async lookup(loginId: string) { const g = this.guests.get(loginId); return g && this.live(g) ? { ...g } : null; }
  async loginResult(guestId: string, ok: boolean) {
    const g = [...this.guests.values()].find((x) => x.guestId === guestId);
    if (!g) return;
    if (ok) { g.failed = 0; g.lockedUntil = null; g.logins++; return; }
    g.failed++;
    if (g.failed >= 5) { g.failed = 0; g.lockedUntil = new Date(Date.now() + 15 * 60_000).toISOString(); }
  }
  async claimSeed(tenantId: string) {
    const g = [...this.guests.values()].find((x) => x.tenantId === tenantId);
    if (!g || g.seeded || this.seeding.has(tenantId)) return false;
    this.seeding.add(tenantId);
    return true;
  }
  async markSeeded(tenantId: string) { const g = [...this.guests.values()].find((x) => x.tenantId === tenantId); if (g) g.seeded = true; }
  async sessionTenant(sessionId: string) {
    const g = [...this.guests.values()].find((x) => x.sessions.has(sessionId));
    return g && this.live(g) && g.seeded ? g.tenantId : null;
  }
  async trial(tenantId: string) { const g = [...this.guests.values()].find((x) => x.tenantId === tenantId && !x.deleted); return g ? { ...g.trial } : null; }
  async acceptTerms(tenantId: string) { const g = [...this.guests.values()].find((x) => x.tenantId === tenantId); if (g) g.trial.termsAcceptedAt ??= new Date().toISOString(); }
  async purgeDue() {
    const out: string[] = [];
    for (const g of this.guests.values()) if (!g.deleted && !this.live(g)) { g.deleted = true; out.push(g.tenantId); }
    return out;
  }
  async deletedSince() { return [...this.guests.values()].filter((g) => g.deleted).map((g) => g.tenantId); }

  /** 自分で申し込める状態（テストで変える）。 */
  signup = { open: true, dailyLimit: 20, budgetLeft: true, days: 14 };
  private readonly usedEmails = new Set<string>();
  private readonly usedSources = new Set<string>();
  private selfCount = 0;

  async selfSignup(p: DemoSelfSignup) {
    if (!this.signup.open) throw new Error('signup_closed');
    if (this.usedEmails.has(p.emailKey)) throw new Error('signup_email_used');
    if (this.usedSources.has(p.source)) throw new Error('signup_source_used');
    if (this.selfCount >= this.signup.dailyLimit) throw new Error('signup_daily_limit');
    if (!this.signup.budgetLeft) throw new Error('signup_budget');
    if (this.guests.has(p.loginId)) throw new Error('login_taken');
    this.usedEmails.add(p.emailKey);
    this.usedSources.add(p.source);
    this.selfCount++;
    const key = p.loginId.slice(6);
    const g = { loginId: p.loginId, guestId: `dg-${key}`, tenantId: `d-${key}`, userId: `u-${p.loginId}`, passwordHash: p.passwordHash,
      expiresAt: new Date(Date.now() + this.signup.days * 86_400_000).toISOString(), seeded: false };
    this.add(g);
    this.guests.get(p.loginId)!.trial.termsAcceptedAt = new Date().toISOString();
    return { guestId: g.guestId, tenantId: g.tenantId, userId: g.userId, expiresAt: g.expiresAt };
  }
}
