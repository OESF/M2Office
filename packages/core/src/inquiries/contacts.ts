/**
 * @file 問い合わせを、名刺管理の連絡先とつなぐ（仕様書 第33.6.1節）。
 *
 * 同じ人は、会社で共有の連絡先のうちメールアドレス・電話番号・氏名と会社名で見分ける。
 * 見つからず、名前とメールか電話のどちらかが分かれば、会社で共有の連絡先を作る。「自分だけ」の連絡先にはつながない（ほかの人に見えてしまうため）。
 * 名刺管理を切っている会社・利用範囲の外の人では、つながない（問い合わせの中だけに持つ）。
 */

import { randomUUID } from 'node:crypto';
import { EMPTY_CARD_FIELDS, type Contact, type ContactScope, type InquiryParty } from '@m2office/shared';
import type { ContactStore } from '../cards/store.js';

/** 問い合わせから使う連絡先の口。 */
export interface InquiryContactBook {
  /**
   * 同じ人の連絡先を探し、無ければ作る。
   *
   * @returns つないだ連絡先と、新しく作ったか。つながなければ `null`
   */
  link(who: { tenantId: string; userId: string }, from: InquiryParty): Promise<{ contactId: string; created: boolean } | null>;
  /**
   * 問い合わせから作った連絡先を消す（本人から求められたとき。第33.21節）。名刺から作った連絡先は消さない。
   *
   * @returns `deleted` は消した、`kept` は名刺から作ったので残した、`missing` は見つからない
   */
  forget(who: { tenantId: string; userId: string }, contactId: string): Promise<'deleted' | 'kept' | 'missing'>;
}

/** 問い合わせから作った連絡先のメモ（作った出どころの印）。 */
export const INQUIRY_CONTACT_NOTE = '出どころ: 問い合わせの記録';

/** 数字だけにする（電話番号を比べるため）。 */
const digits = (s: string) => s.replace(/\D/g, '');

/**
 * 名刺管理の置き場から、問い合わせの連絡先の口を作る。
 *
 * @param access 依頼者が名刺管理を使えるか（{@link cardsAccess}）
 */
export function contactBookFrom(store: ContactStore, access: (tenantId: string, userId: string) => Promise<{ defaultScope: ContactScope } | null>): InquiryContactBook {
  return {
    async link(who, from) {
      if (!(await access(who.tenantId, who.userId))) return null;
      const scope: ContactScope = 'company';
      if (from.email) {
        const hit = await store.findByEmails(who, scope, [from.email.toLowerCase()]);
        if (hit[0]) return { contactId: hit[0].id, created: false };
      }
      const phone = digits(from.phone);
      if (phone.length >= 9) {
        const cands = await store.listContacts(who, { q: from.phone, scope, status: 'active', limit: 10 });
        for (const c of cands) {
          const full = await store.getContact(who, c.id);
          if (full?.phones.some((p) => digits(p.number) === phone)) return { contactId: full.id, created: false };
        }
      }
      if (from.name && from.company) {
        const hit = await store.findByNameCompany(who, scope, from.name, from.company);
        if (hit.length === 1) return { contactId: hit[0]!.id, created: false };
      }
      // 名前と、メールか電話のどちらかが分かったときだけ作る（名前だけでは同じ人を見分けられない）
      if (!from.name || (!from.email && phone.length < 9)) return null;
      const now = new Date().toISOString();
      const contact: Contact = {
        ...EMPTY_CARD_FIELDS, name: from.name, company: from.company,
        phones: phone.length >= 9 ? [{ kind: 'main', number: from.phone }] : [], emails: from.email ? [from.email.toLowerCase()] : [],
        id: `ct-${randomUUID()}`, tenantId: who.tenantId, scope, ownerUserId: who.userId, note: INQUIRY_CONTACT_NOTE,
        status: 'active', trashedAt: null, createdBy: who.userId, createdAt: now, updatedBy: who.userId, updatedAt: now,
      };
      await store.insertContact(who, contact);
      return { contactId: contact.id, created: true };
    },
    async forget(who, contactId) {
      const c = await store.getContact(who, contactId);
      if (!c) return 'missing';
      if (!c.note.includes(INQUIRY_CONTACT_NOTE)) return 'kept';
      return (await store.deleteContactWithoutCards(who, contactId)) ? 'deleted' : 'kept';
    },
  };
}
