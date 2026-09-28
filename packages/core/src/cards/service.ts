/**
 * @file 名刺管理の操作。取り込み（受け付けと後ろでの読み取り）、登録、修正、範囲、分ける、ごみ箱と消去。
 *
 * 画面（API）・ワーカー（読み取りの待ち行列）・道具（秘書と業務）の 3 か所から同じものを使う。
 * 読み取ったら確認を挟まずに登録し、同じ人は AI がまとめる（ADR-0028）。間違いは画面か秘書で直す。
 *
 * @see 仕様書 第27章 名刺管理
 */

import { randomUUID } from 'node:crypto';
import {
  CARDS_EXTENSION_ID, EMPTY_CARD_FIELDS, canUseAgent, type AuditEvent, type CardFields, type Contact, type ContactCard, type ContactScope, type User,
} from '@m2office/shared';
import type { Repository } from '../repository/types.js';
import type { FileStore } from '../files/store.js';
import type { LlmProvider } from '../llm/provider.js';
import { saveFile } from '../files/service.js';
import { silentLogger, type Logger } from '../log/logger.js';
import { CARD_BATCH_MAX, CARD_MIME, detectCardKind, splitCardPdf, type CardFileKind } from './formats.js';
import { readCard, type CardReading } from './read.js';
import { mergeFields, resolveContact } from './identity.js';
import type { CardViewer, ContactPatch, ContactStore, NewCard } from './store.js';

/** 1 ファイルの上限（第9.4.1節と同じ 10 MB）。 */
export const CARD_FILE_MAX_BYTES = 10 * 1024 * 1024;

/** 何枚も写っていたときに添える知らせ（第27.4節）。 */
export const MULTIPLE_NOTE = '1 枚の写真に何枚も写っていたため、いちばん大きい 1 枚だけを読み取りました。1 枚ずつ撮ってください';

export interface CardServiceDeps {
  store: ContactStore;
  repo: Repository;
  files: FileStore;
  /** その会社の推論（会社の鍵か運営の鍵）。 */
  llmFor(tenantId: string): Promise<LlmProvider>;
  logger?: Logger;
}

/** 受け付けたファイル 1 つ。 */
export interface CardUpload {
  name: string;
  bytes: Uint8Array;
  /** 撮るときに「裏も撮る」で組にした表のファイルの番号（同じ回の中の 0 から）。表なら `null`。 */
  backOf?: number | null;
}

/** 受け付けの結果。 */
export interface AcceptResult {
  batchId: string;
  /** 読み取りの待ちに入れた名刺の数。 */
  queued: number;
  /** 受け付けなかったファイルと理由。 */
  rejected: { name: string; reason: string }[];
}

/** 詳細の画面に出す 1 件。 */
export interface ContactDetail {
  contact: Contact;
  cards: ContactCard[];
  /** 名刺の履歴（以前の会社・役職）。新しい順。 */
  history: { receivedOn: string; company: string; department: string; title: string }[];
}

export class CardService {
  private readonly log: Logger;

  constructor(private readonly deps: CardServiceDeps) {
    this.log = deps.logger ?? silentLogger;
  }

