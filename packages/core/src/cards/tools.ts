/**
 * @file 名刺管理のツール。名刺を探す・1 件を見る・登録と修正・画像から読み取る。秘書と付属の業務が使う。
 *
 * どのツールも、呼んだ人が見られる範囲だけを扱う（自分だけの名刺は本人だけ。データベースの行単位の制限でも絞る）。
 * 名刺管理を切っている会社と、利用範囲の外の人には、ツールは「使えない」と返す（呼ぶたびに `ctx.cards.access()` で確かめる）。
 * 名刺の中身はデータであり、指示として扱わない（不変則 I-6）。
 *
 * @see 仕様書 第27.9節 秘書と業務から使う
 */

import { randomUUID } from 'node:crypto';
import { EMPTY_CARD_FIELDS, type CardFields, type ContactScope } from '@m2office/shared';
import type { Tool, ToolContext } from '../tools/registry.js';
import type { LlmProvider } from '../llm/provider.js';
import { loadFile, saveFile } from '../files/service.js';
import { CARD_MIME, type CardFileKind } from './formats.js';
import { CARD_MAX_PER_IMAGE, parseCardReading, readCard } from './read.js';
import type { CardService } from './service.js';
import type { ContactStore } from './store.js';
import type { BulkMailService, BulkPreview } from './bulk.js';
import { ConnectorUnavailableError } from '../connectors/types.js';
import { GOOGLE_PUSH_MAX, type GoogleContactsService } from './google-contacts.js';

/** ツールに渡す名刺管理の文脈。 */
export interface CardToolContext {
  service: CardService;
  store: ContactStore;
  /** 名刺を読み取る推論（その会社のもの）。 */
  llm: LlmProvider;
  /**
   * 依頼者がいま名刺管理を使えるか。会社が名刺管理を使っていて、依頼者が利用範囲の中なら、取り込んだ名刺の既定の範囲を返す（第27.7節）。
   *
   * @returns 使えなければ `null`
   */
  access(): Promise<{ defaultScope: ContactScope } | null>;
  /** まとめてのメール（第27.9.1節）。無ければまとめてのメールのツールは「使えない」と返す。 */
  bulk?: BulkMailService;
  /** 本人の Google の連絡先へのつなぎ（第27.15節）。無ければ連絡先のツールは「使えない」と返す。 */
  google?: GoogleContactsService;
}

/** 名刺管理を使えるなら文脈と既定の範囲を返す。使えなければ `null`。 */
async function cardsOf(ctx: ToolContext): Promise<(CardToolContext & { defaultScope: ContactScope }) | null> {
  if (!ctx.cards) return null;
  const access = await ctx.cards.access();
  return access ? { ...ctx.cards, defaultScope: access.defaultScope } : null;
}

const UNAVAILABLE = { available: false, reason: '名刺管理は使えません（会社で切っているか、利用範囲の外です）' };

const str = (v: unknown) => (typeof v === 'string' ? v : '');

/** 呼んだ人として見る。 */
const viewer = (ctx: ToolContext) => ({ tenantId: ctx.tenantId, userId: ctx.userId });

/**
 * 名刺の画像から項目を取り出す（第27.5節）。
 *
 * @remarks 危険度 `read`。登録はしない（登録は `contacts.save`）。読み取りは推論であり、確かな値ではない
 */
