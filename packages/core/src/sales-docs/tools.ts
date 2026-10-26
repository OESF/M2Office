/**
 * @file 販売の書類と受注のツール（仕様書 第42.8節）。書類を作る・発行する・訂正する・取り消す・探す、送るメールの用意、
 * 受注を取り込む・探す・直す、取引先の締め日と支払い条件を覚える。付属の業務と秘書が使う。
 *
 * 会社が販売の書類と受注を切っているときと、利用範囲の外の人には「使えない」と返す（呼ぶたびに `ctx.salesDocs.access()` で確かめる）。
 * **金額は推論に計算させない**（ツールが決まった計算で出す）。発行（`sales.issue`）は危険度 `financial` で、承認の後にだけ行う。
 */

import { randomUUID } from 'node:crypto';
import {
  SALES_DOC_KIND_LABELS, SALES_DOC_STATUS_LABELS, SALES_ORDER_STATUS_LABELS, plannedTaxNote, taxCategoryOf, taxRateLabel,
  type SalesDocKind, type SalesDocsSettings, type SalesDocument, type SalesOrder, type SalesOrderStatus,
} from '@m2office/shared';
import type { Tool, ToolContext } from '../tools/registry.js';
import { saveFile } from '../files/service.js';
import { itemsFrom } from './extract.js';
import { docMarkdown, docTitle, numberText, DOC_WORDS } from './render.js';
import type { CreateDocInput, SalesDocService } from './service.js';
import { closingDayFrom, yenText } from './calc.js';

/** ツールに渡す販売の書類と受注の文脈。 */
export interface SalesDocToolContext {
  service: SalesDocService;
  /**
   * 依頼者がいま販売の書類と受注を使えるか。使えるなら会社の設定を返す。
   *
   * @returns 使えなければ `null`
   */
  access(): Promise<SalesDocsSettings | null>;
}

const UNAVAILABLE = { available: false, reason: '販売の書類と受注は使えません（会社で切っているか、利用範囲の外です）' };
const str = (v: unknown, max = 200) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
const KINDS = Object.keys(SALES_DOC_KIND_LABELS) as SalesDocKind[];
const kindOf = (v: unknown): SalesDocKind | null => (KINDS.includes(v as SalesDocKind) ? v as SalesDocKind : null);
const numOf = (v: unknown): number | null => {
  const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() ? Number(v.normalize('NFKC').replace(/[,円￥¥\s]/g, '')) : NaN;
  return Number.isFinite(n) ? n : null;
};

async function serviceOf(ctx: ToolContext): Promise<SalesDocService | null> {
  if (!ctx.salesDocs) return null;
  return (await ctx.salesDocs.access()) ? ctx.salesDocs.service : null;
}

const who = (ctx: ToolContext) => ({ tenantId: ctx.tenantId, userId: ctx.userId });

/** 書類の画面の場所（受注と同じ画面。ID の頭で見分ける）。 */
export const salesDocPath = (id: string) => `/sales/${encodeURIComponent(id)}`;
/** 受注の画面の場所。 */
export const salesOrderPath = (id: string) => `/sales/${encodeURIComponent(id)}`;

/** 秘書と業務に返す書類 1 通の形。 */
export function briefDoc(d: SalesDocument) {
  return {
    documentId: d.id, path: salesDocPath(d.id), kind: SALES_DOC_KIND_LABELS[d.kind], number: d.number ? numberText(d) : '（下書き。発行時に付けます）',
    status: SALES_DOC_STATUS_LABELS[d.status], to: d.party.name || d.party.person, subject: d.subject, date: d.issuedOn, due: d.dueOn,
    subtotal: d.subtotal, tax: d.tax, total: d.total,
    taxLines: d.taxLines.map((x) => (x.rate === 0 ? `対象外 ${yenText(x.base)}` : `${taxRateLabel(x.rate)} ${yenText(x.base)}・消費税 ${yenText(x.tax)}`)),
    items: d.items.map((i) => `${i.name} ${i.quantity}${i.unit}${i.unitPrice === null ? '（単価なし）' : ` × ${yenText(i.unitPrice)}`}`).slice(0, 20),
    ...(d.kind === 'delivery' ? { billed: !!d.invoiceId } : {}),
    ...(d.notices.length ? { notices: d.notices } : {}),
    ...(d.cancelReason ? { cancelReason: d.cancelReason } : {}),
  };
}

