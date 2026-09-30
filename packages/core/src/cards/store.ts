/**
 * @file 名刺と連絡先の置き場。問い合わせごとに会社と利用者を設定し、データベースの行単位の制限で絞る。
 *
 * 自分だけの名刺は、テナントに加えて持ち主でも絞る（管理者も見られない）。
 * そのため、どの問い合わせも「誰として見るか」（{@link CardViewer}）を受け取る。
 * 会社と持ち主をまたぐのは、読み取りの待ち行列の確保と、期限を過ぎたものの消去だけ（データベースの関数に閉じる）。
 *
 * @see 仕様書 第27.7節 持ち主の範囲
 * @see 仕様書 第27.10節 個人情報とデータの扱い
 * @see 仕様書 第27.11節 データモデル
 */

import pg from 'pg';
import type { CardCorners, CardFields, Contact, ContactCard, ContactScope } from '@m2office/shared';

/** 誰として見るか。自分だけの名刺は `userId` の人のものだけが見える。 */
export interface CardViewer {
  tenantId: string;
  userId: string;
}

/** 新しく取り込む名刺（読み取りの前）。 */
export interface NewCard {
  id: string;
  scope: ContactScope;
  batchId: string;
  seq: number;
  frontFileId: string;
  backFileId: string | null;
  paired: boolean;
  /** 受け取った日（`YYYY-MM-DD`）。取り込んだ人のタイムゾーンでの取り込んだ日を初めの値にする（第27.3節）。 */
  receivedOn: string;
}

/**
 * 読み取り済みで作る名刺（1 枚の写真に何枚も写っていたときの 2 枚目から。第27.4節）。待ち行列に入れず、登録済みで作る。
 */
export interface ReadCard extends Omit<NewCard, 'frontFileId'> {
  /** 画像。表から取り込んだ名刺（第27.4節）は画像が無く `null`。 */
  frontFileId: string | null;
  contactId: string;
  extracted: CardFields;
  frontRotation: number;
  frontCorners: CardCorners | null;
}

/** 一覧の 1 行。 */
export interface ContactSummary {
  id: string;
  scope: ContactScope;
  ownerUserId: string;
  name: string;
  nameKana: string;
  company: string;
  department: string;
  title: string;
  emails: string[];
  status: 'active' | 'trash';
  trashedAt: string | null;
  /** いちばん新しい名刺（縮小の画像に使う）。 */
  cardId: string | null;
  frontFileId: string | null;
  frontRotation: number;
  /** 名刺の四隅（第27.5節）。画面が切り出しに使う。 */
  frontCorners: CardCorners | null;
  frontKind: string | null;
  /** 最後に交換した日。 */
  lastReceivedOn: string | null;
  cardCount: number;
}

/** 一覧の絞り込み。 */
export interface ContactQuery {
  /** 氏名・ふりがな・会社名・部署・メールアドレス・電話番号の一部。 */
  q?: string;
  scope?: 'all' | ContactScope;
  status?: 'active' | 'trash';
  /** 交換した日（`YYYY-MM-DD`）の範囲。 */
  receivedFrom?: string;
  receivedTo?: string;
  limit: number;
  offset?: number;
}

/** 名刺の更新。 */
export type CardPatch = Partial<Pick<ContactCard,
  'contactId' | 'scope' | 'status' | 'failureReason' | 'extracted' | 'corrected' | 'frontRotation' | 'backRotation' | 'backFileId' | 'paired'
  | 'receivedOn' | 'frontCorners' | 'backCorners'>>;

/** 連絡先の更新。 */
export type ContactPatch = Partial<CardFields & Pick<Contact, 'note' | 'scope' | 'status' | 'trashedAt'>>;

/** 期限を過ぎた名刺（消す対象）。 */
export interface ExpiredCard {
  tenantId: string;
  cardId: string;
  contactId: string | null;
  frontFileId: string | null;
  backFileId: string | null;
}

/** まとまりの進み具合。 */
export interface BatchProgress {
  batchId: string;
  total: number;
  done: number;
  failed: number;
  pending: number;
}