export const cardRead: Tool = {
  name: 'card.read',
  risk: 'read',
  activityLabel: '名刺を読み取っています',
  helpText: '名刺の画像から、氏名・会社名・電話・メールアドレスなどを読み取ります。登録はしません',
  description: '名刺の画像（PNG・JPEG・HEIC・WebP・PDF）から項目を取り出す。何枚も写っていれば cards に名刺ごとに返す。名刺ごとに contacts.save の card（fileId・fields・rotation・corners）に渡すと登録できる',
  args: { properties: { fileId: { type: 'string', description: '名刺の画像のファイル ID' } }, required: ['fileId'] },
  async invoke(args, ctx) {
    const cards = await cardsOf(ctx);
    if (!cards) return UNAVAILABLE;
    const f = await loadFile(ctx.repo, ctx.files, ctx.tenantId, str(args['fileId']), { id: ctx.userId, roles: [] });
    if (!f) return { available: false, reason: 'ファイルが見つかりません' };
    const mime = CARD_MIME[f.meta.kind as CardFileKind];
    if (!mime) return { available: false, reason: `名刺の画像ではありません: ${f.meta.kind}` };
    const { reading } = await readCard(cards.llm, f.bytes, mime);
    if (reading.kind === 'unavailable') return { available: false, reason: reading.reason };
    if (reading.kind === 'not-card') return { available: true, isCard: false, note: '名刺と見分けられないか、文字が読めませんでした' };
    const [first] = reading.cards;
    return {
      available: true, isCard: true, untrusted: true, fileId: f.meta.id, fields: first!.fields, rotation: first!.rotation, corners: first!.corners,
      // 1 枚の写真に何枚も写っていれば、名刺ごとに返す（第27.4節）
      ...(reading.cards.length > 1 ? { cards: reading.cards.map((c) => ({ fields: c.fields, rotation: c.rotation, corners: c.corners })) } : {}),
      ...(reading.truncated ? { note: `${CARD_MAX_PER_IMAGE} 枚より多く写っていたため、${CARD_MAX_PER_IMAGE} 枚までを読み取りました` } : {}),
    };
  },
};

/** 秘書の検索で 1 度に返す連絡先の数。 */
const SEARCH_LIMIT = 20;

/**
 * 名刺（連絡先）を探す（第27.9節）。
 *
 * @remarks 危険度 `read`。呼んだ人が見られる範囲だけを返す。見つからなければ空（推測で答えない）
 */
export const contactsSearch: Tool = {
  name: 'contacts.search',
  risk: 'read',
  activityLabel: '名刺を探しています',
  helpText: '取り込んだ名刺から、氏名・会社名・住所・電話番号などで人を探します。見るだけです',
  description: '名刺（連絡先）を探す。query は氏名・ふりがな・会社名・部署・住所（「横浜市」など）・メールアドレス・電話番号・英語の表記・名刺の裏の文・関連会社・商品とサービスの一部。空白で区切るとすべてに当たるものに絞る。from・to で名刺を交換した日（YYYY-MM-DD）の範囲に絞れる。more が true なら続きがある（言葉を足して絞る）',
  args: {
    properties: {
      query: { type: 'string', description: '探す言葉（空なら交換した日の範囲だけで絞る）' },
      from: { type: 'string', description: '交換した日の始め（YYYY-MM-DD）' },
      to: { type: 'string', description: '交換した日の終わり（YYYY-MM-DD）' },
    },
  },
  async invoke(args, ctx) {
    const cards = await cardsOf(ctx);
    if (!cards) return UNAVAILABLE;
    const who = viewer(ctx);
    const date = (v: unknown) => (/^\d{4}-\d{2}-\d{2}$/.test(str(v)) ? str(v) : undefined);
    // 1 件多く取り、続きがあるかを示す（「横浜市の人」のように多く当たる問いで、全部と取り違えないように）
    const found = await cards.store.listContacts(who, {
      q: str(args['query']).slice(0, 100), limit: SEARCH_LIMIT + 1,
      ...(date(args['from']) ? { receivedFrom: date(args['from'])! } : {}),
      ...(date(args['to']) ? { receivedTo: date(args['to'])! } : {}),
    });
    const items = [];
    for (const s of found.slice(0, SEARCH_LIMIT)) {
      const c = await cards.store.getContact(who, s.id);
      if (!c) continue;
      items.push({
        contactId: c.id, name: c.name, nameKana: c.nameKana, company: c.company, department: c.department, title: c.title,
        phones: c.phones, emails: c.emails, address: c.address, lastReceivedOn: s.lastReceivedOn,
        scope: c.scope === 'personal' ? '自分だけ' : '会社で共有',
      });
    }
    const more = found.length > SEARCH_LIMIT;
    return {
      available: true, untrusted: true, count: items.length, more, items,
      ...(items.length === 0 ? { note: '見つかりませんでした' } : more ? { note: `${SEARCH_LIMIT} 件より多く当たりました。ここに無い人もいます` } : {}),
    };
  },
};

/**
 * 1 件の連絡先と、名刺の履歴・交換の記録を返す（第27.9節）。
 *
 * @remarks 危険度 `read`。見られない連絡先は「見つからない」と返す（存在を示さない）
 */