/** 秘書と業務に返す受注 1 件の形。 */
export function briefOrder(o: SalesOrder) {
  return {
    orderId: o.id, path: salesOrderPath(o.id), number: o.number, status: SALES_ORDER_STATUS_LABELS[o.status], from: o.party.name, customerRef: o.customerRef,
    orderedOn: o.orderedOn, dueOn: o.dueOn, total: o.total, statedTotal: o.statedTotal,
    items: o.items.map((i, k) => `${i.name} ${i.quantity}${i.unit}（納品 ${o.delivered[k] ?? 0}）`).slice(0, 20),
    flags: o.flags.map((f) => f.text),
  };
}

/** 番号か ID から書類を引く（番号なら新しい版）。 */
async function findDoc(service: SalesDocService, ctx: ToolContext, ref: string): Promise<SalesDocument | null> {
  if (!ref) return null;
  if (ref.startsWith('sd-')) return (await service.get(who(ctx), ref))?.doc ?? null;
  const number = ref.replace(/（.*$/, '').trim();
  const list = await service.list(who(ctx), { number, withSuperseded: true });
  return list.sort((a, b) => b.version - a.version)[0] ?? null;
}

/** 番号か ID から受注を引く。 */
async function findOrder(service: SalesDocService, ctx: ToolContext, ref: string): Promise<SalesOrder | null> {
  if (!ref) return null;
  if (ref.startsWith('so-')) return (await service.getOrder(who(ctx), ref))?.order ?? null;
  return (await service.listOrders(who(ctx), { search: ref })).find((o) => o.number === ref || o.customerRef === ref) ?? null;
}

/** 成果物を残す（承認の画面の「判断するもの」に出る。第9.3.3節）。 */
async function artifact(ctx: ToolContext, d: SalesDocument): Promise<void> {
  await ctx.repo.createArtifact({
    id: randomUUID(), runId: ctx.runId, tenantId: ctx.tenantId, kind: `sales-${d.kind}`, title: docTitle(d),
    body: docMarkdown(d), fileId: d.fileId, createdAt: new Date().toISOString(),
  });
}

const PARTY_ARGS = {
  to: { type: 'string', description: '宛先の会社名（個人なら氏名）' },
  department: { type: 'string', description: '宛先の部署（任意）' },
  person: { type: 'string', description: '宛先の担当者（任意）' },
  address: { type: 'string', description: '宛先の住所（任意）' },
} as const;

const partyOf = (args: Record<string, unknown>) => ({
  name: str(args['to'], 100).replace(/\s*(御中|様|殿)$/, ''), department: str(args['department'], 60), person: str(args['person'], 40), address: str(args['address'], 160),
});

/**
 * 書類を作る（注文書・納品書・請求書・領収書。第42.3節・第42.4節）。
 *
 * @remarks 危険度 `draft`（社外には出さない）。金額はツールが決まった計算で出す。納品書は作ったら発行済み、ほかは下書き（承認で発行する）
 */