/** 名刺と連絡先の置き場。 */
export interface ContactStore {
  createCards(who: CardViewer, cards: NewCard[]): Promise<void>;
  /** 読み取り済みの名刺を作る（1 枚の写真の 2 枚目から・表からの取り込み。第27.4節）。 */
  createReadCard(who: CardViewer, card: ReadCard): Promise<void>;
  /** 会社で共有の使っている連絡先と、最後に交換した日（まとめての書き出し。第27.10節）。 */
  listCompanyContacts(who: CardViewer): Promise<{ contact: Contact; lastReceivedOn: string | null }[]>;
  /** 画像を、指定した名刺のほかに指している名刺があるか（写真を消す前に確かめる。第27.4節）。 */
  fileInUse(tenantId: string, fileId: string, exclude: string[]): Promise<boolean>;
  /** 次に読み取る名刺を 1 枚確保する（会社をまたぐ）。無ければ `null`。 */
  claimNextCard(): Promise<{ id: string; tenantId: string; ownerUserId: string } | null>;
  getCard(who: CardViewer, id: string): Promise<ContactCard | null>;
  updateCard(who: CardViewer, id: string, patch: CardPatch): Promise<void>;
  /** 名刺の行を消す（画像のファイルは残す。表と裏をまとめ直すときに使う）。 */
  deleteCard(who: CardViewer, id: string): Promise<void>;
  /** まとまりの中で、ひとつ前の名刺。 */
  previousCardInBatch(who: CardViewer, batchId: string, seq: number): Promise<ContactCard | null>;
  batchProgress(who: CardViewer, batchId: string): Promise<BatchProgress>;
  /** 本人が取り込んで、まだ読み取りが終わっていない名刺のまとまり。 */
  activeBatches(who: CardViewer): Promise<BatchProgress[]>;
  /** 本人が取り込んで、読み取り中か読み取れなかった名刺。 */
  listUnresolvedCards(who: CardViewer): Promise<ContactCard[]>;
  listContacts(who: CardViewer, q: ContactQuery): Promise<ContactSummary[]>;
  getContact(who: CardViewer, id: string): Promise<Contact | null>;
  listCardsOfContact(who: CardViewer, contactId: string): Promise<ContactCard[]>;
  /** 同じ範囲の、有効な連絡先のうち、メールアドレスのどれかが同じもの。 */
  findByEmails(who: CardViewer, scope: ContactScope, emails: string[]): Promise<Contact[]>;
  /** 同じ範囲の、有効な連絡先のうち、氏名と会社名が同じもの（空白と大文字小文字を無視）。 */
  findByNameCompany(who: CardViewer, scope: ContactScope, name: string, company: string): Promise<Contact[]>;
  insertContact(who: CardViewer, c: Contact): Promise<void>;
  updateContact(who: CardViewer, id: string, patch: ContactPatch, by: string): Promise<void>;
  /** 連絡先の名刺の範囲を連絡先に合わせる。 */
  setCardsScope(who: CardViewer, contactId: string, scope: ContactScope): Promise<void>;
  /** 期限を過ぎたもの（ごみ箱に 30 日・読み取れなかったもの 4 週。会社と持ち主をまたぐ）。 */
  expiredCards(): Promise<ExpiredCard[]>;
  /** 名刺を本当に消す（会社と持ち主をまたぐ）。名刺の無くなったごみ箱の連絡先と、画像のファイルの行も消す。 */
  purgeCards(ids: string[]): Promise<number>;
  /** 利用者の自分だけの名刺（連絡先）の数。止めるときに管理者へ件数だけを示す（第27.7節、Q-94。中身は返さない）。 */
  countPersonalContacts(tenantId: string, userId: string): Promise<number>;
  close?(): Promise<void>;
}

const CONTACT_COLUMNS = `
  id, tenant_id as "tenantId", scope, owner_user_id as "ownerUserId", name, name_kana as "nameKana",
  kana_estimated as "kanaEstimated", company, department, title, postal_code as "postalCode", address,
  phones, emails, website, extra, note, status, trashed_at as "trashedAt", created_by as "createdBy",
  created_at as "createdAt", updated_by as "updatedBy", updated_at as "updatedAt"`;

