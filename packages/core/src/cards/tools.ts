/**
 * @file 名刺管理の道具。名刺を探す・1 件を見る・登録と修正・画像から読み取る。秘書と付属の業務が使う。
 *
 * どの道具も、呼んだ人が見られる範囲だけを扱う（自分だけの名刺は本人だけ。データベースの行単位の制限でも絞る）。
 * 名刺管理を切っている会社と、利用範囲の外の人には、道具は「使えない」と返す（呼ぶたびに `ctx.cards.access()` で確かめる）。
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
import { parseCardReading, readCard } from './read.js';
import type { CardService } from './service.js';
import type { ContactStore } from './store.js';

/** 道具に渡す名刺管理の文脈。 */
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
  description: '名刺の画像（PNG・JPEG・HEIC・WebP・PDF）から項目を取り出す。結果を contacts.save の card に渡すと登録できる',
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
    return {
      available: true, isCard: true, untrusted: true, fileId: f.meta.id, fields: reading.fields, rotation: reading.rotation,
      ...(reading.multiple ? { note: '何枚も写っていたため、いちばん大きい 1 枚だけを読み取りました' } : {}),
    };
  },
};

/**
 * 名刺（連絡先）を探す（第27.9節）。
 *
 * @remarks 危険度 `read`。呼んだ人が見られる範囲だけを返す。見つからなければ空（推測で答えない）
 */
export const contactsSearch: Tool = {
  name: 'contacts.search',
  risk: 'read',
  activityLabel: '名刺を探しています',
  helpText: '取り込んだ名刺から、氏名・会社名・電話番号などで人を探します。見るだけです',
  description: '名刺（連絡先）を探す。query は氏名・ふりがな・会社名・部署・メールアドレス・電話番号の一部。from・to で名刺を交換した日（YYYY-MM-DD）の範囲に絞れる',
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
    const found = await cards.store.listContacts(who, {
      q: str(args['query']).slice(0, 100), limit: 10,
      ...(date(args['from']) ? { receivedFrom: date(args['from'])! } : {}),
      ...(date(args['to']) ? { receivedTo: date(args['to'])! } : {}),
    });
    const items = [];
    for (const s of found) {
      const c = await cards.store.getContact(who, s.id);
      if (!c) continue;
      items.push({
        contactId: c.id, name: c.name, nameKana: c.nameKana, company: c.company, department: c.department, title: c.title,
        phones: c.phones, emails: c.emails, address: c.address, lastReceivedOn: s.lastReceivedOn,
        scope: c.scope === 'personal' ? '自分だけ' : '会社で共有',
      });
    }
    return { available: true, untrusted: true, count: items.length, items, ...(items.length === 0 ? { note: '見つかりませんでした' } : {}) };
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
  description: '1 件の連絡先（contactId）の項目・メモ・名刺の履歴（以前の会社・役職）・交換の記録（受け取った人と日）を返す',
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
    const parsed = parseCardReading(JSON.stringify({ isCard: true, ...(card['fields'] as object ?? {}), rotation: card['rotation'] }));
    if (parsed.kind !== 'card') return { saved: false, reason: '氏名も会社名も無いため、登録できません' };
    // 秘書に渡したファイルは 4 週で消えるため、名刺の画像として写しを持つ（連絡先がある間は残す。第27.10節）
    const image = await saveFile(ctx.repo, ctx.files, {
      tenantId: ctx.tenantId, ownerUserId: ctx.userId, name: f.meta.name, kind: f.meta.kind, bytes: f.bytes, origin: 'card', runId: null,
    });
    const cardId = `cc-${randomUUID()}`;
    const scope = cards.defaultScope;
    const today = await cards.service.today(who);
    await cards.store.createCards(who, [{ id: cardId, scope, batchId: `cb-${randomUUID()}`, seq: 0, frontFileId: image.id, backFileId: null, paired: false, receivedOn: today }]);
    const saved = await cards.service.register(who, { id: cardId, scope, receivedOn: today }, { ...EMPTY_CARD_FIELDS, ...parsed.fields }, ctx.userId);
    await cards.store.updateCard(who, cardId, { status: 'done', contactId: saved, extracted: parsed.fields, frontRotation: parsed.rotation });
    return { saved: true, contactId: saved, name: parsed.fields.name, company: parsed.fields.company, scope: scope === 'personal' ? '自分だけ' : '会社で共有' };
  },
};

/** 名刺管理の道具（内蔵の拡張。第27.9節）。 */
export const CARD_TOOLS: Tool[] = [cardRead, contactsSearch, contactsGet, contactsSave];
