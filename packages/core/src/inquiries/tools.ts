/**
 * @file 問い合わせの記録のツール。残す（続きを足す）・一覧を読む・返事の下書き・返事を送る（承認の後）・朝のブリーフ・月の振り返り。
 * 秘書と付属の業務が使う。
 *
 * 会社が問い合わせの記録を切っているときと、利用範囲の外の人には「使えない」と返す（呼ぶたびに `ctx.inquiries.access()` で確かめる）。
 * 問い合わせの中身はお客様の言葉であり、データとして扱う（不変則 I-6。読むツールの結果に `untrusted` を付ける）。
 *
 * @see 仕様書 第33.17節 段 1 の実装の決まり
 */

import {
  INQUIRY_CHANNEL_LABELS, INQUIRY_STATUS_LABELS, INQUIRY_TEMPERATURE_LABELS, type Inquiry, type InquirySettings,
} from '@m2office/shared';
import { dateIn } from '../cards/service.js';
import { monthStats, previousMonth, reviewText } from './review.js';
import type { Tool, ToolContext } from '../tools/registry.js';
import type { InquiryService } from './service.js';

/** ツールに渡す問い合わせの記録の文脈。 */
export interface InquiryToolContext {
  service: InquiryService;
  /**
   * 依頼者がいま問い合わせの記録を使えるか。使えるなら会社の設定を返す。
   *
   * @returns 使えなければ `null`
   */
  access(): Promise<InquirySettings | null>;
}

const UNAVAILABLE = { available: false, reason: '問い合わせの記録は使えません（会社で切っているか、利用範囲の外です）' };

const str = (v: unknown) => (typeof v === 'string' ? v.trim() : '');

async function inquiriesOf(ctx: ToolContext): Promise<InquiryService | null> {
  if (!ctx.inquiries) return null;
  return (await ctx.inquiries.access()) ? ctx.inquiries.service : null;
}

/** 問い合わせの画面の場所（秘書の答えに添える）。 */
export const inquiryPath = (id: string) => `/inquiries/${encodeURIComponent(id)}`;

/** 秘書に返す 1 件の形（誰から・用件・次にやること）。 */
function brief(i: Inquiry) {
  return {
    path: inquiryPath(i.id),
    from: i.from.name ? `${i.from.name}さん${i.from.company ? `（${i.from.company}）` : ''}` : i.from.company || 'お名前は記録していません',
    channel: INQUIRY_CHANNEL_LABELS[i.channel], category: i.category, summary: i.summary, source: i.source,
    temperature: INQUIRY_TEMPERATURE_LABELS[i.temperature], status: INQUIRY_STATUS_LABELS[i.status],
    nextTask: i.nextTask ? { what: i.nextTask.what, due: i.nextTask.due, assignee: i.nextTask.assigneeName } : null,
    receivedBy: i.receivedByName, lastAt: i.lastAt,
  };
}

/**
 * 問い合わせを残す（第33.5節）。新しい問い合わせか、前の問い合わせの続きかは AI が見分ける。
 *
 * @remarks 危険度 `write-internal`。社内の問い合わせの記録に書くだけで、お客様には何も送らない
 */
export const inquiriesRecord: Tool = {
  name: 'inquiries.record',
  risk: 'write-internal',
  activityLabel: '問い合わせを残しています',
  helpText: '電話や来店の問い合わせを、話した文から項目に分けて残します。前の問い合わせの続きなら、同じ問い合わせに足します。お客様には何も送りません',
  description: '受けた問い合わせ、または問い合わせへの対応（「田中さんに見積もりを送った」）を、問い合わせの記録に残す。text には依頼者が話した文をそのまま入れる（要約しない）。前の問い合わせの続きは自動で見分ける。1 つに決まらなければ候補を返す',
  args: {
    properties: {
      text: { type: 'string', description: '依頼者が話した・書いた文（そのまま）' },
      inquiryId: { type: 'string', description: '続きを足す問い合わせ（分かっているときだけ）' },
    },
    required: ['text'],
  },
  async invoke(args, ctx) {
    const service = await inquiriesOf(ctx);
    if (!service) return UNAVAILABLE;
    const res = await service.record({ tenantId: ctx.tenantId, userId: ctx.userId }, str(args['text']), {
      ...(str(args['inquiryId']) ? { inquiryId: str(args['inquiryId']) } : {}),
    });
    if (res.kind === 'error') return { available: false, reason: res.error };
    if (res.kind === 'ambiguous') {
      return { available: false, reason: 'どの問い合わせの続きか、1 つに決まりません', candidates: res.candidates.map(brief), untrusted: true };
    }
    return {
      available: true, untrusted: true, kind: res.kind === 'created' ? '新しい問い合わせ' : '前の問い合わせの続き', ...brief(res.inquiry),
      addedTask: res.task ? { what: res.task.what, due: res.task.due } : null,
      closedTask: res.closedTask ? res.closedTask.what : null,
      note: [
        res.sensitive ? '健康などのことを話されていたため、その部分は記録に入れていません' : '',
        res.contactCreated ? '名刺管理に連絡先を作りました' : '',
      ].filter(Boolean).join('。') || null,
    };
  },
};

