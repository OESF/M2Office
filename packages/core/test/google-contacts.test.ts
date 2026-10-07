/**
 * @file 名刺を Google の連絡先に入れる処理の単体テスト（仕様書 第27.15節、ADR-0084）。
 *
 * 入れる形（メモと裏の文は入れない・英語の表記の置き場）、人が Google で直した項目を上書きしない決まり、
 * Google で消されたものを自動では入れ直さないこと、自動で入れる名刺の選び方、People API の呼び方を確かめる。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type IncomingMessage } from 'node:http';
import type { AddressInfo } from 'node:net';
import { EMPTY_CARD_FIELDS, type Contact } from '@m2office/shared';
import {
  GoogleContactsService, MockWorkspaceConnector, planGoogleUpdate, toPeoplePerson, fromGooglePerson,
  type GoogleContactLink, type GoogleContactPrefs, type GoogleContactStore, type Repository, type WorkspaceConnector,
} from '../src/index.js';
import { googleContacts } from '../src/connectors/google/people.js';
import type { GoogleApiEndpoints, GoogleTokenSource } from '../src/connectors/google/http.js';

const contact = (over: Partial<Contact> = {}): Contact => ({
  ...EMPTY_CARD_FIELDS, id: 'k1', tenantId: 't', scope: 'company', ownerUserId: 'u1', note: '展示会で会った', status: 'active', trashedAt: null,
  createdBy: 'u1', createdAt: '2026-10-01T00:00:00Z', updatedBy: 'u1', updatedAt: '2026-10-01T00:00:00Z',
  name: '佐野 毅', nameKana: 'さの つよし', company: '株式会社サンプル', department: '営業部', title: '課長',
  phones: [{ kind: 'main', number: '03-1111-2222' }, { kind: 'mobile', number: '090-1111-2222' }], emails: ['sano@sample.example'],
  postalCode: '100-0001', address: '東京都千代田区1-1', website: 'https://sample.example',
  backText: '当社はサンプルの会社です', ...over,
});

/** つなぎの置き場（メモリ）。 */
class MemoryStore implements GoogleContactStore {
  contacts = new Map<string, Contact>();
  links = new Map<string, GoogleContactLink>();
  prefs: GoogleContactPrefs = { auto: false, autoSince: null, group: null };
  candidates: string[] = [];
  async getContact(_w: unknown, id: string) { return this.contacts.get(id) ?? null; }
  async getGooglePrefs() { return { ...this.prefs }; }
  async saveGooglePrefs(_w: unknown, p: GoogleContactPrefs) { this.prefs = { ...p }; }
  async listGoogleLinks(_w: unknown, ids: string[]) { return ids.map((id) => this.links.get(id)).filter((x): x is GoogleContactLink => !!x); }
  async saveGoogleLink(_w: unknown, l: GoogleContactLink) { this.links.set(l.contactId, structuredClone(l)); }
  async deleteGoogleLink(_w: unknown, id: string) { this.links.delete(id); }
  async googleLinksDue() {
    return [...this.links.values()].filter((l) => !l.goneAt && (this.contacts.get(l.contactId)?.updatedAt ?? '') > l.syncedAt).map((l) => l.contactId);
  }
  async googleAutoCandidates() { return this.candidates.filter((id) => !this.links.has(id)); }
}

function setup(source: 'mock' | 'google' = 'mock') {
  const store = new MemoryStore();
  const mock = new MockWorkspaceConnector();
  const audits: { action: string; detail: Record<string, unknown> }[] = [];
  const connector = new Proxy(mock, { get: (t, k) => (k === 'sourceFor' ? () => source : Reflect.get(t, k)) }) as unknown as WorkspaceConnector;
  const repo = {
    appendAudit: async (e: { action: string; detail: Record<string, unknown> }) => { audits.push(e); },
    getGoogleConnection: async () => ({ scopes: ['contacts'] }),
    listTenantIds: async () => ['t'],
    listGoogleConnections: async () => [{ userId: 'u1', scopes: ['contacts'] }, { userId: 'u2', scopes: ['gmail.readonly'] }],
    listUsers: async () => [{ id: 'u1', status: 'active' }, { id: 'u2', status: 'active' }],
  } as unknown as Repository;
  const service = new GoogleContactsService({ store, connector, repo });
  const who = { tenantId: 't', userId: 'u1' };
  const book = () => mock.people.get('t:u1')!;
  return { store, mock, service, who, audits, book };
}