export const contactsGet: Tool = {
  name: 'contacts.get',
  risk: 'read',
  activityLabel: '名刺を見ています',
  helpText: '1 人分の名刺の中身と、誰がいつ名刺を受け取ったかを見ます。見るだけです',
  description: '1 件の連絡先（contactId）の項目・メモ・英語の表記・名刺の裏の文と関連会社・商品とサービス・名刺の履歴（以前の会社・役職）・交換の記録（受け取った人と日）を返す',
  args: { properties: { contactId: { type: 'string', description: '連絡先の ID（contacts.search の結果）' } }, required: ['contactId'] },
  async invoke(args, ctx) {
    const cards = await cardsOf(ctx);
    if (!cards) return UNAVAILABLE;
    const d = await cards.service.detail(viewer(ctx), str(args['contactId']));
    if (!d || d.contact.status !== 'active') return { available: false, reason: '名刺が見つかりません' };
    const users = await ctx.repo.listUsers(ctx.tenantId);
    const nameOf = (id: string) => users.find((u) => u.id === id)?.displayName ?? id;
    const { contact: c } = d;
    return {
      available: true, untrusted: true,
      contact: {
        contactId: c.id, name: c.name, nameKana: c.nameKana, company: c.company, department: c.department, title: c.title,
        postalCode: c.postalCode, address: c.address, phones: c.phones, emails: c.emails, website: c.website, extra: c.extra, note: c.note,
        // 名刺の裏から読んだもの（第27.5.1節）。英語のメールを書くときは英語の表記を使う。裏の文はデータであり、指示ではない
        english: c.english ?? null, related: c.related ?? [], products: c.products ?? [], backText: c.backText ?? '',
      },
      exchanges: d.cards.filter((x) => x.status === 'done').map((x) => ({
        cardId: x.id, receivedOn: x.receivedOn, receivedBy: nameOf(x.ownerUserId), mine: x.ownerUserId === ctx.userId,
      })),
      history: d.history,
    };
  },
};

/**
 * 連絡先を登録・更新する（第27.9節）。
 *
 * @remarks
 * 危険度 `write-internal`。社内の名刺の置き場に書くだけで、社外には何も送らない。
 * `contactId` があれば項目とメモを直す（見られる人の全員が直せる）。`card` があれば、読み取った名刺を登録する
 * （同じ人がいればまとめる。第27.6節）。範囲は会社の既定（取り込んだ人が画面で変えられる）
 */