const CARD_COLUMNS = `
  id, tenant_id as "tenantId", contact_id as "contactId", scope, owner_user_id as "ownerUserId",
  batch_id as "batchId", seq, front_file_id as "frontFileId", back_file_id as "backFileId",
  front_rotation as "frontRotation", back_rotation as "backRotation", front_corners as "frontCorners", back_corners as "backCorners", paired, status,
  failure_reason as "failureReason", extracted, corrected, to_char(received_on, 'YYYY-MM-DD') as "receivedOn",
  created_at as "createdAt"`;

/** 連絡先の項目と列の対応。更新で利用者の入力を列名に使わないため、この表からだけ引く。 */
const CONTACT_FIELD_COLUMNS: Record<keyof ContactPatch, string> = {
  name: 'name', nameKana: 'name_kana', kanaEstimated: 'kana_estimated', company: 'company', department: 'department',
  title: 'title', postalCode: 'postal_code', address: 'address', phones: 'phones', emails: 'emails', website: 'website',
  extra: 'extra', note: 'note', scope: 'scope', status: 'status', trashedAt: 'trashed_at',
};

const CARD_FIELD_COLUMNS: Record<keyof CardPatch, string> = {
  contactId: 'contact_id', scope: 'scope', status: 'status', failureReason: 'failure_reason', extracted: 'extracted',
  corrected: 'corrected', frontRotation: 'front_rotation', backRotation: 'back_rotation', backFileId: 'back_file_id', paired: 'paired',
  receivedOn: 'received_on', frontCorners: 'front_corners', backCorners: 'back_corners',
};

/** JSON で持つ列（書くときに文字列にする）。 */
const JSON_COLUMNS = new Set(['phones', 'extracted', 'corrected', 'front_corners', 'back_corners']);

/**
 * PostgreSQL の名刺の置き場。
 *
 * @remarks
 * 問い合わせごとにトランザクションを張り、`app.tenant_id` と `app.user_id` を設定する。
 * データベースの行単位の制限が、会社で共有の名刺と、自分の自分だけの名刺だけを返す（移行 036）。
 * SQL の条件を書き漏らしても、他社の名刺と他人の自分だけの名刺は返らない
 */
export class PostgresContactStore implements ContactStore {
  private readonly pool: pg.Pool;

  constructor(connectionString: string) {
    this.pool = new pg.Pool({ connectionString, max: 4 });
  }

  async close(): Promise<void> {
    await this.pool.end();
  }