test('入れる形: メモと裏の文は入れない。英語の表記は 2 つ目の会社・ニックネーム・2 つ目の住所', () => {
  const p = toPeoplePerson(contact({ english: { name: 'Tsuyoshi Sano', company: 'Sample Inc.', department: 'Sales', title: 'Manager', address: '1-1 Chiyoda, Tokyo' } }));
  assert.deepEqual(p.names, [{ unstructuredName: '佐野 毅', phoneticFullName: 'さの つよし' }]);
  assert.deepEqual(p.nicknames, [{ value: 'Tsuyoshi Sano' }]);
  assert.deepEqual(p.organizations.map((o) => o.type), ['work', 'English']);
  assert.deepEqual(p.phoneNumbers, [{ value: '03-1111-2222', type: 'main' }, { value: '090-1111-2222', type: 'mobile' }]);
  assert.deepEqual(p.addresses.map((a) => a.type), ['work', 'English']);
  assert.doesNotMatch(JSON.stringify(p), /展示会|当社はサンプル/);
  // 英語の表記が無ければ、空のまとまりにする
  const plain = toPeoplePerson(contact());
  assert.deepEqual(plain.nicknames, []);
  assert.equal(plain.organizations.length, 1);
});

test('新しくする: 人が Google で直したまとまりは送らず、覚えている値もそのまま', () => {
  const pushed = toPeoplePerson(contact());
  const google = structuredClone(pushed);
  google.phoneNumbers = [{ value: '03-9999-9999', type: 'main' }]; // 人が Google で直した
  const next = toPeoplePerson(contact({ title: '部長', phones: [{ kind: 'main', number: '03-2222-3333' }] }));
  const plan = planGoogleUpdate(google, pushed, next);
  assert.deepEqual(Object.keys(plan.patch), ['organizations']);
  assert.equal(plan.patch.organizations![0]!.title, '部長');
  assert.deepEqual(plan.pushed.phoneNumbers, pushed.phoneNumbers);
  assert.equal(plan.pushed.organizations[0]!.title, '部長');
  // 前後の空白の違いは、人の直しとみなさない
  const spaced = structuredClone(pushed);
  spaced.names[0]!.unstructuredName = ' 佐野 毅 ';
  assert.deepEqual(Object.keys(planGoogleUpdate(spaced, pushed, pushed).patch), []);
});

test('入れる・新しくする・外す（見本の接続口）', async () => {
  const { store, service, who, audits, book } = setup();
  store.contacts.set('k1', contact());
  const r = await service.push(who, ['k1', 'missing']);
  assert.equal(r.added, 1);
  assert.deepEqual(r.failed.map((f) => f.contactId), ['missing']);
  const link = store.links.get('k1')!;
  const b = book();
  assert.equal(b.people.get(link.resourceName)!.groups[0], [...b.groups.values()][0]);
  assert.deepEqual([...b.groups.keys()], ['M2Office の名刺']);
  assert.ok(audits.some((a) => a.action === 'contact.google_push'));

  // 人が Google で電話を直し、M2Office で役職と電話が直された → 役職だけ新しくなる
  b.people.get(link.resourceName)!.person.phoneNumbers = [{ value: '03-9999-9999', type: 'main' }];
  store.contacts.set('k1', contact({ title: '部長', phones: [{ kind: 'main', number: '03-2222-3333' }], updatedAt: '2026-10-05T00:00:00Z' }));
  const s = await service.sync(who);
  assert.equal(s.updated, 1);
  const now = b.people.get(link.resourceName)!.person;
  assert.equal(now.organizations[0]!.title, '部長');
  assert.deepEqual(now.phoneNumbers, [{ value: '03-9999-9999', type: 'main' }]);
  assert.equal(store.links.get('k1')!.syncedAt, '2026-10-05T00:00:00Z');
  assert.equal((await service.sync(who)).updated, 0);

  // 外す: Google の連絡先から消え、つなぎも消える。名刺は残る
  assert.equal(await service.remove(who, 'k1'), true);
  assert.equal(b.people.size, 0);
  assert.equal(store.links.size, 0);
  assert.ok(store.contacts.has('k1'));
  assert.equal(await service.remove(who, 'k1'), false);
});