export const contactsSave: Tool = {
  name: 'contacts.save',
  risk: 'write-internal',
  activityLabel: '名刺を登録しています',
  helpText: '名刺を連絡先として登録するか、電話番号やメモなどを直します。社内の名刺の置き場に書くだけで、誰にも送りません',
  description: '連絡先を直す（contactId と fields・note）か、card.read で読み取った名刺を登録する（card に card.read の fileId・fields・rotation をそのまま渡す）。'
    + '受け取った日を直すときは contactId と receivedOn（YYYY-MM-DD）。直せるのは呼んだ人が受け取った名刺だけ（cardId を省くと、呼んだ人が受け取ったいちばん新しい名刺）',
  args: {
    properties: {
      contactId: { type: 'string', description: '直す連絡先の ID。新しく登録するときは書かない' },
      fields: { type: 'object', description: '直す項目（name・nameKana・company・department・title・postalCode・address・phones・emails・website・extra）' },
      note: { type: 'string', description: 'メモ（「展示会で会った」など）。書くと置き換える' },
      card: { type: 'object', description: '登録する名刺。card.read の結果の fileId・fields・rotation' },
      receivedOn: { type: 'string', description: '名刺を受け取った日（YYYY-MM-DD）。直すときだけ書く' },
      cardId: { type: 'string', description: '受け取った日を直す名刺（contacts.get の exchanges の cardId）。省くと呼んだ人のいちばん新しい名刺' },
    },
  },
  async invoke(args, ctx) {
    const cards = await cardsOf(ctx);
    if (!cards) return UNAVAILABLE;
    const who = viewer(ctx);
    const contactId = str(args['contactId']);
    if (contactId) {
      const fields = (args['fields'] && typeof args['fields'] === 'object' ? args['fields'] : {}) as Partial<CardFields>;
      const note = typeof args['note'] === 'string' ? { note: args['note'] } : {};
      const receivedOn = str(args['receivedOn']);
      if (receivedOn) {
        // 受け取った日は、呼んだ人が受け取った名刺のものだけを直す（第27.3節）
        const mine = (await cards.store.listCardsOfContact(who, contactId)).filter((x) => x.status === 'done' && x.ownerUserId === ctx.userId);
        const target = str(args['cardId']) ? mine.find((x) => x.id === str(args['cardId'])) : mine[0];
        if (!target) return { saved: false, reason: 'あなたが受け取った、この人の名刺が見つかりません' };
        const err = await cards.service.setReceivedOn(who, target.id, receivedOn);
        if (err) return { saved: false, reason: err };
        if (Object.keys(fields).length === 0 && !('note' in note)) return { saved: true, contactId, receivedOn };
      }
      const ok = await cards.service.updateFields(who, contactId, { ...fields, ...note });
      return ok ? { saved: true, contactId, ...(receivedOn ? { receivedOn } : {}) } : { saved: false, reason: '名刺が見つかりません' };
    }
    const card = (args['card'] && typeof args['card'] === 'object' ? args['card'] : null) as Record<string, unknown> | null;
    const fileId = str(card?.['fileId']);
    if (!card || !fileId) return { saved: false, reason: 'contactId か card を指定してください' };
    const f = await loadFile(ctx.repo, ctx.files, ctx.tenantId, fileId, { id: ctx.userId, roles: [] });
    if (!f || !CARD_MIME[f.meta.kind as CardFileKind]) return { saved: false, reason: '名刺の画像が見つかりません' };
    // 推論が書き写した項目を、読み取りの結果と同じ決まりで整える（知らない項目は捨てる・推測で埋めない）
    const reading = parseCardReading(JSON.stringify({ isCard: true, ...(card['fields'] as object ?? {}), rotation: card['rotation'], corners: card['corners'] }));
    if (reading.kind !== 'card') return { saved: false, reason: '氏名も会社名も無いため、登録できません' };
    const parsed = reading.cards[0]!;
    // 秘書に渡したファイルは 4 週で消えるため、名刺の画像として写しを持つ（連絡先がある間は残す。第27.10節）
    const image = await saveFile(ctx.repo, ctx.files, {
      tenantId: ctx.tenantId, ownerUserId: ctx.userId, name: f.meta.name, kind: f.meta.kind, bytes: f.bytes, origin: 'card', runId: null,
    });
    const cardId = `cc-${randomUUID()}`;
    const scope = cards.defaultScope;
    const today = await cards.service.today(who);
    await cards.store.createCards(who, [{ id: cardId, scope, batchId: `cb-${randomUUID()}`, seq: 0, frontFileId: image.id, backFileId: null, paired: false, receivedOn: today }]);
    const saved = await cards.service.register(who, { id: cardId, scope, receivedOn: today }, { ...EMPTY_CARD_FIELDS, ...parsed.fields }, ctx.userId);
    await cards.store.updateCard(who, cardId, { status: 'done', contactId: saved, extracted: parsed.fields, frontRotation: parsed.rotation, frontCorners: parsed.corners });
    return { saved: true, contactId: saved, name: parsed.fields.name, company: parsed.fields.company, scope: scope === 'personal' ? '自分だけ' : '会社で共有' };
  },
};

/**
 * 名刺を本人の Google の連絡先に入れる・外す（第27.15節、ADR-0084）。
 *
 * @remarks
 * 危険度 `write-internal`。本人の Google の連絡先（本人のもの）に書くだけで、社外には何も送らない。
 * 権限 `contacts` はツールに持たせない（使う人だけに、使うときに画面で同意を求める。会社の全員に再同意を求めないため）。
 * 許可が無ければ、名刺の画面から許可するよう伝える
 */