  /**
   * 名刺のファイルを受け付けて、読み取りの待ちに入れる（第27.4節）。撮る人を待たせない。
   *
   * @param who 取り込む人
   * @param uploads 渡されたファイル（1 回に 50 まで）。PDF は 1 ページを 1 枚とみなす
   * @param scope 範囲（選ばなければ会社の既定）
   * @remarks 形式と大きさは拡張子と中身の先頭の両方で確かめる。受け付けないものは理由を返し、ほかは受け付ける
   */
  async accept(who: CardViewer, uploads: CardUpload[], scope: ContactScope): Promise<AcceptResult> {
    const batchId = `cb-${randomUUID()}`;
    const rejected: AcceptResult['rejected'] = [];
    // 受け取った日の初めの値は、取り込んだ人のタイムゾーンでの今日（第27.3節）
    const receivedOn = await this.today(who);
    if (uploads.length > CARD_BATCH_MAX) {
      return { batchId, queued: 0, rejected: [{ name: '', reason: `1 回に渡せるのは ${CARD_BATCH_MAX} 枚までです` }] };
    }
    // 表のファイルの番号 → 作った名刺（裏を組にするため）
    const fronts = new Map<number, NewCard>();
    const cards: NewCard[] = [];
    let seq = 0;
    for (const [i, u] of uploads.entries()) {
      if (u.bytes.byteLength > CARD_FILE_MAX_BYTES) { rejected.push({ name: u.name, reason: '10 MB を超えています' }); continue; }
      const kind = detectCardKind(u.name, u.bytes);
      if (!kind) { rejected.push({ name: u.name, reason: '名刺の画像（PNG・JPEG・HEIC・WebP）か PDF ではありません' }); continue; }
      const front = u.backOf !== undefined && u.backOf !== null ? fronts.get(u.backOf) : undefined;
      if (front && kind !== 'pdf') {
        const back = await this.saveImage(who, u.name, kind, u.bytes);
        front.backFileId = back.id;
        front.paired = true;
        continue;
      }
      const pages = kind === 'pdf' ? await splitCardPdf(u.bytes) : [{ page: 1, kind, bytes: u.bytes }];
      if (pages.length === 0) { rejected.push({ name: u.name, reason: 'PDF を開けませんでした' }); continue; }
      for (const p of pages) {
        if (cards.length >= CARD_BATCH_MAX) { rejected.push({ name: `${u.name}（${p.page} ページ目から）`, reason: `1 回に ${CARD_BATCH_MAX} 枚までです` }); break; }
        const name = pages.length > 1 ? `${u.name}（${p.page} ページ目）` : u.name;
        const saved = await this.saveImage(who, name, p.kind as CardFileKind, p.bytes);
        const card: NewCard = { id: `cc-${randomUUID()}`, scope, batchId, seq: seq++, frontFileId: saved.id, backFileId: null, paired: false, receivedOn };
        cards.push(card);
        if (pages.length === 1) fronts.set(i, card);
      }
    }
    await this.deps.store.createCards(who, cards);
    if (cards.length > 0) {
      await this.audit(who.tenantId, { type: 'user', id: who.userId }, 'card.import', 'card_batch', batchId, { count: cards.length, scope });
    }
    return { batchId, queued: cards.length, rejected };
  }

  /** その人のタイムゾーン（個人設定。第6.5.1節）での今日（`YYYY-MM-DD`）。 */
  async today(who: CardViewer): Promise<string> {
    const settings = await this.deps.repo.getUserSettings(who.tenantId, who.userId).catch(() => null);
    return dateIn(settings?.profile.timezone || 'Asia/Tokyo');
  }

  /**
   * 受け取った日を直す（第27.3節）。受け取った本人だけが、自分の受け取った名刺の日付を直せる。
   *
   * @param receivedOn `YYYY-MM-DD`。今日より後の日は受け付けない
   * @returns 直せなければ理由
   * @remarks 会った場面の予定（第27.8節）は、直した日で引く
   */
  async setReceivedOn(who: CardViewer, cardId: string, receivedOn: string): Promise<string | null> {
    const card = await this.deps.store.getCard(who, cardId);
    if (!card || card.status !== 'done') return '名刺が見つかりません';
    if (card.ownerUserId !== who.userId) return '受け取った日を直せるのは、その名刺を受け取った本人です';
    const valid = /^\d{4}-\d{2}-\d{2}$/.test(receivedOn) && !Number.isNaN(Date.parse(`${receivedOn}T00:00:00Z`))
      && new Date(`${receivedOn}T00:00:00Z`).toISOString().slice(0, 10) === receivedOn;
    if (!valid || receivedOn < '1950-01-01') return '日付は 2026-09-25 の形で書いてください';
    if (receivedOn > await this.today(who)) return '今日より後の日にはできません';
    await this.deps.store.updateCard(who, cardId, { receivedOn });
    return null;
  }

  /** 名刺の画像を保存する（出どころは「名刺」。連絡先がある間は残す。第27.10節）。 */
  private saveImage(who: CardViewer, name: string, kind: CardFileKind, bytes: Uint8Array) {
    return saveFile(this.deps.repo, this.deps.files, {
      tenantId: who.tenantId, ownerUserId: who.userId, name, kind, bytes, origin: 'card', runId: null,
    });
  }