/**
 * 問い合わせの一覧を読む（第33.10節「今週の問い合わせは？」「返事してない問い合わせある？」）。
 *
 * @remarks 危険度 `read`
 */
export const inquiriesList: Tool = {
  name: 'inquiries.list',
  risk: 'read',
  activityLabel: '問い合わせを調べています',
  helpText: '問い合わせの記録を読みます（対応中・最近のもの・人や会社の名前で探す）',
  description: '問い合わせの記録を読む。status は open（対応中。既定）か all、days は最近何日に動いたものか、q は人・会社・用件の言葉。waiting を true にすると、次にやることが残っているものだけ。最大 30 件を、期限の近い順に返す',
  args: {
    properties: {
      status: { type: 'string', description: '対応中か、すべてか', enum: ['open', 'all'] },
      days: { type: 'number', description: '最近何日に動いたもの' },
      q: { type: 'string', description: '人・会社・用件の言葉' },
      waiting: { type: 'boolean', description: '次にやることが残っているものだけ' },
    },
  },
  async invoke(args, ctx) {
    const service = await inquiriesOf(ctx);
    if (!service) return UNAVAILABLE;
    const days = typeof args['days'] === 'number' && args['days'] > 0 ? Math.min(args['days'], 366) : 0;
    const all = await service.list({ tenantId: ctx.tenantId, userId: ctx.userId }, {
      status: str(args['status']) === 'all' ? 'all' : 'open', search: str(args['q']),
      ...(days ? { since: new Date(Date.now() - days * 86_400_000).toISOString() } : {}), limit: 200,
    });
    const items = (args['waiting'] === true ? all.filter((i) => i.nextTask) : all).slice(0, 30);
    return { available: true, untrusted: true, count: items.length, items: items.map(brief), path: '/inquiries' };
  },
};

const viewer = (ctx: ToolContext) => ({ tenantId: ctx.tenantId, userId: ctx.userId });
/** 比べる形の言葉。 */
const norm = (v: string) => v.toLowerCase().replace(/[\s　「」『』（）()・、。!！?？]/g, '').replace(/(さん|様|さま)/g, '');

/**
 * 返事の下書きを作る（第33.6節）。問い合わせを ID か人・会社の言葉で選び、AI が本文を書く。送るのは画面の「承認へ進む」の後。
 *
 * @remarks 危険度 `write-internal`。社内の問い合わせの記録に下書きを置くだけで、お客様には何も送らない
 */
export const inquiriesReplyDraft: Tool = {
  name: 'inquiries.reply_draft',
  risk: 'write-internal',
  activityLabel: '問い合わせの返事を書いています',
  helpText: '問い合わせへの返事の下書きを書きます。送るのは、画面で確かめて承認へ進め、承認された後です',
  description: '問い合わせへの返事のメールの下書きを書く。inquiryId か、q（人・会社の言葉）で問い合わせを選ぶ。instruction は書き方の頼み（「もっと丁寧に」など）。送らない',
  args: {
    properties: {
      inquiryId: { type: 'string', description: '問い合わせの ID（分かっているとき）' },
      q: { type: 'string', description: '人・会社の言葉' },
      instruction: { type: 'string', description: '書き方の頼み' },
    },
  },
  async invoke(args, ctx) {
    const service = await inquiriesOf(ctx);
    if (!service) return UNAVAILABLE;
    let id = str(args['inquiryId']);
    if (!id) {
      const words = norm(str(args['q']));
      const open = await service.list(viewer(ctx), { status: 'open', limit: 200 });
      const found = words ? open.filter((i) => norm(`${i.from.name}${i.from.company}${i.from.email}`).includes(words)) : [];
      if (found.length === 0) return { available: false, reason: 'その問い合わせが見つかりません（対応中のものから探しました）' };
      if (found.length > 1) return { available: false, reason: '問い合わせが 1 つに決まりません', candidates: found.slice(0, 8).map(brief), untrusted: true };
      id = found[0]!.id;
    }
    const res = await service.draftReply(viewer(ctx), id, str(args['instruction']));
    if ('error' in res) return { available: false, reason: res.error };
    return {
      available: true, path: inquiryPath(id), to: res.reply.to, from: res.reply.from, subject: res.reply.subject, body: res.reply.body,
      note: '下書きを書きました。問い合わせの画面で確かめて「承認へ進む」を押すと、承認の後に送ります',
    };
  },
};

