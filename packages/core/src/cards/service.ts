/**
 * @file 名刺管理の操作。取り込み（受け付けと後ろでの読み取り）、登録、修正、範囲、分ける、ごみ箱と消去。
 *
 * 画面（API）・ワーカー（読み取りの待ち行列）・ツール（秘書と業務）の 3 か所から同じものを使う。
 * 読み取ったら確認を挟まずに登録し、同じ人は AI がまとめる（ADR-0028）。間違いは画面か秘書で直す。
 *
 * @see 仕様書 第27章 名刺管理
 */

import { randomUUID } from 'node:crypto';
import {
  CARDS_EXTENSION_ID, EMPTY_CARD_FIELDS, canUseAgent, type AuditEvent, type CardFields, type Contact, type ContactCard, type ContactChange,
  type ContactScope, type User,
} from '@m2office/shared';
import type { Repository } from '../repository/types.js';
import type { FileStore } from '../files/store.js';
import type { LlmProvider } from '../llm/provider.js';
import { saveFile } from '../files/service.js';
import { silentLogger, type Logger } from '../log/logger.js';
import { CARD_BATCH_MAX, CARD_MIME, detectCardKind, splitCardPdf, type CardFileKind } from './formats.js';
import { CARD_MAX_PER_IMAGE, readCard, type CardReading } from './read.js';
import { mergeFields, resolveContact } from './identity.js';
import { revertPatch } from './signature.js';
import { CARD_EXPORT_COLUMNS, cardFromRow, exportRow, mapCardHeaders, type CardTableField, type TableCell } from './table.js';
import type { CardViewer, ContactPatch, ContactStore, NewCard } from './store.js';

/** 1 ファイルの上限（第9.4.1節と同じ 10 MB）。 */
export const CARD_FILE_MAX_BYTES = 10 * 1024 * 1024;

/** 1 枚の写真に上限より多く写っていたときに添える知らせ（第27.4節）。 */
export const MULTIPLE_NOTE = `1 枚の写真に ${CARD_MAX_PER_IMAGE} 枚より多く写っていたため、${CARD_MAX_PER_IMAGE} 枚までを読み取りました`;

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

/** 表から取り込む行の上限（第27.4節「表から取り込む」）。 */
export const CARD_TABLE_MAX_ROWS = 1000;

/** 表からの取り込みの結果。 */
export interface TableImportResult {
  /** 新しく作った連絡先の数。 */
  created: number;
  /** 同じ人としてまとめた数。 */
  merged: number;
  /** 取り込めなかった行（1 から数えた行の番号と理由）。 */
  skipped: { row: number; reason: string }[];
  /** 列の見出しと、何として読んだか。 */
  mapping: { header: string; field: CardTableField | null }[];
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
  /** メールの署名から新しくした記録（戻していないもの。新しい順。第27.6.1節）。誰のメールからかは含めない。 */
  changes: ContactChange[];
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
    const reading = card.frontFileId ? await this.readFile(llm, who.tenantId, card.frontFileId) : null;
    if (!reading || reading.kind !== 'card') {
      await store.updateCard(who, card.id, {
        status: 'failed',
        failureReason: reading?.kind === 'unavailable' ? reading.reason : '名刺と見分けられないか、文字が読めませんでした',
      });
      await this.finishBatch(who, card.batchId);
      return;
    }
    const [front, ...others] = reading.cards as [typeof reading.cards[number], ...typeof reading.cards];
    const single = others.length === 0;
    let fields = front.fields;
    let backRotation = 0;
    let backCorners = null as typeof front.corners;
    if (card.backFileId && single) {
      // 組にした裏は、表に無い項目を埋めるのに使う（英語の面のメールアドレスなど）
      const back = await this.readFile(llm, who.tenantId, card.backFileId);
      if (back?.kind === 'card') {
        fields = fillBlanks(fields, back.cards[0]!.fields);
        backRotation = back.cards[0]!.rotation;
        backCorners = back.cards[0]!.corners;
      }
    }

