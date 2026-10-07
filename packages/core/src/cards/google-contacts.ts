/**
 * @file 名刺を本人の Google の連絡先に入れる（仕様書 第27.15節、ADR-0084、Q-96）。
 *
 * M2Office から Google への一方向。本人の Google の連絡先の「M2Office の名刺」のラベルに入れる。
 * 名刺が直されたら入れた連絡先も新しくするが、**人が Google で直した項目は上書きしない**
 * （入れたときの値を覚えておき、Google の今の値と違う項目のまとまりは残す）。
 * M2Office で名刺を削除しても Google の連絡先は消さない。本人が「Google の連絡先から外す」を押したときだけ消す。
 * 権限 `contacts` は、使う人だけに、使うときに求める（ほかの人の再同意は要らない）。
 */

import { randomUUID } from 'node:crypto';
import type { Contact, PhoneKind } from '@m2office/shared';
import { ConnectorUnavailableError, PEOPLE_FIELDS, type PeopleField, type PeoplePerson, type WorkspaceConnector } from '../connectors/types.js';
import type { Repository } from '../repository/types.js';
import { silentLogger, type Logger } from '../log/logger.js';
import type { CardViewer } from './store.js';

/** 本人の Google の連絡先の中の、M2Office が入れる先のラベルの名前。 */
export const GOOGLE_CONTACTS_LABEL = 'M2Office の名刺';

/** Google の連絡先を読み書きする権限（短い名前）。使う人だけに、使うときに求める。 */
export const GOOGLE_CONTACTS_SCOPE = 'contacts';

/** 1 回に入れる名刺の上限。 */
export const GOOGLE_PUSH_MAX = 200;

/** 見回り 1 回で、1 人について新しくする・自動で入れる数の上限（Google の呼び出しの量を抑える）。 */
const SYNC_PER_USER = 50;

/** 連絡先ごと・人ごとのつなぎ。 */
export interface GoogleContactLink {
  contactId: string;
  /** Google の連絡先の番号（`people/…`）。 */
  resourceName: string;
  /** 入れたときの値（項目のまとまりごと）。 */
  pushed: PeoplePerson;
  pushedAt: string;
  /** どの時点の連絡先（`updatedAt`）まで写したか。 */
  syncedAt: string;
  /** Google の側で消されていたと分かった時刻。消されたものは自動では入れ直さない。 */
  goneAt: string | null;
}

/** 人ごとの設定。 */
export interface GoogleContactPrefs {
  /** 自分が取り込んだ名刺を自動で入れる（既定は切り）。 */
  auto: boolean;
  /** 自動を入れた時刻。これより後に取り込んだ名刺だけを入れる。 */
  autoSince: string | null;
  /** ラベルの番号（`contactGroups/…`）。 */
  group: string | null;
}

/** つなぎの置き場（名刺の置き場が持つ。行は本人だけが見る）。 */
export interface GoogleContactStore {
  getContact(who: CardViewer, id: string): Promise<Contact | null>;
  getGooglePrefs(who: CardViewer): Promise<GoogleContactPrefs>;
  saveGooglePrefs(who: CardViewer, prefs: GoogleContactPrefs): Promise<void>;
  listGoogleLinks(who: CardViewer, contactIds: string[]): Promise<GoogleContactLink[]>;
  saveGoogleLink(who: CardViewer, link: GoogleContactLink): Promise<void>;
  deleteGoogleLink(who: CardViewer, contactId: string): Promise<void>;
  /** 入れたあとに直された（まだ写していない）連絡先。見られなくなったもの・ごみ箱のものは含めない。 */
  googleLinksDue(who: CardViewer, limit: number): Promise<string[]>;
  /** 自動で入れる候補（`since` より後に本人が取り込み、まだ入れていない連絡先）。 */
  googleAutoCandidates(who: CardViewer, since: string, limit: number): Promise<string[]>;
}

/** 本人の Google の連絡先の状態。 */
export interface GoogleContactsStatus {
  /** `contacts` の許可があるか（見本の会社では常に `true`）。 */
  granted: boolean;
  /** Google と接続しているか（見本の会社では常に `true`）。 */
  connected: boolean;
  auto: boolean;
}

/** 入れた結果。 */
export interface GooglePushResult {
  added: number;
  updated: number;
  failed: { contactId: string; reason: string }[];
}