/**
 * 承認された返事を、窓口のアカウントから送る（第33.6節）。承認の前に、宛先・差出人・件名・本文を承認の画面に出す。
 *
 * @remarks 危険度 `external-send`。お客様にメールを送る。いつも人に判断を求める
 */
export const inquiriesReplySend: Tool = {
  name: 'inquiries.reply_send',
  risk: 'external-send',
  activityLabel: '問い合わせの返事を送っています',
  helpText: '承認された問い合わせの返事を、会社の窓口のアカウントから送ります',
  description: '承認された返事（replyId）を、会社の窓口のアカウントから送る',
  args: { properties: { replyId: { type: 'string', description: '返事の ID' } }, required: ['replyId'] },
  planKey: (args) => `inquiry-reply:${str(args['replyId'])}`,
  async prepare(args, ctx) {
    const service = await inquiriesOf(ctx);
    if (!service) return { kind: 'problem', reason: UNAVAILABLE.reason };
    const p = await service.previewReply(viewer(ctx), str(args['replyId'])).catch(() => null);
    if (!p) return { kind: 'problem', reason: '返事が見つかりません' };
    if (p.problems.length > 0) return { kind: 'problem', reason: p.problems.join('／') };
    const r = p.reply;
    return {
      kind: 'ready', args: { replyId: r.id, digest: p.digest }, audience: 'external',
      shown: [`宛先: ${r.to}`, `差出人: ${r.from}`, `件名: ${r.subject}`, '', r.body].join('\n'),
    };
  },
  async invoke(args, ctx) {
    const service = await inquiriesOf(ctx);
    if (!service) return UNAVAILABLE;
    const res = await service.sendReply(viewer(ctx), str(args['replyId']), str(args['digest']));
    if ('error' in res) return { available: false, reason: res.error };
    return { available: true, sent: true, note: `返事を送りました（${res.to}）` };
  },
};

/**
 * 朝のブリーフに載せる問い合わせ（第33.18節）。本人が担当の、今日が期限・期限を過ぎた次にやることと、返事を待たせている問い合わせ。
 *
 * @remarks 危険度 `read`
 */
export const inquiriesBrief: Tool = {
  name: 'inquiries.brief',
  risk: 'read',
  activityLabel: '問い合わせを調べています',
  helpText: '朝のブリーフに載せる、今日が期限の問い合わせと返事を待たせている問い合わせを読みます',
  description: '本人が担当の、今日が期限・期限を過ぎた問い合わせの次にやることと、お客様のメール・フォーム・LINE に返事をしていない問い合わせを返す',
  args: { properties: {} },
  async invoke(_args, ctx) {
    const service = await inquiriesOf(ctx);
    if (!service) return UNAVAILABLE;
    const today = dateIn('Asia/Tokyo');
    const due = (await service.store.dueTasks(ctx.tenantId, today)).filter((t) => t.assignee === ctx.userId);
    const items = [];
    for (const t of due.slice(0, 10)) {
      const i = await service.store.get(ctx.tenantId, t.inquiryId);
      if (i) items.push({ what: t.what, due: t.due, overdue: (t.due ?? '') < today, from: brief(i).from, path: inquiryPath(i.id) });
    }
    const waiting = await service.store.waitingReplies(ctx.tenantId, 20);
    return {
      available: true, untrusted: true, today, mine: items,
      waitingReply: { count: waiting.length, items: waiting.slice(0, 5).map((i) => ({ from: brief(i).from, summary: i.summary.slice(0, 60), since: i.lastAt, path: inquiryPath(i.id) })) },
    };
  },
};

/**
 * 月の振り返り（第33.9節）。数はプログラムが数える。
 *
 * @remarks 危険度 `read`
 */
export const inquiriesReview: Tool = {
  name: 'inquiries.review',
  risk: 'read',
  activityLabel: '問い合わせを数えています',
  helpText: 'ある月の問い合わせの件数・経路・どこで知ったか・分類を数えます',
  description: 'ある月（month: YYYY-MM。無ければ先月）の問い合わせの件数・経路・どこで知ったか・分類・温度感・窓口の宛先ごとの数と、前の月の件数を返す。数はそのまま答えること',
  args: { properties: { month: { type: 'string', description: '月（YYYY-MM）' } } },
  async invoke(args, ctx) {
    const service = await inquiriesOf(ctx);
    if (!service) return UNAVAILABLE;
    const month = /^\d{4}-\d{2}$/.test(str(args['month'])) ? str(args['month']) : previousMonth(new Date());
    const stats = await monthStats(service.store, ctx.tenantId, month);
    return { available: true, ...stats, text: reviewText(stats) };
  },
};

/** 問い合わせの記録のツール。 */
export const INQUIRY_TOOLS: Tool[] = [inquiriesRecord, inquiriesList, inquiriesReplyDraft, inquiriesReplySend, inquiriesBrief, inquiriesReview];
