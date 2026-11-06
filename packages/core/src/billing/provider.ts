/**
 * @file 支払いの口（仕様書 第23.4.5節「ダミーの支払いの口」、ADR-0123）。
 *
 * カードの登録と課金を 1 つの型にまとめる。Stripe のアカウントと ID は運営会社との調整待ち（Q-305）なので、
 * いまはダミー（{@link MockPaymentProvider}）だけを持つ。本物は、この型の実装と設定を足すだけで替えられる。
 * カードの番号を M2Office の画面とサーバーに通さない。ダミーにも番号を入れる欄を置かない。
 */

import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';

/** 支払いの口から届く知らせ（本物の知らせと同じ形にそろえる）。 */
export type PaymentEvent =
  | { id: string; kind: 'card.registered'; tenantId: string; customerId: string; returnUrl: string }
  | { id: string; kind: 'charge.succeeded'; invoiceId: string; paymentId: string }
  | { id: string; kind: 'charge.failed'; invoiceId: string; error: string };

/** カードの登録を始める入力。 */
export interface CardSetupInput {
  tenantId: string;
  /** 登録が済んだ後に戻す画面。 */
  returnUrl: string;
  /** すでに持っている顧客の ID（カードを替えるとき）。 */
  customerId: string | null;
}

/** 課金の入力。 */
export interface ChargeInput {
  invoiceId: string;
  number: string;
  totalJpy: number;
  customerId: string;
}

/**
 * 支払いの口。
 *
 * @remarks 鍵を持つのは申し込みの口のプロセスだけ（第23.3.1節）。顧客向けの API とワーカーには渡さない
 */
export interface PaymentProvider {
  /** 口の名前（`mock`・`stripe`）。 */
  readonly name: string;
  /** カードの登録を始め、移る先の URL を返す。 */
  startCardSetup(input: CardSetupInput): Promise<{ url: string }>;
  /** カードを替えるページの URL を返す。 */
  cardPortalUrl(customerId: string, returnUrl: string): Promise<string>;
  /** 金額を課金する。結果は知らせで返る。 */
  charge(input: ChargeInput): Promise<PaymentEvent>;
  /** 届いた知らせの署名を確かめて読む。確かめられなければ null。 */
  readEvent(body: string, signature: string | null): PaymentEvent | null;
}

/** 課金が失敗するダミーのカードの顧客 ID の頭。 */
const MOCK_FAIL_PREFIX = 'mock_cus_fail_';

/**
 * ダミーの支払いの口。カードの登録は「登録したことにする」ボタンだけのページで、番号を受け取らない。
 *
 * @remarks
 * 知らせは本物と同じく、署名を付けて受ける側の口へ渡す。受ける側の処理まで通すため。
 * 本番では作れない（{@link paymentProviderFromEnv}）。
 */
export class MockPaymentProvider implements PaymentProvider {
  readonly name = 'mock';

  /** @param secret ダミーの知らせの署名の鍵 @param pageUrl ダミーの登録のページの URL */
  constructor(private readonly secret: string, private readonly pageUrl: string) {}

  async startCardSetup(input: CardSetupInput): Promise<{ url: string }> {
    const session = this.sign(JSON.stringify({ tenantId: input.tenantId, returnUrl: input.returnUrl, at: Date.now() }));
    return { url: `${this.pageUrl}?session=${encodeURIComponent(session)}` };
  }

  async cardPortalUrl(_customerId: string, returnUrl: string): Promise<string> {
    return returnUrl;
  }

  async charge(input: ChargeInput): Promise<PaymentEvent> {
    if (input.customerId.startsWith(MOCK_FAIL_PREFIX)) {
      return { id: `evt_${randomUUID()}`, kind: 'charge.failed', invoiceId: input.invoiceId, error: 'ダミーのカードの失敗' };
    }
    return { id: `evt_${randomUUID()}`, kind: 'charge.succeeded', invoiceId: input.invoiceId, paymentId: `mock_pay_${randomUUID()}` };
  }

  /**
   * ダミーのページのボタンから、登録の知らせを作る。
   *
   * @param session {@link startCardSetup} が URL に入れた札
   * @param fails 課金が失敗するカードとして登録するか
   * @returns 知らせ。札が正しくなければ null（30 分で切れる）
   */
  completeCardSetup(session: string, fails: boolean, now = Date.now()): PaymentEvent | null {
    const raw = this.verify(session);
    if (!raw) return null;
    const v = JSON.parse(raw) as { tenantId: string; returnUrl: string; at: number };
    if (now - v.at > 30 * 60_000) return null;
    const customerId = `${fails ? MOCK_FAIL_PREFIX : 'mock_cus_'}${randomUUID()}`;
    return { id: `evt_${randomUUID()}`, kind: 'card.registered', tenantId: v.tenantId, customerId, returnUrl: v.returnUrl };
  }

  readEvent(body: string, signature: string | null): PaymentEvent | null {
    if (!signature || !this.safeEqual(signature, this.mac(body))) return null;
    return JSON.parse(body) as PaymentEvent;
  }

  /** 知らせに署名する（ダミーの知らせを受ける側の口へ渡すときに使う）。 */
  signature(body: string): string {
    return this.mac(body);
  }

  private mac(value: string): string {
    return createHmac('sha256', this.secret).update(value).digest('base64url');
  }

  private sign(value: string): string {
    const body = Buffer.from(value).toString('base64url');
    return `${body}.${this.mac(body)}`;
  }

  private verify(token: string): string | null {
    const [body, sig] = token.split('.');
    if (!body || !sig || !this.safeEqual(sig, this.mac(body))) return null;
    return Buffer.from(body, 'base64url').toString('utf8');
  }

  private safeEqual(a: string, b: string): boolean {
    const x = Buffer.from(a);
    const y = Buffer.from(b);
    return x.length === y.length && timingSafeEqual(x, y);
  }
}

/** 設定から読んだ支払いの口の名前。無ければ null。 */
export type PaymentProviderName = 'mock' | 'stripe' | null;

/**
 * 設定から支払いの口の名前を読む。
 *
 * @param env 環境変数
 * @returns 名前。本番の既定は無し（カードを選べない）、開発の既定は `mock`
 * @throws {Error} 本番で `mock` を指定したとき（ダミーのカードで有料の会社ができることを防ぐ。第23.4.5節「本番の守り」）
 * @throws {Error} 知らない名前のとき
 */
export function paymentProviderName(env: Record<string, string | undefined>): PaymentProviderName {
  const production = env['NODE_ENV'] === 'production';
  const raw = env['M2O_PAYMENT_PROVIDER']?.trim() || (production ? '' : 'mock');
  if (!raw) return null;
  if (raw !== 'mock' && raw !== 'stripe') throw new Error(`M2O_PAYMENT_PROVIDER の値が違います（mock か stripe）: ${raw}`);
  if (raw === 'mock' && production) throw new Error('本番環境で M2O_PAYMENT_PROVIDER=mock は使えません。起動を中止します。');
  return raw;
}