export const salesCreateDocument: Tool = {
  name: 'sales.create_document',
  risk: 'draft',
  activityLabel: '書類を作っています',
  helpText: '注文書・納品書・請求書・領収書を PDF で作ります。注文書・請求書・領収書は下書きで、あなたの確認の後に発行します。社外へは送りません',
  description: [
    '書類を作る。kind は purchase_order（注文書）・delivery（納品書）・invoice（請求書）・receipt（領収書）・acknowledgement（注文請書。受けた注文の写しを相手に送る書類。orderNumber から作る）。',
    '品目（items）は { name, code, quantity, unit, unitPrice, taxCategory, discount } の配列。**金額・消費税・合計を自分で計算しない**（ツールが計算する）。単価が分からなければ unitPrice を空にする。taxCategory は消費税の区分で、standard（標準 10%）・food（飲食料品。軽減税率）・news（定期購読の新聞。軽減税率）・exempt（対象外: 対価の無い会費・寄付・印紙・切手など）。酒類・外食・ケータリングは standard。税率の数は渡さない（取引の日の税率をツールが当てる）。分からなければ空にする（ツールが品名から決める）。',
    '受注から作るときは orderNumber（S-…）。請求書で納品書をまとめるときは deliveryNumbers（D-… の配列）か、取引先の未請求の納品書をまとめるなら collectFor に取引先の名前。',
    '領収書は invoiceNumber（I-…）。一部の入金なら amount に受け取った額（税込）。下書きを直すときは documentId にその書類を渡し、直す項目だけを渡す。',
  ].join(''),
  args: {
    properties: {
      kind: { type: 'string', description: 'purchase_order・delivery・invoice・receipt・acknowledgement' },
      documentId: { type: 'string', description: '直す下書きの書類（documentId か番号）' },
      ...PARTY_ARGS,
      subject: { type: 'string', description: '件名（請求書の「〇〇の件」、領収書の但し書き）' },
      items: { type: 'array', description: '品目。{ name, code, quantity, unit, unitPrice, taxCategory, discount } の配列。taxCategory は standard・food・news・exempt' },
      orderNumber: { type: 'string', description: 'つなぐ受注の番号（S-…）' },
      deliveryNumbers: { type: 'array', description: '請求書にまとめる納品書の番号（D-…）' },
      collectFor: { type: 'string', description: '請求書: この取引先の未請求の納品書をまとめる' },
      invoiceNumber: { type: 'string', description: '領収書: 元の請求書の番号（I-…）' },
      amount: { type: 'number', description: '領収書: 受け取った額（税込。一部の入金のとき）' },
      dueOn: { type: 'string', description: '支払期限（請求書）・納期（注文書）。YYYY-MM-DD' },
      terms: { type: 'string', description: '支払い条件・納品場所などの条件' },
      notes: { type: 'string', description: '備考' },
    },
    required: ['kind'],
  },
  async invoke(args, ctx) {
    const service = await serviceOf(ctx);
    if (!service) return UNAVAILABLE;
    const kind = kindOf(args['kind']);
    if (!kind) return { available: false, created: false, reason: 'kind は purchase_order・delivery・invoice・receipt・acknowledgement のどれかです' };
    const input: CreateDocInput = { kind };
    const docRef = str(args['documentId'], 80);
    if (docRef) {
      const d = await findDoc(service, ctx, docRef);
      if (!d) return { available: false, created: false, reason: `書類 ${docRef} が見つかりません` };
      input.documentId = d.id;
    }
    const party = partyOf(args);
    if (Object.values(party).some(Boolean)) input.party = party;
    if (str(args['subject'])) input.subject = str(args['subject'], 80);
    const items = itemsFrom(args['items']);
    if (items.length) input.items = items;
    const orderRef = str(args['orderNumber'], 80);
    if (orderRef) {
      const o = await findOrder(service, ctx, orderRef);
      if (!o) return { available: false, created: false, reason: `受注 ${orderRef} が見つかりません` };
      input.orderId = o.id;
    }
    const deliveries = Array.isArray(args['deliveryNumbers']) ? args['deliveryNumbers'].map((x) => str(x, 40)).filter(Boolean).slice(0, 50) : [];
    if (deliveries.length) {
      input.deliveryIds = [];
      for (const n of deliveries) {
        const d = await findDoc(service, ctx, n);
        if (d) input.deliveryIds.push(d.id);
      }
      if (input.deliveryIds.length === 0) return { available: false, created: false, reason: '納品書が見つかりません' };
    }
    if (str(args['collectFor'])) input.collectFor = str(args['collectFor'], 100);
    const invRef = str(args['invoiceNumber'], 80);
    if (invRef) {
      const inv = await findDoc(service, ctx, invRef);
      if (!inv) return { available: false, created: false, reason: `請求書 ${invRef} が見つかりません` };
      input.invoiceId = inv.id;
    }
    const amount = numOf(args['amount']);
    if (amount) input.amount = amount;
    for (const k of ['dueOn', 'terms', 'notes'] as const) if (str(args[k])) input[k] = str(args[k], 400);
    const r = await service.createDocument(who(ctx), input, ctx.runId);
    if ('error' in r) return { available: false, created: false, reason: r.error };
    await artifact(ctx, r.doc);
    return {
      created: true, ...briefDoc(r.doc), fileId: r.doc.fileId,
      ...(r.doc.status === 'draft' ? { next: '下書きです。発行は承認の後に sales.issue で行います' } : {}),
      ...(r.warnings.length ? { warning: r.warnings.join('。') } : {}),
      ...(r.notes.length ? { note: r.notes.join('。') } : {}),
    };
  },
};

/**
 * 発行した書類の訂正版を作る（同じ番号の新しい版。第42.3.2節）。
 *
 * @remarks 危険度 `draft`。納品書の訂正版は作ったら発行済み、ほかは下書き（承認で発行する）。前の版は消さない
 */