const PHONE_TYPE: Record<PhoneKind, string> = { main: 'main', direct: 'work', mobile: 'mobile', fax: 'workFax' };

/**
 * 連絡先を、Google の連絡先に入れる形にする（第27.15節「項目」）。メモと裏の文は入れない。
 *
 * @remarks 英語の氏名はニックネームに、英語の会社名・部署・役職は 2 つ目の会社（種類 `English`）に、英語の住所は 2 つ目の住所に入れる
 */
export function toPeoplePerson(c: Contact): PeoplePerson {
  const en = c.english;
  const org = (name: string, department: string, title: string, type: string) =>
    (name || department || title ? [{ name, department, title, type }] : []);
  return {
    names: c.name || c.nameKana ? [{ unstructuredName: c.name, phoneticFullName: c.nameKana }] : [],
    nicknames: en?.name ? [{ value: en.name }] : [],
    organizations: [...org(c.company, c.department, c.title, 'work'), ...org(en?.company ?? '', en?.department ?? '', en?.title ?? '', 'English')],
    phoneNumbers: c.phones.filter((p) => p.number).map((p) => ({ value: p.number, type: PHONE_TYPE[p.kind] ?? 'work' })),
    emailAddresses: c.emails.filter(Boolean).map((value) => ({ value, type: 'work' })),
    addresses: [
      ...(c.address || c.postalCode ? [{ streetAddress: c.address, postalCode: c.postalCode, type: 'work' }] : []),
      ...(en?.address ? [{ streetAddress: en.address, postalCode: '', type: 'English' }] : []),
    ],
    urls: c.website ? [{ value: c.website, type: 'work' }] : [],
  };
}

/** 比べるための形（前後の空白を除き、Google が足しうる違いを吸収する）。 */
function canonical(v: unknown): string {
  return JSON.stringify(v, (_k, x) => (typeof x === 'string' ? x.trim() : x));
}

/**
 * 新しくするときに Google へ送る項目と、次に覚えておく「入れたときの値」を決める（第27.15節「新しくする」）。
 *
 * @param google Google の今の値
 * @param pushed 前に入れたときの値
 * @param next M2Office の今の値
 * @returns `patch` は送る項目のまとまりだけ。人が Google で直したまとまり（今の値が入れたときの値と違う）は送らず、覚えている値もそのまま
 */
export function planGoogleUpdate(google: PeoplePerson, pushed: PeoplePerson, next: PeoplePerson): { patch: Partial<PeoplePerson>; pushed: PeoplePerson } {
  const patch: Partial<PeoplePerson> = {};
  const remembered = { ...pushed } as Record<PeopleField, unknown>;
  for (const f of PEOPLE_FIELDS) {
    const untouched = canonical(google[f] ?? []) === canonical(pushed[f] ?? []);
    if (!untouched) continue;
    if (canonical(next[f]) === canonical(google[f] ?? [])) continue;
    (patch as Record<PeopleField, unknown>)[f] = next[f];
    remembered[f] = next[f];
  }
  return { patch, pushed: remembered as unknown as PeoplePerson };
}

export interface GoogleContactsDeps {
  store: GoogleContactStore;
  connector: WorkspaceConnector;
  repo: Repository;
  logger?: Logger;
}

/** 断りの理由を、利用者に見せる文にする（連絡先の中身は入れない）。 */
function reasonOf(err: unknown): string {
  if (err instanceof ConnectorUnavailableError) return err.message;
  return '入れられませんでした。しばらくしてからもう一度お試しください';
}

/**
 * 本人の Google の連絡先へのつなぎ。画面（API）・秘書のツール・ワーカーの見回りが同じものを使う。
 */
export class GoogleContactsService {
  private readonly log: Logger;

  constructor(private readonly deps: GoogleContactsDeps) {
    this.log = deps.logger ?? silentLogger;
  }

  /** 本人の状態（許可・自動の入り切り）。 */
  async status(who: CardViewer): Promise<GoogleContactsStatus> {
    const prefs = await this.deps.store.getGooglePrefs(who);
    if (this.deps.connector.sourceFor(who.tenantId) === 'mock') return { connected: true, granted: true, auto: prefs.auto };
    const conn = await this.deps.repo.getGoogleConnection(who.tenantId, who.userId);
    return { connected: !!conn, granted: !!conn?.scopes.includes(GOOGLE_CONTACTS_SCOPE), auto: prefs.auto };
  }