export const contactsGooglePush: Tool = {
  name: 'contacts.google_push',
  risk: 'write-internal',
  activityLabel: 'Google の連絡先に入れています',
  helpText: '名刺を、あなたの Google の連絡先（「M2Office の名刺」のラベル）に入れるか、外します。あなたの電話帳に入るだけで、誰にも送りません',
  description: '名刺（contacts.search の contactId）を、呼んだ人の Google の連絡先の「M2Office の名刺」のラベルに入れる。入れたものは新しくする。'
    + `remove が true なら Google の連絡先から外す（M2Office の名刺は消さない）。1 回に ${GOOGLE_PUSH_MAX} 件まで`,
  args: {
    properties: {
      contactIds: { type: 'array', items: { type: 'string', description: '連絡先の ID' }, description: '入れる（外す）連絡先の ID（contacts.search の結果の contactId）' },
      remove: { type: 'boolean', description: 'Google の連絡先から外すときだけ true' },
    },
    required: ['contactIds'],
  },
  async invoke(args, ctx) {
    const cards = await cardsOf(ctx);
    if (!cards) return UNAVAILABLE;
    if (!cards.google) return { available: false, reason: 'Google の連絡先へのつなぎは、ここでは使えません' };
    const ids = (Array.isArray(args['contactIds']) ? args['contactIds'] : []).map(str).filter(Boolean);
    if (ids.length === 0) return { done: false, reason: 'contactIds を指定してください' };
    const who = viewer(ctx);
    try {
      if (args['remove'] === true) {
        let removed = 0;
        for (const id of ids.slice(0, GOOGLE_PUSH_MAX)) if (await cards.google.remove(who, id)) removed++;
        return { done: true, removed, ...(removed < ids.length ? { note: 'Google の連絡先に入れていない名刺は、そのままです' } : {}) };
      }
      const r = await cards.google.push(who, ids);
      return { done: true, added: r.added, updated: r.updated, failed: r.failed, label: 'M2Office の名刺' };
    } catch (err) {
      if (err instanceof ConnectorUnavailableError && err.kind === 'insufficient-scope') {
        return { done: false, reason: 'Google の連絡先を使う許可がまだありません。名刺の画面で「Google の連絡先に入れる」を押し、Google で許可してください' };
      }
      if (err instanceof ConnectorUnavailableError) return { done: false, reason: err.message };
      throw err;
    }
  },
};

/** 名刺管理のツール（内蔵の拡張。第27.9節）。 */
/** 変更の記録に出す項目の名前。 */
const CHANGE_LABELS: Record<string, string> = {
  company: '会社名', department: '部署', title: '役職', postalCode: '郵便番号', address: '住所', phones: '電話', website: 'Web',
};

/** 電話の並びを 1 行にする（記録を読みやすくする）。 */
const phonesText = (v: unknown) => (Array.isArray(v) ? (v as { number?: unknown }[]).map((p) => String(p.number ?? '')).join('・') : String(v ?? ''));

/**
 * 最近、メールの署名から新しくした名刺を返す（「最近異動した人は？」・週次ブリーフ。第27.6.1節）。
 *
 * @remarks 危険度 `read`。呼んだ人が見られる連絡先だけ。戻した記録は返さない。誰のメールからかは返さない（`mine` で自分のものに絞るだけ）
 */
export const contactsChanges: Tool = {
  name: 'contacts.changes',
  risk: 'read',
  activityLabel: '名刺の変更を調べています',
  helpText: 'メールの署名から、会社・部署・役職・電話などが新しくなった名刺を調べます。見るだけです',
  description: '最近、取引先から届いたメールの署名で会社・部署・役職・電話などが新しくなった名刺（異動・昇進）を新しい順に返す。days で何日前まで（既定 30・最大 90）、mine が true なら自分が受け取ったメールから分かったものだけ',
  args: {
    properties: {
      days: { type: 'number', description: '何日前までを見るか（既定 30、最大 90）' },
      mine: { type: 'boolean', description: '自分が受け取ったメールから分かったものだけにする' },
    },
  },
  async invoke(args, ctx) {
    const cards = await cardsOf(ctx);
    if (!cards) return UNAVAILABLE;
    const who = viewer(ctx);
    const days = Math.min(90, Math.max(1, typeof args['days'] === 'number' ? Math.floor(args['days']) : 30));
    const since = new Date(Date.now() - days * 86_400_000).toISOString();
    const changes = await cards.store.listChanges(who, { since, limit: 30, ...(args['mine'] === true ? { mailboxUserId: ctx.userId } : {}) });
    const items = [];
    for (const ch of changes) {
      const c = await cards.store.getContact(who, ch.contactId);
      if (!c || c.status !== 'active') continue;
      items.push({
        contactId: c.id, name: c.name, company: c.company, date: ch.occurredAt.slice(0, 10),
        // データベースは項目の順番を保たないため、会社名・部署・役職…の順に並べる
        changes: Object.keys(CHANGE_LABELS).filter((f) => f in ch.fields).map((f) => [f, ch.fields[f as keyof typeof ch.fields]] as const).map(([f, v]) => ({
          field: CHANGE_LABELS[f] ?? f,
          before: f === 'phones' ? phonesText(v?.before) : String(v?.before ?? ''),
          after: f === 'phones' ? phonesText(v?.after) : String(v?.after ?? ''),
        })),
      });
    }
    return { available: true, untrusted: true, count: items.length, items, ...(items.length === 0 ? { note: '新しくなった名刺はありません' } : {}) };
  },
};