export const salesRevise: Tool = {
  name: 'sales.revise',
  risk: 'draft',
  activityLabel: '書類の訂正版を作っています',
  helpText: '発行した書類を消さずに、同じ番号の訂正版を作ります。注文書・請求書・領収書の訂正版は、あなたの確認の後に発行します',
  description: '発行した書類の訂正版を作る。number に書類の番号（I-… など）、直す項目だけを渡す（items を渡すと品目をすべて置き換える。金額は自分で計算しない）',
  args: {
    properties: {
      number: { type: 'string', description: '訂正する書類の番号（I-… など）か documentId' },
      ...PARTY_ARGS,
      subject: { type: 'string', description: '件名' },
      items: { type: 'array', description: '品目（すべて置き換える）' },
      dueOn: { type: 'string', description: '支払期限・納期（YYYY-MM-DD）' },
      terms: { type: 'string', description: '条件' },
      notes: { type: 'string', description: '備考' },
    },
    required: ['number'],
  },
  async invoke(args, ctx) {
    const service = await serviceOf(ctx);
    if (!service) return UNAVAILABLE;
    const d = await findDoc(service, ctx, str(args['number'], 80));
    if (!d) return { available: false, created: false, reason: '書類が見つかりません' };
    const items = itemsFrom(args['items']);
    const party = partyOf(args);
    const r = await service.revise(who(ctx), d.id, {
      ...(items.length ? { items } : {}), ...(Object.values(party).some(Boolean) ? { party } : {}),
      ...(str(args['subject']) ? { subject: str(args['subject'], 80) } : {}),
      ...(str(args['dueOn']) ? { dueOn: str(args['dueOn'], 10) } : {}), ...(str(args['terms']) ? { terms: str(args['terms'], 120) } : {}),
      ...(str(args['notes']) ? { notes: str(args['notes'], 400) } : {}),
    }, ctx.runId);
    if ('error' in r) return { available: false, created: false, reason: r.error };
    await artifact(ctx, r.doc);
    return { created: true, ...briefDoc(r.doc), fileId: r.doc.fileId, ...(r.notes.length ? { note: r.notes.join('。') } : {}) };
  },
};

/**
 * 下書きを発行する（番号を付け、「下書き」を外す。請求書はまとめた納品書を請求済みにする。第42.3.1節）。
 *
 * @remarks 危険度 `financial`（請求の確定・支払いの約束・受け取りの証明）。承認の直後の段でだけ行う。承認の前に、発行できるかを読むだけで確かめる
 */
export const salesIssue: Tool = {
  name: 'sales.issue',
  risk: 'financial',
  activityLabel: '書類を発行しています',
  helpText: '注文書・請求書・領収書の下書きを発行します（番号を付けます）。必ずあなたの確認の後に行います',
  description: '下書きの書類を発行する。documentId に sales.create_document が返した documentId を渡す',
  args: { properties: { documentId: { type: 'string', description: '発行する下書きの documentId' } }, required: ['documentId'] },
  async prepare(args, ctx) {
    const service = await serviceOf(ctx);
    if (!service) return { kind: 'problem', reason: UNAVAILABLE.reason };
    const d = await findDoc(service, ctx, str(args['documentId'], 80));
    if (!d) return { kind: 'problem', reason: '発行する書類が見つかりません' };
    if (d.status !== 'draft') return { kind: 'problem', reason: `${SALES_DOC_KIND_LABELS[d.kind]} ${d.number ?? ''} は下書きではありません` };
    return { kind: 'ready', args: { documentId: d.id }, shown: issueLine(d) };
  },
  async invoke(args, ctx) {
    const service = await serviceOf(ctx);
    if (!service) return UNAVAILABLE;
    const d = await findDoc(service, ctx, str(args['documentId'], 80));
    if (!d) return { issued: false, reason: '書類が見つかりません' };
    const r = await service.issue(who(ctx), d.id);
    if ('error' in r) return { issued: false, reason: r.error };
    return { issued: true, ...briefDoc(r) };
  },
};

/** 承認の画面に出す、発行する書類の 1 行（宛先・合計・税率ごとの内訳・期限）。 */
export function issueLine(d: SalesDocument): string {
  const w = DOC_WORDS[d.kind];
  return [
    `${SALES_DOC_KIND_LABELS[d.kind]}${d.number ? ` ${numberText(d)}` : ''}`,
    `宛先 ${d.party.name || d.party.person || '（未記入）'}`,
    `${w.headline} ${yenText(d.total)}`,
    ...(d.taxLines.length ? [`（${d.taxLines.map((x) => (x.rate === 0 ? `対象外 ${yenText(x.base)}` : `${taxRateLabel(x.rate)} ${yenText(x.base)}・消費税 ${yenText(x.tax)}`)).join('、')}）`] : []),
    ...(w.due && d.dueOn ? [`${w.due} ${d.dueOn}`] : []),
    // まだ確定していない税率の変更（食料品の 1% など。第15.1.1節）
    ...[...new Set(d.items.map((i) => plannedTaxNote(taxCategoryOf(i), d.issuedOn)).filter((x): x is string => !!x))],
  ].join('／');
}

