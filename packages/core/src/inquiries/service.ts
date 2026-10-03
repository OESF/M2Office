/**
 * @file 問い合わせの記録の処理（仕様書 第33章・第33.17節）。残す・続きを足す・一覧・1 件・直す・次にやること・削除。
 *
 * 秘書に話した文や画面の 1 行の欄に書いた文から、AI が項目に分けて残す（{@link readInquiry}）。
 * 前の問い合わせの続き（「田中さんに見積もりを送った」）なら同じ問い合わせに足し、次にやることを閉じる。1 つに決まらなければ候補を返す。
 * 要配慮個人情報は要約にも原文にも残さない。名刺管理が使えれば、同じ人の連絡先とつなぐ。
 *
 * @see 仕様書 第33.17節 段 1 の実装の決まり
 */

import { randomUUID } from 'node:crypto';
import {
  INQUIRIES_EXTENSION_ID, INQUIRY_SOURCE_UNKNOWN, canUseAgent,
  type Inquiry, type InquiryChannel, type InquiryDetail, type InquiryParty, type InquirySettings, type InquiryStatus, type InquiryTask, type InquiryTemperature,
} from '@m2office/shared';
import type { LlmProvider } from '../llm/provider.js';
import type { Repository } from '../repository/types.js';
import { silentLogger, type Logger } from '../log/logger.js';
import { dateIn } from '../cards/service.js';
import type { InquiryContactBook } from './contacts.js';
import { hasSensitive, readInquiry, stripSensitive } from './extract.js';
import type { InquiryPatch, InquiryQuery, InquiryStore } from './store.js';

/** 問い合わせを扱う人。 */
export interface InquiryViewer {
  tenantId: string;
  userId: string;
}

/** 処理が使うもの。 */
export interface InquiryServiceDeps {
  store: InquiryStore;
  repo: Repository;
  /** その会社の推論（会社の AI の方針に従う。問い合わせは会社のデータなので、ローカルを既定の会社ではローカル AI。第33.12節）。 */
  llmFor(tenantId: string): Promise<LlmProvider>;
  /** 名刺管理の連絡先とつなぐ口。無ければつながない。 */
  contacts?: InquiryContactBook | null;
  logger?: Logger;
}

/** 残した結果。 */
export type RecordResult =
  | {
    kind: 'created' | 'appended';
    inquiry: Inquiry;
    /** 新しく足した次にやること。 */
    task: InquiryTask | null;
    /** 済んだことにした次にやること。 */
    closedTask: InquiryTask | null;
    /** 要配慮個人情報が話に出ていた（記録には入れていない）。 */
    sensitive: boolean;
    /** 名刺管理に連絡先を新しく作った。 */
    contactCreated: boolean;
  }
  | { kind: 'ambiguous'; candidates: Inquiry[] }
  | { kind: 'error'; error: string };

/** 書いた文の長さの上限。 */
export const INQUIRY_TEXT_MAX = 4000;

const CHANNELS: InquiryChannel[] = ['phone', 'mail', 'form', 'line', 'visit', 'other'];
const TEMPS: InquiryTemperature[] = ['high', 'normal', 'low'];
const STATUSES: InquiryStatus[] = ['open', 'done', 'dropped'];
const DATE = /^\d{4}-\d{2}-\d{2}$/;

/** 比べる形の言葉（空白と敬称を除く）。 */
const norm = (s: string) => s.replace(/[\s　]/g, '').replace(/(さん|様|さま)$/, '').toLowerCase();

/**
 * 会社が問い合わせの記録を使っていて、利用者が利用範囲の中なら、会社の設定を返す。
 *
 * @returns 使えなければ `null`
 */
export function inquiriesAccess(repo: Repository) {
  return async (tenantId: string, userId: string): Promise<InquirySettings | null> => {
    const settings = await repo.getTenantSettings(tenantId);
    if (!settings.inquiries.enabled) return null;
    const groups = await repo.listUserGroupIds(tenantId, userId);
    if (!canUseAgent(settings.access, INQUIRIES_EXTENSION_ID, userId, groups)) return null;
    return settings.inquiries;
  };
}

/**
 * 問い合わせの記録の操作。
 *
 * @remarks 呼ぶ前に、利用者が使えるかを {@link inquiriesAccess} で確かめること
 */
export class InquiryService {
  private readonly log: Logger;

  constructor(private readonly deps: InquiryServiceDeps) {
    this.log = deps.logger ?? silentLogger;
  }

  /** 置き場（ツールが一覧を読むため）。 */
  get store(): InquiryStore {
    return this.deps.store;
  }

  /** 利用者の名前（ID から）。 */
  private async names(tenantId: string): Promise<Map<string, string>> {
    return new Map((await this.deps.repo.listUsers(tenantId)).map((u) => [u.id, u.displayName || u.email]));
  }