/** まとめてのメールの見本を、推論と承認の画面に渡す形にする。 */
function previewResult(p: BulkPreview) {
  return {
    available: true, untrusted: true, bulkMailId: p.id, status: p.status, subject: p.subject,
    advertising: p.advertising !== false, recipientCount: p.recipients.length,
    recipients: p.recipients.map((r) => ({ name: r.name, company: r.company, email: r.email })),
    excluded: p.excluded.map((r) => ({ name: r.name, company: r.company, email: r.email, reason: r.reason })),
    sample: p.sample, problems: p.problems,
  };
}

/** 承認の画面に出す、まとめてのメールの中身（Markdown。第27.9.1節）。 */
export function describeBulk(p: BulkPreview): string {
  const ad = p.advertising !== false;
  const lines = [
    `宛先 ${p.recipients.length} 人／件名「${p.sample?.subject ?? p.subject}」／${ad ? '宣伝を含む（末尾に会社の名称・住所・問い合わせ先・配信の停止の方法を入れます）' : '宣伝を含まない（お礼・あいさつなど）'}`,
    '',
    '**宛先**',
    ...p.recipients.map((r) => `- ${r.name || '（氏名なし）'}${r.company ? `（${r.company}）` : ''} ${r.email}`),
  ];
  if (p.excluded.length > 0) {
    lines.push('', `**除いた人（${p.excluded.length} 人）**`, ...p.excluded.map((r) => `- ${r.name || '（氏名なし）'}${r.company ? `（${r.company}）` : ''}: ${r.reason}`));
  }
  if (p.sample) {
    const body = p.sample.body.length > 3000 ? `${p.sample.body.slice(0, 3000)}\n…（長いため、ここで切りました）` : p.sample.body;
    lines.push('', `**見本（${p.sample.to} に送る文）**`, ...body.split('\n').map((l) => `> ${l}`));
  }
  return lines.join('\n');
}

/** まとめてのメールを使えるなら文脈を返す。 */
async function bulkOf(ctx: ToolContext): Promise<(CardToolContext & { bulk: BulkMailService }) | null> {
  const cards = await cardsOf(ctx);
  return cards?.bulk ? { ...cards, bulk: cards.bulk } : null;
}

/**
 * 秘書から頼まれたまとめてのメールの下書きを作る（第27.9.1節）。送らない。
 *
 * @remarks 危険度 `write-internal`（本人だけの下書き）。宛先は呼んだ人が見られる連絡先だけ
 */
export const contactsBulkDraft: Tool = {
  name: 'contacts.bulk_draft',
  risk: 'write-internal',
  activityLabel: 'まとめてのメールの下書きを作っています',
  helpText: '名刺の相手へのまとめてのメールの下書きを作ります。送りません',
  description: 'contacts.search で集めた連絡先（contactIds）と、1 つの文面（subject・body）で、まとめてのメールの下書きを作る。'
    + '本文の {会社名}・{氏名} に宛名を差し込む。人ごとに違う文は書かない。返す bulkMailId と見本・除いた人を確かめる。送るのは承認の後の mail.bulk_send',
  args: {
    properties: {
      contactIds: { type: 'array', items: { type: 'string', description: '連絡先の ID' }, description: '宛先の連絡先の ID（contacts.search の結果の contactId）。100 人まで' },
      subject: { type: 'string', description: '件名（{会社名}・{氏名} を使える）' },
      body: { type: 'string', description: '本文。宛名は「{会社名}\n{氏名} 様」のように差し込む。末尾の会社の表示と配信の停止の URL は入れない（自動で入る）' },
    },
    required: ['contactIds', 'subject', 'body'],
  },
  async invoke(args, ctx) {
    const b = await bulkOf(ctx);
    if (!b) return UNAVAILABLE;
    const who = viewer(ctx);
    const ids = Array.isArray(args['contactIds']) ? (args['contactIds'] as unknown[]).map(String) : [];
    const res = await b.bulk.createDraft(who, { contactIds: ids, subject: str(args['subject']), body: str(args['body']) });
    if ('error' in res) return { available: false, reason: res.error };
    const p = await b.bulk.preview(who, res.id);
    return p ? previewResult(p) : { available: false, reason: '下書きが見つかりません' };
  },
};

