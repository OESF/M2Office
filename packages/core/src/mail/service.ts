/**
 * @file メールの画面の処理（仕様書 第9.5.1.1節、ADR-0131）。API と秘書が使う。
 *
 * 一覧・1 件を開く・下書きを直す・秘書に直してもらう・済みにする・送る前の控え・本人の頼み（止める・知らせる相手・待つ日数）。
 * 見られるのは本人だけ（呼ぶ側が本人の `MailOwner` を渡す）。本文は開いたときだけ Gmail から読み、残さない。
 */

import {
  MAIL_LIMITS, type MailItem, type MailOverview, type MailPrefs, type MailThreadDetail, type MailWatchState,
} from '@m2office/shared';
import type { Repository } from '../repository/types.js';
import type { MailConnector } from '../connectors/types.js';
import type { LlmProvider } from '../llm/provider.js';
import { aiAvailable } from '../llm/unconfigured.js';
import type { MailOwner, MailStore, MailThreadRow } from './store.js';
import { MAIL_AI_LIMIT_MARK, addressOf, businessDaysSince, doneRow, replySubject, waitDaysFor, type MailWatch } from './watch.js';

/** 処理が使うもの。 */
export interface MailServiceDeps {
  store: MailStore;
  repo: Repository;
  mail: MailConnector;
  watch: MailWatch;
  llmFor(tenantId: string): Promise<LlmProvider | null>;
}

/** メールアドレスの形（宛先の確かめ）。 */
const ADDRESS = /^[^\s@<>,]+@[^\s@<>,]+\.[^\s@<>,]+$/;

/** Gmail でスレッドを開く URL。 */
export const gmailThreadUrl = (threadId: string) => `https://mail.google.com/mail/u/0/#all/${encodeURIComponent(threadId)}`;

/** メールの画面の処理。 */
export class MailService {
  constructor(private readonly deps: MailServiceDeps) {}

  get store(): MailStore {
    return this.deps.store;
  }

  /** 一覧の 1 件の形。 */
  itemOf(t: MailThreadRow): MailItem {
    return {
      threadId: t.threadId, group: t.group, from: t.from, subject: t.subject, summary: t.summary, due: t.dueText, dueDate: t.dueDate,
      lastAt: t.lastAt, sentAt: t.sentAt, draftReady: t.draftState === 'ready' && !!t.draft, sending: !!t.outgoing && !!t.sendRunId,
    };
  }

  /** 見回りの様子。 */
  async watchState(o: MailOwner): Promise<MailWatchState> {
    const why = await this.deps.watch.reasonNotToWatch(o);
    const w = await this.deps.store.watch(o);
    if (why === 'paused' || why === 'low') return { state: 'paused', checkedAt: w?.checkedAt ?? null, error: null };
    if (why) return { state: 'off', checkedAt: w?.checkedAt ?? null, error: null };
    if (!w?.checkedAt || !w.historyId) return { state: w?.error ? 'error' : 'starting', checkedAt: w?.checkedAt ?? null, error: w?.error ?? null };
    if (w.error && !w.error.startsWith(MAIL_AI_LIMIT_MARK)) return { state: 'error', checkedAt: w.checkedAt, error: w.error };
    return { state: 'ready', checkedAt: w.checkedAt, error: null };
  }

  /**
   * 一覧（第9.5.1.1節「一覧」）。返事が要る・対応が要るは期限の近い順、次に新しい順。返事待ちは、待つ日数を過ぎたものだけ。
   */
  async overview(o: MailOwner, now: Date = new Date()): Promise<MailOverview> {
    const { store, repo } = this.deps;
    const [open, w, settings] = await Promise.all([store.openThreads(o), store.watch(o), repo.getTenantSettings(o.tenantId)]);
    const prefs = w?.prefs ?? {};
    const byDue = (a: MailThreadRow, b: MailThreadRow) => (a.dueDate ?? '9999').localeCompare(b.dueDate ?? '9999') || b.lastAt.localeCompare(a.lastAt);
    const of = (g: MailThreadRow['group']) => open.filter((t) => t.group === g);
    const waiting = of('waiting').filter((t) => t.sentAt && businessDaysSince(settings.company, t.sentAt, now) >= waitDaysFor(prefs, t.sentTo || t.from))
      .sort((a, b) => (a.sentAt ?? '').localeCompare(b.sentAt ?? ''));
    const recent = now.getTime() - MAIL_LIMITS.firstDays * 86_400_000;
    return {
      reply: of('reply').sort(byDue).map((t) => this.itemOf(t)),
      action: of('action').sort(byDue).map((t) => this.itemOf(t)),
      waiting: waiting.map((t) => this.itemOf(t)),
      read: of('read').slice(0, 100).map((t) => this.itemOf(t)),
      promoCount: of('promo').filter((t) => Date.parse(t.lastAt) >= recent).length,
      watch: await this.watchState(o),
      aiLimited: !!w?.error?.startsWith(MAIL_AI_LIMIT_MARK),
    };
  }