  private named(i: Inquiry, names: Map<string, string>): Inquiry {
    return {
      ...i, receivedByName: names.get(i.receivedBy) ?? '',
      nextTask: i.nextTask ? { ...i.nextTask, assigneeName: names.get(i.nextTask.assignee) ?? '' } : null,
    };
  }

  /** 本人の地域の今日。 */
  private async today(who: InquiryViewer): Promise<string> {
    const prefs = await this.deps.repo.getUserSettings(who.tenantId, who.userId).catch(() => null);
    return dateIn(prefs?.profile.timezone || 'Asia/Tokyo');
  }

  private async audit(who: InquiryViewer, action: string, id: string, detail: Record<string, unknown>): Promise<void> {
    await this.deps.repo.appendAudit({
      id: randomUUID(), tenantId: who.tenantId, actorType: 'user', actorId: who.userId, action, targetType: 'inquiry', targetId: id,
      detail, occurredAt: new Date().toISOString(),
    });
  }

  /**
   * 書いた文から問い合わせを残す。前の問い合わせの続きなら、同じ問い合わせに足す。
   *
   * @param opts.inquiryId 続きを足す問い合わせ（1 件の画面から書いたとき）。無ければ AI が見分ける
   */
  async record(who: InquiryViewer, text: string, opts: { inquiryId?: string } = {}): Promise<RecordResult> {
    const raw = text.trim().slice(0, INQUIRY_TEXT_MAX);
    if (!raw) return { kind: 'error', error: 'どんな問い合わせかを書いてください' };
    const { store } = this.deps;
    const open = await store.list(who.tenantId, { status: 'open', limit: 30 });
    const llm = await this.deps.llmFor(who.tenantId).catch(() => null);
    const draft = await readInquiry(llm, raw, { date: await this.today(who) }, open);
    // 要配慮個人情報が話に出ていたら、原文を残さない（要約からも除いてある。第33.5節）
    const sensitive = draft.sensitive || hasSensitive(raw);
    const body = sensitive ? null : stripSensitive(raw).text || null;
    const summary = draft.summary || '（用件は記録していません）';

    let target: Inquiry | null = null;
    if (opts.inquiryId) {
      target = await store.get(who.tenantId, opts.inquiryId);
      if (!target) return { kind: 'error', error: '問い合わせが見つかりません' };
    } else if (draft.intent === 'followup') {
      target = draft.inquiryId ? await store.get(who.tenantId, draft.inquiryId) : null;
      if (!target) {
        const name = norm(draft.from.name);
        const company = norm(draft.from.company);
        const cands = (name || company) ? open.filter((o) => (name && norm(o.from.name).includes(name)) || (company && norm(o.from.company).includes(company))) : [];
        // 名前がそのまま同じものが 1 つなら、それにする（「田中」と「田中二郎」が並んでも迷わない）
        const exact = name ? cands.filter((o) => norm(o.from.name) === name) : [];
        if (exact.length === 1) target = exact[0]!;
        else if (cands.length > 1) return { kind: 'ambiguous', candidates: cands.slice(0, 8).map((c) => this.named(c, new Map())) };
        else target = cands[0] ?? null;
      }
    }

    if (target) return this.append(who, target, draft, { summary, body, sensitive });

    // 新しい問い合わせ。名刺管理が使えれば、同じ人の連絡先とつなぐ（無ければ作る）
    const linked = draft.from.name || draft.from.email || draft.from.phone
      ? await this.deps.contacts?.link(who, draft.from).catch((err: unknown) => {
        this.log.warn('inquiry.contact_link_failed', { error: err instanceof Error ? err.message : String(err) });
        return null;
      }) ?? null
      : null;
    const id = await store.create(who.tenantId, {
      from: draft.from, contactId: linked?.contactId ?? null, channel: draft.channel, category: draft.category, summary,
      source: draft.source || INQUIRY_SOURCE_UNKNOWN, temperature: draft.temperature, receivedBy: who.userId, createdBy: who.userId,
    });
    await store.addEvent(who.tenantId, id, { direction: draft.direction, channel: draft.channel, summary, body, createdBy: who.userId });
    let task: InquiryTask | null = null;
    if (draft.task) {
      const taskId = await store.addTask(who.tenantId, id, { assignee: who.userId, what: draft.task.what, due: draft.task.due, createdBy: who.userId });
      task = (await store.task(who.tenantId, taskId)) ?? null;
    }
    // 監査ログには、お客様の名前や用件を残さない（経路と、要配慮の情報を除いたかだけ）
    await this.audit(who, 'inquiry.create', id, { channel: draft.channel, sensitiveRemoved: sensitive, contactCreated: !!linked?.created });
    const names = await this.names(who.tenantId);
    const inquiry = (await store.get(who.tenantId, id))!;
    return {
      kind: 'created', inquiry: this.named(inquiry, names), task: task ? { ...task, assigneeName: names.get(task.assignee) ?? '' } : null,
      closedTask: null, sensitive, contactCreated: !!linked?.created,
    };
  }

