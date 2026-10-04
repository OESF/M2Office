/**
 * @file お知らせの作成のツール（仕様書 第35.9節）。下書きを作る・直す・承認へ進める・一覧と LINE の残り・出す（承認の後）。
 * 秘書と付属の業務が使う。
 *
 * 会社がお知らせの作成を切っているときと、利用範囲の外の人には「使えない」と返す（呼ぶたびに `ctx.announcements.access()` で確かめる）。
 * **出すのは承認の後だけ**（`announcements.publish` は危険度 `external-send`。承認の画面に出し先ごとの見え方を出す）。
 */

import { ANNOUNCEMENT_CHANNEL_LABELS, ANNOUNCEMENT_STATUS_LABELS, type Announcement, type AnnouncementSettings } from '@m2office/shared';
import type { Tool, ToolContext } from '../tools/registry.js';
import { periodText } from './draft.js';
import type { AnnouncementService } from './service.js';

/** ツールに渡すお知らせの作成の文脈。 */
export interface AnnouncementToolContext {
  service: AnnouncementService;
  /**
   * 依頼者がいまお知らせの作成を使えるか。使えるなら会社の設定を返す。
   *
   * @returns 使えなければ `null`
   */
  access(): Promise<AnnouncementSettings | null>;
}

const UNAVAILABLE = { available: false, reason: 'お知らせの作成は使えません（会社で切っているか、利用範囲の外です）' };
const str = (v: unknown) => (typeof v === 'string' ? v.trim() : '');

async function serviceOf(ctx: ToolContext): Promise<AnnouncementService | null> {
  if (!ctx.announcements) return null;
  return (await ctx.announcements.access()) ? ctx.announcements.service : null;
}

const who = (ctx: ToolContext) => ({ tenantId: ctx.tenantId, userId: ctx.userId });

/** お知らせの画面の場所。 */
export const announcementPath = (id: string) => `/announcements/${encodeURIComponent(id)}`;

/** 秘書に返す 1 件の形。 */
function brief(a: Announcement) {
  return {
    path: announcementPath(a.id), title: a.title, status: ANNOUNCEMENT_STATUS_LABELS[a.status],
    period: periodText(a.startDate, a.endDate) || null, publishAt: a.publishAt, channels: a.channels.map((c) => ANNOUNCEMENT_CHANNEL_LABELS[c]),
  };
}

/**
 * お知らせの下書きを作る（第35.5節 ②）。
 *
 * @remarks 危険度 `write-internal`。社内の下書きを作るだけで、外には何も出さない
 */
export const announcementsDraft: Tool = {
  name: 'announcements.draft',
  risk: 'write-internal',
  activityLabel: 'お知らせの下書きを作っています',
  helpText: '頼みから、お知らせの題名・本文・期間と、Web サイト・LINE・店頭の画面ごとの文を作ります。出すのは承認の後です',
  description: 'お知らせの下書きを作る。request には依頼者の頼みをそのまま入れる（「年末年始の休業のお知らせを出して。12/28〜1/5」「夏季休業のお知らせ、LINE だけで」）。外には出さない',
  args: { properties: { request: { type: 'string', description: '依頼者の頼み（そのまま）' } }, required: ['request'] },
  async invoke(args, ctx) {
    const service = await serviceOf(ctx);
    if (!service) return UNAVAILABLE;
    const r = await service.draft(who(ctx), str(args['request']));
    if ('error' in r) return { available: false, reason: r.error };
    return { available: true, ...brief(r.announcement), body: r.announcement.body, line: r.announcement.texts.line, note: '下書きを作りました。出すには承認が要ります' };
  },
};

/**
 * 下書きを直す（「もっと丁寧に」「来週月曜の朝 9 時に出して」）。
 *
 * @remarks 危険度 `write-internal`
 */
