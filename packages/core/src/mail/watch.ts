/**
 * @file メールの見回り（仕様書 第9.5.1.1節、ADR-0131）。ワーカーが 15 分ごとに呼ぶ。
 *
 * 1 人ずつ、Gmail の履歴の番号から差分だけを読み、変わったスレッドを振り分け直す。
 * - 届いたメール: 受信トレイの「メイン」だけを見る。配信のメールは推論を呼ばずに「宣伝・お知らせ」、ほかは推論で 4 つに分ける
 * - 本人が送ったメール: 前に並べていたものは片付いたとみなし、返事を待っているものは「返事待ち」にする
 * - アーカイブ・ごみ箱: 片付いたとみなす
 * 「返事が要る」と、日のたった「返事待ち」には下書きを用意する。急ぎのものだけ、すぐ本人に知らせる。
 *
 * メールの文はデータであり、指示として扱わない（不変則 I-6）。本文は保存しない（下書きを作るときだけ読む）。
 */

import { randomUUID } from 'node:crypto';
import { MAIL_LIMITS, type MailGroupId, type MailPrefs } from '@m2office/shared';
import type { Repository } from '../repository/types.js';
import type { ConnectorPrincipal, MailConnector, MailHead } from '../connectors/types.js';
import type { LlmProvider } from '../llm/provider.js';
import { aiAvailable } from '../llm/unconfigured.js';
import { AiLimitError, withAiUsage } from '../usage/ai-usage.js';
import { silentLogger, type Logger } from '../log/logger.js';
import { closedReason } from '../scheduler/business-days.js';
import { classifyInbound, classifySent, draftReply, type TriageInput } from './triage.js';
import type { MailOwner, MailStore, MailThreadRow, MailWatchRow } from './store.js';

/** 見回りが使うもの。 */
export interface MailWatchDeps {
  store: MailStore;
  repo: Repository;
  mail: MailConnector;
  llmFor(tenantId: string): Promise<LlmProvider | null>;
  /** 見本の接続口を使う会社か（Google の接続を確かめない）。 */
  isMock(tenantId: string): boolean;
  logger?: Logger;
}

/** 受信トレイの「メイン」の問い（Gmail の検索の書き方）。 */
const INBOX_MAIN = 'in:inbox category:primary';
/** AI の上限で振り分けを止めたときの印（`mail_watch.error` の頭）。 */
export const MAIL_AI_LIMIT_MARK = 'ai-limit:';