  /** 前の問い合わせに続きを足す。 */
  private async append(
    who: InquiryViewer, target: Inquiry, draft: Awaited<ReturnType<typeof readInquiry>>, e: { summary: string; body: string | null; sensitive: boolean },
  ): Promise<RecordResult> {
    const { store } = this.deps;
    await store.addEvent(who.tenantId, target.id, { direction: draft.direction, channel: draft.channel, summary: e.summary, body: e.body, createdBy: who.userId });
    let closedTask: InquiryTask | null = null;
    if (draft.closesTask && target.nextTask) {
      await store.updateTask(who.tenantId, target.nextTask.id, { done: true });
      closedTask = target.nextTask;
    }
    let task: InquiryTask | null = null;
    if (draft.task && draft.direction === 'in') {
      const taskId = await store.addTask(who.tenantId, target.id, { assignee: who.userId, what: draft.task.what, due: draft.task.due, createdBy: who.userId });
      task = await store.task(who.tenantId, taskId);
    }
    // 空の項目だけを、新しく分かったことで埋める。お客様からまた届いたら、対応中に戻す
    const from: InquiryParty = {
      name: target.from.name || draft.from.name, company: target.from.company || draft.from.company,
      phone: target.from.phone || draft.from.phone, email: target.from.email || draft.from.email,
    };
    const patch: InquiryPatch = { lastAt: new Date().toISOString(), from, idleNotifiedAt: null };
    if (target.source === INQUIRY_SOURCE_UNKNOWN && draft.source && draft.source !== INQUIRY_SOURCE_UNKNOWN) patch.source = draft.source;
    if (draft.direction === 'in' && target.status !== 'open') patch.status = 'open';
    await store.update(who.tenantId, target.id, patch);
    await this.audit(who, 'inquiry.append', target.id, { channel: draft.channel, direction: draft.direction, sensitiveRemoved: e.sensitive, closedTask: !!closedTask });
    const names = await this.names(who.tenantId);
    return {
      kind: 'appended', inquiry: this.named((await store.get(who.tenantId, target.id))!, names),
      task: task ? { ...task, assigneeName: names.get(task.assignee) ?? '' } : null, closedTask, sensitive: e.sensitive, contactCreated: false,
    };
  }

  /** 一覧（対応中を先に、次にやることの期限が近い順、その後に新しい順）。 */
  async list(who: InquiryViewer, q: InquiryQuery = {}): Promise<Inquiry[]> {
    const names = await this.names(who.tenantId);
    return (await this.deps.store.list(who.tenantId, q)).map((i) => this.named(i, names));
  }

  /** 1 件と、会話の履歴と、次にやること。見つからなければ `null`。 */
  async detail(who: InquiryViewer, id: string): Promise<InquiryDetail | null> {
    const { store } = this.deps;
    const inquiry = await store.get(who.tenantId, id);
    if (!inquiry) return null;
    const names = await this.names(who.tenantId);
    const [events, tasks] = await Promise.all([store.events(who.tenantId, id), store.tasks(who.tenantId, id)]);
    return {
      inquiry: this.named(inquiry, names),
      events: events.map((e) => ({ ...e, createdByName: names.get(e.createdBy) ?? '' })),
      tasks: tasks.map((t) => ({ ...t, assigneeName: names.get(t.assignee) ?? '' })),
    };
  }