export const announcementsRevise: Tool = {
  name: 'announcements.revise',
  risk: 'write-internal',
  activityLabel: 'お知らせを直しています',
  helpText: 'いちばん新しいお知らせの下書きを、頼みに合わせて直します（書き方・予約の日時）',
  description: 'いちばん新しいお知らせの下書きを直す。instruction は書き方の頼み（「もっと丁寧に」）、publishAt は予約の日時（ISO。「来週月曜の朝 9 時に出して」なら、その日時を日本時間で計算して入れる）',
  args: {
    properties: {
      instruction: { type: 'string', description: '書き方の頼み' },
      publishAt: { type: 'string', description: '予約の日時（ISO 8601）' },
    },
  },
  async invoke(args, ctx) {
    const service = await serviceOf(ctx);
    if (!service) return UNAVAILABLE;
    const r = await service.revise(who(ctx), null, str(args['instruction']), str(args['publishAt']) || null);
    if ('error' in r) return { available: false, reason: r.error };
    return { available: true, ...brief(r.announcement), body: r.announcement.body };
  },
};

/**
 * いちばん新しい下書きを承認へ進める（「承認へ進めて」）。
 *
 * @remarks 危険度 `write-internal`。承認の依頼を出すだけで、出すのは承認の後
 */
export const announcementsSubmit: Tool = {
  name: 'announcements.submit',
  risk: 'write-internal',
  activityLabel: 'お知らせを承認へ進めています',
  helpText: 'いちばん新しいお知らせの下書きを、承認へ進めます。出すのは承認の後です',
  description: 'いちばん新しいお知らせの下書きを承認へ進める（管理者か承認者が承認すると出る）',
  args: { properties: {} },
  async invoke(_args, ctx) {
    const service = await serviceOf(ctx);
    if (!service) return UNAVAILABLE;
    const draft = (await service.list(who(ctx), 20)).find((a) => a.status === 'draft');
    if (!draft) return { available: false, reason: '承認へ進める下書きがありません' };
    const r = await service.submit(who(ctx), draft.id);
    if ('error' in r) return { available: false, reason: r.error, path: announcementPath(draft.id) };
    return { available: true, ...brief(draft), note: '承認へ進めました。管理者か承認者が承認すると出ます' };
  },
};

/**
 * お知らせの一覧と、LINE の友だちの数・今月の残り（「LINE の友だちは何人？今月あと何通送れる？」）。
 *
 * @remarks 危険度 `read`
 */
export const announcementsList: Tool = {
  name: 'announcements.list',
  risk: 'read',
  activityLabel: 'お知らせを調べています',
  helpText: 'お知らせの一覧（下書き・予約・出したもの）と、LINE の友だちの数・今月あと何通送れるかを読みます',
  description: 'お知らせの一覧（新しい順に 10 件）と、LINE の友だちの数・今月の残りの数を返す',
  args: { properties: {} },
  async invoke(_args, ctx) {
    const service = await serviceOf(ctx);
    if (!service) return UNAVAILABLE;
    const list = await service.list(who(ctx), 10);
    const line = await service.lineStatus(ctx.tenantId);
    return { available: true, items: list.map(brief), line, path: '/announcements' };
  },
};

/**
 * 承認されたお知らせを出す（付属の業務「お知らせを出す」が承認の後に呼ぶ）。
 *
 * @remarks 危険度 `external-send`。Web への公開・LINE の一斉配信は社外への送信。承認の画面に出し先ごとの見え方・送る数を出す
 */