  /**
   * 読み取りの待ちから 1 枚を取り出して読み取り、登録する（ワーカーが呼ぶ）。
   *
   * @returns 1 枚を処理したら `true`。待ちが空なら `false`
   * @remarks 失敗しても例外を外へ出さない。3 回まで取り出し直し、それでも駄目なら「読み取れませんでした」にする
   */
  async processNext(): Promise<boolean> {
    const claimed = await this.deps.store.claimNextCard();
    if (!claimed) return false;
    const who = { tenantId: claimed.tenantId, userId: claimed.ownerUserId };
    try {
      await this.process(who, claimed.id);
    } catch (err) {
      this.log.warn('名刺を読み取れませんでした', { tenantId: who.tenantId, cardId: claimed.id, error: String(err) });
      const card = await this.deps.store.getCard(who, claimed.id).catch(() => null);
      // 取り出しの回数が上限に達したら、読み取れなかったことにする（待ちに残し続けない）
      if (card && card.status === 'reading') {
        await this.deps.store.updateCard(who, card.id, { status: 'failed', failureReason: '読み取りに失敗しました。撮り直してください' });
        await this.finishBatch(who, card.batchId);
      }
    }
    return true;
  }

  /** 名刺 1 枚を読み取って登録する。 */
  async process(who: CardViewer, cardId: string): Promise<void> {
    const { store } = this.deps;
    const card = await store.getCard(who, cardId);
    if (!card || card.status === 'done' || card.status === 'failed') return;
    const llm = await this.deps.llmFor(who.tenantId);
    const front = card.frontFileId ? await this.readFile(llm, who.tenantId, card.frontFileId) : null;
    if (!front || front.kind !== 'card') {
      await store.updateCard(who, card.id, {
        status: 'failed',
        failureReason: front?.kind === 'unavailable' ? front.reason : '名刺と見分けられないか、文字が読めませんでした',
      });
      await this.finishBatch(who, card.batchId);
      return;
    }
    let fields = front.fields;
    let backRotation = 0;
    if (card.backFileId) {
      // 組にした裏は、表に無い項目を埋めるのに使う（英語の面のメールアドレスなど）
      const back = await this.readFile(llm, who.tenantId, card.backFileId);
      if (back?.kind === 'card') {
        fields = fillBlanks(fields, back.fields);
        backRotation = back.rotation;
      }
    }

    // 表裏を組にせずに続けて渡した同じ人の 2 枚は、1 枚の名刺（表と裏）にまとめる（第27.4節）
    if (!card.paired && !card.backFileId) {
      const prev = await store.previousCardInBatch(who, card.batchId, card.seq);
      if (prev && prev.status === 'done' && prev.contactId && !prev.backFileId && !prev.paired) {
        const prevContact = await store.getContact(who, prev.contactId);
        if (prevContact && samePersonOnCard(prevContact, fields)) {
          await store.updateCard(who, prev.id, { backFileId: card.frontFileId, backRotation: front.rotation, paired: true });
          const patch = mergeFields(prevContact, fields, false);
          if (Object.keys(patch).length > 0) await store.updateContact(who, prevContact.id, patch, who.userId);
          await store.deleteCard(who, card.id);
          await this.finishBatch(who, card.batchId);
          return;
        }
      }
    }

    const contactId = await this.register(who, card, fields, 'system');
    await store.updateCard(who, card.id, {
      status: 'done', contactId, extracted: fields, frontRotation: front.rotation, backRotation,
      failureReason: front.multiple ? MULTIPLE_NOTE : null,
    });
    await this.finishBatch(who, card.batchId);
  }

  /** ファイルを読み、名刺として読み取る。 */
  private async readFile(llm: LlmProvider, tenantId: string, fileId: string): Promise<CardReading | null> {
    const meta = await this.deps.repo.getFile(tenantId, fileId);
    const bytes = meta ? await this.deps.files.get(tenantId, fileId) : null;
    if (!meta || !bytes) return null;
    const mime = CARD_MIME[meta.kind as CardFileKind] ?? meta.mime;
    const { reading } = await readCard(llm, bytes, mime);
    return reading;
  }

