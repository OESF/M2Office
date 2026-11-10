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
import { sanitizeMailHtml } from '../connectors/google/mime.js';
import type { MailCategoryRow, MailOwner, MailStore, MailThreadRow } from './store.js';
import {
  categoryKey, cleanCategoryName, findCategory, interpretCategoryRequest, newCategory, visibleCategories,
} from './categories.js';
import { MAIL_LEARNING, describeLesson, domainOfAddress, isActive, learningProgressOf, lessonAddress, subjectTag, type LearningProgress } from './learning.js';
import { MAIL_AI_LIMIT_MARK, addressOf, businessDaysSince, doneRow, replySubject, waitDaysFor, type MailWatch } from './watch.js';

/** 処理が使うもの。 */
export interface MailServiceDeps {
  store: MailStore;
  repo: Repository;
  mail: MailConnector;
  watch: MailWatch;
  llmFor(tenantId: string): Promise<LlmProvider | null>;
  /** いまの時刻（テスト用。既定は本当の時刻）。見回りが止まっているかを決めるのに使う。 */
  now?: () => Date;
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

  /** 学びの記録（見回りと同じもの。第9.5.1.1.2節）。 */
  get learner() {
    return this.deps.watch.learner;
  }

  /**
   * 一覧の 1 件の形。
   *
   * @param shown 並べているカテゴリー（ID から名前）。並べていないカテゴリーは出さない（1 通だけの話題など）
   */
  itemOf(t: MailThreadRow, shown: Map<string, string> = new Map()): MailItem {
    const name = t.categoryId ? shown.get(t.categoryId) : undefined;
    return {
      threadId: t.threadId, group: t.group, category: name && t.categoryId ? { id: t.categoryId, name } : null, from: t.from, subject: t.subject, summary: t.summary, due: t.dueText, dueDate: t.dueDate,
      lastAt: t.lastAt, sentAt: t.sentAt, draftReady: t.draftState === 'ready' && !!t.draft, sending: !!t.outgoing && !!t.sendRunId,
    };
  }

  /** 見回りの様子。 */
  async watchState(o: MailOwner): Promise<MailWatchState> {
    const why = await this.deps.watch.reasonNotToWatch(o);
    const w = await this.deps.store.watch(o);
    const checkedAt = w?.checkedAt ?? null;
    if (why === 'paused' || why === 'low') return { state: 'paused', checkedAt, error: null, stale: false };
    if (why) return { state: 'off', checkedAt, error: null, stale: false };
    // 見回っているはずの人で、最後の取得から間隔の 2 倍を過ぎていれば、止まっているとみなす
    const stale = checkedAt !== null && (this.deps.now?.() ?? new Date()).getTime() - Date.parse(checkedAt) > MAIL_LIMITS.staleMinutes * 60_000;
    if (!checkedAt || !w?.historyId) return { state: w?.error ? 'error' : 'starting', checkedAt, error: w?.error ?? null, stale };
    if (w.error && !w.error.startsWith(MAIL_AI_LIMIT_MARK)) return { state: 'error', checkedAt, error: w.error, stale };
    return { state: 'ready', checkedAt, error: null, stale };
  }