/**
 * まとめてのメールの下書きの、宛先・除いた人・見本・送れない理由を返す（第27.9.1節）。
 *
 * @remarks 危険度 `read`。下書きは作った本人だけが見られる
 */
export const contactsBulkPreview: Tool = {
  name: 'contacts.bulk_preview',
  risk: 'read',
  activityLabel: 'まとめてのメールを確かめています',
  helpText: 'まとめてのメールの宛先・除いた人・見本を確かめます。見るだけです',
  description: 'まとめてのメールの下書き（bulkMailId）の、送る宛先・除いた人と理由・1 人目に差し込んだ見本・宣伝かどうか・送れない理由（problems）を返す',
  args: { properties: { bulkMailId: { type: 'string', description: 'まとめてのメールの ID' } }, required: ['bulkMailId'] },
  async invoke(args, ctx) {
    const b = await bulkOf(ctx);
    if (!b) return UNAVAILABLE;
    const p = await b.bulk.preview(viewer(ctx), str(args['bulkMailId']));
    return p ? previewResult(p) : { available: false, reason: 'まとめてのメールが見つかりません' };
  },
};

/**
 * 承認されたまとめてのメールを、本人の Gmail から 1 人に 1 通ずつ送る（第27.9.1節）。送るのはワーカーが後ろで行う。
 *
 * @remarks 危険度 `external-send`。承認の段の直後でしか呼べない。承認の前の確かめ（`prepare`）で宛先と文面の要約を記録し、
 * 承認の後に下書きが変わっていれば送らない
 */
export const mailBulkSend: Tool = {
  name: 'mail.bulk_send',
  risk: 'external-send',
  activityLabel: 'まとめてのメールを送っています',
  helpText: '承認されたまとめてのメールを、あなたの Gmail から 1 人に 1 通ずつ送ります',
  description: '承認されたまとめてのメール（bulkMailId）を、本人の Gmail から 1 人に 1 通ずつ送る',
  google: { scope: 'gmail.send', level: 'sensitive' },
  args: { properties: { bulkMailId: { type: 'string', description: 'まとめてのメールの ID' } }, required: ['bulkMailId'] },
  planKey: (args) => `bulk:${str(args['bulkMailId'])}`,
  async prepare(args, ctx) {
    const b = await bulkOf(ctx);
    if (!b) return { kind: 'problem', reason: UNAVAILABLE.reason };
    const p = await b.bulk.preview(viewer(ctx), str(args['bulkMailId'])).catch(() => null);
    if (!p) return { kind: 'problem', reason: 'まとめてのメールが見つかりません' };
    if (p.problems.length > 0) return { kind: 'problem', reason: p.problems.join('／') };
    return { kind: 'ready', args: { bulkMailId: p.id, digest: p.digest }, shown: describeBulk(p), audience: 'external' };
  },
  async invoke(args, ctx) {
    const b = await bulkOf(ctx);
    if (!b) return UNAVAILABLE;
    const res = await b.bulk.start(viewer(ctx), str(args['bulkMailId']), str(args['digest']));
    return 'error' in res ? { available: false, reason: res.error } : { available: true, queued: res.queued, note: `${res.queued} 人に順に送ります。送り終えたら知らせます` };
  },
};

export const CARD_TOOLS: Tool[] = [cardRead, contactsSearch, contactsGet, contactsSave, contactsChanges, contactsBulkDraft, contactsBulkPreview, mailBulkSend, contactsGooglePush];