test('Google で消されたものは自動では入れ直さない。本人が押せば入れ直す', async () => {
  const { store, service, who, book } = setup();
  store.contacts.set('k1', contact());
  await service.push(who, ['k1']);
  book().people.clear();
  store.contacts.set('k1', contact({ title: '部長', updatedAt: '2026-10-05T00:00:00Z' }));
  assert.equal((await service.sync(who)).updated, 0);
  assert.ok(store.links.get('k1')!.goneAt);
  assert.equal(book().people.size, 0);
  assert.equal((await service.sync(who)).updated, 0);
  const again = await service.push(who, ['k1']);
  assert.equal(again.added, 1);
  assert.equal(store.links.get('k1')!.goneAt, null);
});

test('自動で入れる: 入れたときより後に取り込んだ名刺だけ。切りなら入れない', async () => {
  const { store, service, who, book } = setup();
  store.contacts.set('k1', contact());
  store.contacts.set('k2', contact({ id: 'k2', name: '山本 一郎' }));
  store.candidates = ['k2'];
  assert.equal((await service.sync(who)).added, 0);
  await service.setAuto(who, true);
  assert.ok(store.prefs.autoSince);
  assert.equal((await service.sync(who)).added, 1);
  assert.deepEqual([...store.links.keys()], ['k2']);
  assert.equal(book().people.size, 1);
  await service.setAuto(who, false);
  assert.equal(store.prefs.autoSince, null);
});

test('見回り: 本物の接続口の会社で、連絡先の許可のある人だけ回す。見本の会社は回さない', async () => {
  const real = setup('google');
  real.store.contacts.set('k1', contact());
  await real.service.push(real.who, ['k1']);
  real.store.contacts.set('k1', contact({ title: '部長', updatedAt: '2026-10-05T00:00:00Z' }));
  const seen: string[] = [];
  const r = await real.service.tick(async (_t, u) => { seen.push(u); return {}; });
  assert.deepEqual(seen, ['u1']);
  assert.equal(r.updated, 1);
  const mock = setup('mock');
  const seenMock: string[] = [];
  await mock.service.tick(async (_t, u) => { seenMock.push(u); return {}; });
  assert.deepEqual(seenMock, []);
});

test('許可が無ければ断る（画面は同意を求める）', async () => {
  const { store, mock } = setup('google');
  store.contacts.set('k1', contact());
  const connector = new Proxy(mock, { get: (t, k) => (k === 'sourceFor' ? () => 'google' : Reflect.get(t, k)) }) as unknown as WorkspaceConnector;
  const repo = { getGoogleConnection: async () => ({ scopes: ['gmail.readonly'] }), appendAudit: async () => {} } as unknown as Repository;
  const service = new GoogleContactsService({ store, connector, repo });
  await assert.rejects(service.push({ tenantId: 't', userId: 'u1' }, ['k1']), (e: Error & { kind?: string }) => e.kind === 'insufficient-scope');
  assert.deepEqual(await service.status({ tenantId: 't', userId: 'u1' }), { connected: true, granted: false, auto: false });
});