  /**
   * 読み取った項目で連絡先を登録する。同じ人がいればまとめ、いなければ新しく作る（第27.6節）。
   *
   * @param by 誰の操作として残すか（`system` は後ろでの読み取り）
   * @returns 連絡先の ID
   */
  async register(who: CardViewer, card: Pick<ContactCard, 'id' | 'scope' | 'receivedOn'>, fields: CardFields, by: string): Promise<string> {
    const { store } = this.deps;
    const llm = await this.deps.llmFor(who.tenantId);
    const match = await resolveContact(store, llm, who, card.scope, fields);
    if (match) {
      // 新しい名刺の中身を現在の値にする。古い名刺なら空の項目を埋めるだけ
      const latest = (await store.listCardsOfContact(who, match.contact.id)).find((c) => c.status === 'done');
      const newer = !latest || card.receivedOn >= latest.receivedOn;
      const patch = mergeFields(match.contact, fields, newer);
      if (Object.keys(patch).length > 0) await store.updateContact(who, match.contact.id, patch, by === 'system' ? who.userId : by);
      await this.audit(who.tenantId, by === 'system' ? { type: 'system', id: 'cards' } : { type: 'user', id: by },
        'contact.merge', 'contact', match.contact.id, { cardId: card.id, reason: match.reason, requestedBy: who.userId });
      return match.contact.id;
    }
    const now = new Date().toISOString();
    const contact: Contact = {
      ...EMPTY_CARD_FIELDS, ...fields,
      id: `ct-${randomUUID()}`, tenantId: who.tenantId, scope: card.scope, ownerUserId: who.userId, note: '',
      status: 'active', trashedAt: null, createdBy: who.userId, createdAt: now, updatedBy: who.userId, updatedAt: now,
    };
    await store.insertContact(who, contact);
    return contact.id;
  }

  /** まとまりの読み取りが終わったら、本人に知らせる（第27.4節・第6.5.5節）。 */
  private async finishBatch(who: CardViewer, batchId: string): Promise<void> {
    const p = await this.deps.store.batchProgress(who, batchId);
    if (p.total === 0 || p.pending > 0) return;
    const title = p.failed > 0
      ? `名刺を ${p.done} 枚登録しました（読み取れなかったもの ${p.failed} 枚）`
      : `名刺を ${p.done} 枚登録しました`;
    await this.deps.repo.createNotification({
      id: randomUUID(), tenantId: who.tenantId, userId: who.userId, kind: 'run', title,
      body: p.failed > 0 ? '読み取れなかった名刺は、名刺の画面の先頭に画像と一緒に並んでいます。撮り直してください。' : '名刺の画面で確かめられます。',
      runId: null, readAt: null, createdAt: new Date().toISOString(),
    });
  }

  /** 詳細（連絡先・名刺・名刺の履歴）。見られなければ `null`。 */
  async detail(who: CardViewer, contactId: string): Promise<ContactDetail | null> {
    const contact = await this.deps.store.getContact(who, contactId);
    if (!contact) return null;
    const cards = await this.deps.store.listCardsOfContact(who, contactId);
    const history: ContactDetail['history'] = [];
    for (const c of cards) {
      const f = { ...(c.extracted ?? EMPTY_CARD_FIELDS), ...c.corrected };
      if (!f.company && !f.title) continue;
      if (f.company === contact.company && f.department === contact.department && f.title === contact.title) continue;
      if (history.some((h) => h.company === f.company && h.department === f.department && h.title === f.title)) continue;
      history.push({ receivedOn: c.receivedOn, company: f.company, department: f.department, title: f.title });
    }
    return { contact, cards, history };
  }

