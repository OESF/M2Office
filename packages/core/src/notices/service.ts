/**
 * @file 社内のお知らせの処理（仕様書 第10.15節、ADR-0047）。出す・取り下げる・済んだ・本人宛てのものを並べる。
 *
 * 画面の API・秘書・朝のブリーフのツール（`notices.list`）が同じものを使う（第13.1節 A-2）。
 */

import { randomUUID } from 'node:crypto';
import { NOTICE_DEFAULT_DAYS, type Notice, type NoticeForUser } from '@m2office/shared';
import type { Repository } from '../repository/types.js';
import type { WorkspaceConnector } from '../connectors/types.js';
import { groupEmails, reachNotes, resolveGroupSpace } from '../chat/group-share.js';
import type { NoticeStore } from './store.js';

/** 出すときの入力。 */
export interface NoticeInput {
  title: string;
  body?: string;
  link?: string;
  /** 全員宛てか。`false` なら `groupIds` が要る。 */
  all: boolean;
  groupIds?: string[];
  /** 締切（`YYYY-MM-DD`）。 */
  dueOn?: string | null;
  /** 載せる最後の日（`YYYY-MM-DD`）。省けば締切の日、締切も無ければ出した日から 14 日。 */
  until?: string | null;
  /** 外部のアプリが出すときの、出した人の名前（「外部のアプリ（名前）」）。利用者が出すときは使わない。 */
  authorName?: string;
}

/** 題名・本文・リンクの長さの上限。 */
export const NOTICE_LIMITS = { title: 60, body: 1000, link: 500 } as const;

type Deps = {
  store: NoticeStore;
  repo: Pick<Repository, 'listGroups' | 'listUserGroupIds' | 'findUserById' | 'getUserSettings' | 'appendAudit'>
    & Partial<Pick<Repository, 'listUsers' | 'createNotification'>>;
  /**
   * Chat への投稿（第10.15.1節、ADR-0080）。出した人の Google で、宛先に合うスペースへ 1 回投稿する。
   * 無ければ投稿しない（ブリーフと通知で届く）。
   */
  chat?: { connector: WorkspaceConnector; repo: Repository };
};

/** 済んだ人の数と、済んでいない人（締切を過ぎてから出した人と管理者にだけ。第10.15.1節）。 */
export interface NoticeProgress {
  notice: Notice;
  total: number;
  done: number;
  /** 済んでいない人の名前。見せられないときは `null`（締切の前・出した人でも管理者でもない）。 */
  notDone: string[] | null;
  /** 締切を過ぎたか。 */
  overdue: boolean;
}

