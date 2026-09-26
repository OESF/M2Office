/**
 * @file 秘書の先回りの見回り（会議の直前の準備・前日の移動の知らせ。仕様書 第10.12節、ADR-0036）。
 *
 * ワーカーの中から 10 分ごとに呼ぶ。Google と接続した人の予定を見て、要るときだけ業務を起こす。
 * 起こした実行は秘書が起こしたもの（`origin: 'secretary'`）として、調べものと同じ経路で本人に届く（第10.11.7節）。
 */

import type { AgentDefinition } from '@m2office/shared';
import type { Repository } from '../repository/types.js';
import type { CalendarEvent, WorkspaceConnector } from '../connectors/types.js';
import { enqueueJob } from '../engine/enqueue.js';
import { silentLogger, type Logger } from '../log/logger.js';

/** 会議の準備を起こす窓（会議の何分前から何分前まで）。見回りの間隔（10 分）より広く取り、取りこぼさない。 */
export const PREP_WINDOW_MIN = { from: 20, to: 60 };

/** 前日の移動の知らせを起こす時刻（本人の地域の時）。この時刻以降に 1 回。 */
export const TRAVEL_NOTICE_HOUR = 17;

/** 秘書が先回りして起こしたことを示す入力の印。届けるときの言い方を変える。 */
export const PROACTIVE_TRIGGER = '先回り';

/** 前日の移動の知らせの依頼の書き出し。二重に起こさないための見分けにも使う。 */
export const TRAVEL_PREFIX = '【明日の移動】';

export interface ProactiveDeps {
  repo: Repository;
  connector: WorkspaceConnector;
  /** 本人が使える業務（利用範囲の内。会社が止めたものは呼び出し側で除かなくてよい）。 */
  agentsFor(tenantId: string, userId: string): Promise<AgentDefinition[]>;
  logger?: Logger;
}

/** オンライン会議の場所（リンクだけのもの）。移動の知らせにしない。 */
const ONLINE = /^https?:\/\/|meet\.google\.com|zoom\.us|teams\.microsoft|webex|オンライン|online/i;

/**
 * 秘書の先回りの見回り役。
 *
 * @remarks
 * - **見本の接続口の会社では行わない**（見本の予定で毎日業務を動かさない。第10.12節）
 * - 秘書の積極性が「控えめ」の人、止めた・使えない業務は使わない
 * - 同じ会議・同じ日の移動は、起こしたものの入力で見分け、二度起こさない
 * - 予定が読めなかった人（接続が切れた・許可が足りない）は飛ばす。見回り全体は止めない
 */
export class ProactiveWatcher {
  private readonly log: Logger;

  constructor(private readonly deps: ProactiveDeps) {
    this.log = deps.logger ?? silentLogger;
  }

  /**
   * 見回る。
   *
   * @returns 起こした実行の ID
   */
  async tick(now: Date = new Date()): Promise<string[]> {
    const { repo, connector } = this.deps;
    const started: string[] = [];
    for (const tenantId of await repo.listTenantIds()) {
      if (connector.sourceFor(tenantId) !== 'google') continue;
      try {
        const [settings, conns, users] = await Promise.all([
          repo.getTenantSettings(tenantId), repo.listGoogleConnections(tenantId), repo.listUsers(tenantId),
        ]);
        for (const conn of conns) {
          const user = users.find((u) => u.id === conn.userId);
          if (!user || user.status !== 'active') continue;
          try {
            started.push(...await this.forUser(tenantId, user, settings.agents.disabled, now));
          } catch (err) {
            this.log.debug('先回りの見回りで、この人の予定を読めませんでした', { tenantId, userId: user.id, err });
          }
        }
      } catch (err) {
        this.log.warn('先回りの見回りに失敗しました', { tenantId, err });
      }
    }
    return started;
  }