  /**
   * 項目を直す（その場の修正・秘書に頼んだ修正。第27.5節）。見られる人の全員が直せる（第27.7節）。
   *
   * @returns 直せたら `true`。見られなければ `false`
   * @remarks 直した値は、いちばん新しい名刺の「人が直した項目」にも残す（読み取り直しで上書きしない）
   */
  async updateFields(who: CardViewer, contactId: string, patch: Partial<CardFields> & { note?: string }): Promise<boolean> {
    const { store } = this.deps;
    const contact = await store.getContact(who, contactId);
    if (!contact || contact.status !== 'active') return false;
    const clean = cleanPatch(patch);
    if (Object.keys(clean).length === 0) return true;
    await store.updateContact(who, contactId, clean, who.userId);
    const latest = (await store.listCardsOfContact(who, contactId)).find((c) => c.status === 'done');
    if (latest) {
      const { note: _note, ...fields } = clean;
      if (Object.keys(fields).length > 0) await store.updateCard(who, latest.id, { corrected: { ...latest.corrected, ...fields } });
    }
    return true;
  }

  /**
   * 範囲を変える（第27.7節）。会社で共有のものは取り込んだ本人と管理者、自分だけのものは本人だけが変えられる。
   *
   * @returns 変えられなければ理由
   */
  async setScope(who: CardViewer, user: Pick<User, 'id' | 'roles'>, contactId: string, scope: ContactScope): Promise<string | null> {
    const { store } = this.deps;
    const contact = await store.getContact(who, contactId);
    if (!contact) return '名刺が見つかりません';
    if (!canManage(contact, user)) return '範囲を変えられるのは、取り込んだ本人と管理者です';
    if (contact.scope === scope) return null;
    if (scope === 'personal') {
      // 自分だけの名刺は、取り込んだ本人のもの。ほかの人が受け取った名刺が入っていれば、その人から見えなくなるため変えない
      if (contact.ownerUserId !== user.id) return '自分だけにできるのは、取り込んだ本人です';
      const cards = await store.listCardsOfContact(who, contactId);
      if (cards.some((c) => c.ownerUserId !== user.id)) return 'ほかの人が受け取った名刺も入っているため、自分だけにはできません';
    }
    // 範囲は行の制限そのものなので、名刺の行を先に変える（連絡先を先に変えると、自分だけにしたとき名刺の行が見えなくなる）
    await store.setCardsScope(who, contactId, scope);
    await store.updateContact(who, contactId, { scope }, user.id);
    await this.audit(who.tenantId, { type: 'user', id: user.id }, 'contact.scope', 'contact', contactId, { from: contact.scope, to: scope });
    return null;
  }

  /**
   * まとめた名刺を、別の連絡先に分ける（まとめ間違いを戻す。第27.6節）。
   *
   * @returns 新しい連絡先の ID。分けられなければ理由
   */
  async split(who: CardViewer, user: Pick<User, 'id' | 'roles'>, contactId: string, cardId: string): Promise<{ contactId: string } | { error: string }> {
    const { store } = this.deps;
    const contact = await store.getContact(who, contactId);
    if (!contact || contact.status !== 'active') return { error: '名刺が見つかりません' };
    const cards = await store.listCardsOfContact(who, contactId);
    const card = cards.find((c) => c.id === cardId);
    if (!card) return { error: 'この連絡先の名刺ではありません' };
    if (cards.length < 2) return { error: '名刺が 1 枚だけの連絡先は分けられません' };
    const fields = { ...EMPTY_CARD_FIELDS, ...(card.extracted ?? {}), ...card.corrected };
    const now = new Date().toISOString();
    const created: Contact = {
      ...fields, id: `ct-${randomUUID()}`, tenantId: who.tenantId, scope: contact.scope, ownerUserId: card.ownerUserId, note: '',
      status: 'active', trashedAt: null, createdBy: user.id, createdAt: now, updatedBy: user.id, updatedAt: now,
    };
    await store.insertContact(who, created);
    await store.updateCard(who, card.id, { contactId: created.id });
    await this.audit(who.tenantId, { type: 'user', id: user.id }, 'contact.split', 'contact', contactId, { cardId, to: created.id });
    return { contactId: created.id };
  }

