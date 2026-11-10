/**
 * @file 料金と支払いのデータベースの口（仕様書 第23.4.5節）。ロールごとに決めた関数だけを呼ぶ。
 *
 * - {@link BillingAppStore}: 会社の管理者の画面とワーカー（アプリのロール）
 * - {@link SignupStore}: 申し込みの口（`m2office_signup`）
 *
 * マスター管理画面の口は `OpsStore`（`../ops/store.ts`）に置く。
 */

import type pg from 'pg';
import type { BillingCategory, BillingView, ContractTerm, InvoiceView } from '@m2office/shared';

/** データベースの関数が断った理由（`raise exception` の文）を取り出す。 */
export function billingRefusal(err: unknown): string | null {
  const msg = err instanceof Error ? err.message : '';
  return /^[a-z_]+$/.test(msg) ? msg : null;
}

/** 督促を進めた請求。 */
export interface DunningRow {
  invoiceId: string;
  tenantId: string;
  number: string;
  totalJpy: number;
  stage: number;
}

/** 更新の知らせを出す年間契約。 */
export interface RenewalNoticeRow {
  tenantId: string;
  termEnd: string;
  nextTerm: 'monthly' | null;
}

/** アプリのロールの側の口。 */
export class BillingAppStore {
  private readonly categories = new Map<string, { at: number; value: BillingCategory }>();

  constructor(private readonly pool: pg.Pool) {}

  /**
   * 請求の区分。AI の鍵を選ぶたびに読むので 1 分覚える。
   *
   * @returns 行が無い会社は `none`。読めないときは呼び出し側に例外を返す（推測で埋めない）
   */
  async category(tenantId: string, now = Date.now()): Promise<BillingCategory> {
    const hit = this.categories.get(tenantId);
    if (hit && now - hit.at < 60_000) return hit.value;
    const { rows } = await this.pool.query<{ c: BillingCategory }>('select m2o_billing_category($1) as c', [tenantId]);
    const value = rows[0]?.c ?? 'none';
    this.categories.set(tenantId, { at: now, value });
    return value;
  }

  /** 管理者が見るご利用料金。`cardReady` は呼び出し側が足す。 */
  async view(tenantId: string): Promise<Omit<BillingView, 'cardReady'>> {
    const { rows } = await this.pool.query<{ v: Omit<BillingView, 'cardReady'> }>('select m2o_billing_view($1) as v', [tenantId]);
    return rows[0]!.v;
  }

  /** 契約の形を選ぶ。 */
  async setTerm(tenantId: string, userId: string, term: ContractTerm): Promise<void> {
    await this.pool.query('select m2o_billing_set_term($1, $2, $3)', [tenantId, userId, term]);
  }

  /** 銀行振込を選ぶ。 */
  async chooseTransfer(tenantId: string, userId: string, billingName: string): Promise<void> {
    await this.pool.query('select m2o_billing_choose_transfer($1, $2, $3)', [tenantId, userId, billingName]);
    this.categories.delete(tenantId);
  }

  /** カードの登録へ移る札を置く（値のハッシュだけ）。 */
  async cardTicket(tenantId: string, userId: string, hash: string, returnUrl: string, billingName: string): Promise<void> {
    await this.pool.query('select m2o_billing_card_ticket($1, $2, $3, $4, $5)', [tenantId, userId, hash, returnUrl, billingName]);
    this.categories.delete(tenantId);
  }

  /**
   * 解約を申し出る・取り下げる。
   *
   * @returns 使える最後の日（取り下げたら null）
   */
  async setCancel(tenantId: string, userId: string, cancel: boolean): Promise<string | null> {
    const { rows } = await this.pool.query<{ m: string | null }>('select m2o_billing_set_cancel($1, $2, $3) as m', [tenantId, userId, cancel]);
    return rows[0]?.m ?? null;
  }

  /** 発行者の情報が揃っているか。 */
  async issuerReady(): Promise<boolean> {
    const { rows } = await this.pool.query<{ r: boolean }>('select m2o_billing_issuer_ready() as r');
    return rows[0]?.r === true;
  }

  /** 今月の人数の行を置き、月間から年間への移りと年間契約の更新を進める。 */
  async roll(): Promise<number> {
    const { rows } = await this.pool.query<{ n: number }>('select m2o_billing_roll() as n');
    return rows[0]?.n ?? 0;
  }

  /** 締め。作った請求を返す。 */
  async close(): Promise<InvoiceView[]> {
    const { rows } = await this.pool.query<{ v: InvoiceView }>('select m2o_billing_close() as v');
    return rows.map((r) => r.v);
  }

  /** 更新の知らせを出す年間契約（終わる 30 日前から。期間ごとに 1 度だけ）。 */
  async renewalNotices(): Promise<RenewalNoticeRow[]> {
    const { rows } = await this.pool.query<{ tenant_id: string; term_end: string; next_term: 'monthly' | null }>('select * from m2o_billing_renewal_notices()');
    return rows.map((r) => ({ tenantId: r.tenant_id, termEnd: r.term_end, nextTerm: r.next_term }));
  }