  /** 会社と利用者を設定したトランザクションの中で問い合わせる。 */
  private async q<T extends pg.QueryResultRow>(who: CardViewer, text: string, params: unknown[] = []): Promise<T[]> {
    const client = await this.pool.connect();
    try {
      await client.query('begin');
      await client.query(`select set_config('app.tenant_id', $1, true), set_config('app.user_id', $2, true)`, [who.tenantId, who.userId]);
      const res = await client.query<T>(text, params as never[]);
      await client.query('commit');
      return res.rows;
    } catch (err) {
      await client.query('rollback').catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
  }

  async createCards(who: CardViewer, cards: NewCard[]): Promise<void> {
    for (const c of cards) {
      await this.q(who,
        `insert into contact_cards (id, tenant_id, scope, owner_user_id, batch_id, seq, front_file_id, back_file_id, paired, received_on)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
        [c.id, who.tenantId, c.scope, who.userId, c.batchId, c.seq, c.frontFileId, c.backFileId, c.paired, c.receivedOn]);
    }
  }

  async createReadCard(who: CardViewer, c: ReadCard): Promise<void> {
    await this.q(who,
      `insert into contact_cards (id, tenant_id, scope, owner_user_id, batch_id, seq, front_file_id, back_file_id, paired, received_on,
                                  status, contact_id, extracted, front_rotation, front_corners)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'done', $11, $12, $13, $14)`,
      [c.id, who.tenantId, c.scope, who.userId, c.batchId, c.seq, c.frontFileId, c.backFileId, c.paired, c.receivedOn,
        c.contactId, JSON.stringify(c.extracted), c.frontRotation, c.frontCorners ? JSON.stringify(c.frontCorners) : null]);
  }

  async listCompanyContacts(who: CardViewer): Promise<{ contact: Contact; lastReceivedOn: string | null }[]> {
    const rows = await this.q<Contact & { lastReceivedOn: string | null }>(who,
      `select ${CONTACT_COLUMNS},
              (select to_char(max(c.received_on), 'YYYY-MM-DD') from contact_cards c where c.contact_id = contacts.id) as "lastReceivedOn"
         from contacts where tenant_id = $1 and scope = 'company' and status = 'active' order by name_kana, name`,
      [who.tenantId]);
    return rows.map(({ lastReceivedOn, ...contact }) => ({ contact: contact as Contact, lastReceivedOn }));
  }

  async fileInUse(tenantId: string, fileId: string, exclude: string[]): Promise<boolean> {
    const res = await this.pool.query<{ used: boolean }>('select m2o_card_file_in_use($1, $2, $3) as used', [tenantId, fileId, exclude]);
    return res.rows[0]?.used === true;
  }

  async claimNextCard(): Promise<{ id: string; tenantId: string; ownerUserId: string } | null> {
    const res = await this.pool.query<{ id: string; tenant_id: string; owner_user_id: string }>(
      'select id, tenant_id, owner_user_id from m2o_claim_contact_card()');
    const r = res.rows[0];
    return r ? { id: r.id, tenantId: r.tenant_id, ownerUserId: r.owner_user_id } : null;
  }

  async getCard(who: CardViewer, id: string): Promise<ContactCard | null> {
    const rows = await this.q<ContactCard>(who, `select ${CARD_COLUMNS} from contact_cards where tenant_id = $1 and id = $2`, [who.tenantId, id]);
    return rows[0] ?? null;
  }

  async updateCard(who: CardViewer, id: string, patch: CardPatch): Promise<void> {
    const { sets, values } = assignments(patch, CARD_FIELD_COLUMNS, 3);
    if (sets.length === 0) return;
    await this.q(who, `update contact_cards set ${sets.join(', ')}, updated_at = now() where tenant_id = $1 and id = $2`,
      [who.tenantId, id, ...values]);
  }

  async deleteCard(who: CardViewer, id: string): Promise<void> {
    await this.q(who, 'delete from contact_cards where tenant_id = $1 and id = $2', [who.tenantId, id]);
  }

  async previousCardInBatch(who: CardViewer, batchId: string, seq: number): Promise<ContactCard | null> {
    const rows = await this.q<ContactCard>(who,
      `select ${CARD_COLUMNS} from contact_cards where tenant_id = $1 and batch_id = $2 and seq < $3 order by seq desc limit 1`,
      [who.tenantId, batchId, seq]);
    return rows[0] ?? null;
  }

  async batchProgress(who: CardViewer, batchId: string): Promise<BatchProgress> {
    const rows = await this.q<{ total: number; done: number; failed: number; pending: number }>(who,
      `select count(*)::int as total,
              count(*) filter (where status = 'done')::int as done,
              count(*) filter (where status = 'failed')::int as failed,
              count(*) filter (where status in ('pending', 'reading'))::int as pending
         from contact_cards where tenant_id = $1 and batch_id = $2 and owner_user_id = $3`,
      [who.tenantId, batchId, who.userId]);
    const r = rows[0] ?? { total: 0, done: 0, failed: 0, pending: 0 };
    return { batchId, ...r };
  }

  async activeBatches(who: CardViewer): Promise<BatchProgress[]> {
    return this.q<BatchProgress>(who,
      `select batch_id as "batchId", count(*)::int as total,
              count(*) filter (where status = 'done')::int as done,
              count(*) filter (where status = 'failed')::int as failed,
              count(*) filter (where status in ('pending', 'reading'))::int as pending
         from contact_cards
        where tenant_id = $1 and owner_user_id = $2
          and batch_id in (select batch_id from contact_cards where tenant_id = $1 and owner_user_id = $2 and status in ('pending', 'reading'))
        group by batch_id order by min(created_at)`,
      [who.tenantId, who.userId]);
  }

  async listUnresolvedCards(who: CardViewer): Promise<ContactCard[]> {
    return this.q<ContactCard>(who,
      `select ${CARD_COLUMNS} from contact_cards
        where tenant_id = $1 and owner_user_id = $2 and status in ('pending', 'reading', 'failed')
        order by created_at desc, seq desc limit 200`,
      [who.tenantId, who.userId]);
  }

  async listContacts(who: CardViewer, query: ContactQuery): Promise<ContactSummary[]> {
    // 空白で区切った言葉が、どれも項目のどれかに当たるものを返す（「ミライ工業 山本」で会社名と氏名に当たる）。
    // 氏名・ふりがな・会社名・住所は空白を除いて比べる（名刺の「佐野 毅」を「佐野毅」でも探せるように。第27.8節）
    const terms = (query.q ?? '').trim().split(/[\s　]+/).filter(Boolean).slice(0, 4);
    const likes = terms.length > 0 ? terms.map((t) => `%${t.replace(/[\\%_]/g, '\\$&')}%`) : null;
    const digits = terms.length === 1 ? terms[0]!.replace(/[^0-9]/g, '') : '';
    return this.q<ContactSummary>(who,
      `select k.id, k.scope, k.owner_user_id as "ownerUserId", k.name, k.name_kana as "nameKana", k.company,
              k.department, k.title, k.emails, k.status, k.trashed_at as "trashedAt",
              last.id as "cardId", last.front_file_id as "frontFileId", coalesce(last.front_rotation, 0) as "frontRotation",
              last.front_corners as "frontCorners",
              f.kind as "frontKind", to_char(last.received_on, 'YYYY-MM-DD') as "lastReceivedOn",
              (select count(*)::int from contact_cards c where c.contact_id = k.id) as "cardCount"
         from contacts k
         left join lateral (
           select c.id, c.front_file_id, c.front_rotation, c.front_corners, c.received_on from contact_cards c
            where c.contact_id = k.id order by c.received_on desc, c.created_at desc limit 1
         ) last on true
         left join files f on f.id = last.front_file_id
        where k.tenant_id = $1 and k.status = $2
          and ($3::text = 'all' or k.scope = $3)
          and ($4::text[] is null or not exists (
                select 1 from unnest($4::text[]) t
                 where not (regexp_replace(k.name, '[[:space:]　]', '', 'g') ilike t
                            or regexp_replace(coalesce(k.name_kana, ''), '[[:space:]　]', '', 'g') ilike t
                            or regexp_replace(coalesce(k.company, ''), '[[:space:]　]', '', 'g') ilike t
                            or regexp_replace(coalesce(k.address, ''), '[[:space:]　]', '', 'g') ilike t
                            or k.department ilike t or k.title ilike t
                            or array_to_string(k.emails, ' ') ilike t or k.note ilike t))
               or ($5::text <> '' and regexp_replace(k.phones::text, '[^0-9]', '', 'g') like '%' || $5 || '%'))
          and ($6::date is null or exists (select 1 from contact_cards c where c.contact_id = k.id and c.received_on >= $6))
          and ($7::date is null or exists (select 1 from contact_cards c where c.contact_id = k.id and c.received_on <= $7))
        order by coalesce(last.received_on, k.created_at::date) desc, k.updated_at desc
        limit $8 offset $9`,
      [who.tenantId, query.status ?? 'active', query.scope ?? 'all', likes, digits.length >= 3 ? digits : '',
        query.receivedFrom ?? null, query.receivedTo ?? null, query.limit, query.offset ?? 0]);
  }

  async getContact(who: CardViewer, id: string): Promise<Contact | null> {
    const rows = await this.q<Contact>(who, `select ${CONTACT_COLUMNS} from contacts where tenant_id = $1 and id = $2`, [who.tenantId, id]);
    return rows[0] ?? null;
  }

  async listCardsOfContact(who: CardViewer, contactId: string): Promise<ContactCard[]> {
    return this.q<ContactCard>(who,
      `select ${CARD_COLUMNS} from contact_cards where tenant_id = $1 and contact_id = $2 order by received_on desc, created_at desc`,
      [who.tenantId, contactId]);
  }

  async findByEmails(who: CardViewer, scope: ContactScope, emails: string[]): Promise<Contact[]> {
    if (emails.length === 0) return [];
    return this.q<Contact>(who,
      `select ${CONTACT_COLUMNS} from contacts
        where tenant_id = $1 and status = 'active' and scope = $2 and ($2 = 'company' or owner_user_id = $4) and emails && $3::text[]`,
      [who.tenantId, scope, emails.map((e) => e.toLowerCase()), who.userId]);
  }

  async findByNameCompany(who: CardViewer, scope: ContactScope, name: string, company: string): Promise<Contact[]> {
    const norm = (s: string) => s.replace(/[\s　]/g, '').toLowerCase();
    if (!norm(name)) return [];
    return this.q<Contact>(who,
      `select ${CONTACT_COLUMNS} from contacts
        where tenant_id = $1 and status = 'active' and scope = $2 and ($2 = 'company' or owner_user_id = $5)
          and lower(regexp_replace(name, '[\\s　]', '', 'g')) = $3
          and lower(regexp_replace(company, '[\\s　]', '', 'g')) = $4`,
      [who.tenantId, scope, norm(name), norm(company), who.userId]);
  }

  async insertContact(who: CardViewer, c: Contact): Promise<void> {
    await this.q(who,
      `insert into contacts (id, tenant_id, scope, owner_user_id, name, name_kana, kana_estimated, company, department, title,
                             postal_code, address, phones, emails, website, extra, note, status, created_by, updated_by)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,'active',$18,$18)`,
      [c.id, who.tenantId, c.scope, c.ownerUserId, c.name, c.nameKana, c.kanaEstimated, c.company, c.department, c.title,
        c.postalCode, c.address, JSON.stringify(c.phones), c.emails, c.website, c.extra, c.note, c.createdBy]);
  }

  async updateContact(who: CardViewer, id: string, patch: ContactPatch, by: string): Promise<void> {
    const { sets, values } = assignments(patch, CONTACT_FIELD_COLUMNS, 4);
    if (sets.length === 0) return;
    await this.q(who,
      `update contacts set ${sets.join(', ')}, updated_by = $3, updated_at = now() where tenant_id = $1 and id = $2`,
      [who.tenantId, id, by, ...values]);
  }

  async setCardsScope(who: CardViewer, contactId: string, scope: ContactScope): Promise<void> {
    await this.q(who, `update contact_cards set scope = $3, updated_at = now() where tenant_id = $1 and contact_id = $2`,
      [who.tenantId, contactId, scope]);
  }

  async expiredCards(): Promise<ExpiredCard[]> {
    const res = await this.pool.query<{ tenant_id: string; card_id: string; contact_id: string | null; front_file_id: string | null; back_file_id: string | null }>(
      'select tenant_id, card_id, contact_id, front_file_id, back_file_id from m2o_expired_contact_cards()');
    return res.rows.map((r) => ({
      tenantId: r.tenant_id, cardId: r.card_id, contactId: r.contact_id, frontFileId: r.front_file_id, backFileId: r.back_file_id,
    }));
  }

  async countPersonalContacts(tenantId: string, userId: string): Promise<number> {
    const res = await this.pool.query<{ n: number }>('select m2o_count_personal_contacts($1, $2) as n', [tenantId, userId]);
    return res.rows[0]?.n ?? 0;
  }

  async purgeCards(ids: string[]): Promise<number> {
    if (ids.length === 0) return 0;
    const res = await this.pool.query<{ n: number }>('select m2o_purge_contact_cards($1) as n', [ids]);
    return res.rows[0]?.n ?? 0;
  }
}

/**
 * 更新の `set` 句を、固定の対応表から組み立てる。利用者の入力を列名に使わない。
 *
 * @param from 最初のパラメーターの番号
 */
function assignments<P extends object>(
  patch: P, columns: Record<keyof P, string>, from: number,
): { sets: string[]; values: unknown[] } {
  const sets: string[] = [];
  const values: unknown[] = [];
  for (const [key, value] of Object.entries(patch) as [keyof P, unknown][]) {
    if (value === undefined) continue;
    const col = columns[key];
    if (!col) continue;
    values.push(JSON_COLUMNS.has(col) && value !== null ? JSON.stringify(value) : value);
    sets.push(`${col} = $${from + values.length - 1}`);
  }
  return { sets, values };
}