  /** ごみ箱へ移す（30 日で本当に消す。第27.7節）。 */
  async trash(who: CardViewer, user: Pick<User, 'id' | 'roles'>, contactId: string): Promise<string | null> {
    const contact = await this.deps.store.getContact(who, contactId);
    if (!contact || contact.status !== 'active') return '名刺が見つかりません';
    if (!canManage(contact, user)) return '消せるのは、取り込んだ本人と管理者です';
    await this.deps.store.updateContact(who, contactId, { status: 'trash', trashedAt: new Date().toISOString() }, user.id);
    await this.audit(who.tenantId, { type: 'user', id: user.id }, 'contact.trash', 'contact', contactId, {});
    return null;
  }

  /** ごみ箱から戻す。 */
  async restore(who: CardViewer, user: Pick<User, 'id' | 'roles'>, contactId: string): Promise<string | null> {
    const contact = await this.deps.store.getContact(who, contactId);
    if (!contact || contact.status !== 'trash') return 'ごみ箱に見つかりません';
    if (!canManage(contact, user)) return '戻せるのは、取り込んだ本人と管理者です';
    await this.deps.store.updateContact(who, contactId, { status: 'active', trashedAt: null }, user.id);
    await this.audit(who.tenantId, { type: 'user', id: user.id }, 'contact.restore', 'contact', contactId, {});
    return null;
  }

  /**
   * ごみ箱の名刺を、いま本当に消す（名刺の相手から消去を求められたとき。第27.7節）。画像ごと消す。
   *
   * @returns 消せなければ理由
   */
  async purgeNow(who: CardViewer, user: Pick<User, 'id' | 'roles'>, contactId: string): Promise<string | null> {
    const { store } = this.deps;
    const contact = await store.getContact(who, contactId);
    if (!contact || contact.status !== 'trash') return 'ごみ箱に見つかりません（先にごみ箱へ移してください）';
    if (!canManage(contact, user)) return '消せるのは、取り込んだ本人と管理者です';
    const cards = await store.listCardsOfContact(who, contactId);
    await this.removeFiles(who.tenantId, cards.flatMap((c) => [c.frontFileId, c.backFileId]));
    await store.purgeCards(cards.map((c) => c.id));
    await this.audit(who.tenantId, { type: 'user', id: user.id }, 'contact.purge', 'contact', contactId, { cards: cards.length });
    return null;
  }

  /** 読み取れなかった名刺を、待たずに消す（本人だけ）。 */
  async dismissFailed(who: CardViewer, cardId: string): Promise<boolean> {
    const card = await this.deps.store.getCard(who, cardId);
    if (!card || card.status !== 'failed' || card.ownerUserId !== who.userId) return false;
    await this.removeFiles(who.tenantId, [card.frontFileId, card.backFileId]);
    await this.deps.store.purgeCards([card.id]);
    return true;
  }

  /**
   * 期限を過ぎたものを本当に消す（ごみ箱に 30 日・読み取れなかったもの 4 週。ワーカーが呼ぶ）。
   *
   * @returns 消した名刺の数
   */
  async purgeExpired(): Promise<number> {
    const expired = await this.deps.store.expiredCards();
    if (expired.length === 0) return 0;
    for (const e of expired) await this.removeFiles(e.tenantId, [e.frontFileId, e.backFileId]);
    const n = await this.deps.store.purgeCards(expired.map((e) => e.cardId));
    for (const tenantId of new Set(expired.map((e) => e.tenantId))) {
      await this.audit(tenantId, { type: 'system', id: 'cards' }, 'contact.purge', 'card', 'expired',
        { cards: expired.filter((e) => e.tenantId === tenantId).length });
    }
    return n;
  }

  private async removeFiles(tenantId: string, ids: (string | null)[]): Promise<void> {
    for (const id of ids) if (id) await this.deps.files.remove(tenantId, id);
  }

  private async audit(
    tenantId: string, actor: { type: AuditEvent['actorType']; id: string }, action: string,
    targetType: string, targetId: string, detail: Record<string, unknown>,
  ): Promise<void> {
    await this.deps.repo.appendAudit({
      id: randomUUID(), tenantId, actorType: actor.type, actorId: actor.id, action, targetType, targetId,
      detail, occurredAt: new Date().toISOString(),
    });
  }
}