  /**
   * 項目を直す（画面のその場の直し）。
   *
   * @returns 直せなければ理由
   */
  async update(who: InquiryViewer, id: string, input: Partial<{
    from: Partial<InquiryParty>; channel: string; category: string; summary: string; source: string; temperature: string; status: string;
  }>): Promise<string | null> {
    const { store } = this.deps;
    const cur = await store.get(who.tenantId, id);
    if (!cur) return '問い合わせが見つかりません';
    const patch: InquiryPatch = {};
    const text = (v: unknown, max: number) => (typeof v === 'string' ? v.trim().slice(0, max) : undefined);
    if (input.from) {
      const f = input.from;
      patch.from = {
        name: text(f.name, 80) ?? cur.from.name, company: text(f.company, 120) ?? cur.from.company,
        phone: text(f.phone, 40) ?? cur.from.phone, email: text(f.email, 200) ?? cur.from.email,
      };
    }
    if (input.channel !== undefined) {
      if (!CHANNELS.includes(input.channel as InquiryChannel)) return '経路が読めません';
      patch.channel = input.channel as InquiryChannel;
    }
    if (input.temperature !== undefined) {
      if (!TEMPS.includes(input.temperature as InquiryTemperature)) return '温度感が読めません';
      patch.temperature = input.temperature as InquiryTemperature;
    }
    if (input.status !== undefined) {
      if (!STATUSES.includes(input.status as InquiryStatus)) return '状態が読めません';
      patch.status = input.status as InquiryStatus;
    }
    if (input.category !== undefined) patch.category = text(input.category, 40) ?? cur.category;
    if (input.source !== undefined) patch.source = text(input.source, 40) || INQUIRY_SOURCE_UNKNOWN;
    if (input.summary !== undefined) {
      // 人が直した用件でも、要配慮個人情報は残さない
      const s = stripSensitive(text(input.summary, 400) ?? '');
      patch.summary = s.text || cur.summary;
    }
    if (Object.keys(patch).length === 0) return null;
    await store.update(who.tenantId, id, patch);
    // 名刺管理とまだつながっていなければ、直した名前・連絡先でつなぐ
    if (patch.from && !cur.contactId && this.deps.contacts) {
      const linked = await this.deps.contacts.link(who, patch.from).catch(() => null);
      if (linked) await store.update(who.tenantId, id, { contactId: linked.contactId });
    }
    await this.audit(who, 'inquiry.update', id, { fields: Object.keys(patch) });
    return null;
  }

  /**
   * 次にやることを足す。
   *
   * @returns 足せなければ理由
   */
  async addTask(who: InquiryViewer, id: string, input: { what: string; due?: string | null; assignee?: string }): Promise<string | null> {
    const { store } = this.deps;
    if (!(await store.get(who.tenantId, id))) return '問い合わせが見つかりません';
    const what = stripSensitive(input.what.trim().slice(0, 120)).text;
    if (!what) return '次にやることを書いてください';
    if (input.due && !DATE.test(input.due)) return '期限は日付で入れてください';
    const assignee = input.assignee ?? who.userId;
    if (!(await this.activeUser(who.tenantId, assignee))) return '担当の人が見つかりません';
    await store.addTask(who.tenantId, id, { assignee, what, due: input.due || null, createdBy: who.userId });
    await store.update(who.tenantId, id, { idleNotifiedAt: null });
    await this.audit(who, 'inquiry.task_add', id, {});
    return null;
  }

  /**
   * 次にやることを直す・済んだことにする。
   *
   * @returns 直せなければ理由
   */
  async updateTask(who: InquiryViewer, taskId: string, input: Partial<{ what: string; due: string | null; assignee: string; done: boolean }>): Promise<string | null> {
    const { store } = this.deps;
    const t = await store.task(who.tenantId, taskId);
    if (!t) return '次にやることが見つかりません';
    if (input.due && !DATE.test(input.due)) return '期限は日付で入れてください';
    if (input.assignee !== undefined && !(await this.activeUser(who.tenantId, input.assignee))) return '担当の人が見つかりません';
    const what = input.what !== undefined ? stripSensitive(input.what.trim().slice(0, 120)).text : undefined;
    if (what === '') return '次にやることを書いてください';
    await store.updateTask(who.tenantId, taskId, {
      ...(what !== undefined ? { what } : {}), ...(input.due !== undefined ? { due: input.due || null } : {}),
      ...(input.assignee !== undefined ? { assignee: input.assignee } : {}), ...(input.done !== undefined ? { done: input.done } : {}),
    });
    await store.update(who.tenantId, t.inquiryId, { lastAt: new Date().toISOString() });
    await this.audit(who, input.done ? 'inquiry.task_done' : 'inquiry.task_update', t.inquiryId, {});
    return null;
  }

  /**
   * 削除する。残した本人と管理者だけ（会社で共有のため、ほかの人の記録を消させない）。
   *
   * @returns 削除できなければ理由
   */
  async remove(who: InquiryViewer, id: string): Promise<string | null> {
    const cur = await this.deps.store.get(who.tenantId, id);
    if (!cur) return '問い合わせが見つかりません';
    const user = await this.deps.repo.findUserById(who.tenantId, who.userId);
    if (cur.createdBy !== who.userId && !user?.roles.includes('admin')) return '削除できるのは、残した人と管理者だけです';
    await this.deps.store.delete(who.tenantId, id);
    await this.audit(who, 'inquiry.delete', id, {});
    return null;
  }

  private async activeUser(tenantId: string, userId: string): Promise<boolean> {
    const u = await this.deps.repo.findUserById(tenantId, userId);
    return !!u && u.status === 'active';
  }
}
