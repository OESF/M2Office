/**
 * @file お知らせの作成のメール（仕様書 第35.6.3節・第35.18節）。名刺管理の「まとめてのメール」の決まりで送る。
 *
 * 宛先の案は、名刺管理の会社で共有の連絡先のうち、最近 1 年に名刺を交換した人と、最近 180 日に問い合わせのあった人（メールアドレスのある人）。
 * 言葉で絞り直すときは、会社で共有の連絡先の全体と、最近 1 年に問い合わせのあった人を元にする（第35.19節）。
 * 除く人（配信を停止した人・アドレスの無い人・重なり・宣伝なら名刺を交換していない人）・上限（1 回 100 人）・宣伝の表示は、まとめてのメールのまま。
 * 差出人は、窓口のアカウント（第33.6節）があればそのアドレス、無ければ依頼した本人の Gmail（Q-178）。
 */

import type { AnnouncementRecipient } from '@m2office/shared';
import type { BulkMailService } from '../cards/bulk.js';
import type { ContactStore } from '../cards/store.js';
import type { InquiryStore } from '../inquiries/store.js';
import { openMailbox, type MailboxDeps } from '../inquiries/mailbox.js';

/** お知らせの作成がメールを送るのに使う口。 */
export interface AnnouncementMail {
  /** その人がメールの出し先を使えるか（名刺管理を使えるか） */
  available(tenantId: string, userId: string): Promise<boolean>;
  /** 宛先の案 */
  suggest(tenantId: string, userId: string): Promise<AnnouncementRecipient[]>;
  /** 案に入れられる人の全体（言葉で絞り直すときの元。第35.19節） */
  pool(tenantId: string, userId: string): Promise<AnnouncementRecipient[]>;
  /** 宛先の名前とアドレス（画面と承認に出す） */
  recipients(tenantId: string, userId: string, contactIds: string[]): Promise<AnnouncementRecipient[]>;
  /** 差出人の言い方（「窓口のアカウント（info@…）」「あなたの Gmail」） */
  sender(tenantId: string): Promise<string>;
  /** まとめてのメールにして送り始める（承認の後に呼ぶ。送るのはワーカーが 1 通ずつ） */
  send(tenantId: string, userId: string, m: { contactIds: string[]; subject: string; body: string }): Promise<{ bulkMailId: string; queued: number; excluded: number } | { error: string }>;
}

/** 宛先の案の上限（まとめてのメールの 1 回の上限）。 */
const SUGGEST_MAX = 100;

/** 案に入れられる人の全体を読む上限（会社で共有の連絡先）。 */
const POOL_MAX = 2000;

const DAY = 86_400_000;
const daysAgo = (n: number) => new Date(Date.now() - n * DAY).toISOString().slice(0, 10);

/**
 * 名刺管理のまとめてのメールで、お知らせのメールの口を作る。
 */