/** 日本時間の日付。 */
export const mailDay = (d: Date | string) => new Date((typeof d === 'string' ? Date.parse(d) : d.getTime()) + 9 * 3_600_000).toISOString().slice(0, 10);
const nextDay = (day: string) => new Date(Date.parse(`${day}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10);

/**
 * `from` の日の次の日から `now` の日までに、会社の営業日がいくつあるか（返事待ちの日数。第9.5.1.1節）。
 *
 * @remarks 90 日を超えては数えない（それ以上は 90 とする）
 */
export function businessDaysSince(company: { businessDays?: number[]; holidaysClosed?: boolean }, from: string, now: Date): number {
  const end = mailDay(now);
  let d = nextDay(mailDay(from));
  let n = 0;
  for (let i = 0; i < 90 && d <= end; i++) {
    if (closedReason(company, d, false) === null) n += 1;
    d = nextDay(d);
  }
  return n;
}

/** 次の営業日（急ぎの知らせの「期限が今日か次の営業日」）。 */
export function nextMailBusinessDay(company: { businessDays?: number[]; holidaysClosed?: boolean }, today: string): string {
  let d = nextDay(today);
  for (let i = 0; i < 14; i++) {
    if (closedReason(company, d, false) === null) return d;
    d = nextDay(d);
  }
  return d;
}

/** メールアドレスだけを取り出す（「山田 <a@b>」→「a@b」）。 */
export const addressOf = (v: string) => (/<([^>]+)>/.exec(v)?.[1] ?? v).trim().toLowerCase();

/** 相手ごとの返事待ちの日数（本人が秘書に頼んだもの）。無ければ既定の 3 営業日。 */
export function waitDaysFor(prefs: MailPrefs, who: string): number {
  const w = who.toLowerCase();
  for (const [key, days] of Object.entries(prefs.waitDays ?? {})) {
    if (key && w.includes(key.toLowerCase()) && Number.isFinite(days) && days > 0) return Math.min(Math.floor(days), 60);
  }
  return MAIL_LIMITS.waitBusinessDays;
}

/** すぐ知らせる相手か（本人が秘書に頼んだもの）。 */
export const urgentSender = (prefs: MailPrefs, from: string) =>
  (prefs.urgentFrom ?? []).some((k) => k.trim() && from.toLowerCase().includes(k.trim().toLowerCase()));

/** 返信の件名。 */
export const replySubject = (subject: string) => (/^\s*(re|返信)\s*[:：]/i.test(subject) ? subject : `Re: ${subject}`);

/** 新しい行の形。 */
function newRow(threadId: string, group: MailGroupId, lastAt: string): MailThreadRow {
  return {
    threadId, group, state: 'open', doneReason: null, doneAt: null, lastMessageId: '', replyToId: '', from: '', subject: '', summary: '',
    dueText: '', dueDate: null, lastAt, sentAt: null, sentTo: '', recipients: { to: [], cc: [] }, draftState: 'none', draft: '',
    outgoing: null, sendRunId: null, notifiedAt: null, updatedAt: lastAt,
  };
}

/** 片付いた形にする。 */
export function doneRow(t: MailThreadRow, reason: string, at: string): MailThreadRow {
  return { ...t, state: 'done', doneReason: reason, doneAt: at, draft: '', draftState: 'none', outgoing: null };
}

/** 1 人の見回りの結果（テストと記録のため）。 */
export interface MailTickResult {
  looked: number;
  classified: number;
  drafted: number;
  notified: number;
}

/** メールの見回り。 */
export class MailWatch {
  private readonly log: Logger;

  constructor(private readonly deps: MailWatchDeps) {
    this.log = deps.logger ?? silentLogger;
  }

  /**
   * 見回る人か（第9.5.1.1節「見る人」。Q-318 で決定: はじめから入れておく）。
   *
   * @returns 見るなら `null`、見ないなら理由
   */
  async reasonNotToWatch(o: MailOwner): Promise<'inactive' | 'low' | 'paused' | 'not-connected' | null> {
    const { repo, store } = this.deps;
    const user = await repo.findUserById(o.tenantId, o.userId);
    if (!user || user.status !== 'active') return 'inactive';
    const prefs = (await store.watch(o))?.prefs ?? {};
    if (prefs.paused) return 'paused';
    // 「控えめ」でも、本人が「またメールを見て」と言っていれば見る（第 0.543.0 版）
    if (!prefs.keepWatching && (await repo.getUserSettings(o.tenantId, o.userId)).secretary.proactivity === 'low') return 'low';
    if (!this.deps.isMock(o.tenantId)) {
      const conn = await repo.getGoogleConnection(o.tenantId, o.userId).catch(() => null);
      if (!conn || !conn.scopes.includes('gmail.readonly')) return 'not-connected';
    }
    return null;
  }

  /** 会社ごとに、見回る人を 1 人ずつ見る。1 人の失敗はほかの人を止めない。 */
  async tick(tenantIds: string[], now: Date = new Date()): Promise<number> {
    let n = 0;
    for (const tenantId of tenantIds) {
      for (const u of await this.deps.repo.listUsers(tenantId)) {
        if (u.status !== 'active') continue;
        // AI の利用は本人の分として数える（1 人の上限が効く。第6.6.2節）
        const r = await withAiUsage({ userId: u.id, purpose: 'worker:mail' }, () => this.runFor({ tenantId, userId: u.id }, now)).catch((err) => {
          this.log.warn('メールを見られませんでした', { tenantId, userId: u.id, err });
          return null;
        });
        if (r) n += r.looked;
      }
    }
    return n;
  }

  /**
   * 1 人の受信箱を見る。前に見てから 15 分たっていなければ何もしない。
   *
   * @param force 間隔を待たずに見る（画面を開いて、まだ一度も見ていないとき）
   */
  async runFor(o: MailOwner, now: Date = new Date(), force = false): Promise<MailTickResult | null> {
    if (await this.reasonNotToWatch(o)) return null;
    const { store, mail } = this.deps;
    const w: MailWatchRow = (await store.watch(o)) ?? { historyId: null, startedAt: null, checkedAt: null, error: null, prefs: {} };
    if (!force && w.checkedAt && now.getTime() - Date.parse(w.checkedAt) < MAIL_LIMITS.pollMinutes * 60_000 - 30_000) return null;
    if (!mail.historyStart || !mail.historySince || !mail.threadHeads || !mail.threadIdsOf) return null;
    const p: ConnectorPrincipal = o;

    // 変わったスレッドを集める（最初の 1 回は直近 14 日、番号が古すぎたら直近 2 日を見直す）
    let historyId = w.historyId;
    let ids: string[];
    // 「メイン」かどうかは Gmail の検索（category:primary）で決める。ラベルでは決めない
    // （「新着」などのタブを使っていない人は、CATEGORY_UPDATES の印が付いたメールも「メイン」に出る。2026-11-09 に oesf で、25 件中 22 件がそうだった）
    let primary: Set<string>;
    try {
      if (!historyId) {
        historyId = await mail.historyStart(p);
        ({ ids, primary } = await this.recent(p, MAIL_LIMITS.firstDays, MAIL_LIMITS.firstMax));
        w.startedAt = now.toISOString();
      } else {
        const changed = await mail.historySince(p, historyId);
        if (changed) {
          historyId = changed.historyId;
          ids = changed.threadIds;
          primary = changed.threadIds.length ? new Set(await mail.threadIdsOf(p, `${INBOX_MAIN} newer_than:${MAIL_LIMITS.recheckDays}d`, 300)) : new Set();
        } else {
          historyId = await mail.historyStart(p);
          ({ ids, primary } = await this.recent(p, MAIL_LIMITS.recheckDays, MAIL_LIMITS.firstMax));
        }
      }
    } catch (err) {
      w.error = err instanceof Error ? err.message : String(err);
      w.checkedAt = now.toISOString();
      await store.saveWatch(o, w);
      return null;
    }

    const result: MailTickResult = { looked: ids.length, classified: 0, drafted: 0, notified: 0 };
    const user = await this.deps.repo.findUserById(o.tenantId, o.userId);
    const me = (user?.email ?? '').toLowerCase();
    const inbound: { row: MailThreadRow; head: MailHead }[] = [];
    const sent: { row: MailThreadRow | null; head: MailHead; heads: MailHead[] }[] = [];
    for (const threadId of ids) {
      const heads = await mail.threadHeads(p, threadId).catch(() => null);
      if (heads === null) continue;
      const row = await store.thread(o, threadId);
      const at = now.toISOString();
      if (heads.length === 0) {
        if (row?.state === 'open') await store.saveThread(o, doneRow(row, 'gone', at));
        continue;
      }
      const last = heads[heads.length - 1]!;
      const mine = last.labels.includes('SENT') || (!!me && addressOf(last.from) === me);
      if (mine) {
        if (row && row.lastMessageId === last.id) continue;
        // 前に並べていた届いたメールは、本人が返事をしたので片付いた
        const base = row?.state === 'open' && row.group !== 'waiting' ? doneRow(row, 'replied', at) : row;
        if (base && base !== row) await store.saveThread(o, base);
        sent.push({ row: base, head: last, heads });
        continue;
      }
      const inInbox = heads.some((h) => h.labels.includes('INBOX'));
      const gone = heads.some((h) => h.labels.includes('SPAM')) || last.labels.includes('TRASH');
      if (!inInbox || gone) {
        if (row?.state === 'open') await store.saveThread(o, doneRow(row, gone ? 'trashed' : 'archived', at));
        continue;
      }
      // 同じメールのまま（ラベルが変わっただけ）なら、片付けたものを開き直さない
      if (row && row.lastMessageId === last.id) continue;
      // まだ並べていないスレッドは、「メイン」にあるものだけを見る（プロモーション・ソーシャルなどのタブに入ったものは見ない）
      if (!row && !primary.has(threadId)) continue;
      const base = row ?? newRow(threadId, 'read', last.receivedAt);
      const fresh: MailThreadRow = {
        ...base, state: 'open', doneReason: null, doneAt: null, lastMessageId: last.id, replyToId: last.id, from: last.from,
        subject: last.subject, lastAt: last.receivedAt, recipients: this.recipientsOf(last, me), outgoing: null, sendRunId: null,
      };
      if (last.bulk) {
        await store.saveThread(o, { ...fresh, group: 'promo', summary: '', dueText: '', dueDate: null, draftState: 'none', draft: '' });
        continue;
      }
      inbound.push({ row: fresh, head: last });
    }

    // 振り分け（推論）。使えなければ「目を通すだけ」に入れ、画面に止めていることを出す
    const llm = await this.deps.llmFor(o.tenantId).catch(() => null);
    const usable = !!llm && aiAvailable(llm);
    let aiLimited = false;
    const today = mailDay(now);
    const todo = inbound.slice(0, MAIL_LIMITS.classifyPerTick);
    if (todo.length) {
      let verdicts: Awaited<ReturnType<typeof classifyInbound>>['verdicts'] | null = null;
      if (usable) {
        try {
          verdicts = (await classifyInbound(llm!, today, todo.map((x) => this.inputOf(x.head)))).verdicts;
        } catch (err) {
          if (err instanceof AiLimitError) aiLimited = true;
          else this.log.warn('メールを振り分けられませんでした', { tenantId: o.tenantId, err });
        }
      } else {
        aiLimited = true;
      }
      for (let i = 0; i < todo.length; i++) {
        const v = verdicts?.[i];
        const row: MailThreadRow = v
          ? { ...todo[i]!.row, group: v.group, summary: v.summary, dueText: v.due, dueDate: v.dueDate,
            draftState: v.group === 'reply' ? 'pending' : 'none', draft: v.group === 'reply' ? todo[i]!.row.draft : '' }
          : { ...todo[i]!.row, group: 'read', summary: '', dueText: '', dueDate: null, draftState: 'none', draft: '' };
        await store.saveThread(o, row);
        if (v) result.classified += 1;
      }
    }

    // 本人が送ったもの: 返事を待っているかを見分ける
    if (sent.length && usable && !aiLimited) {
      try {
        const waiting = await classifySent(llm!, sent.map((x) => ({ from: x.head.to.join(', '), subject: x.head.subject, head: x.head.snippet })));
        for (let i = 0; i < sent.length; i++) {
          const { row, head } = sent[i]!;
          if (!waiting[i]) continue;
          const base = row ?? newRow(head.threadId, 'waiting', head.receivedAt);
          await store.saveThread(o, {
            ...base, group: 'waiting', state: 'open', doneReason: null, doneAt: null, lastMessageId: head.id, replyToId: head.id,
            from: head.to.join(', '), subject: head.subject, summary: '', dueText: '', dueDate: null, lastAt: head.receivedAt,
            sentAt: head.receivedAt, sentTo: head.to[0] ?? '', recipients: { to: head.to, cc: head.cc }, draftState: 'none', draft: '',
            outgoing: null, sendRunId: null, notifiedAt: null,
          });
        }
      } catch (err) {
        if (err instanceof AiLimitError) aiLimited = true;
        else this.log.warn('送ったメールを見分けられませんでした', { tenantId: o.tenantId, err });
      }
    }

    if (usable && !aiLimited) result.drafted = await this.prepareDrafts(o, llm!, w.prefs, now).catch((err) => {
      if (!(err instanceof AiLimitError)) this.log.warn('下書きを作れませんでした', { tenantId: o.tenantId, err });
      else aiLimited = true;
      return 0;
    });
    result.notified = await this.notifyUrgent(o, w.prefs, now);

    w.historyId = historyId;
    w.checkedAt = now.toISOString();
    w.error = aiLimited ? `${MAIL_AI_LIMIT_MARK}AI の上限に達したため、振り分けていません` : null;
    // 本人の頼み（止める・知らせる相手）は、見ている間に変わっていても上書きしない
    const latest = await store.watch(o);
    await store.saveWatch(o, { ...w, prefs: latest?.prefs ?? w.prefs });
    return result;
  }

  /** 直近の日数の「メイン」と送ったもののスレッド。`primary` は「メイン」にあるスレッド。 */
  private async recent(p: ConnectorPrincipal, days: number, max: number): Promise<{ ids: string[]; primary: Set<string> }> {
    const mail = this.deps.mail;
    const inbox = await mail.threadIdsOf!(p, `${INBOX_MAIN} newer_than:${days}d`, max);
    const sentIds = await mail.threadIdsOf!(p, `in:sent newer_than:${days}d`, Math.ceil(max / 2));
    return { ids: [...new Set([...inbox, ...sentIds])], primary: new Set(inbox) };
  }

  /** 返事の宛先: 差出人に返し、ほかの宛先と CC は CC に残す（本人は除く）。 */
  private recipientsOf(h: MailHead, me: string): { to: string[]; cc: string[] } {
    const notMe = (a: string) => !me || addressOf(a) !== me;
    const to = [h.from].filter(notMe);
    const cc = [...h.to, ...h.cc].filter(notMe).filter((a) => !to.some((t) => addressOf(t) === addressOf(a)));
    return { to, cc: [...new Map(cc.map((a) => [addressOf(a), a])).values()] };
  }

  private inputOf(h: MailHead): TriageInput {
    return { from: h.from, subject: h.subject, head: h.snippet };
  }

  /**
   * 下書きを用意する。「返事が要る」で下書きがまだのものと、日のたった「返事待ち」で催促の下書きがまだのもの。
   *
   * @returns 作った数（1 回に 5 つまで）
   */
  async prepareDrafts(o: MailOwner, llm: LlmProvider, prefs: MailPrefs, now: Date): Promise<number> {
    const { store, repo } = this.deps;
    const company = (await repo.getTenantSettings(o.tenantId)).company;
    const open = await store.openThreads(o);
    const due = open.filter((t) => (t.group === 'reply' && t.draftState === 'pending')
      || (t.group === 'waiting' && t.draftState === 'none' && t.sentAt && businessDaysSince(company, t.sentAt, now) >= waitDaysFor(prefs, t.sentTo || t.from)));
    let n = 0;
    for (const t of due.slice(0, MAIL_LIMITS.draftsPerTick)) {
      const text = await this.draftFor(o, t, llm);
      if (text === null) continue;
      const cur = await store.thread(o, t.threadId);
      if (!cur || cur.state !== 'open' || cur.lastMessageId !== t.lastMessageId) continue;
      await store.saveThread(o, { ...cur, draft: text, draftState: 'ready' });
      n += 1;
    }
    return n;
  }

  /**
   * 1 件の下書きを作る（直す頼みがあれば直す）。スレッドの本文はこのときだけ Gmail から読み、残さない。
   *
   * @returns 作れなければ `null`
   */
  async draftFor(o: MailOwner, t: MailThreadRow, llm: LlmProvider, instruction?: string): Promise<string | null> {
    const { repo, mail } = this.deps;
    const messages = mail.thread ? await mail.thread(o, t.threadId).catch(() => []) : [];
    if (!messages.length) return null;
    const user = await repo.findUserById(o.tenantId, o.userId);
    const settings = await repo.getTenantSettings(o.tenantId);
    const me = (user?.email ?? '').toLowerCase();
    const { text } = await draftReply(llm, {
      kind: t.group === 'waiting' ? 'nudge' : 'reply',
      me: { name: user?.displayName ?? '', company: settings.company.shortName || settings.company.legalName || '' },
      messages: messages.map((m) => ({ from: m.from, at: m.receivedAt, body: m.body, mine: m.labels.includes('SENT') || (!!me && addressOf(m.from) === me) })),
      ...(instruction ? { instruction, current: t.draft } : {}),
    });
    return text || null;
  }

  /**
   * 急ぎのものを、すぐ本人に知らせる（通知の種類 `mail`。第9.5.1.1節「急ぎの知らせ」）。1 件に 1 回だけ。
   *
   * @remarks 本人が「メール」の知らせを切っていれば作らない
   */
  async notifyUrgent(o: MailOwner, prefs: MailPrefs, now: Date): Promise<number> {
    const { store, repo } = this.deps;
    const settings = await repo.getTenantSettings(o.tenantId);
    const user = await repo.getUserSettings(o.tenantId, o.userId);
    const today = mailDay(now);
    const soon = nextMailBusinessDay(settings.company, today);
    const urgent = (await store.openThreads(o)).filter((t) => !t.notifiedAt && (t.group === 'reply' || t.group === 'action')
      && ((t.dueDate !== null && t.dueDate <= soon) || urgentSender(prefs, t.from)));
    let n = 0;
    for (const t of urgent.slice(0, 10)) {
      await store.saveThread(o, { ...t, notifiedAt: now.toISOString() });
      if (user.notifications.kinds.mail === false) continue;
      const who = t.from.replace(/\s*<[^>]*>\s*$/, '').replace(/^"|"$/g, '') || t.from;
      await repo.createNotification({
        id: randomUUID(), tenantId: o.tenantId, userId: o.userId, kind: 'mail',
        title: `${who}から急ぎのメール: ${t.subject}`.slice(0, 120),
        body: [t.summary, t.dueText ? `期限: ${t.dueText}` : ''].filter(Boolean).join('\n'), runId: null, readAt: null, createdAt: now.toISOString(),
      });
      n += 1;
    }
    return n;
  }
}
