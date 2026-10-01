/**
 * @file 社内のお知らせの処理（仕様書 第10.15節、ADR-0047）。出す・取り下げる・済んだ・本人宛てのものを並べる。
 *
 * 画面の API・秘書・朝のブリーフのツール（`notices.list`）が同じものを使う（第13.1節 A-2）。
 */

import { randomUUID } from 'node:crypto';
import { NOTICE_DEFAULT_DAYS, type Notice, type NoticeForUser } from '@m2office/shared';
import type { Repository } from '../repository/types.js';
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
}

/** 題名・本文・リンクの長さの上限。 */
export const NOTICE_LIMITS = { title: 60, body: 1000, link: 500 } as const;

type Deps = {
  store: NoticeStore;
  repo: Pick<Repository, 'listGroups' | 'listUserGroupIds' | 'findUserById' | 'getUserSettings' | 'appendAudit'>;
};

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
   * @remarks 出せるのは会社の全員（第10.15節）。宛先のグループはその会社のものに限る
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
    const author = await this.deps.repo.findUserById(tenantId, authorId);
    const notice: Notice = {
      id: randomUUID(), tenantId, authorId, authorName: author?.displayName ?? '', title, body, link,
      audience: { all: !!input.all, groupIds: input.all ? [] : groupIds },
      dueOn, until, createdAt: now.toISOString(), withdrawnAt: null, withdrawnBy: null,
    };
    await this.deps.store.create(notice);
    await this.deps.repo.appendAudit({
      id: randomUUID(), tenantId, actorType: 'user', actorId: authorId, action: 'notice.create',
      targetType: 'notice', targetId: notice.id,
      detail: { title, all: notice.audience.all, groups: notice.audience.groupIds.length, dueOn, until }, occurredAt: notice.createdAt,
    });
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
      id: randomUUID(), tenantId, actorType: 'user', actorId: userId, action: 'notice.withdraw',
      targetType: 'notice', targetId: id, detail: { title: notice.title }, occurredAt: at,
    });
    return { notice };
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
