/**
 * @file ダッシュボードの「人の状態」を、既存の記録から組み立てる（仕様書 第6.7.4・6.7.4.1節）。
 *
 * 状態のための記録は持たない。ログイン状態・実行とステップ・承認・監査ログから、そのつど決める。
 * 個人の状態の履歴を残さないという規定（第6.7.10節）を、実装の側からも守るためである。
 *
 * @see ADR-0013
 */

import { canDecide, type Approval, type Job, type Run, type RunStep, type User } from '@m2office/shared';

/** 「ログイン中」とみなす、最後の操作からの時間（分）。 */
export const ACTIVE_WINDOW_MIN = 15;

/** 「秘書と会話中」とみなす、直近の依頼からの時間（分）。 */
export const TALKING_WINDOW_MIN = 2;

/** 人の状態（仕様書 第6.7.4節）。強い順に見て、先に当たったものを採る。 */
export type PresenceState = 'approval' | 'activity' | 'running' | 'talking' | 'idle' | 'offline';

/** 状態の表示名。画面と、本人への説明（第6.7.10節 規定 4）で使う。 */
export const PRESENCE_LABELS: Record<PresenceState, string> = {
  approval: '承認の依頼あり',
  activity: '活動中',
  running: '業務を実行中',
  talking: '秘書と会話中',
  idle: 'ログイン中（待機）',
  offline: 'オフライン',
};

/** 1 人分の状態。中身（会話・入力・成果物）は持たない（第6.7.10節 規定 1）。 */
export interface Presence {
  userId: string;
  name: string;
  state: PresenceState;
  /** 状態に添える言葉（「議事録作成・共有を実行中」「リサーチ中」「承認の依頼 2 件」など）。 */
  detail: string;
  /** いま使っている業務の名前。無ければ `null`。 */
  agentName: string | null;
  /** 接続の経路（画面・外部アプリ）。音声と LINE は Phase 2。 */
  route: '画面' | '外部アプリ' | null;
  /** 端末の種類。 */
  device: 'パソコン' | 'スマートフォン' | null;
}

/** ログイン状態から取り出した、1 人分の接続の様子。 */
export interface PresenceSession {
  userId: string;
  lastSeenAt: string;
  userAgent: string | null;
}

export interface PresenceInput {
  now: Date;
  users: User[];
  /** 有効なログイン状態（利用者ごとに、最後に操作したもの）。 */
  sessions: PresenceSession[];
  /** 動いている実行と、その依頼。 */
  liveRuns: { run: Run; job: Job }[];
  /** 実行ごとのステップ（活動の表示名を拾う）。 */
  stepsByRun: Map<string, RunStep[]>;
  /** 判断されていない承認。 */
  pending: Approval[];
  /** 直近の秘書の監査ログ（`secretary.*`）。 */
  secretaryEvents: { actorId: string; occurredAt: string }[];
  /** 業務の ID から表示名を引く。 */
  agentName(agentId: string): string;
}

/** 利用者エージェントから端末の種類を決める。細かい判別はしない。 */
export function deviceOf(userAgent: string | null): Presence['device'] {
  if (!userAgent) return null;
  return /Mobile|Android|iPhone|iPad/i.test(userAgent) ? 'スマートフォン' : 'パソコン';
}

/**
 * いま実行中のステップに書かれている活動の表示名（第6.7.7節）。
 *
 * @remarks ツールを呼ぶ直前に実行エンジンが書き、呼び終えたら消す（ADR-0013 決定 7）。
 */
export function activityOf(steps: RunStep[]): string | null {
  const running = steps.find((s) => s.status === 'running');
  const activity = (running?.input as { activity?: unknown } | null)?.activity;
  return typeof activity === 'string' && activity ? activity : null;
}

/**
 * 人の状態を組み立てる。
 *
 * @returns 利用者ごとの状態。停止した利用者は含めない
 */
export function buildPresence(input: PresenceInput): Presence[] {
  const { now, users, sessions, liveRuns, stepsByRun, pending, secretaryEvents } = input;
  const activeSince = now.getTime() - ACTIVE_WINDOW_MIN * 60_000;
  const talkingSince = now.getTime() - TALKING_WINDOW_MIN * 60_000;
  const sessionOf = new Map(sessions.map((s) => [s.userId, s]));

  return users
    .filter((u) => u.status === 'active')
    .map((user): Presence => {
      const session = sessionOf.get(user.id);
      const online = !!session && Date.parse(session.lastSeenAt) >= activeSince;
      const mine = liveRuns.filter(({ job, run }) => job.requestedBy === user.id && run.status !== 'failed');
      const decidable = pending.filter((a) => canDecide(a, user));
      const talking = secretaryEvents.some(
        (e) => e.actorId === user.id && Date.parse(e.occurredAt) >= talkingSince,
      );
      const activity = mine
        .map(({ run }) => activityOf(stepsByRun.get(run.id) ?? []))
        .find((a): a is string => !!a) ?? null;
      const agentName = mine[0] ? input.agentName(mine[0].job.agentId) : null;
      const base = {
        userId: user.id,
        name: user.displayName,
        agentName,
        route: online ? ('画面' as const) : null,
        device: online ? deviceOf(session?.userAgent ?? null) : null,
      };

      // 強い順に決める。承認待ちは、離席していても知らせる価値があるため最初に見る
      if (decidable.length > 0) return { ...base, state: 'approval', detail: `承認の依頼 ${decidable.length} 件` };
      if (activity) return { ...base, state: 'activity', detail: activity };
      if (mine.length > 0) return { ...base, state: 'running', detail: `${agentName ?? '業務'}を実行中` };
      if (talking && online) return { ...base, state: 'talking', detail: PRESENCE_LABELS.talking };
      if (online) return { ...base, state: 'idle', detail: PRESENCE_LABELS.idle };
      return { ...base, state: 'offline', detail: PRESENCE_LABELS.offline, route: null, device: null };
    });
}

/**
 * 個人名を出さない粒度（Q-64）の見せ方。状態ごとの人数と、動いている業務の名前だけにする。
 *
 * @remarks 人数が 0 の状態も落とさずに並べる。並びが変わると、そこから誰かを推し量れるため。
 */
export function summarizePresence(people: Presence[]): {
  counts: { state: PresenceState; label: string; n: number }[];
  agents: string[];
} {
  const states: PresenceState[] = ['approval', 'activity', 'running', 'talking', 'idle', 'offline'];
  return {
    counts: states.map((state) => ({
      state,
      label: PRESENCE_LABELS[state],
      n: people.filter((p) => p.state === state).length,
    })),
    agents: [...new Set(people.map((p) => p.agentName).filter((a): a is string => !!a))],
  };
}