  /** 自動で入れるかを決める。入れた時刻より後に取り込んだ名刺だけを入れる。 */
  async setAuto(who: CardViewer, auto: boolean): Promise<void> {
    const prefs = await this.deps.store.getGooglePrefs(who);
    if (prefs.auto === auto) return;
    await this.deps.store.saveGooglePrefs(who, { ...prefs, auto, autoSince: auto ? new Date().toISOString() : null });
    await this.audit(who, 'contact.google_auto', who.userId, { auto });
  }

  /** 本人が入れた連絡先のつなぎ（画面の表示に使う）。 */
  async links(who: CardViewer, contactIds: string[]): Promise<GoogleContactLink[]> {
    return this.deps.store.listGoogleLinks(who, contactIds);
  }

  /**
   * 名刺を Google の連絡先に入れる。入れたものは新しくする。Google の側で消されていたものは入れ直す（本人が押したため）。
   *
   * @throws {ConnectorUnavailableError} 許可が無いなど、1 件も入れられないとき（`insufficient-scope` のとき、画面は同意を求める）
   */
  async push(who: CardViewer, contactIds: string[], by: 'user' | 'auto' = 'user'): Promise<GooglePushResult> {
    const ids = [...new Set(contactIds)].slice(0, GOOGLE_PUSH_MAX);
    const result: GooglePushResult = { added: 0, updated: 0, failed: [] };
    if (ids.length === 0) return result;
    const status = await this.status(who);
    if (!status.connected) throw new ConnectorUnavailableError('not-connected', 'Google と接続していません。個人設定の「Google 連携」で接続してください');
    if (!status.granted) throw new ConnectorUnavailableError('insufficient-scope', 'Google の連絡先を使う許可がまだありません');
    const links = new Map((await this.deps.store.listGoogleLinks(who, ids)).map((l) => [l.contactId, l]));
    let group: string | null = null;
    for (const id of ids) {
      const contact = await this.deps.store.getContact(who, id);
      if (!contact || contact.status !== 'active') { result.failed.push({ contactId: id, reason: '名刺が見つかりません' }); continue; }
      try {
        const link = links.get(id);
        if (link && !link.goneAt && (await this.syncOne(who, contact, link)) !== 'gone') { result.updated++; continue; }
        group ??= await this.group(who);
        const person = toPeoplePerson(contact);
        const { resourceName } = await this.deps.connector.contacts.create(who, person, group).catch(async (err) => {
          // 本人が Google でラベルを消していると入れられない。ラベルを探し直す（無ければ作る）
          if (err instanceof ConnectorUnavailableError) throw err;
          group = await this.group(who, true);
          return this.deps.connector.contacts.create(who, person, group);
        });
        const now = new Date().toISOString();
        await this.deps.store.saveGoogleLink(who, { contactId: id, resourceName, pushed: person, pushedAt: now, syncedAt: contact.updatedAt, goneAt: null });
        result.added++;
      } catch (err) {
        // 許可が無い・取り消されたときは、残りも同じなので止める
        if (err instanceof ConnectorUnavailableError && err.kind !== 'unreachable') throw err;
        result.failed.push({ contactId: id, reason: reasonOf(err) });
      }
    }
    if (result.added || result.updated) {
      await this.audit(who, 'contact.google_push', ids.length === 1 ? ids[0]! : who.userId,
        { by, added: result.added, updated: result.updated, failed: result.failed.length, contactIds: ids.slice(0, 50) });
    }
    return result;
  }

  /**
   * 入れた連絡先を Google の連絡先から外す（消す）。M2Office の名刺は消さない。
   *
   * @returns 入れていなければ `false`
   */
  async remove(who: CardViewer, contactId: string): Promise<boolean> {
    const [link] = await this.deps.store.listGoogleLinks(who, [contactId]);
    if (!link) return false;
    if (!link.goneAt) await this.deps.connector.contacts.remove(who, link.resourceName);
    await this.deps.store.deleteGoogleLink(who, contactId);
    await this.audit(who, 'contact.google_remove', contactId, {});
    return true;
  }