test('People API: ラベルを探して無ければ作り、M2Office の番号だけを呼ぶ', async () => {
  const seen: { method: string; url: string; body: unknown }[] = [];
  const read = (req: IncomingMessage) => new Promise<string>((r) => { let b = ''; req.on('data', (c) => { b += c; }); req.on('end', () => r(b)); });
  const server = createServer(async (req, res) => {
    const body = await read(req);
    seen.push({ method: req.method ?? '', url: req.url ?? '', body: body ? JSON.parse(body) : null });
    const send = (status: number, json: unknown) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(json)); };
    if (req.url?.startsWith('/people/contactGroups?')) return send(200, { contactGroups: [{ resourceName: 'contactGroups/myContacts', name: 'myContacts', groupType: 'SYSTEM_CONTACT_GROUP' }] });
    if (req.url === '/people/contactGroups') return send(200, { resourceName: 'contactGroups/abc123' });
    if (req.url?.startsWith('/people/people:createContact')) return send(200, { resourceName: 'people/c42' });
    if (req.url?.startsWith('/people/people/c42?')) return send(200, { resourceName: 'people/c42', etag: 'e1', names: [{ unstructuredName: '佐野 毅', displayName: '佐野 毅', metadata: {} }], phoneNumbers: [{ value: '03', type: 'main', formattedType: 'Main' }] });
    if (req.url?.startsWith('/people/people/c42:updateContact')) return send(200, {});
    if (req.url === '/people/people/c42:deleteContact') return send(200, {});
    if (req.url === '/people/people/c43:deleteContact') return send(404, { error: { code: 404 } });
    send(404, { error: { code: 404 } });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  try {
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const tokens = { token: async () => 'tok', forget: () => {} } as unknown as GoogleTokenSource;
    const c = googleContacts(() => ({ tokens, endpoints: { people: `${base}/people` } as GoogleApiEndpoints }));
    const p = { tenantId: 't', userId: 'u1' };
    assert.equal(await c.ensureGroup(p, 'M2Office の名刺'), 'contactGroups/abc123');
    assert.deepEqual(seen[1]!.body, { contactGroup: { name: 'M2Office の名刺' } });
    assert.deepEqual(await c.create(p, toPeoplePerson(contact()), 'contactGroups/abc123'), { resourceName: 'people/c42' });
    assert.deepEqual((seen[2]!.body as { memberships: unknown }).memberships, [{ contactGroupMembership: { contactGroupResourceName: 'contactGroups/abc123' } }]);
    const got = await c.get(p, 'people/c42');
    assert.equal(got!.etag, 'e1');
    assert.deepEqual(got!.person.phoneNumbers, [{ value: '03', type: 'main' }]);
    await c.update(p, 'people/c42', 'e1', { organizations: [] });
    assert.match(seen[4]!.url, /updatePersonFields=organizations&/);
    assert.equal((seen[4]!.body as { etag: string }).etag, 'e1');
    assert.equal(await c.remove(p, 'people/c42'), true);
    assert.equal(await c.remove(p, 'people/c43'), false);
    // 形の違う番号では呼ばない（ほかの口を呼ばせない）
    await assert.rejects(c.get(p, 'people/../otherContacts'));
    await assert.rejects(c.create(p, toPeoplePerson(contact()), 'https://evil.example'));
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }
  assert.deepEqual(fromGooglePerson({}).names, []);
});

test('秘書: 「〇〇さんを連絡先に入れて」は名刺の修正に回す（予定やメールの依頼は回さない）', async () => {
  const { contactRequest } = await import('../src/secretary/contacts.js');
  assert.equal(contactRequest('ミライ工業の山本さんを連絡先に入れて'), 'fix');
  assert.equal(contactRequest('田中さんを Google の電話帳に登録して'), 'fix');
  assert.equal(contactRequest('この名刺を Google の連絡先に追加して'), 'fix');
  assert.equal(contactRequest('田中さんを連絡先から外して'), 'fix');
  assert.equal(contactRequest('田中さんとの予定を入れて'), null);
  assert.equal(contactRequest('連絡先に入れておいて'), null);
});
