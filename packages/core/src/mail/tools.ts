/**
 * @file メールの片付けのツール（仕様書 第9.5.1.1節、ADR-0131）。
 *
 * - `mail.reply_send`: 本人がメールの画面で確かめた控えだけを、同じスレッドへの返信として送る（承認の段の直後だけ）
 * - `mail.brief`: 朝のブリーフに載せる、返事が要るもの・対応が要るもの・返事待ちが長いもの（読むだけ）
 */

import { createHash } from 'node:crypto';
import { MAIL_LIMITS } from '@m2office/shared';
import type { Tool, ToolContext } from '../tools/registry.js';
import type { MailStore, MailOutgoing } from './store.js';
import { businessDaysSince, doneRow, mailDay, waitDaysFor } from './watch.js';
import { correctionLine, correctionProgress } from '../memory/corrections.js';

/** ツールに渡すもの。 */
export interface MailToolContext {
  store: MailStore;
}

const str = (v: unknown) => (typeof v === 'string' ? v : '');
const principal = (ctx: ToolContext) => ({ tenantId: ctx.tenantId, userId: ctx.userId });

/** 控えの印（承認の後に控えが変わっていたら送らない）。 */
export const outgoingDigest = (o: MailOutgoing) => createHash('sha256').update(JSON.stringify([o.to, o.cc, o.subject, o.body, o.replyTo])).digest('hex').slice(0, 32);

const UNAVAILABLE = { available: false, reason: 'メールの画面を使えません' };

/**
 * 本人が確かめた返事を送る（第9.5.1.1節「送る」）。承認の画面に宛先・CC・件名・本文を出す。
 *
 * @remarks 危険度 `external-send`。いつも人に判断を求める（承認するのは依頼した本人。`approver: requester`）
 */
export const mailReplySend: Tool = {
  name: 'mail.reply_send',
  risk: 'external-send',
  activityLabel: 'メールの返事を送っています',
  helpText: 'メールの画面で確かめた返事を、同じスレッドへの返信として送ります',
  description: 'メールの画面で本人が確かめた返事（threadId）を、同じスレッドへの返信として送る',
  args: { properties: { threadId: { type: 'string', description: 'スレッドの ID' } }, required: ['threadId'] },
  google: { scope: 'gmail.send', level: 'sensitive' },
  planKey: (args) => `mail-reply:${str(args['threadId'])}`,
  async prepare(args, ctx) {
    if (!ctx.mail) return { kind: 'problem', reason: UNAVAILABLE.reason };
    const t = await ctx.mail.store.thread(principal(ctx), str(args['threadId']));
    if (!t?.outgoing) return { kind: 'problem', reason: '送る返事が見つかりません。メールの画面からもう一度送ってください' };
    const o = t.outgoing;
    if (o.to.length === 0) return { kind: 'problem', reason: '宛先がありません' };
    return {
      kind: 'ready', args: { threadId: t.threadId, digest: outgoingDigest(o) }, audience: 'external',
      shown: [`宛先: ${o.to.join(', ')}`, ...(o.cc.length ? [`CC: ${o.cc.join(', ')}`] : []), `件名: ${o.subject}`, '', o.body].join('\n'),
    };
  },
  async invoke(args, ctx) {
    if (!ctx.mail) return UNAVAILABLE;
    const t = await ctx.mail.store.thread(principal(ctx), str(args['threadId']));
    if (!t?.outgoing) return { available: false, reason: '送る返事が見つかりません' };
    if (str(args['digest']) && str(args['digest']) !== outgoingDigest(t.outgoing)) {
      return { available: false, reason: '確かめた後に返事が変わったので送りませんでした。メールの画面からもう一度送ってください' };
    }
    const o = t.outgoing;
    const res = await ctx.connector.mail.send(principal(ctx), { to: o.to, cc: o.cc, subject: o.subject, body: o.body, replyTo: o.replyTo || null });
    await ctx.mail.store.saveThread(principal(ctx), doneRow(t, 'replied', new Date().toISOString()));
    return { available: true, sent: true, messageId: res.messageId, note: `返事を送りました（${o.to.join(', ')}）` };
  },
};