    // 表裏を組にせずに続けて渡した同じ人の 2 枚は、1 枚の名刺（表と裏）にまとめる（第27.4節）。写真に 1 枚だけのときに限る
    if (single && !card.paired && !card.backFileId) {
      const prev = await store.previousCardInBatch(who, card.batchId, card.seq);
      if (prev && prev.status === 'done' && prev.contactId && !prev.backFileId && !prev.paired) {
        const prevContact = await store.getContact(who, prev.contactId);
        if (prevContact && samePersonOnCard(prevContact, fields)) {
          await store.updateCard(who, prev.id, { backFileId: card.frontFileId, backRotation: front.rotation, backCorners: front.corners, paired: true });
          const patch = mergeFields(prevContact, fields, false);
          if (Object.keys(patch).length > 0) await store.updateContact(who, prevContact.id, patch, who.userId);
          await store.deleteCard(who, card.id);
          await this.finishBatch(who, card.batchId);
          return;
        }
      }
    }

    // 1 枚の写真に何枚も写っていれば、2 枚目からを名刺ごとに登録する（同じ写真を名刺ごとの四隅で指す。第27.4節）。
    // 表と裏の組にしないよう、同じ写真の名刺は組にした印を付ける
    for (const other of others) {
      const id = `cc-${randomUUID()}`;
      const otherContact = await this.register(who, { id, scope: card.scope, receivedOn: card.receivedOn }, other.fields, 'system');
      await store.createReadCard(who, {
        id, scope: card.scope, batchId: card.batchId, seq: card.seq, frontFileId: card.frontFileId!, backFileId: null, paired: true,
        receivedOn: card.receivedOn, contactId: otherContact, extracted: other.fields, frontRotation: other.rotation, frontCorners: other.corners,
      });
    }
    const contactId = await this.register(who, card, fields, 'system');
    await store.updateCard(who, card.id, {
      status: 'done', contactId, extracted: fields, frontRotation: front.rotation, frontCorners: front.corners, backRotation, backCorners,
      ...(single ? {} : { paired: true }),
      failureReason: reading.truncated ? MULTIPLE_NOTE : null,
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
    return (await this.registerDetailed(who, card, fields, by)).id;
  }

  /**
   * 連絡先を登録し、同じ人にまとめたかも返す（表からの取り込みで数えるため）。
   *
   * @param note 新しく作る連絡先のメモ（まとめたときは、今のメモが空なら入れる）
   */
  private async registerDetailed(
    who: CardViewer, card: Pick<ContactCard, 'id' | 'scope' | 'receivedOn'>, fields: CardFields, by: string, note = '',
  ): Promise<{ id: string; merged: boolean }> {
    const { store } = this.deps;
    const llm = await this.deps.llmFor(who.tenantId);
    const match = await resolveContact(store, llm, who, card.scope, fields);
    if (match) {
      // 新しい名刺の中身を現在の値にする。古い名刺なら空の項目を埋めるだけ
      const latest = (await store.listCardsOfContact(who, match.contact.id)).find((c) => c.status === 'done');
      const newer = !latest || card.receivedOn >= latest.receivedOn;
      const patch = mergeFields(match.contact, fields, newer);
      if (note && !match.contact.note) (patch as ContactPatch).note = note;
      if (Object.keys(patch).length > 0) await store.updateContact(who, match.contact.id, patch, by === 'system' ? who.userId : by);
      await this.audit(who.tenantId, by === 'system' ? { type: 'system', id: 'cards' } : { type: 'user', id: by },
        'contact.merge', 'contact', match.contact.id, { cardId: card.id, reason: match.reason, requestedBy: who.userId });
      return { id: match.contact.id, merged: true };
    }
    const now = new Date().toISOString();
    const contact: Contact = {
      ...EMPTY_CARD_FIELDS, ...fields,
      id: `ct-${randomUUID()}`, tenantId: who.tenantId, scope: card.scope, ownerUserId: who.userId, note,
      status: 'active', trashedAt: null, createdBy: who.userId, createdAt: now, updatedBy: who.userId, updatedAt: now,
    };
    await store.insertContact(who, contact);
    return { id: contact.id, merged: false };
  }

  /**
   * 表（CSV・Excel を読んだもの）から名刺を取り込む（第27.4節「表から取り込む」）。1 行目を列の見出しとして読む。
   *
   * @param scope 範囲（画像の取り込みと同じく、選ばなければ会社の既定）
   * @remarks
   * 列の見出しは、よくある言い方で読み、読めない列は推論で読む（人に対応表を作らせない。ADR-0028）。
   * 1 行を 1 枚の名刺（画像の無い名刺）として登録し、同じ人はまとめる（第27.6節）。表の中身はデータであり、指示として扱わない（不変則 I-6）。
   * 監査ログには件数だけを残す（相手の名前は入れない）
   */
  async importTable(who: CardViewer, rows: TableCell[][], scope: ContactScope): Promise<TableImportResult> {
    const headers = (rows[0] ?? []).map((h) => String(h ?? '').trim());
    const llm = await this.deps.llmFor(who.tenantId).catch(() => null);
    const fields = await mapCardHeaders(headers, llm);
    const result: TableImportResult = { created: 0, merged: 0, skipped: [], mapping: headers.map((header, i) => ({ header, field: fields[i] ?? null })) };
    if (!fields.some((f) => f === 'name' || f === 'lastName' || f === 'company')) {
      result.skipped.push({ row: 1, reason: '氏名か会社名の列が見つかりませんでした' });
      return result;
    }
    const today = await this.today(who);
    const batchId = `cb-${randomUUID()}`;
    const body = rows.slice(1, CARD_TABLE_MAX_ROWS + 1);
    for (const [i, row] of body.entries()) {
      const read = cardFromRow(row, fields, today);
      if (!read) {
        if (row.some((v) => v !== null && String(v).trim() !== '')) result.skipped.push({ row: i + 2, reason: '氏名も会社名もありません' });
        continue;
      }
      const id = `cc-${randomUUID()}`;
      const receivedOn = read.receivedOn ?? today;
      const saved = await this.registerDetailed(who, { id, scope, receivedOn }, read.fields, who.userId, read.note);
      await this.deps.store.createReadCard(who, {
        id, scope, batchId, seq: i, frontFileId: null, backFileId: null, paired: true, receivedOn,
        contactId: saved.id, extracted: read.fields, frontRotation: 0, frontCorners: null,
      });
      if (saved.merged) result.merged++; else result.created++;
    }
    if (rows.length - 1 > CARD_TABLE_MAX_ROWS) result.skipped.push({ row: CARD_TABLE_MAX_ROWS + 2, reason: `${CARD_TABLE_MAX_ROWS} 行を超えた分は取り込んでいません` });
    await this.audit(who.tenantId, { type: 'user', id: who.userId }, 'card.import', 'card_batch', batchId,
      { count: result.created + result.merged, created: result.created, merged: result.merged, skipped: result.skipped.length, scope, source: 'table' });
    return result;
  }

  /**
   * 会社で共有の名刺を表にする（第27.10節「書き出し」）。管理者だけが呼ぶ（確かめるのは呼ぶ側）。自分だけの名刺は入れない。
   *
   * @remarks 監査ログに件数と形式を残す（相手の名前は入れない）
   */
  async exportTable(who: CardViewer, format: 'csv' | 'xlsx'): Promise<{ columns: string[]; rows: TableCell[][] }> {
    const items = await this.deps.store.listCompanyContacts(who);
    const names = new Map((await this.deps.repo.listUsers(who.tenantId)).map((u) => [u.id, u.displayName || u.email]));
    const rows = items.map(({ contact, lastReceivedOn }) => exportRow(contact, lastReceivedOn, names.get(contact.ownerUserId) ?? ''));
    await this.audit(who.tenantId, { type: 'user', id: who.userId }, 'contact.export', 'contact', 'company', { count: rows.length, format });
    return { columns: CARD_EXPORT_COLUMNS, rows };
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
    const changes = await this.deps.store.listChanges(who, { contactId, limit: 20 });
    return { contact, cards, history, changes };
  }

  /**
   * メールの署名から新しくした記録を戻す（第27.6.1節）。見られる人の全員が戻せる（直せる人と同じ。第27.7節）。
   *
   * @returns 戻せなければ理由
   * @remarks 今の値が署名から変えた値のままの項目だけを戻す。戻した項目は、署名が同じ値を示している間は再び変えない
   */
  async revertChange(who: CardViewer, contactId: string, changeId: string): Promise<string | null> {
    const { store } = this.deps;
    const change = await store.getChange(who, changeId);
    if (!change || change.contactId !== contactId) return '記録が見つかりません';
    if (change.revertedAt) return null;
    const contact = await store.getContact(who, contactId);
    if (!contact || contact.status !== 'active') return '名刺が見つかりません';
    const patch = revertPatch(contact, change.fields);
    if (Object.keys(patch).length > 0) await store.updateContact(who, contactId, patch, who.userId);
    await store.markChangeReverted(who, changeId, who.userId);
    await this.audit(who.tenantId, { type: 'user', id: who.userId }, 'contact.signature_revert', 'contact', contactId, { fields: Object.keys(patch) });
    return null;
  }

  /**
   * 本人か会社から Google のデータの削除を求められたとき、その人のメールの署名から変えた値を前の値に戻し、変更の記録を消す
   * （第27.6.1節、Q-152）。Google の連携の解除では呼ばない。
   *
   * @param mailboxUserId メールを受け取った人
   * @param by 求めに応じて操作した人
   * @returns 消した変更の記録の数
   * @remarks その後にほかの出どころで変わった項目は戻さない。見張りの状態（その人のメールで見た署名の値）も消す
   */
  async forgetMailSignatures(tenantId: string, mailboxUserId: string, by: string): Promise<number> {
    const { store } = this.deps;
    // その人として見る（会社で共有の名刺と、その人の自分だけの名刺。署名から変えるのはこの範囲だけ）
    const who: CardViewer = { tenantId, userId: mailboxUserId };
    const changes = await store.listChanges(who, { mailboxUserId, includeReverted: true, limit: 100_000 });
    const touched = new Set<string>();
    // 新しい順に戻すと、同じ項目を何度も変えていても最初の値まで戻る（今の値が後の記録の「後」と合う間だけ戻す）
    for (const change of changes) {
      touched.add(change.contactId);
      if (change.revertedAt) continue;
      const contact = await store.getContact(who, change.contactId);
      if (!contact) continue;
      const patch = revertPatch(contact, change.fields);
      if (Object.keys(patch).length > 0) await store.updateContact(who, change.contactId, patch, by);
    }
    for (const contactId of touched) await store.saveSignatureState(who, contactId, {});
    const n = await store.deleteChanges(who, changes.map((c) => c.id));
    await this.audit(tenantId, { type: 'user', id: by }, 'contact.signature_forget', 'user', mailboxUserId, { count: n });
    return n;
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
    await this.removeFiles(who.tenantId, cards.flatMap((c) => [c.frontFileId, c.backFileId]), cards.map((c) => c.id));
    await store.purgeCards(cards.map((c) => c.id));
    await this.audit(who.tenantId, { type: 'user', id: user.id }, 'contact.purge', 'contact', contactId, { cards: cards.length });
    return null;
  }

  /** 読み取れなかった名刺を、待たずに消す（本人だけ）。 */
  async dismissFailed(who: CardViewer, cardId: string): Promise<boolean> {
    const card = await this.deps.store.getCard(who, cardId);
    if (!card || card.status !== 'failed' || card.ownerUserId !== who.userId) return false;
    await this.removeFiles(who.tenantId, [card.frontFileId, card.backFileId], [card.id]);
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
    for (const e of expired) await this.removeFiles(e.tenantId, [e.frontFileId, e.backFileId], expired.map((x) => x.cardId));
    const n = await this.deps.store.purgeCards(expired.map((e) => e.cardId));
    for (const tenantId of new Set(expired.map((e) => e.tenantId))) {
      await this.audit(tenantId, { type: 'system', id: 'cards' }, 'contact.purge', 'card', 'expired',
        { cards: expired.filter((e) => e.tenantId === tenantId).length });
    }
    return n;
  }

  /**
   * 名刺の画像を置き場から消す。1 枚の写真に何枚も写っていたときは、ほかの名刺が指している間は消さない（第27.4節）。
   *
   * @param cardIds 消そうとしている名刺（これらのほかに指している名刺があるかを見る）
   */
  private async removeFiles(tenantId: string, ids: (string | null)[], cardIds: string[]): Promise<void> {
    for (const id of new Set(ids)) {
      if (id && !(await this.deps.store.fileInUse(tenantId, id, cardIds))) await this.deps.files.remove(tenantId, id);
    }
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