/** `YYYY-MM-DD` として正しい日付か。 */
function isDay(v: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(v)) return false;
  const d = new Date(`${v}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === v;
}

/** 日付に日数を足す。 */
export function addDays(day: string, days: number): string {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** `from` から `to` まで何日か（同じ日は 0）。 */
export function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);
}

/** その地域の今日（`YYYY-MM-DD`）。 */
export function todayIn(timezone: string, now: Date = new Date()): string {
  return new Intl.DateTimeFormat('sv-SE', { timeZone: timezone || 'Asia/Tokyo' }).format(now);
}

/**
 * お知らせの処理。
 *
 * @remarks どの操作も会社で絞る（不変則 I-2）。承認は挟まない（社内だけのもの。第10.15節）
 */
export class NoticeService {
  constructor(private readonly deps: Deps) {}

  /** 本人の地域の今日。 */
  private async today(tenantId: string, userId: string, now: Date): Promise<string> {
    const prefs = await this.deps.repo.getUserSettings(tenantId, userId);
    return todayIn(prefs.profile.timezone, now);
  }

  /**
   * 会社の有効なお知らせ（宛先を問わない）。取り下げの候補に使う。
   *
   * @remarks 取り下げられるかは {@link withdraw} が確かめる。画面の一覧には使わない（宛先の外の人に中身を見せないため）
   */
  async active(tenantId: string, userId: string, now: Date = new Date()): Promise<Notice[]> {
    return this.deps.store.listActive(tenantId, await this.today(tenantId, userId, now));
  }

  /**
   * 本人宛ての有効なお知らせ（済んだものを除く）。新しい順。
   *
   * @param options.markShown 朝のブリーフに載せたとして記録するか（ツール `notices.list` だけが使う）
   */
  async forUser(
    tenantId: string, userId: string, now: Date = new Date(), options: { markShown?: boolean } = {},
  ): Promise<NoticeForUser[]> {
    const today = await this.today(tenantId, userId, now);
    const [active, groups] = await Promise.all([
      this.deps.store.listActive(tenantId, today),
      this.deps.repo.listUserGroupIds(tenantId, userId),
    ]);
    const mine = active.filter((n) => n.audience.all || n.audience.groupIds.some((g) => groups.includes(g)));
    const receipts = new Map((await this.deps.store.receipts(tenantId, userId, mine.map((n) => n.id))).map((r) => [r.noticeId, r]));
    const out = mine
      .filter((n) => !receipts.get(n.id)?.doneAt)
      .map((n): NoticeForUser => ({
        ...n,
        isNew: !receipts.get(n.id)?.firstShownAt,
        daysLeft: n.dueOn ? daysBetween(today, n.dueOn) : null,
      }));
    if (options.markShown) {
      await this.deps.store.markShown(tenantId, userId, out.filter((n) => n.isNew).map((n) => n.id), now.toISOString());
    }
    return out;
  }

  /**
   * お知らせを出す。
   *
   * @returns 出したもの。入力が正しくなければ理由
   * @remarks 出せるのは会社の全員（第10.15節）。宛先のグループはその会社のものに限る。
   * 外部のアプリ（`app:<アプリ>`）が出すときは、Chat には投稿しない（Chat への投稿は出した人の Google で行うため。第13.4.2節）
   */
  async create(
    tenantId: string, authorId: string, input: NoticeInput, now: Date = new Date(),
  ): Promise<{ notice: Notice } | { error: string }> {
    const title = (input.title ?? '').trim();
    const body = (input.body ?? '').trim();
    const link = (input.link ?? '').trim();
    if (!title) return { error: '題名が要ります' };
    if (title.length > NOTICE_LIMITS.title) return { error: `題名は ${NOTICE_LIMITS.title} 字までにしてください` };
    if (body.length > NOTICE_LIMITS.body) return { error: `本文は ${NOTICE_LIMITS.body} 字までにしてください` };
    if (link && (!/^https:\/\/\S+$/.test(link) || link.length > NOTICE_LIMITS.link)) return { error: 'リンクは https で始まるものだけを受け付けます' };
    const known = new Set((await this.deps.repo.listGroups(tenantId)).map((g) => g.id));
    const groupIds = [...new Set(input.groupIds ?? [])];
    if (!input.all) {
      if (groupIds.length === 0) return { error: '宛先（全員かグループ）が要ります' };
      if (groupIds.some((g) => !known.has(g))) return { error: '宛先のグループが見つかりません' };
    }
    const today = await this.today(tenantId, authorId, now);
    const dueOn = input.dueOn?.trim() || null;
    if (dueOn && !isDay(dueOn)) return { error: '締切の日付が正しくありません' };
    if (dueOn && dueOn < today) return { error: '締切が過ぎています' };
    const until = input.until?.trim() || dueOn || addDays(today, NOTICE_DEFAULT_DAYS);
    if (!isDay(until)) return { error: '載せる期間の日付が正しくありません' };
    if (until < today) return { error: '載せる期間が過ぎています' };
    const byApp = authorId.startsWith('app:');
    const author = byApp ? null : await this.deps.repo.findUserById(tenantId, authorId);
    const notice: Notice = {
      id: randomUUID(), tenantId, authorId, authorName: author?.displayName ?? (byApp ? (input.authorName ?? '外部のアプリ') : ''), title, body, link,
      audience: { all: !!input.all, groupIds: input.all ? [] : groupIds },
      dueOn, until, createdAt: now.toISOString(), withdrawnAt: null, withdrawnBy: null,
    };
    await this.deps.store.create(notice);
    await this.deps.repo.appendAudit({
      id: randomUUID(), tenantId, actorType: byApp ? 'api_client' : 'user', actorId: authorId, action: 'notice.create',
      targetType: 'notice', targetId: notice.id,
      detail: { title, all: notice.audience.all, groups: notice.audience.groupIds.length, dueOn, until }, occurredAt: notice.createdAt,
    });
    // 宛先に合う Chat のスペースにも 1 回投稿する（第10.15.1節）。待たせない。投稿できなくてもブリーフと通知で届く
    if (this.deps.chat && !byApp) void this.postToChat(tenantId, notice).catch(() => undefined);
    return { notice };
  }

  /**
   * 取り下げる。出した人と管理者だけ（第10.15節）。
   *
   * @remarks 見つからない・取り下げられない理由を返す。ほかの会社のものは「見つからない」
   */
  async withdraw(
    tenantId: string, userId: string, id: string, now: Date = new Date(),
  ): Promise<{ notice: Notice } | { error: string; status: 403 | 404 }> {
    const notice = await this.deps.store.get(tenantId, id);
    if (!notice || notice.withdrawnAt) return { error: 'お知らせが見つかりません', status: 404 };
    const user = await this.deps.repo.findUserById(tenantId, userId);
    if (notice.authorId !== userId && !user?.roles.includes('admin')) {
      return { error: '取り下げられるのは、出した人と管理者だけです', status: 403 };
    }
    const at = now.toISOString();
    await this.deps.store.withdraw(tenantId, id, userId, at);
    await this.deps.repo.appendAudit({
      id: randomUUID(), tenantId, actorType: userId.startsWith('app:') ? 'api_client' : 'user', actorId: userId, action: 'notice.withdraw',
      targetType: 'notice', targetId: id, detail: { title: notice.title }, occurredAt: at,
    });
    return { notice };
  }

  /**
   * お知らせの宛先の人（利用中の人だけ）。
   *
   * @remarks 全員宛てなら会社の利用中の人、グループ宛てならそのどれかのグループに入っている人
   */
  async recipients(tenantId: string, notice: Notice): Promise<{ id: string; name: string }[]> {
    if (!this.deps.repo.listUsers) return [];
    const users = (await this.deps.repo.listUsers(tenantId)).filter((u) => u.status === 'active');
    if (notice.audience.all) return users.map((u) => ({ id: u.id, name: u.displayName }));
    const members = new Set((await this.deps.repo.listGroups(tenantId)).filter((g) => notice.audience.groupIds.includes(g.id)).flatMap((g) => g.memberIds));
    return users.filter((u) => members.has(u.id)).map((u) => ({ id: u.id, name: u.displayName }));
  }

  /**
   * 済んだ人の数（出した人と管理者）。済んでいない人の名前は、締切を過ぎてから見せる（第10.15.1節）。
   *
   * @returns 見つからない・見せられない理由
   */
  async progress(tenantId: string, userId: string, id: string, now: Date = new Date()): Promise<NoticeProgress | { error: string }> {
    const notice = await this.deps.store.get(tenantId, id);
    if (!notice || notice.withdrawnAt) return { error: 'お知らせが見つかりません' };
    const user = await this.deps.repo.findUserById(tenantId, userId);
    const admin = !!user?.roles.includes('admin');
    if (notice.authorId !== userId && !admin) return { error: '済んだ人の数は、出した人と管理者が見られます' };
    const [people, states] = await Promise.all([this.recipients(tenantId, notice), this.deps.store.states(tenantId, id)]);
    const done = new Set(states.filter((s) => s.doneAt).map((s) => s.userId));
    const today = await this.today(tenantId, userId, now);
    const overdue = !!notice.dueOn && today > notice.dueOn;
    return {
      notice, total: people.length, done: people.filter((p) => done.has(p.id)).length, overdue,
      notDone: overdue ? people.filter((p) => !done.has(p.id)).map((p) => p.name) : null,
    };
  }

  /** 本人が「このお知らせはもう知らせないで」と言った。締切の前の知らせを止める（済んだとは数えない）。 */
  async mute(tenantId: string, userId: string, id: string, now: Date = new Date()): Promise<{ notice: Notice } | { error: string }> {
    const mine = await this.forUser(tenantId, userId, now);
    const notice = mine.find((n) => n.id === id);
    if (!notice) return { error: 'お知らせが見つかりません' };
    await this.deps.store.markMuted(tenantId, userId, id, now.toISOString());
    return { notice };
  }

  /**
   * 締切の前の知らせ（3 日前と当日の朝 8 時から。第10.15.1節）。まだ済んでいない・止めていない宛先の人へ、画面の通知を 1 回ずつ届ける。
   * ワーカーが 1 時間ごとに呼ぶ。
   *
   * @returns 届けた数
   */
  async remind(tenantId: string, now: Date = new Date()): Promise<number> {
    if (!this.deps.repo.createNotification || !this.deps.repo.listUsers) return 0;
    const jst = new Date(now.getTime() + 9 * 3_600_000);
    if (jst.getUTCHours() < 8) return 0;
    const today = jst.toISOString().slice(0, 10);
    let sent = 0;
    for (const notice of await this.deps.store.listActive(tenantId, today)) {
      if (!notice.dueOn) continue;
      const left = daysBetween(today, notice.dueOn);
      const stage = left === 3 ? 'before' : left === 0 ? 'due' : null;
      if (!stage) continue;
      const states = new Map((await this.deps.store.states(tenantId, notice.id)).map((s) => [s.userId, s]));
      for (const p of await this.recipients(tenantId, notice)) {
        const s = states.get(p.id);
        if (s?.doneAt || s?.mutedAt) continue;
        if (!(await this.deps.store.markReminded(tenantId, p.id, notice.id, stage, now.toISOString()))) continue;
        await this.deps.repo.createNotification({
          id: randomUUID(), tenantId, userId: p.id, kind: 'notice',
          title: stage === 'before' ? `「${notice.title}」の締切まで 3 日です` : `「${notice.title}」の締切は今日です`,
          body: `${notice.authorName ? `${notice.authorName}さんからのお知らせです。` : ''}済んだら秘書に「済んだ」と伝えてください。`,
          runId: null, readAt: null, createdAt: now.toISOString(),
        });
        sent++;
      }
    }
    return sent;
  }

  /**
   * 宛先に合う Chat のスペースへ、出した人として題名・締切・リンクを 1 回投稿する（第10.15.1節、ADR-0080）。
   *
   * @remarks 危険度: 社内への送信。**メンバーを確かめ、会社の外の人と Google のグループがいないと分かったときだけ投稿する**
   * （確かめられなければ投稿しない。承認を求めずに、ブリーフと通知で届ける。第9.4.0節）。合うスペースが 1 つに決まらなければ投稿しない
   * @returns 投稿したスペースの名前。しなければ理由
   */
  async postToChat(tenantId: string, notice: Notice): Promise<{ space: string } | { skipped: string }> {
    const chat = this.deps.chat;
    if (!chat) return { skipped: 'Chat につないでいません' };
    const p = { tenantId, userId: notice.authorId };
    const deps = { repo: chat.repo, connector: chat.connector };
    try {
      let target: { space: string; name: string; external: boolean; group: { group: import('@m2office/shared').UserGroup; by: 'name' | 'members' | 'told'; emails: string[] } | null } | null = null;
      if (notice.audience.all) {
        // 会社の全員が入っているスペースが 1 つに決まればそこ
        const users = (await chat.repo.listUsers(tenantId)).filter((u) => u.status === 'active');
        const emails: string[] = [];
        for (const u of users) emails.push(((await chat.repo.getGoogleConnection(tenantId, u.id).catch(() => null))?.googleEmail ?? u.email).toLowerCase());
        const hits: { space: string; displayName: string; external: boolean }[] = [];
        for (const s of (await chat.connector.chat.listSpaces(p)).slice(0, 15)) {
          const m = await chat.connector.chat.members(p, s.space, emails).catch(() => null);
          if (m && m.present.length === emails.length) hits.push(s);
        }
        if (hits.length !== 1) return { skipped: hits.length ? '会社の全員が入っているスペースが 1 つに決まりません' : '会社の全員が入っているスペースがありません' };
        target = { space: hits[0]!.space, name: hits[0]!.displayName, external: hits[0]!.external, group: null };
      } else {
        if (notice.audience.groupIds.length !== 1) return { skipped: '宛先のグループが 2 つ以上あります' };
        const group = (await chat.repo.listGroups(tenantId)).find((g) => g.id === notice.audience.groupIds[0]);
        if (!group) return { skipped: '宛先のグループが見つかりません' };
        const r = await resolveGroupSpace(deps, p, group.name);
        if (r.kind === 'problem') return { skipped: r.reason };
        if (r.kind === 'found') target = { space: r.space, name: r.name, external: r.external, group: { group: r.group, by: r.by, emails: r.emails } };
        else {
          // グループと同じ名前のスペースがある
          const f = await chat.connector.chat.findSpace(p, group.name);
          if ('reason' in f) return { skipped: f.reason };
          target = { space: f.space, name: f.displayName ?? group.name, external: f.external !== false, group: { group, by: 'name', emails: await groupEmails(chat.repo, tenantId, group) } };
        }
      }
      if (!target) return { skipped: '合うスペースがありません' };
      const reach = await reachNotes(deps, p, target.space, target.group);
      if (target.external || !reach.internalOnly) return { skipped: '社内の人だけのスペースだと確かめられませんでした' };
      if (!(await this.deps.store.markChatPosted(tenantId, notice.id, target.name))) return { skipped: 'すでに投稿しています' };
      const due = notice.dueOn ? `（締切 ${Number(notice.dueOn.slice(5, 7))}/${Number(notice.dueOn.slice(8, 10))}）` : '';
      const text = [`【お知らせ】${notice.title}${due}`, notice.link, notice.authorName ? `${notice.authorName} より` : ''].filter(Boolean).join('\n');
      await chat.connector.chat.post(p, { space: target.space, text });
      await this.deps.repo.appendAudit({
        id: randomUUID(), tenantId, actorType: 'user', actorId: notice.authorId, action: 'notice.chat_post',
        targetType: 'notice', targetId: notice.id, detail: { space: target.name }, occurredAt: new Date().toISOString(),
      });
      return { space: target.name };
    } catch (err) {
      return { skipped: err instanceof Error ? err.message : 'Chat に投稿できませんでした' };
    }
  }

  /** 本人が済んだとする。本人宛てでなければ「見つからない」。 */
  async done(tenantId: string, userId: string, id: string, now: Date = new Date()): Promise<{ notice: Notice } | { error: string }> {
    const mine = await this.forUser(tenantId, userId, now);
    const notice = mine.find((n) => n.id === id);
    if (!notice) return { error: 'お知らせが見つかりません' };
    await this.deps.store.markDone(tenantId, userId, id, now.toISOString());
    return { notice };
  }
}