/**
 * 利用者がいま名刺管理を使えるかを決める関数を作る（会社の入り切りと利用範囲。第27.2節・第12.13節）。
 *
 * @returns 使えるなら取り込んだ名刺の既定の範囲、使えなければ `null` を返す関数
 */
export function cardsAccess(repo: Repository) {
  return async (tenantId: string, userId: string): Promise<{ defaultScope: ContactScope } | null> => {
    const settings = await repo.getTenantSettings(tenantId);
    if (!settings.cards.enabled) return null;
    const groups = await repo.listUserGroupIds(tenantId, userId);
    if (!canUseAgent(settings.access, CARDS_EXTENSION_ID, userId, groups)) return null;
    return { defaultScope: settings.cards.defaultScope };
  };
}

/**
 * タイムゾーンでの今日の日付（`YYYY-MM-DD`）。
 *
 * @remarks データベースの時計（世界標準時）で日付を決めると、日本時間の 0〜9 時が前の日になる（第27.11節）
 */
export function dateIn(timeZone: string, at: Date = new Date()): string {
  try {
    return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(at);
  } catch {
    return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Tokyo', year: 'numeric', month: '2-digit', day: '2-digit' }).format(at);
  }
}

/** 範囲の変更・消去ができるか（取り込んだ本人と、会社で共有のものは管理者も。第27.7節）。 */
export function canManage(contact: Pick<Contact, 'scope' | 'ownerUserId'>, user: Pick<User, 'id' | 'roles'>): boolean {
  if (contact.ownerUserId === user.id) return true;
  return contact.scope === 'company' && user.roles.includes('admin');
}

/** 表の空の項目を、裏の項目で埋める。 */
function fillBlanks(front: CardFields, back: CardFields): CardFields {
  const out = { ...front };
  for (const k of ['name', 'nameKana', 'company', 'department', 'title', 'postalCode', 'address', 'website', 'extra'] as const) {
    if (!out[k] && back[k]) out[k] = back[k];
  }
  out.phones = [...front.phones, ...back.phones.filter((p) => !front.phones.some((x) => x.number === p.number))];
  out.emails = [...new Set([...front.emails, ...back.emails])];
  return out;
}

/**
 * 続けて渡した 2 枚が、同じ人の表と裏か。メールアドレスか電話番号が重なれば同じ人とみなす。
 *
 * @remarks 日本語の面と英語の面は氏名の書き方が違うため、氏名では見ない
 */
function samePersonOnCard(a: CardFields, b: CardFields): boolean {
  if (a.emails.some((e) => b.emails.includes(e))) return true;
  const digits = (s: string) => s.replace(/[^0-9]/g, '').replace(/^81/, '0');
  const pa = a.phones.map((p) => digits(p.number)).filter((d) => d.length >= 9);
  return b.phones.some((p) => pa.includes(digits(p.number)));
}

/** 直す項目を整える（知らない項目は捨て、長さを切る）。 */
function cleanPatch(p: Partial<CardFields> & { note?: string }): ContactPatch {
  const out: ContactPatch = {};
  const text = { name: 100, nameKana: 100, company: 200, department: 200, title: 200, postalCode: 10, address: 300, website: 300, extra: 500, note: 2000 } as const;
  for (const [k, max] of Object.entries(text) as [keyof typeof text, number][]) {
    if (typeof p[k] === 'string') out[k] = (p[k] as string).trim().slice(0, max);
  }
  // 人がふりがなを直したら、推定ではなくなる
  if (out.nameKana !== undefined) out.kanaEstimated = false;
  if (Array.isArray(p.emails)) {
    out.emails = [...new Set(p.emails.filter((e): e is string => typeof e === 'string').map((e) => e.trim().toLowerCase()).filter(Boolean))].slice(0, 5);
  }
  if (Array.isArray(p.phones)) {
    out.phones = p.phones
      .filter((x) => x && typeof x.number === 'string' && x.number.trim())
      .map((x) => ({ kind: (['main', 'direct', 'mobile', 'fax'] as const).includes(x.kind) ? x.kind : 'main', number: x.number.trim().slice(0, 40) }))
      .slice(0, 8);
  }
  return out;
}