  /** 「返事が要る」の件数（左のメニューの数）。 */
  async replyCount(o: MailOwner): Promise<number> {
    return (await this.deps.store.openThreads(o)).filter((t) => t.group === 'reply').length;
  }

  /**
   * 1 件を開く（第9.5.1.1節「1 件を開いたとき」）。本文は Gmail から読み、残さない。
   * 「目を通すだけ」は、開いたら片付いたとみなす。
   *
   * @returns 本人のものでなければ `null`
   */
  async detail(o: MailOwner, threadId: string, now: Date = new Date()): Promise<MailThreadDetail | null> {
    const { store, repo, mail } = this.deps;
    let t = await store.thread(o, threadId);
    if (!t) return null;
    if (t.state === 'open' && (t.group === 'read' || t.group === 'promo')) {
      t = doneRow(t, 'opened', now.toISOString());
      await store.saveThread(o, t);
    }
    const user = await repo.findUserById(o.tenantId, o.userId);
    const me = (user?.email ?? '').toLowerCase();
    let messages: MailThreadDetail['messages'] = [];
    let readError: string | null = null;
    try {
      const got = mail.thread ? await mail.thread(o, threadId) : [];
      messages = got.map((m) => ({
        id: m.id, from: m.from, at: m.receivedAt, body: m.body,
        mine: m.labels.includes('SENT') || (!!me && addressOf(m.from) === me),
      }));
      if (!got.length) readError = 'Gmail にこのスレッドが見つかりませんでした';
    } catch (err) {
      readError = `Gmail から読めませんでした（${err instanceof Error ? err.message : String(err)}）`;
    }
    let sending: MailThreadDetail['sending'] = null;
    if (t.sendRunId && t.outgoing) {
      const run = await repo.getRun(o.tenantId, t.sendRunId);
      const approvals = run ? await repo.listRunApprovals(o.tenantId, run.id) : [];
      const pending = approvals.find((a) => a.decision === null && a.approverUserId === o.userId);
      const status = run?.status ?? 'queued';
      if (!run || ['failed', 'cancelled', 'expired', 'completed'].includes(status)) {
        // 断った・失敗した送信は控えを外し、直して送り直せるようにする（送れたものは送る業務が片付けている）
        await this.clearSend(o, threadId);
        t = { ...t, outgoing: null, sendRunId: null };
        if (status !== 'completed') readError = readError ?? (status === 'failed' ? '前の送信は失敗しました。直してもう一度送ってください' : null);
      } else {
        sending = { runId: t.sendRunId, approvalId: pending?.id ?? null, status };
      }
    }
    return {
      item: this.itemOf(t), done: t.state === 'done', messages, readError, draft: t.draft, recipients: t.recipients, replySubject: replySubject(t.subject),
      gmailUrl: gmailThreadUrl(threadId), sending,
    };
  }

  /** 下書きを直して残す（本人が画面で書き換えたもの）。 */
  async saveDraft(o: MailOwner, threadId: string, draft: string): Promise<boolean> {
    const t = await this.deps.store.thread(o, threadId);
    if (!t || t.state !== 'open') return false;
    await this.deps.store.saveThread(o, { ...t, draft: draft.slice(0, 20_000), draftState: draft.trim() ? 'ready' : t.draftState });
    return true;
  }

  /**
   * 下書きを作る・秘書の頼みで直す（「もっと短く」「来週の火曜で提案して」など）。
   *
   * @returns 直した下書き。推論が使えなければ理由
   */
  async redraft(o: MailOwner, threadId: string, instruction?: string): Promise<{ draft: string } | { error: string; status: 404 | 409 | 503 }> {
    const t = await this.deps.store.thread(o, threadId);
    if (!t || t.state !== 'open') return { error: 'メールが見つかりません', status: 404 };
    const llm = await this.deps.llmFor(o.tenantId).catch(() => null);
    if (!llm || !aiAvailable(llm)) return { error: 'AI が使えないため、下書きを作れません', status: 503 };
    const text = await this.deps.watch.draftFor(o, t, llm, instruction?.trim() || undefined);
    if (!text) return { error: 'スレッドを Gmail から読めなかったため、下書きを作れませんでした', status: 409 };
    await this.deps.store.saveThread(o, { ...t, draft: text, draftState: 'ready' });
    return { draft: text };
  }

