/**
 * @file 料金の見回り（仕様書 第23.4.5節「請求の正と毎月の流れ」）。ワーカーが 1 時間ごとに呼ぶ。
 *
 * 今月の人数を置き、先月までの請求を作り、督促を進め、解約と長く使われないスターターを片付けて、管理者に知らせる。
 * 課金はしない（鍵を持つ申し込みの口が行う）。止めることもしない（第23.8.6節。人の承認を経る）。
 */

import type { InvoiceView } from '@m2office/shared';
import type { DunningRow, RenewalNoticeRow } from './store.js';

/** 見回りに渡すもの。 */
export interface BillingWatchDeps {
  store: {
    roll(): Promise<number>;
    issuerReady(): Promise<boolean>;
    close(): Promise<InvoiceView[]>;
    renewalNotices(): Promise<RenewalNoticeRow[]>;
    dunning(): Promise<DunningRow[]>;
    applyCancels(): Promise<number>;
    idleStarters(): Promise<{ tenantId: string; action: 'notice' | 'cancelled' }[]>;
  };
  /** 会社の管理者に知らせる。 */
  notifyAdmins(tenantId: string, title: string, body: string): Promise<void>;
  /** 記録。 */
  log: { warn(msg: string, fields?: Record<string, unknown>): void; info(msg: string, fields?: Record<string, unknown>): void };
}

/** 見回りの結果。 */
export interface BillingWatchResult {
  issued: number;
  renewals: number;
  dunned: number;
  cancelled: number;
  idle: number;
  /** 発行者の情報が揃わず、発行しなかった。 */
  issuerMissing: boolean;
}

const yen = (n: number) => `${n.toLocaleString('ja-JP')} 円`;
const monthText = (m: string) => `${m.slice(0, 4)} 年 ${Number(m.slice(5))} 月`;

/** 請求を出した知らせの文（請求の種類と、カードと振込で分ける）。 */
export function invoiceNotice(i: Pick<InvoiceView, 'kind' | 'method' | 'month' | 'totalJpy' | 'dueDate' | 'seats' | 'months' | 'termStart' | 'termEnd'>): { title: string; body: string } {
  const period = `${i.termStart} から ${i.termEnd} まで`;
  const [head, lead] =
    i.kind === 'monthly' ? [`${monthText(i.month)}分のご利用料金`, `有料の ${i.seats} 人分です。`]
    : i.kind === 'annual' ? ['年間契約のご利用料金', `${period}の、有料の ${i.seats} 人分です。`]
    : i.kind === 'annual_add' ? ['年間契約で増えた席のご利用料金', `増えた ${i.seats} 人の、残り ${i.months} か月分です（${i.termEnd} まで）。`]
    : ['年間契約のご利用料金', `${period}の定額です。`];
  const title = `${head} ${yen(i.totalJpy)}`;
  return i.method === 'card'
    ? { title, body: `${lead}登録のカードに課金します。請求書は管理者ページの「ご利用料金」にあります。` }
    : { title, body: `${lead}${i.dueDate} までにお振り込みください。請求書と振込先は管理者ページの「ご利用料金」にあります。` };
}

/** 年間契約の更新の知らせの文。 */
export function renewalNotice(r: Pick<RenewalNoticeRow, 'termEnd' | 'nextTerm'>): { title: string; body: string } {
  return r.nextTerm === 'monthly'
    ? { title: '年間契約がまもなく終わります', body: `${r.termEnd} で終わり、その翌月から月間契約の請求になります。管理者ページの「ご利用料金」で確かめられます。` }
    : { title: '年間契約がまもなく更新されます', body: `${r.termEnd} の翌日に自動で更新します。やめる場合や月間契約へ移る場合は、それまでに管理者ページの「ご利用料金」で手続きしてください。` };
}

/** 督促の文。段が進むほどはっきり伝える（決めた文面。第23.4.4節）。 */
export function dunningNotice(d: Pick<DunningRow, 'number' | 'totalJpy' | 'stage'>): { title: string; body: string } {
  const lead = `請求書 ${d.number}（${yen(d.totalJpy)}）のお支払いが確認できていません。`;
  if (d.stage >= 3) return { title: 'ご利用料金のお支払いのお願い（重要）', body: `${lead}このまま確認できない場合、ご利用を止めることがあります（止める前に予告します）。管理者ページの「ご利用料金」をご確認ください。` };
  return { title: 'ご利用料金のお支払いのお願い', body: `${lead}管理者ページの「ご利用料金」をご確認ください。行き違いの場合はご容赦ください。` };
}

/**
 * 見回りの 1 回分。
 *
 * @param deps 口と知らせ
 * @returns 行ったことの数
 *
 * @remarks 知らせに失敗しても、請求と督促はすでに記録したので、ほかの会社の知らせを続ける。督促の段は進めたまま（同じ督促を何度も送らない）
 */
export async function billingWatchTick(deps: BillingWatchDeps): Promise<BillingWatchResult> {
  const tell = async (tenantId: string, n: { title: string; body: string }) => {
    await deps.notifyAdmins(tenantId, n.title, n.body).catch((err: unknown) => {
      deps.log.warn('料金の知らせを届けられませんでした', { tenantId, err: err instanceof Error ? err.message : String(err) });
    });
  };
  await deps.store.roll();
  const ready = await deps.store.issuerReady();
  const issued = ready ? await deps.store.close() : [];
  for (const i of issued) await tell(i.tenantId, invoiceNotice(i));
  const renewals = await deps.store.renewalNotices();
  for (const r of renewals) await tell(r.tenantId, renewalNotice(r));
  const dunned = await deps.store.dunning();
  for (const d of dunned) await tell(d.tenantId, dunningNotice(d));
  const cancelled = await deps.store.applyCancels();
  const idle = await deps.store.idleStarters();
  for (const x of idle) {
    if (x.action === 'notice') {
      await tell(x.tenantId, { title: 'しばらくご利用がありません', body: 'このまま 30 日ご利用がなければ、解約の扱いにします。続けて使う場合は、ログインしていただくだけで構いません。' });
    }
  }
  return { issued: issued.length, renewals: renewals.length, dunned: dunned.length, cancelled, idle: idle.length, issuerMissing: !ready };
}