/**
 * 書類を取り消す（削除しない。理由を残す）。
 *
 * @remarks 危険度 `write-internal`（社内の記録だけ。相手には何も送らない）
 */
export const salesCancel: Tool = {
  name: 'sales.cancel',
  risk: 'write-internal',
  activityLabel: '書類を取り消しています',
  helpText: '発行した書類を取り消します（記録は残します。相手には何も送りません）',
  description: '発行した書類を取り消す。number に番号、reason に理由',
  args: { properties: { number: { type: 'string', description: '書類の番号' }, reason: { type: 'string', description: '取り消しの理由' } }, required: ['number', 'reason'] },
  async invoke(args, ctx) {
    const service = await serviceOf(ctx);
    if (!service) return UNAVAILABLE;
    const d = await findDoc(service, ctx, str(args['number'], 80));
    if (!d) return { cancelled: false, reason: '書類が見つかりません' };
    const problem = await service.cancel(who(ctx), d.id, str(args['reason'], 200));
    return problem ? { cancelled: false, reason: problem } : { cancelled: true, kind: SALES_DOC_KIND_LABELS[d.kind], number: d.number };
  },
};

/**
 * 書類を探す（「先月 A 社に出した請求書は？」「10 万円以上の請求書」）。
 *
 * @remarks 危険度 `read`。取引の日付・金額・取引先で探せる（第42.6節）
 */
export const salesDocuments: Tool = {
  name: 'sales.documents',
  risk: 'read',
  activityLabel: '販売の書類を探しています',
  helpText: '作った注文書・納品書・請求書・領収書を、取引先・日付・金額で探します',
  description: '書類を探す。kind（purchase_order・delivery・invoice・receipt）・party（取引先の名前）・from と to（取引の日 YYYY-MM-DD）・min と max（合計の円）・status（draft・issued・cancelled）・number（番号）・unbilled（true なら未請求の納品書だけ）',
  args: {
    properties: {
      kind: { type: 'string', description: '書類の種類' }, party: { type: 'string', description: '取引先の名前' },
      from: { type: 'string', description: '取引の日の始め' }, to: { type: 'string', description: '取引の日の終わり' },
      min: { type: 'number', description: '合計の下限（円）' }, max: { type: 'number', description: '合計の上限（円）' },
      status: { type: 'string', description: 'draft・issued・cancelled' }, number: { type: 'string', description: '番号' },
      unbilled: { type: 'boolean', description: '未請求の納品書だけ' },
    },
  },
  async invoke(args, ctx) {
    const service = await serviceOf(ctx);
    if (!service) return UNAVAILABLE;
    const status = str(args['status']);
    const date = (k: string) => (/^\d{4}-\d{2}-\d{2}$/.test(str(args[k])) ? str(args[k]) : undefined);
    let list = await service.list(who(ctx), {
      ...(kindOf(args['kind']) ? { kind: kindOf(args['kind'])! } : {}), ...(str(args['party']) ? { party: str(args['party'], 100) } : {}),
      ...(date('from') ? { from: date('from')! } : {}), ...(date('to') ? { to: date('to')! } : {}),
      ...(numOf(args['min']) !== null ? { min: numOf(args['min'])! } : {}), ...(numOf(args['max']) !== null ? { max: numOf(args['max'])! } : {}),
      ...(status === 'draft' || status === 'issued' || status === 'cancelled' ? { status } : {}),
      ...(str(args['number']) ? { number: str(args['number'], 40) } : {}), limit: 50,
    });
    if (args['unbilled'] === true) list = list.filter((d) => d.kind === 'delivery' && d.status === 'issued' && !d.invoiceId);
    return { available: true, path: '/sales', count: list.length, documents: list.slice(0, 20).map(briefDoc) };
  },
};

/**
 * 書類を送るメールの用意（送り先が無ければ送らない）。
 *
 * @remarks 危険度 `read`（何も送らない）。発行済みの書類は、この実行のファイルとして写して添える。下書きは、発行で描き直す同じファイルを添える
 */