  private async forUser(
    tenantId: string, user: { id: string; email: string }, disabled: string[], now: Date,
  ): Promise<string[]> {
    const { repo, connector } = this.deps;
    const prefs = await repo.getUserSettings(tenantId, user.id);
    if (prefs.secretary.proactivity === 'low') return [];
    const agents = (await this.deps.agentsFor(tenantId, user.id)).filter((a) => !disabled.includes(a.id));
    const prep = agents.find((a) => a.id === 'meeting-prep');
    const lookup = agents.find((a) => a.id === 'secretary-lookup');
    if (!prep && !lookup) return [];
    const tz = prefs.profile.timezone || 'Asia/Tokyo';
    const p = { tenantId, userId: user.id };
    const recent = await repo.listRunsWithJobs(tenantId, { limit: 50, requestedBy: user.id });
    const started: string[] = [];

    // 会議の直前の準備（20〜60 分前）
    if (prep) {
      const events = await connector.calendar.list(p, {
        from: now.toISOString(), to: new Date(now.getTime() + PREP_WINDOW_MIN.to * 60_000).toISOString(),
      });
      for (const e of events.filter((x) => isMeetingSoon(x, user.email, now))) {
        const meeting = meetingKey(e, tz);
        if (recent.some(({ job }) => job.agentId === prep.id && job.input['meeting'] === meeting)) continue;
        const { runId } = await enqueueJob(repo, {
          tenantId, requestedBy: user.id, def: prep, input: { meeting, trigger: PROACTIVE_TRIGGER },
          origin: 'secretary', actor: { type: 'system', id: 'secretary-proactive' },
        });
        started.push(runId);
      }
    }

    // 前日の移動の知らせ（17 時以降に 1 回）
    if (lookup && hourIn(now, tz) >= TRAVEL_NOTICE_HOUR) {
      const tomorrow = dateIn(new Date(now.getTime() + 86_400_000), tz);
      const head = `${TRAVEL_PREFIX}${mdOf(tomorrow)}`;
      const done = recent.some(({ job }) => job.agentId === lookup.id && String(job.input['request'] ?? '').startsWith(head));
      if (!done) {
        const events = await connector.calendar.list(p, {
          from: now.toISOString(), to: new Date(now.getTime() + 48 * 3_600_000).toISOString(),
        });
        const going = events.filter((e) => !e.allDay && dateIn(new Date(e.start), tz) === tomorrow && hasPlace(e));
        if (going.length > 0) {
          // 検索に渡りうるため、予定の題名・参加者は書かない。時刻と場所だけ（第10.12節）
          const request = [
            `${head}（${weekdayOf(tomorrow)}）の次の予定に間に合う出発時刻と行き方を、自宅か勤務地から教えてください。`,
            ...going.map((e) => `- ${hmIn(new Date(e.start), tz)}〜 ${e.location}`),
          ].join('\n');
          const { runId } = await enqueueJob(repo, {
            tenantId, requestedBy: user.id, def: lookup, input: { request, trigger: PROACTIVE_TRIGGER },
            origin: 'secretary', actor: { type: 'system', id: 'secretary-proactive' },
          });
          started.push(runId);
        }
      }
    }
    return started;
  }
}

/** ほかの人のいる会議が、20〜60 分後に始まるか。終日の予定は除く。 */
export function isMeetingSoon(e: CalendarEvent, selfEmail: string, now: Date): boolean {
  if (e.allDay) return false;
  const others = e.attendees.filter((a) => a.toLowerCase() !== selfEmail.toLowerCase());
  const minutes = (Date.parse(e.start) - now.getTime()) / 60_000;
  return others.length > 0 && minutes >= PREP_WINDOW_MIN.from && minutes <= PREP_WINDOW_MIN.to;
}

/** 会場や住所の入った予定か（オンライン会議を除く）。 */
export function hasPlace(e: CalendarEvent): boolean {
  const loc = e.location?.trim() ?? '';
  return loc !== '' && !ONLINE.test(loc);
}

/** 会議の準備の入力。題名と日時で、同じ会議を見分ける。 */
export function meetingKey(e: CalendarEvent, tz: string): string {
  const d = new Date(e.start);
  return `${e.title}（${dateIn(d, tz)} ${hmIn(d, tz)}）`;
}

const dateIn = (d: Date, tz: string) => new Intl.DateTimeFormat('sv-SE', { timeZone: tz }).format(d);
const hmIn = (d: Date, tz: string) =>
  new Intl.DateTimeFormat('ja-JP', { timeZone: tz, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(d);
const hourIn = (d: Date, tz: string) =>
  Number(new Intl.DateTimeFormat('en-US', { timeZone: tz, hour: 'numeric', hourCycle: 'h23' }).format(d));
const mdOf = (date: string) => `${Number(date.slice(5, 7))}/${Number(date.slice(8, 10))}`;
const weekdayOf = (date: string) => '日月火水木金土'[new Date(`${date}T12:00:00Z`).getUTCDay()];