export function announcementMailFrom(deps: {
  bulk: BulkMailService;
  contacts: ContactStore;
  cardsAccess(tenantId: string, userId: string): Promise<unknown | null>;
  /** 問い合わせの置き場（最近の問い合わせの相手を案に入れる）。問い合わせの記録を使っていない会社では `null` を返す */
  inquiries?(tenantId: string): Promise<InquiryStore | null>;
  mailbox?: MailboxDeps;
}): AnnouncementMail {
  const toRecipient = (c: { id: string; name: string; company: string; emails: string[]; department?: string }, extra: Partial<Pick<AnnouncementRecipient, 'exchangedOn' | 'inquiredOn'>> = {}): AnnouncementRecipient =>
    ({ contactId: c.id, name: c.name, company: c.company, email: c.emails[0] ?? '', department: c.department ?? '', exchangedOn: extra.exchangedOn ?? null, inquiredOn: extra.inquiredOn ?? null });
  /** 会社で共有の連絡先（アドレスのある人）と、最近 1 年に問い合わせのあった人。名刺を交換した日と問い合わせの日を添える */
  const pool = async (tenantId: string, userId: string): Promise<AnnouncementRecipient[]> => {
    const who = { tenantId, userId };
    const contacts = await deps.contacts.listContacts(who, { scope: 'company', status: 'active', limit: POOL_MAX }).catch(() => []);
    const byId = new Map<string, AnnouncementRecipient>();
    for (const c of contacts) if (c.emails.length > 0) byId.set(c.id, toRecipient(c, { exchangedOn: c.lastReceivedOn }));
    const store = deps.inquiries ? await deps.inquiries(tenantId).catch(() => null) : null;
    if (store) {
      const recent = await store.list(tenantId, { status: 'all', since: new Date(Date.now() - 365 * DAY).toISOString(), limit: 500 }).catch(() => []);
      const inquired = new Map<string, string>();
      for (const i of recent) {
        if (!i.contactId) continue;
        const d = (i.lastAt || i.createdAt).slice(0, 10);
        if ((inquired.get(i.contactId) ?? '') < d) inquired.set(i.contactId, d);
      }
      const missing = [...inquired.keys()].filter((id) => !byId.has(id));
      const extra = missing.length ? await deps.bulk.store.contactsByIds(who, missing) : [];
      for (const c of extra) if (c.status === 'active' && c.emails.length > 0) byId.set(c.id, toRecipient(c));
      for (const [id, d] of inquired) { const r = byId.get(id); if (r) r.inquiredOn = d; }
    }
    return [...byId.values()];
  };
  return {
    available: async (tenantId, userId) => !!(await deps.cardsAccess(tenantId, userId).catch(() => null)),
    pool,
    async suggest(tenantId, userId) {
      // 最近 1 年に名刺を交換した人と、最近 180 日に問い合わせのあった人（新しい順に 100 人まで）
      const exchangedSince = daysAgo(365);
      const inquiredSince = daysAgo(180);
      const all = await pool(tenantId, userId);
      const latest = (r: AnnouncementRecipient) => [r.exchangedOn ?? '', r.inquiredOn ?? ''].sort().at(-1) ?? '';
      return all.filter((r) => (r.exchangedOn && r.exchangedOn >= exchangedSince) || (r.inquiredOn && r.inquiredOn >= inquiredSince))
        .sort((a, b) => latest(b).localeCompare(latest(a))).slice(0, SUGGEST_MAX);
    },
    async recipients(tenantId, userId, contactIds) {
      if (!contactIds.length) return [];
      const known = new Map((await pool(tenantId, userId)).map((r) => [r.contactId, r]));
      const missing = contactIds.filter((id) => !known.has(id));
      if (missing.length) for (const c of await deps.bulk.store.contactsByIds({ tenantId, userId }, missing)) known.set(c.id, toRecipient(c));
      return contactIds.flatMap((id) => (known.has(id) ? [known.get(id)!] : []));
    },
    async sender(tenantId) {
      const mb = deps.mailbox ? await openMailbox(deps.mailbox, tenantId).catch(() => null) : null;
      return mb ? `窓口のアカウント（${mb.address}）` : '承認へ進めた人の Gmail';
    },
    async send(tenantId, userId, m) {
      const who = { tenantId, userId };
      const mb = deps.mailbox ? await openMailbox(deps.mailbox, tenantId).catch(() => null) : null;
      const draft = await deps.bulk.createDraft(who, { contactIds: m.contactIds, subject: m.subject, body: m.body, fromMailbox: !!mb });
      if ('error' in draft) return draft;
      const p = await deps.bulk.preview(who, draft.id);
      if (!p) return { error: 'まとめてのメールを作れませんでした' };
      if (p.problems.length) return { error: p.problems.join('／') };
      const started = await deps.bulk.start(who, draft.id, p.digest);
      if ('error' in started) return started;
      return { bulkMailId: draft.id, queued: started.queued, excluded: p.excluded.length };
    },
  };
}