  /** 済みにする（本人が押した・秘書に「済んだ」と言った）。 */
  async done(o: MailOwner, threadId: string, now: Date = new Date()): Promise<boolean> {
    const t = await this.deps.store.thread(o, threadId);
    if (!t) return false;
    if (t.state === 'open') await this.deps.store.saveThread(o, doneRow(t, 'marked', now.toISOString()));
    return true;
  }

  /**
   * 送る前の控えを残す（第9.5.1.1節「送る」）。本人が確かめた宛先・CC・本文を控え、送る業務がこの控えだけを送る。
   *
   * @returns 控えたスレッド。宛先が不正なら理由
   */
  async prepareSend(o: MailOwner, threadId: string, input: { to: unknown; cc: unknown; body: unknown }): Promise<{ row: MailThreadRow } | { error: string; status: 400 | 404 | 409 }> {
    const t = await this.deps.store.thread(o, threadId);
    if (!t || t.state !== 'open') return { error: 'メールが見つかりません', status: 404 };
    if (t.outgoing && t.sendRunId) return { error: 'この返事は送っている最中です', status: 409 };
    const list = (v: unknown) => (Array.isArray(v) ? v : []).filter((x): x is string => typeof x === 'string').map((x) => x.trim()).filter(Boolean);
    const to = list(input.to);
    const cc = list(input.cc);
    const body = typeof input.body === 'string' ? input.body.trim() : '';
    if (to.length === 0) return { error: '宛先を入れてください', status: 400 };
    const bad = [...to, ...cc].filter((a) => !ADDRESS.test(addressOf(a)));
    if (bad.length) return { error: `メールアドレスの形ではありません: ${bad.join(', ')}`, status: 400 };
    if (!body) return { error: '本文を入れてください', status: 400 };
    if (to.length + cc.length > 50) return { error: '宛先と CC は合わせて 50 人までです', status: 400 };
    const row: MailThreadRow = {
      ...t, draft: body, draftState: 'ready',
      outgoing: { to, cc, subject: replySubject(t.subject), body: body.slice(0, 20_000), replyTo: t.replyToId },
    };
    await this.deps.store.saveThread(o, row);
    return { row };
  }

  /** 送る業務の実行を結び付ける（送り終えるまで「送っている」と出す）。 */
  async attachSendRun(o: MailOwner, threadId: string, runId: string): Promise<void> {
    const t = await this.deps.store.thread(o, threadId);
    if (t) await this.deps.store.saveThread(o, { ...t, sendRunId: runId });
  }

  /** 送るのをやめる（承認を断った・失敗した後に、控えを外して直せるようにする）。 */
  async clearSend(o: MailOwner, threadId: string): Promise<void> {
    const t = await this.deps.store.thread(o, threadId);
    if (t) await this.deps.store.saveThread(o, { ...t, outgoing: null, sendRunId: null });
  }

  /**
   * Gmail の下書きに入れる（本人が「Gmail で直したい」を押したときだけ）。
   *
   * @returns 作った下書きの ID
   */
  async toGmailDraft(o: MailOwner, threadId: string): Promise<{ draftId: string } | null> {
    const t = await this.deps.store.thread(o, threadId);
    if (!t) return null;
    const res = await this.deps.mail.createDraft(o, {
      replyTo: t.replyToId || null, to: t.recipients.to[0] ?? '', subject: replySubject(t.subject), body: t.draft,
    });
    return { draftId: res.draftId };
  }

  /** 本人の頼みを読む。 */
  async prefs(o: MailOwner): Promise<MailPrefs> {
    return (await this.deps.store.watch(o))?.prefs ?? {};
  }

  /** 本人の頼みを直す（秘書が使う。第9.5.1.1節「見る人」「急ぎの知らせ」「返事待ち」）。 */
  async setPrefs(o: MailOwner, patch: (p: MailPrefs) => MailPrefs): Promise<MailPrefs> {
    const w = (await this.deps.store.watch(o)) ?? { historyId: null, startedAt: null, checkedAt: null, error: null, prefs: {} };
    const next = patch(structuredClone(w.prefs ?? {}));
    await this.deps.store.saveWatch(o, { ...w, prefs: next });
    return next;
  }
}