  /** 督促を 1 段ずつ進める。 */
  async dunning(): Promise<DunningRow[]> {
    const { rows } = await this.pool.query<{ invoice_id: string; tenant_id: string; number: string; total_jpy: number; stage: number }>('select * from m2o_billing_dunning()');
    return rows.map((r) => ({ invoiceId: r.invoice_id, tenantId: r.tenant_id, number: r.number, totalJpy: r.total_jpy, stage: r.stage }));
  }

  /** 解約の申し出の月が過ぎた会社を解約済みにする。 */
  async applyCancels(): Promise<number> {
    const { rows } = await this.pool.query<{ n: number }>('select m2o_billing_apply_cancels() as n');
    return rows[0]?.n ?? 0;
  }

  /** 長く使われないスターターの知らせと解約。 */
  async idleStarters(): Promise<{ tenantId: string; action: 'notice' | 'cancelled' }[]> {
    const { rows } = await this.pool.query<{ tenant_id: string; action: 'notice' | 'cancelled' }>('select * from m2o_billing_idle_starters()');
    return rows.map((r) => ({ tenantId: r.tenant_id, action: r.action }));
  }
}

/** 申し込みの口が見る受付の様子（公開してよいものだけ）。 */
export interface SignupStatus {
  open: boolean;
  monthlyPriceJpy: number;
  annualPriceJpy: number;
  taxPercent: number;
  termsVersion: string;
}

/** 課金する請求。 */
export interface DueCharge {
  id: string;
  tenantId: string;
  number: string;
  totalJpy: number;
  customerId: string;
}

/** 申し込みの口の側の口（`m2office_signup`）。業務の表も運営の表も直接は読まない。 */
export class SignupStore {
  constructor(private readonly pool: pg.Pool) {}

  /** 受付の様子。 */
  async status(): Promise<SignupStatus> {
    const { rows } = await this.pool.query<{ open: boolean; monthly_price_jpy: number; annual_price_jpy: number; tax_percent: number; terms_version: string }>('select * from ops.signup_status()');
    const r = rows[0]!;
    return { open: r.open === true, monthlyPriceJpy: r.monthly_price_jpy, annualPriceJpy: r.annual_price_jpy, taxPercent: r.tax_percent, termsVersion: r.terms_version };
  }

  /** 申し込みのページが見せる利用規約（版と本文。第23.3.1節。第 0.542.0 版）。 */
  async terms(): Promise<{ version: string; text: string }> {
    const { rows } = await this.pool.query<{ version: string; body: string }>('select * from ops.signup_terms()');
    const r = rows[0];
    return { version: r?.version ?? '', text: r?.body ?? '' };
  }

  /** サブドメインの空き。 */
  async subdomainFree(subdomain: string): Promise<boolean> {
    const { rows } = await this.pool.query<{ f: boolean }>('select ops.signup_subdomain_free($1) as f', [subdomain]);
    return rows[0]?.f === true;
  }

  /** そのドメインの会社のサブドメイン（無ければ null）。 */
  async domainTenant(domain: string): Promise<string | null> {
    const { rows } = await this.pool.query<{ s: string | null }>('select ops.signup_domain_tenant($1) as s', [domain]);
    return rows[0]?.s ?? null;
  }

  /** 会社をスターターで作る。 */
  async provision(v: { subdomain: string; name: string; domain: string; admin: string; termsVersion: string }): Promise<string> {
    const { rows } = await this.pool.query<{ t: string }>('select ops.signup_provision($1, $2, $3, $4, $5) as t', [v.subdomain, v.name, v.domain, v.admin, v.termsVersion]);
    return rows[0]!.t;
  }

  /** カードの登録の札を引き換える（1 回限り）。 */
  async takeCardTicket(hash: string): Promise<{ tenantId: string; returnUrl: string; customerId: string | null } | null> {
    const { rows } = await this.pool.query<{ tenant_id: string; return_url: string; customer_id: string | null }>('select * from ops.signup_card_take($1)', [hash]);
    const r = rows[0];
    return r ? { tenantId: r.tenant_id, returnUrl: r.return_url, customerId: r.customer_id } : null;
  }

  /** カードの登録が済んだ。 */
  async cardDone(tenantId: string, customerId: string): Promise<void> {
    await this.pool.query('select ops.signup_card_done($1, $2)', [tenantId, customerId]);
  }

  /** 課金する請求。 */
  async chargesDue(limit = 20): Promise<DueCharge[]> {
    const { rows } = await this.pool.query<{ id: string; tenant_id: string; number: string; total_jpy: number; customer_id: string }>('select * from ops.signup_charges_due($1)', [limit]);
    return rows.map((r) => ({ id: r.id, tenantId: r.tenant_id, number: r.number, totalJpy: r.total_jpy, customerId: r.customer_id }));
  }

  /** 課金の結果を書く。同じ知らせは 1 度だけ扱う。 */
  async chargeResult(eventId: string, invoiceId: string, ok: boolean, paymentId: string | null, error: string | null): Promise<boolean> {
    const { rows } = await this.pool.query<{ r: boolean }>('select ops.signup_charge_result($1, $2, $3, $4, $5) as r', [eventId, invoiceId, ok, paymentId, error]);
    return rows[0]?.r === true;
  }
}