export const announcementsPublish: Tool = {
  name: 'announcements.publish',
  risk: 'external-send',
  activityLabel: 'お知らせを出しています',
  helpText: '承認されたお知らせを、Web サイト・LINE・店頭の画面に出します（予約があればその時刻に）',
  description: '承認されたお知らせ（announcementId）を出し先ごとに出す。予約があれば予約にする',
  args: { properties: { announcementId: { type: 'string', description: 'お知らせの ID' } }, required: ['announcementId'] },
  planKey: (args) => `announcement:${str(args['announcementId'])}`,
  async prepare(args, ctx) {
    const service = await serviceOf(ctx);
    if (!service) return { kind: 'problem', reason: UNAVAILABLE.reason };
    const id = str(args['announcementId']);
    const p = await service.preview(who(ctx), id).catch(() => null);
    const d = await service.detail(who(ctx), id).catch(() => null);
    if (!p || !d) return { kind: 'problem', reason: 'お知らせが見つかりません' };
    if (p.problems.length > 0) return { kind: 'problem', reason: p.problems.join('／') };
    const a = d.announcement;
    // メールの宛先は 1 人ずつ出す（承認する人が、誰に届くかを見て判断できるように。まとめてのメールと同じ）
    const people = a.channels.includes('mail') ? await service.mailRecipients(who(ctx), id).catch(() => []) : [];
    const lines = [
      `題名: ${a.title}`,
      a.startDate || a.endDate ? `期間: ${periodText(a.startDate, a.endDate)}（期間が終わったら店頭の画面から外し、Web の記事の題名に「（終了しました）」を付けます）` : '',
      `出す日時: ${a.publishAt ? new Date(a.publishAt).toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' }) : '承認したとき'}`,
      a.channels.includes('web') ? `■ Web サイト（${p.web}）\n${a.texts.web.title}\n${a.texts.web.body}` : '',
      a.channels.includes('line') ? `■ LINE（友だち ${p.line?.followers ?? '?'} 人に一斉配信。今月の残り ${p.line?.limit !== null && p.line ? `${Math.max(0, p.line.limit - p.line.used)} 通` : '上限なし'}。送った後は取り消せません）\n${a.texts.line}` : '',
      a.channels.includes('mail') && p.mail ? `■ メール（${p.mail.count} 人に、${p.mail.from}から 1 人に 1 通ずつ。配信を停止した人などは除きます。送った後は取り消せません）\n件名: ${a.texts.mail.subject}\n${a.texts.mail.body}\n宛先:\n${people.map((r) => `- ${r.name}${r.company ? `（${r.company}）` : ''} ${r.email}`).join('\n')}` : '',
      a.channels.includes('signage') ? `■ 店頭の画面（${p.screens.join('・')}）\n${a.texts.signage.headline}／${a.texts.signage.period}／${a.texts.signage.note}` : '',
    ].filter(Boolean);
    return { kind: 'ready', args: { announcementId: id, digest: p.digest }, shown: lines.join('\n'), audience: 'external' };
  },
  async invoke(args, ctx) {
    const service = await serviceOf(ctx);
    if (!service) return UNAVAILABLE;
    const r = await service.publish(who(ctx), str(args['announcementId']), str(args['digest']));
    if ('error' in r) return { available: false, reason: r.error };
    return {
      available: true, status: r.status === 'scheduled' ? '予約' : '出した',
      outputs: r.outputs.map((o) => ({ channel: ANNOUNCEMENT_CHANNEL_LABELS[o.channel], status: o.status, reason: o.reason || null, link: o.result.link ?? null })),
    };
  },
};

/**
 * 会社の営業日と、これからの休業の期間（「年末は何日まで営業？」「次の休みはいつ？」）。
 *
 * @remarks 危険度 `read`
 */
export const announcementsClosures: Tool = {
  name: 'announcements.closures',
  risk: 'read',
  activityLabel: '休業の予定を調べています',
  helpText: '会社の営業日（曜日と祝日）と、お知らせで出した休業の期間を読みます',
  description: '会社の営業する曜日・祝日を休むか・これからの休業の期間（お知らせで出したもの）を返す。「年末は何日まで営業？」「次の休みはいつ？」に答えるのに使う',
  args: { properties: {} },
  async invoke(_args, ctx) {
    const service = await serviceOf(ctx);
    if (!service) return UNAVAILABLE;
    const r = await service.closures(ctx.tenantId);
    return { available: true, ...r, note: r.closures.length ? null : 'お知らせで出した休業の期間はありません' };
  },
};

/** お知らせの作成のツール。 */
export const ANNOUNCEMENT_TOOLS: Tool[] = [announcementsDraft, announcementsRevise, announcementsSubmit, announcementsList, announcementsPublish, announcementsClosures];
