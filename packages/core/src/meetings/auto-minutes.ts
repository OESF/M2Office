/**
 * @file 会議が終わったら、主催した人の議事録を作り始める（仕様書 第9.5.2.1節、ADR-0081）。
 *
 * ワーカーが 10 分ごとに、本人が主催者か参加者だった終わった会議を見て、**本人が主催し、文字起こしができていて、10 分以上の会議**だけ、
 * 主催した人の依頼として業務「議事録の作成・共有」（AG-02）を始める。人に始めるかを聞かない（ADR-0028）。承認は AG-02 のとおり
 * （社外に出るものが無ければ自動で通る）。共有先は、同じ題名の会議で前に共有したスペース。分からなければ Chat には投稿しない。
 * 本人は会話で止められる（全部・題名ごと）。AI の利用の上限に当たっていれば始めない。
 */

import { randomUUID } from 'node:crypto';
import type { AgentDefinition, UserSettings } from '@m2office/shared';
import type { Repository } from '../repository/types.js';
import type { WorkspaceConnector } from '../connectors/types.js';
import { enqueueJob } from '../engine/enqueue.js';
import { AiLimitError } from '../usage/ai-usage.js';

/** 議事録の業務の ID。 */
export const MINUTES_AGENT_ID = 'minutes';
/** これより短い会議は作らない（分）。 */
const MIN_MINUTES = 10;
/** 終わってからこれより長くたった会議は見ない（文字起こしができないままのもの）。 */
const LOOKBACK_MS = 24 * 3_600_000;

/** 会議の題名を比べる形（日付の添え書き・空白・括弧の中を除く）。 */
export function meetingTitleKey(title: string): string {
  return title.normalize('NFKC').replace(/（\d{1,2}\/\d{1,2}）$/, '').replace(/[（(][^）)]*[）)]/g, '').replace(/\s+/g, '').toLowerCase();
}

/** 本人が止めた会議か（全部止めた・題名に止めた言葉を含む）。 */
export function minutesStopped(s: UserSettings['secretary'], title: string): boolean {
  if (s.autoMinutes === false) return true;
  const key = meetingTitleKey(title);
  return (s.noMinutes ?? []).some((w) => w && key.includes(meetingTitleKey(w)));
}

export interface AutoMinutesDeps {
  repo: Repository;
  connector: WorkspaceConnector;
  /** 本人が使える議事録の業務（利用範囲・会社の入り切り）。使えなければ `null`。 */
  agentFor(tenantId: string, userId: string): Promise<AgentDefinition | null>;
}

/** 会議が終わったら議事録を作り始める見回り。 */
export class AutoMinutes {
  constructor(private readonly deps: AutoMinutesDeps) {}

  /**
   * 1 回見回る。
   *
   * @returns 始めた業務の実行の数
   */
  async tick(now: Date = new Date()): Promise<number> {
    if (!this.deps.connector.meet.ended) return 0;
    let started = 0;
    for (const tenantId of await this.deps.repo.listTenantIds()) {
      for (const user of (await this.deps.repo.listUsers(tenantId)).filter((u) => u.status === 'active')) {
        try {
          started += await this.forUser(tenantId, user.id, now);
        } catch {
          // 接続が無い・準備中の接続口・一時的な失敗は、その人だけ飛ばす
        }
      }
    }
    return started;
  }

  /** 1 人の終わった会議を見て、要るものだけ始める。 */
  async forUser(tenantId: string, userId: string, now: Date): Promise<number> {
    const prefs = await this.deps.repo.getUserSettings(tenantId, userId);
    if (prefs.secretary.autoMinutes === false) return 0;
    const def = await this.deps.agentFor(tenantId, userId);
    if (!def) return 0;
    const p = { tenantId, userId };
    const meetings = (await this.deps.connector.meet.ended!(p, new Date(now.getTime() - LOOKBACK_MS).toISOString()))
      .filter((m) => m.organizerSelf && m.hasTranscript && Date.parse(m.endedAt) - Date.parse(m.startedAt) >= MIN_MINUTES * 60_000)
      .filter((m) => !minutesStopped(prefs.secretary, m.title));
    if (!meetings.length) return 0;
    const past = (await this.deps.repo.listRunsWithJobs(tenantId, { limit: 200, requestedBy: userId }))
      .map((r) => r.job).filter((j) => j.agentId === MINUTES_AGENT_ID);
    let started = 0;
    for (const m of meetings) {
      const ended = new Date(Date.parse(m.endedAt) + 9 * 3_600_000);
      const title = `${m.title}（${ended.getUTCMonth() + 1}/${ended.getUTCDate()}）`;
      // 同じ会議の議事録はすでにある（自動か本人の依頼か）
      if (past.some((j) => j.input['title'] === title || j.input['meetingId'] === m.id)) continue;
      // 共有先は、同じ題名の会議で前に共有したスペース
      const space = past.find((j) => meetingTitleKey(String(j.input['title'] ?? '')) === meetingTitleKey(m.title) && typeof j.input['space'] === 'string' && j.input['space'])?.input['space'] as string | undefined;
      try {
        const { runId } = await enqueueJob(this.deps.repo, {
          tenantId, requestedBy: userId, def, origin: 'secretary', actor: { type: 'system', id: 'auto-minutes' },
          input: { title, ...(space ? { space } : {}) },
        });
        await this.deps.repo.appendAudit({
          id: randomUUID(), tenantId, actorType: 'system', actorId: 'auto-minutes', action: 'minutes.auto_start', targetType: 'run', targetId: runId,
          detail: { title, space: space ?? null }, occurredAt: now.toISOString(),
        });
        past.push({ id: runId, tenantId, agentId: MINUTES_AGENT_ID, agentVersion: def.version, requestedBy: userId, origin: 'secretary', input: { title }, createdAt: now.toISOString() });
        started++;
      } catch (err) {
        // AI の利用の上限に当たっていれば始めない（第6.6.2節）
        if (err instanceof AiLimitError) return started;
        throw err;
      }
    }
    return started;
  }
}

/** 「会議の後に議事録を作らないで」など、自動の議事録の入り切りの言い方（第9.5.2.1節）。 */
export function autoMinutesRequest(message: string): { kind: 'off' } | { kind: 'on' } | { kind: 'skip'; title: string } | null {
  const m = message.normalize('NFKC').replace(/\s+/g, '');
  const series = /^「?(.{1,30}?)」?(?:の会議|会議)は議事録を(?:自動で)?(?:作らないで|作らなくていい|いらない)/.exec(m);
  if (series && !/^(会議の(?:後|あと)|全部|すべて)$/.test(series[1]!)) return { kind: 'skip', title: series[1]! };
  if (/(会議の(?:後|あと)に|自動で)議事録を(?:作らないで|作らなくていい|いらない)|議事録の自動(?:作成)?を(?:止めて|やめて)/.test(m)) return { kind: 'off' };
  if (/(会議の(?:後|あと)に|自動で)議事録を作って|議事録の自動(?:作成)?を(?:始めて|戻して)/.test(m)) return { kind: 'on' };
  return null;
}