export const salesPrepareMail: Tool = {
  name: 'sales.prepare_mail',
  risk: 'read',
  activityLabel: '書類を送るメールを用意しています',
  helpText: '書類を送るメールの宛先と添えるファイルを確かめます。送るのは承認の後です',
  description: '書類を送るメールの用意。documentId と sendTo（送り先のメールアドレス）を渡す。送り先が無ければ送らない',
  args: { properties: { documentId: { type: 'string', description: '送る書類の documentId か番号' }, sendTo: { type: 'string', description: '送り先のメールアドレス（無ければ空）' } } },
  async invoke(args, ctx) {
    const service = await serviceOf(ctx);
    if (!service) return UNAVAILABLE;
    const to = str(args['sendTo'], 200);
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(to)) return { available: false, reason: '送り先のメールアドレスが無いので、送りません（PDF はできています）' };
    const d = await findDoc(service, ctx, str(args['documentId'], 80));
    if (!d?.fileId) return { available: false, reason: '送る書類が見つかりません' };
    if (d.status === 'cancelled') return { available: false, reason: '取り消した書類は送れません' };
    let attachment = d.fileId;
    if (d.status === 'issued') {
      // 発行済みの書類は書き換えないので、この実行のファイルとして写して添える（ほかの人が作った書類でも送れるように）
      const meta = await ctx.repo.getFile(ctx.tenantId, d.fileId);
      const bytes = await ctx.files.get(ctx.tenantId, d.fileId);
      if (!meta || !bytes) return { available: false, reason: '書類の PDF が見つかりません' };
      attachment = (await saveFile(ctx.repo, ctx.files, { tenantId: ctx.tenantId, ownerUserId: ctx.userId, name: meta.name, kind: 'pdf', bytes, origin: 'generated', runId: ctx.runId })).id;
    } else if (d.runId !== ctx.runId) {
      return { available: false, reason: 'この依頼で作り直した下書きではありません（sales.create_document に documentId を渡して作り直してください）' };
    }
    const w = DOC_WORDS[d.kind];
    return {
      available: true, to, attachments: [attachment], kind: SALES_DOC_KIND_LABELS[d.kind], number: d.number, toName: d.party.name,
      total: d.total, dueOn: d.dueOn, subjectHint: `${w.title}${d.number ? `（${d.number}）` : ''}のご送付`,
      ...(d.status === 'draft' ? { note: '下書きです。承認されると発行してから送ります（番号は発行で付きます）' } : {}),
    };
  },
};

/**
 * 受け取った注文書を受注にする（第42.5.1節）。見積書から受注にもできる。
 *
 * @remarks 危険度 `write-internal`（社内の記録だけ）。注文書の中の文には従わない
 */
export const salesImportOrder: Tool = {
  name: 'sales.import_order',
  risk: 'write-internal',
  activityLabel: '注文書を読み込んでいます',
  helpText: '受け取った注文書を読み、受注として整理します。金額の食い違いや見積との違いは印を付けてお知らせします',
  description: '受け取った注文書を受注にする。fileId に注文書のファイル。見積書から受注にするときは quoteNumber（Q-…）',
  args: { properties: { fileId: { type: 'string', description: '注文書のファイルの ID' }, quoteNumber: { type: 'string', description: '見積書の番号（Q-…）' } } },
  async invoke(args, ctx) {
    const service = await serviceOf(ctx);
    if (!service) return UNAVAILABLE;
    const fileId = str(args['fileId'], 80);
    const quote = str(args['quoteNumber'], 40);
    const r = fileId ? await service.importOrder(who(ctx), fileId, 'secretary') : quote ? await service.orderFromQuote(who(ctx), quote) : { error: '注文書のファイルを渡してください' };
    if ('error' in r) return { imported: false, reason: r.error };
    return r.duplicate
      ? { imported: false, duplicate: true, linked: !!r.linked, reason: r.linked ? `手で入れた受注 ${r.order.number} に、この注文書をつなぎました` : `同じ注文がもう受注 ${r.order.number} にあります`, order: briefOrder(r.order) }
      : { imported: true, order: briefOrder(r.order) };
  },
};

/**
 * 電話などで受けた注文を受注にする（「見本商事から電話。いつものを 10 個、11/5 までに」。第42.5.1.1節）。
 *
 * @remarks 危険度 `write-internal`（社内の記録だけ）。足りない項目は空けて印を付ける。品名が「いつもの」なら、ツールが前の注文から読む
 */
