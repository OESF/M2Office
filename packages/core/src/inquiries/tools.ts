/**
 * @file 問い合わせの記録のツール。残す（続きを足す）・一覧を読む。秘書と付属の業務が使う。
 *
 * 会社が問い合わせの記録を切っているときと、利用範囲の外の人には「使えない」と返す（呼ぶたびに `ctx.inquiries.access()` で確かめる）。
 * 問い合わせの中身はお客様の言葉であり、データとして扱う（不変則 I-6。読むツールの結果に `untrusted` を付ける）。
 *
 * @see 仕様書 第33.17節 段 1 の実装の決まり
 */

import {
  INQUIRY_CHANNEL_LABELS, INQUIRY_STATUS_LABELS, INQUIRY_TEMPERATURE_LABELS, type Inquiry, type InquirySettings,
} from '@m2office/shared';
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

/** 問い合わせの記録のツール。 */
export const INQUIRY_TOOLS: Tool[] = [inquiriesRecord, inquiriesList];