/**
 * 朝のブリーフに載せるメール（第9.5.5.1節 ④。第 0.540.0 版からメールの一覧から伝える）。
 *
 * @returns 見回りがまだなら `ready: false`（ブリーフは受信トレイの未読を読む）
 * @remarks 危険度 `read`。差出人・件名はデータとして扱う
 */
export const mailBrief: Tool = {
  name: 'mail.brief',
  risk: 'read',
  activityLabel: 'メールの一覧を読んでいます',
  helpText: '朝のブリーフに載せる、返事が要るメール・対応が要るメール・返事待ちが長いメールを読みます',
  description: 'メールの画面の一覧から、返事が要るもの・対応が要るものの件数と主なもの、返事待ちが長いものを返す。ready が false なら見回りがまだなので gmail.unread を使う',
  args: { properties: {} },
  async invoke(_args, ctx: ToolContext) {
    if (!ctx.mail) return { available: true, ready: false };
    const w = await ctx.mail.store.watch(principal(ctx));
    if (!w?.checkedAt || !w.historyId) return { available: true, ready: false };
    const company = (await ctx.repo.getTenantSettings(ctx.tenantId)).company;
    const now = new Date();
    const open = await ctx.mail.store.openThreads(principal(ctx));
    const pick = (g: 'reply' | 'action') => open.filter((t) => t.group === g)
      .sort((a, b) => (a.dueDate ?? '9999').localeCompare(b.dueDate ?? '9999') || b.lastAt.localeCompare(a.lastAt));
    const reply = pick('reply');
    const action = pick('action');
    const longWait = open.filter((t) => t.group === 'waiting' && t.sentAt
      && businessDaysSince(company, t.sentAt, now) >= Math.max(MAIL_LIMITS.longWaitBusinessDays, waitDaysFor(w.prefs, t.sentTo || t.from)));
    const item = (t: (typeof open)[number]) => ({ from: t.from, subject: t.subject, summary: t.summary, due: t.dueText, path: '/mail' });
    return {
      available: true, untrusted: true, ready: true, today: mailDay(now),
      reply: { count: reply.length, items: reply.slice(0, 5).map(item) },
      action: { count: action.length, items: action.slice(0, 5).map(item) },
      longWaiting: longWait.slice(0, 5).map((t) => ({ to: t.from, subject: t.subject, sentAt: t.sentAt, path: '/mail' })),
      note: 'メールの画面（/mail）の一覧から読みました',
    };
  },
};

/**
 * 秘書の学びの進み具合（第11.13.7節「見せ方」。第9.5.1.1.2節のメールの数を含む）。週次ブリーフに 1 行で伝える
 * （「今週の秘書への直しは 6 回でした（頼んだ 100 件あたり 4 回。先週は 7 回）」）。
 *
 * @remarks 危険度 `read`。数だけを返し、直しの文やメールの中身は返さない
 */
export const learningProgress: Tool = {
  name: 'learning.progress',
  risk: 'read',
  activityLabel: '秘書の学びの進み具合を読んでいます',
  helpText: '週次ブリーフに載せる、秘書への直しの回数（今週と先週・頼んだ 100 件あたり）を読みます',
  description: '本人が秘書と業務を直した回数（会話での訂正・作り直しの頼み・差し戻し・取り次ぎの頼み直し・メール）を、今週と先週で返す。line はブリーフにそのまま載せる 1 行。まだ数が無ければ available が false',
  args: { properties: {} },
  async invoke(_args, ctx: ToolContext) {
    const now = new Date();
    const mailWeeks = ctx.mail ? await ctx.mail.store.weeks(principal(ctx), 2).catch(() => []) : [];
    const p = await correctionProgress(ctx.repo, ctx.tenantId, ctx.userId, now, mailWeeks).catch(() => null);
    if (!p || (p.thisWeek.total === 0 && p.thisWeek.requests === 0 && !p.lastWeek)) return { available: false, note: 'まだ数がありません' };
    return { available: true, thisWeek: p.thisWeek, lastWeek: p.lastWeek, line: correctionLine(p) };
  },
};

/** メールの片付けのツール。 */
export const MAIL_TOOLS: Tool[] = [mailReplySend, mailBrief, learningProgress];