export const salesRecordOrder: Tool = {
  name: 'sales.record_order',
  risk: 'write-internal',
  activityLabel: '受注を入れています',
  helpText: '電話などで受けた注文を受注に入れます。「いつもの」は前の注文から読み、読んだことを印でお知らせします',
  description: [
    '電話などで受けた注文を受注にする。party に取引先（略した呼び方のままでよい）、items に品目 { name, quantity, unit, unitPrice }。',
    '品名が「いつもの」「いつものあれ」なら、name に言われたとおり「いつもの」と入れる（ツールが前の注文から読む。自分で品名を決めない）。',
    '単価・納期が言われていなければ空にする（推測しない）。dueOn・orderedOn は YYYY-MM-DD（「来週の金曜」などは今日から日付にする）',
  ].join(''),
  args: {
    properties: {
      party: { type: 'string', description: '取引先の名前' }, person: { type: 'string', description: '先方の担当者（任意）' },
      items: { type: 'array', description: '品目 { name, quantity, unit, unitPrice, taxCategory } の配列（taxCategory は standard・food・news・exempt。分からなければ空）' },
      dueOn: { type: 'string', description: '納期（YYYY-MM-DD）' }, orderedOn: { type: 'string', description: '注文日（無ければ今日）' },
      customerRef: { type: 'string', description: '相手の注文番号（任意）' }, deliverTo: { type: 'string', description: '納品先（任意）' },
      terms: { type: 'string', description: '支払い条件（任意）' }, notes: { type: 'string', description: '備考（任意）' },
    },
    required: ['party', 'items'],
  },
  async invoke(args, ctx) {
    const service = await serviceOf(ctx);
    if (!service) return UNAVAILABLE;
    const r = await service.recordOrder(who(ctx), {
      party: str(args['party'], 100), person: str(args['person'], 40), items: itemsFrom(args['items']),
      dueOn: str(args['dueOn'], 10), orderedOn: str(args['orderedOn'], 10), customerRef: str(args['customerRef'], 60),
      deliverTo: str(args['deliverTo'], 120), terms: str(args['terms'], 80), notes: str(args['notes'], 300),
    }, 'secretary');
    if ('error' in r) return { imported: false, reason: r.error };
    return r.duplicate
      ? { imported: false, duplicate: true, reason: `同じ注文がもう受注 ${r.order.number} にあります`, order: briefOrder(r.order) }
      : { imported: true, order: briefOrder(r.order) };
  },
};

/**
 * 受注を探す（「A 社の注文、納期はいつ？」「納品していない受注は？」）。
 *
 * @remarks 危険度 `read`
 */
export const salesOrders: Tool = {
  name: 'sales.orders',
  risk: 'read',
  activityLabel: '受注を探しています',
  helpText: '受注を、取引先・注文番号・品名・状態で探します',
  description: '受注を探す。search（取引先・注文番号・受注番号・品名）・status（open=受注・partial=一部納品・delivered=納品済み・invoiced=請求済み・cancelled=取り消し）。notDelivered が true なら、納品が終わっていない受注だけ',
  args: {
    properties: {
      search: { type: 'string', description: '取引先・注文番号・品名' }, status: { type: 'string', description: '状態' },
      notDelivered: { type: 'boolean', description: '納品が終わっていない受注だけ' },
    },
  },
  async invoke(args, ctx) {
    const service = await serviceOf(ctx);
    if (!service) return UNAVAILABLE;
    const status = str(args['status']) as SalesOrderStatus;
    let list = await service.listOrders(who(ctx), {
      ...(str(args['search']) ? { search: str(args['search'], 100) } : {}), ...(status in SALES_ORDER_STATUS_LABELS ? { status } : {}), limit: 50,
    });
    if (args['notDelivered'] === true) list = list.filter((o) => o.status === 'open' || o.status === 'partial');
    return { available: true, path: '/sales', count: list.length, orders: list.slice(0, 20).map(briefOrder) };
  },
};

/**
 * 受注を直す・取り消す（読み取りの直し）。
 *
 * @remarks 危険度 `write-internal`
 */
export const salesUpdateOrder: Tool = {
  name: 'sales.update_order',
  risk: 'write-internal',
  activityLabel: '受注を直しています',
  helpText: '受注の納期・品目などを直す、または取り消します（社内の記録だけ）',
  description: '受注を直す。number に受注番号（S-…）か相手の注文番号。直す項目だけを渡す（dueOn・orderedOn は YYYY-MM-DD、items は品目をすべて置き換える）。取り消すなら cancelReason に理由',
  args: {
    properties: {
      number: { type: 'string', description: '受注番号か相手の注文番号' }, dueOn: { type: 'string', description: '納期' },
      orderedOn: { type: 'string', description: '注文日' }, customerRef: { type: 'string', description: '相手の注文番号' },
      deliverTo: { type: 'string', description: '納品先' }, terms: { type: 'string', description: '支払い条件' },
      items: { type: 'array', description: '品目（すべて置き換える）' }, cancelReason: { type: 'string', description: '取り消すときの理由' },
    },
    required: ['number'],
  },
  async invoke(args, ctx) {
    const service = await serviceOf(ctx);
    if (!service) return UNAVAILABLE;
    const o = await findOrder(service, ctx, str(args['number'], 80));
    if (!o) return { updated: false, reason: '受注が見つかりません' };
    if (str(args['cancelReason'])) {
      const problem = await service.cancelOrder(who(ctx), o.id, str(args['cancelReason'], 200));
      return problem ? { updated: false, reason: problem } : { updated: true, cancelled: true, number: o.number };
    }
    const body: Record<string, unknown> = {};
    for (const k of ['dueOn', 'orderedOn', 'customerRef', 'deliverTo', 'terms']) if (str(args[k])) body[k] = str(args[k], 120);
    if (Array.isArray(args['items'])) body['items'] = args['items'];
    const problem = await service.updateOrder(who(ctx), o.id, body);
    if (problem) return { updated: false, reason: problem };
    return { updated: true, order: briefOrder((await service.getOrder(who(ctx), o.id))!.order) };
  },
};