  /**
   * 本人の、直された名刺を写し、自動で入れる名刺を入れる（ワーカーの見回りから呼ぶ）。
   *
   * @returns 新しくした数と、自動で入れた数
   */
  async sync(who: CardViewer): Promise<{ updated: number; added: number }> {
    let updated = 0;
    for (const id of await this.deps.store.googleLinksDue(who, SYNC_PER_USER)) {
      const [link] = await this.deps.store.listGoogleLinks(who, [id]);
      const contact = await this.deps.store.getContact(who, id);
      if (!link || !contact) continue;
      if ((await this.syncOne(who, contact, link)) === 'updated') updated++;
    }
    const prefs = await this.deps.store.getGooglePrefs(who);
    let added = 0;
    if (prefs.auto && prefs.autoSince) {
      const ids = await this.deps.store.googleAutoCandidates(who, prefs.autoSince, SYNC_PER_USER);
      if (ids.length) added = (await this.push(who, ids, 'auto')).added;
    }
    if (updated) await this.audit(who, 'contact.google_update', who.userId, { updated });
    return { updated, added };
  }

  /**
   * 1 件を写す。Google の側で消されていたら、消された印を付ける（自動では入れ直さない）。
   *
   * @returns `updated`（送った）・`same`（送るものが無い）・`gone`（消されていた）
   */
  private async syncOne(who: CardViewer, contact: Contact, link: GoogleContactLink): Promise<'updated' | 'same' | 'gone'> {
    const now = await this.deps.connector.contacts.get(who, link.resourceName);
    if (!now) {
      await this.deps.store.saveGoogleLink(who, { ...link, goneAt: new Date().toISOString() });
      return 'gone';
    }
    const plan = planGoogleUpdate(now.person, link.pushed, toPeoplePerson(contact));
    const changed = Object.keys(plan.patch).length > 0;
    if (changed) await this.deps.connector.contacts.update(who, link.resourceName, now.etag, plan.patch);
    await this.deps.store.saveGoogleLink(who, { ...link, pushed: plan.pushed, syncedAt: contact.updatedAt });
    return changed ? 'updated' : 'same';
  }

  /**
   * 本人ごとに {@link sync} を回す（ワーカーの見回り。会社をまたぐ）。
   *
   * @param access その人がいま名刺管理を使えるか
   * @remarks 見本の会社は回さない（見本の連絡先はプロセスのメモリにあり、API とワーカーで別のため）。`contacts` の許可がある人だけ
   */
  async tick(access: (tenantId: string, userId: string) => Promise<unknown>): Promise<{ updated: number; added: number }> {
    const { repo, connector } = this.deps;
    const total = { updated: 0, added: 0 };
    for (const tenantId of await repo.listTenantIds()) {
      if (connector.sourceFor(tenantId) !== 'google') continue;
      const conns = (await repo.listGoogleConnections(tenantId)).filter((c) => c.scopes.includes(GOOGLE_CONTACTS_SCOPE));
      if (conns.length === 0) continue;
      const users = await repo.listUsers(tenantId);
      for (const conn of conns) {
        const user = users.find((u) => u.id === conn.userId);
        if (!user || user.status !== 'active' || !(await access(tenantId, user.id))) continue;
        try {
          const r = await this.sync({ tenantId, userId: user.id });
          total.updated += r.updated;
          total.added += r.added;
        } catch (err) {
          this.log.debug('google_contacts.sync_failed', { tenantId, error: err instanceof Error ? err.message : String(err) });
        }
      }
    }
    return total;
  }

  /** 「M2Office の名刺」のラベル。覚えた番号を使い、無ければ探すか作る。 */
  private async group(who: CardViewer, fresh = false): Promise<string> {
    const prefs = await this.deps.store.getGooglePrefs(who);
    if (prefs.group && !fresh) return prefs.group;
    const group = await this.deps.connector.contacts.ensureGroup(who, GOOGLE_CONTACTS_LABEL);
    await this.deps.store.saveGooglePrefs(who, { ...prefs, group });
    return group;
  }

  private async audit(who: CardViewer, action: string, targetId: string, detail: Record<string, unknown>): Promise<void> {
    await this.deps.repo.appendAudit({
      id: randomUUID(), tenantId: who.tenantId, actorType: 'user', actorId: who.userId, action, targetType: 'contact', targetId,
      detail, occurredAt: new Date().toISOString(),
    }).catch((err) => this.log.warn('監査ログに残せませんでした', { action, err: err instanceof Error ? err.message : String(err) }));
  }
}
