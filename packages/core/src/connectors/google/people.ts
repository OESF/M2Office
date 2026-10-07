/**
 * @file Google の連絡先（People API）の接続口（仕様書 第27.15節、ADR-0084）。
 *
 * 権限は `contacts`。M2Office が入れた連絡先と、M2Office のラベル（連絡先のグループ）だけを扱う。
 * ほかの連絡先は一覧も読まない。読む・直す・消すのは、M2Office が覚えている連絡先の番号（`people/…`）だけである。
 */

import { PEOPLE_FIELDS, type ConnectorPrincipal, type ContactsConnector, type PeoplePerson } from '../types.js';
import { callGoogle, type GoogleApiEndpoints, type GoogleTokenSource } from './http.js';

/** 呼び出しに使うもの。接続口の組み立てより後に決まるため、呼ぶたびに引く。 */
type Ctx = () => { tokens: GoogleTokenSource; endpoints: GoogleApiEndpoints };

const PEOPLE_API = 'https://people.googleapis.com/v1';

const s = (v: unknown) => (typeof v === 'string' ? v : '');
const list = (v: unknown): Record<string, unknown>[] => (Array.isArray(v) ? v.filter((x) => x && typeof x === 'object') : []);

/**
 * Google の応答の Person を、M2Office が入れる項目だけの形にする（Google が足す `metadata`・`formattedType` などは捨てる）。
 *
 * @remarks 入れたときの値と比べるため、同じ形・同じ順にそろえる
 */
export function fromGooglePerson(p: Record<string, unknown>): PeoplePerson {
  return {
    names: list(p['names']).slice(0, 1).map((n) => ({ unstructuredName: s(n['unstructuredName']) || s(n['displayName']), phoneticFullName: s(n['phoneticFullName']) })),
    nicknames: list(p['nicknames']).map((n) => ({ value: s(n['value']) })),
    organizations: list(p['organizations']).map((o) => ({ name: s(o['name']), department: s(o['department']), title: s(o['title']), type: s(o['type']) })),
    phoneNumbers: list(p['phoneNumbers']).map((x) => ({ value: s(x['value']), type: s(x['type']) })),
    emailAddresses: list(p['emailAddresses']).map((x) => ({ value: s(x['value']), type: s(x['type']) })),
    addresses: list(p['addresses']).map((a) => ({ streetAddress: s(a['streetAddress']), postalCode: s(a['postalCode']), type: s(a['type']) })),
    urls: list(p['urls']).map((x) => ({ value: s(x['value']), type: s(x['type']) })),
  };
}

/**
 * Google の連絡先の接続口を作る。
 *
 * @param ctx トークンと呼び先を返す
 */
export function googleContacts(ctx: Ctx): ContactsConnector {
  const people = (p: ConnectorPrincipal, path: string, init?: Parameters<typeof callGoogle>[4]) =>
    callGoogle(ctx().tokens, p, '連絡先', `${ctx().endpoints.people ?? PEOPLE_API}${path}`, init);
  // 番号は Google が返した `people/c…`・`contactGroups/…` の形だけを通す（ほかの口を呼ばせない）
  const checked = (rn: string, kind: 'people' | 'contactGroups') => {
    if (!new RegExp(`^${kind}/[A-Za-z0-9_-]+$`).test(rn)) throw new Error('連絡先の番号の形が違います');
    return rn;
  };

  return {
    ensureGroup: async (p, name) => {
      const res = await people(p, '/contactGroups?pageSize=1000&groupFields=name,groupType');
      const hit = list(res?.['contactGroups']).find((g) => g['groupType'] === 'USER_CONTACT_GROUP' && g['name'] === name);
      if (hit) return checked(s(hit['resourceName']), 'contactGroups');
      const made = await people(p, '/contactGroups', { method: 'POST', body: { contactGroup: { name } } });
      return checked(s(made?.['resourceName']), 'contactGroups');
    },
    create: async (p, person, group) => {
      const body = { ...person, memberships: [{ contactGroupMembership: { contactGroupResourceName: checked(group, 'contactGroups') } }] };
      const res = await people(p, `/people:createContact?personFields=${PEOPLE_FIELDS.join(',')}`, { method: 'POST', body });
      return { resourceName: checked(s(res?.['resourceName']), 'people') };
    },
    get: async (p, resourceName) => {
      const res = await people(p, `/${checked(resourceName, 'people')}?personFields=${PEOPLE_FIELDS.join(',')}`);
      return res ? { person: fromGooglePerson(res), etag: s(res['etag']) } : null;
    },
    update: async (p, resourceName, etag, patch) => {
      const fields = PEOPLE_FIELDS.filter((f) => patch[f] !== undefined);
      if (!fields.length) return;
      await people(p, `/${checked(resourceName, 'people')}:updateContact?updatePersonFields=${fields.join(',')}&personFields=names`,
        { method: 'PATCH', body: { ...patch, etag } });
    },
    remove: async (p, resourceName) => {
      const res = await people(p, `/${checked(resourceName, 'people')}:deleteContact`, { method: 'DELETE' });
      return res !== null;
    },
  };
}