/**
 * 取引先の締め日と支払い条件を覚える（「A 社は 20 日締めの翌月末払い」。第42.4.2節）。
 *
 * @remarks 危険度 `write-internal`（社内の覚えだけ）
 */
export const salesRememberParty: Tool = {
  name: 'sales.remember_party',
  risk: 'write-internal',
  activityLabel: '取引先の条件を覚えています',
  helpText: '取引先ごとの締め日と支払い条件を覚えます（請求書の支払期限とまとめる納品書に使います）',
  description: '取引先の締め日と支払い条件を覚える。name に取引先、paymentTerms に言い方そのまま（「20 日締め翌月末払い」）',
  args: { properties: { name: { type: 'string', description: '取引先の名前' }, paymentTerms: { type: 'string', description: '支払い条件' } }, required: ['name', 'paymentTerms'] },
  async invoke(args, ctx) {
    const service = await serviceOf(ctx);
    if (!service) return UNAVAILABLE;
    const name = str(args['name'], 100);
    const terms = str(args['paymentTerms'], 80);
    if (!name || !terms) return { saved: false, reason: '取引先と支払い条件を渡してください' };
    await service.rememberParty(who(ctx), name, { paymentTerms: terms }, '会話');
    const closing = closingDayFrom(terms);
    return { saved: true, name, paymentTerms: terms, closing: closing === null ? '読み取れませんでした' : closing === 0 ? '月末締め' : `${closing} 日締め` };
  },
};

/**
 * 朝のブリーフに載せる、本人の請求書の下書きと、納期が明日・過ぎた受注（第42.13.2節・第42.13.3節）。
 *
 * @remarks 危険度 `read`
 */
export const salesBrief: Tool = {
  name: 'sales.brief',
  risk: 'read',
  activityLabel: '受注と請求書の下書きを見ています',
  helpText: '朝のブリーフに載せる、発行を待っている請求書の下書きと、納期の近い受注を読みます',
  description: '本人が作った（締めで作られた）請求書の下書きと、本人が入れた受注のうち納期が明日か過ぎていて納品が終わっていないものを返す',
  args: { properties: {} },
  async invoke(_args, ctx) {
    const service = await serviceOf(ctx);
    if (!service) return UNAVAILABLE;
    const today = new Date(Date.now() + 9 * 3_600_000).toISOString().slice(0, 10);
    const tomorrow = new Date(Date.parse(`${today}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10);
    const drafts = (await service.list(who(ctx), { kind: 'invoice', status: 'draft', limit: 50 })).filter((d) => d.createdBy === ctx.userId);
    const orders = (await service.listOrders(who(ctx), { limit: 500 }))
      .filter((o) => o.createdBy === ctx.userId && (o.status === 'open' || o.status === 'partial') && o.dueOn && o.dueOn <= tomorrow);
    return {
      available: true, untrusted: true, path: '/sales',
      draftInvoices: drafts.slice(0, 10).map((d) => ({ to: d.party.name, total: d.total, subject: d.subject })),
      dueOrders: orders.slice(0, 10).map((o) => ({ from: o.party.name, number: o.number, dueOn: o.dueOn, late: !!o.dueOn && o.dueOn < today })),
    };
  },
};

/** 販売の書類と受注のツール。 */
export const SALES_DOC_TOOLS: Tool[] = [
  salesBrief, salesCreateDocument, salesRevise, salesIssue, salesCancel, salesDocuments, salesPrepareMail, salesImportOrder, salesRecordOrder, salesOrders, salesUpdateOrder,
  salesRememberParty,
];