  /**
   * 一覧（第9.5.1.1節「一覧」）。返事が要る・対応が要るは期限の近い順、次に新しい順。返事待ちは、待つ日数を過ぎたものだけ。
   */
  async overview(o: MailOwner, now: Date = new Date()): Promise<MailOverview> {
    const { store, repo } = this.deps;
    const [open, w, settings, cats] = await Promise.all([store.openThreads(o), store.watch(o), repo.getTenantSettings(o.tenantId), store.categories(o)]);
    const prefs = w?.prefs ?? {};
    const byDue = (a: MailThreadRow, b: MailThreadRow) => (a.dueDate ?? '9999').localeCompare(b.dueDate ?? '9999') || b.lastAt.localeCompare(a.lastAt);
    const of = (g: MailThreadRow['group']) => open.filter((t) => t.group === g);
    const waiting = of('waiting').filter((t) => t.sentAt && businessDaysSince(settings.company, t.sentAt, now) >= waitDaysFor(prefs, t.sentTo || t.from))
      .sort((a, b) => (a.sentAt ?? '').localeCompare(b.sentAt ?? ''));
    const recent = now.getTime() - MAIL_LIMITS.firstDays * 86_400_000;
    const promo = of('promo').filter((t) => Date.parse(t.lastAt) >= recent);
    // カテゴリー（第9.5.1.1.1節）。並べるのは、最近 30 日に動きがあり、2 通以上で、一覧にいま 1 件以上あるもの
    const listed = [...of('reply'), ...of('action'), ...waiting, ...of('read')];
    const counts = new Map<string, number>();
    for (const t of listed) if (t.categoryId) counts.set(t.categoryId, (counts.get(t.categoryId) ?? 0) + 1);
    const chips = visibleCategories(cats, now).filter((c) => counts.has(c.id))
      .map((c) => ({ id: c.id, name: c.name, count: counts.get(c.id)! })).sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
    const shown = new Map(chips.map((c) => [c.id, c.name]));
    return {
      reply: of('reply').sort(byDue).map((t) => this.itemOf(t, shown)),
      action: of('action').sort(byDue).map((t) => this.itemOf(t, shown)),
      waiting: waiting.map((t) => this.itemOf(t, shown)),
      read: of('read').slice(0, 100).map((t) => this.itemOf(t, shown)),
      promo: promo.slice(0, 100).map((t) => this.itemOf(t, shown)),
      promoCount: promo.length,
      categories: chips,
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
    // 秘書への「このメールは〇〇の件」の「このメール」に使う（第9.5.1.1.1節「直し方」）
    await this.setPrefs(o, (p) => ({ ...p, lastOpened: { threadId, at: now.toISOString() } }));
    if (t.state === 'open' && (t.group === 'read' || t.group === 'promo')) {
      // 学び: 届いて 1 時間以内に開いた → その相手は大事
      if (now.getTime() - Date.parse(t.lastAt) <= MAIL_LEARNING.quickOpenMs) await this.learner.behavior(o, t.from, t.subject, 'important', now).catch(() => undefined);
      t = doneRow(t, 'opened', now.toISOString());
      await store.saveThread(o, t);
    }
    const user = await repo.findUserById(o.tenantId, o.userId);
    const me = (user?.email ?? '').toLowerCase();
    let messages: MailThreadDetail['messages'] = [];
    let readError: string | null = null;
    try {
      const got = mail.thread ? await mail.thread(o, threadId, { html: true }) : [];
      messages = got.map((m) => ({
        // HTML は、どの接続口から来ても、画面に渡す前に動くものを外す（画面の切り離した枠と二重の守り）
        id: m.id, from: m.from, at: m.receivedAt, body: m.body, ...(m.html ? { html: sanitizeMailHtml(m.html) } : {}),
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
      item: this.itemOf(t, new Map((await store.categories(o)).map((c) => [c.id, c.name]))), done: t.state === 'done', messages, readError, draft: t.draft, recipients: t.recipients, replySubject: replySubject(t.subject),
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
    if (t.state === 'open') {
      await this.deps.store.saveThread(o, doneRow(t, 'marked', now.toISOString()));
      // 学び: 「返事が要る」を返事せずに済みにした → その相手は返事が要らないことが多い（振り分けの外れ）
      if (t.group === 'reply') await this.learner.behavior(o, t.from, t.subject, 'read', now, true).catch(() => undefined);
    }
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
    // 学び（返事の書き方）: 用意した下書きを大きく短く・長く直して送るなら、その向きを覚える
    if (t.draftState === 'ready' && t.draft) await this.learner.style(o, to[0]!, t.draft, body, new Date()).catch(() => undefined);
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

  /**
   * 本人のカテゴリーの直しを行う（第9.5.1.1.1節「直し方」）。「このメールは新店舗の件」「A と B は同じにして」「採用というカテゴリーを作って」。
   * 付け替えたものは、次の振り分けの例として覚える（学び）。確認は求めない（ADR-0028）。
   *
   * @returns 本人への答え。AI が使えなければ理由
   */
  async categoryRequest(o: MailOwner, request: string, now: Date = new Date()): Promise<{ text: string; tokensUsed: number }> {
    const { store } = this.deps;
    const llm = await this.deps.llmFor(o.tenantId).catch(() => null);
    if (!llm || !aiAvailable(llm)) return { text: 'AI が使えないため、カテゴリーを直せませんでした。', tokensUsed: 0 };
    const [cats, open, prefs] = await Promise.all([store.categories(o), store.openThreads(o), this.prefs(o)]);
    const byId = new Map(cats.map((c) => [c.id, c]));
    const threads = open.filter((t) => t.group !== 'promo').slice(0, 60);
    // 「このメール」は、30 分以内に開いたスレッド
    const current = prefs.lastOpened && now.getTime() - Date.parse(prefs.lastOpened.at) < 30 * 60_000 ? prefs.lastOpened.threadId : null;
    if (current && !threads.some((t) => t.threadId === current)) {
      const t = await store.thread(o, current);
      if (t) threads.unshift(t);
    }
    const { actions, tokensUsed } = await interpretCategoryRequest(llm, request, {
      categories: cats, current,
      threads: threads.map((t) => ({ threadId: t.threadId, from: t.from, subject: t.subject, category: t.categoryId ? byId.get(t.categoryId)?.name ?? '' : '' })),
    });
    const at = now.toISOString();
    const ensure = async (name: string): Promise<MailCategoryRow> => {
      const found = findCategory(cats, name);
      if (found) return found;
      const c = newCategory(name, '', at);
      cats.push(c);
      await store.saveCategory(o, c);
      return c;
    };
    let done = 0;
    for (const name of actions.create) { await ensure(name); done += 1; }
    for (const r of actions.rename) {
      const c = findCategory(cats, r.from);
      if (!c) continue;
      c.name = cleanCategoryName(r.to);
      await store.saveCategory(o, c);
      done += 1;
    }
    for (const m of actions.merge) {
      const from = findCategory(cats, m.from);
      const into = await ensure(m.into);
      if (!from || from.id === into.id) continue;
      await store.deleteCategory(o, from.id, into.id);
      await store.saveCategory(o, { ...into, seen: into.seen + from.seen, lastAt: from.lastAt > into.lastAt ? from.lastAt : into.lastAt, endedAt: null });
      cats.splice(cats.indexOf(from), 1);
      done += 1;
    }
    for (const name of actions.end) {
      const c = findCategory(cats, name);
      if (!c) continue;
      await store.saveCategory(o, { ...c, endedAt: at > c.lastAt ? at : c.lastAt });
      done += 1;
    }
    for (const a of actions.assign) {
      const t = threads.find((x) => x.threadId === a.threadId);
      if (!t) continue;
      let categoryId: string | null = null;
      if (a.category) {
        const c = await ensure(a.category);
        // 本人が付けたものは、そのまま並べる（2 通に満たなくても）。「終わった」ものも並べ直す
        await store.saveCategory(o, { ...c, seen: Math.max(c.seen + (c.id === t.categoryId ? 0 : 1), 2), lastAt: t.lastAt > c.lastAt ? t.lastAt : c.lastAt, endedAt: null });
        categoryId = c.id;
      }
      await store.saveThread(o, { ...t, categoryId });
      // 直しを覚えて、次の振り分けに例として渡す（学び。第9.5.1.1.2節）
      await this.learner.teach(o, 'category', 'from', addressOf(t.from), a.category, now, t.subject);
      done += 1;
    }
    for (const r of actions.rename) await this.learner.renameCategory(o, r.from, cleanCategoryName(r.to));
    for (const m of actions.merge) await this.learner.renameCategory(o, m.from, cleanCategoryName(m.into));
    // 振り分けの直し（第9.5.1.1.2節）。覚えて、いま並んでいるその相手のメールもすぐ分け直す
    for (const x of actions.teach) {
      const t = threads.find((y) => y.threadId === x.threadId);
      if (!t) continue;
      const address = addressOf(t.from);
      const keyValue = x.scope === 'subject' ? subjectTag(t.subject) : x.scope === 'domain' ? domainOfAddress(address) : address;
      if (!keyValue) continue;
      await this.learner.teach(o, 'group', x.scope, keyValue, x.target, now);
      const matches = (row: MailThreadRow) => row.group !== 'waiting' && (x.scope === 'subject' ? subjectTag(row.subject) === keyValue
        : x.scope === 'domain' ? domainOfAddress(addressOf(row.from)) === keyValue : addressOf(row.from) === keyValue);
      for (const row of (await store.openThreads(o)).filter(matches)) {
        const group = x.target === 'important' ? (row.group === 'promo' ? 'read' : row.group) : x.target;
        if (group === row.group) continue;
        await store.saveThread(o, { ...row, group, ...(group === 'reply' ? { draftState: row.draft ? 'ready' : 'pending' } : { draftState: 'none', draft: '' }),
          ...(group === 'promo' ? { categoryId: null } : {}) });
      }
      done += 1;
    }
    if (!done) return { text: actions.reply || 'どのメールのことか分かりませんでした。メールを開いてから「このメールは〇〇の件」と言ってください。', tokensUsed };
    return { text: `${actions.reply || 'カテゴリーを直しました。'}\n\n[メールを開く](/mail)`, tokensUsed };
  }

  /**
   * カテゴリーの名前に合うものがあれば、「もう終わった」にする（「補助金の件はもう終わった」。第9.5.1.1.1節「直し方」）。
   *
   * @returns 終わりにしたカテゴリーの名前。合うものが無ければ `null`（スレッドの「済んだ」として扱う）
   */
  async endCategory(o: MailOwner, words: string, now: Date = new Date()): Promise<string | null> {
    const cats = await this.deps.store.categories(o);
    const c = findCategory(cats, words) ?? cats.find((x) => categoryKey(x.name).includes(categoryKey(words)) && categoryKey(words).length >= 2) ?? null;
    if (!c) return null;
    // 終わったときより後に動きがあれば並べ直すので、終わりの時刻は最後の動きより前にしない
    const at = now.toISOString();
    await this.deps.store.saveCategory(o, { ...c, endedAt: at > c.lastAt ? at : c.lastAt });
    return c.name;
  }

  /**
   * カテゴリーか差出人で絞った一覧（「新店舗の件でメール来てる？」「アルファ商事から何か届いた？」。第9.5.1.1.1節「秘書」）。
   *
   * @returns 合うカテゴリーの名前（無ければ `null`）と、合うメール
   */
  async findByCategory(o: MailOwner, words: string, now: Date = new Date()): Promise<{ category: string | null; items: MailItem[] }> {
    const v = await this.overview(o, now);
    const k = categoryKey(words);
    const cat = v.categories.find((c) => categoryKey(c.name) === k) ?? v.categories.find((c) => k.length >= 2 && (categoryKey(c.name).includes(k) || k.includes(categoryKey(c.name)))) ?? null;
    const all = [...v.reply, ...v.action, ...v.waiting, ...v.read];
    const w = words.toLowerCase();
    const items = cat ? all.filter((t) => t.category?.id === cat.id) : all.filter((t) => t.from.toLowerCase().includes(w) || t.subject.toLowerCase().includes(w));
    return { category: cat?.name ?? null, items };
  }

  /**
   * 覚えていること（第9.5.1.1.2節「見る・直す・消す」）。本人の直しと、傾向になったふるまい（3 回そろったもの）だけを返す。
   */
  async lessonsView(o: MailOwner, now: Date = new Date()): Promise<{ id: string; text: string; source: 'told' | 'behavior'; at: string }[]> {
    return (await this.deps.store.lessons(o)).filter((l) => isActive(l, now))
      .map((l) => ({ id: l.id, text: describeLesson(l), source: l.source, at: l.lastAt }));
  }

  /**
   * 相手の言葉に合う学びを消す（「〇〇さんのことは忘れて」）。差出人のアドレス・名前・ドメイン・件名の形で探す。
   *
   * @returns 消した数（合うものが無ければ 0。ふつうの記憶の「忘れて」として扱う）
   */
  async forgetLessonsAbout(o: MailOwner, words: string): Promise<number> {
    const w = words.toLowerCase().trim();
    if (w.length < 2) return 0;
    const open = await this.deps.store.openThreads(o);
    // 名前で言われたら、一覧の差出人から、そのアドレスを探す
    const addresses = new Set(open.filter((t) => t.from.toLowerCase().includes(w)).map((t) => lessonAddress(t.from)));
    let n = 0;
    for (const l of await this.deps.store.lessons(o)) {
      if (l.keyValue.includes(w) || addresses.has(l.keyValue) || (l.keyType === 'domain' && [...addresses].some((a) => domainOfAddress(a) === l.keyValue))) {
        if (await this.deps.store.deleteLesson(o, l.id)) n += 1;
      }
    }
    return n;
  }

  /** 学びを 1 つ消す（「記憶とデータ」の画面）。 */
  async deleteLesson(o: MailOwner, id: string): Promise<boolean> {
    return this.deps.store.deleteLesson(o, id);
  }

  /** 学びをすべて消す（「記憶とデータ」の「すべて削除」）。 */
  async clearLessons(o: MailOwner): Promise<number> {
    return this.deps.store.clearLessons(o);
  }

  /**
   * 学びの進み具合（今週と先週の、直した回数と振り分けの外れ。週次ブリーフに 1 行で伝える。第9.5.1.1.2節「進み具合」）。
   */
  async learningProgress(o: MailOwner, now: Date = new Date()): Promise<LearningProgress> {
    return learningProgressOf(this.deps.store, o, now);
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
