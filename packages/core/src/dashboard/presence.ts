/**
 * @file ダッシュボードの「人の状態」を、既存の記録から組み立てる（仕様書 第6.7.4・6.7.4.1節）。
 *
 * 状態のための記録は持たない。ログイン状態・実行とステップ・承認・監査ログから、そのつど決める。
 * 個人の状態の履歴を残さないという規定（第6.7.10節）を、実装の側からも守るためである。
 *
 * 本人の状態と、その人に付く秘書の状態を分けても持つ（第6.7.4.4節）。本人がオフラインでも、秘書は業務を進めているため。
 *
 * @see ADR-0013
 */

import { canDecide, type Approval, type Job, type Run, type RunStep, type User } from '@m2office/shared';

/** 「ログイン中」とみなす、最後の操作からの時間（分）。 */
export const ACTIVE_WINDOW_MIN = 15;

/** 「秘書と会話中」とみなす、直近の依頼からの時間（分）。 */
export const TALKING_WINDOW_MIN = 2;

/** 音声の対話を開いたままと見なす上限（分）。異常終了で終わりが残らなかった対話を数え続けないため（第6.7.4.1節）。 */
export const VOICE_WINDOW_MIN = 60;

/** 人の状態（仕様書 第6.7.4節）。強い順に見て、先に当たったものを採る。 */
export type PresenceState = 'approval' | 'activity' | 'running' | 'voice' | 'talking' | 'idle' | 'offline';

/** 状態の表示名。画面と、本人への説明（第6.7.10節 規定 4）で使う。 */
export const PRESENCE_LABELS: Record<PresenceState, string> = {
  approval: '承認の依頼あり',
  activity: '活動中',
  running: '業務を実行中',
  voice: '音声で会話中',
  talking: '秘書と会話中',
  idle: 'ログイン中（待機）',
  offline: 'オフライン',
};

/** 本人だけの状態（第6.7.4.4節）。業務の進み具合は秘書の側に出す。 */
export type SelfState = 'approval' | 'voice' | 'talking' | 'idle' | 'offline';

/** 秘書の状態（第6.7.4.4節）。強い順に見て、先に当たったものを採る。 */
export type SecretaryState = 'activity' | 'running' | 'awaiting' | 'queued' | 'voice' | 'talking' | 'idle';

/** 秘書の状態の表示名。 */
export const SECRETARY_LABELS: Record<SecretaryState, string> = {
  activity: '活動中',
  running: '業務を実行中',
  awaiting: '承認待ち',
  queued: '順番待ち',
  voice: '音声で応対中',
  talking: '応対中',
  idle: '待機',
};

/** 1 人分の状態。中身（会話・入力・成果物）は持たない（第6.7.10節 規定 1）。 */
export interface Presence {
  userId: string;
  name: string;
  state: PresenceState;
  /** 状態に添える言葉（「議事録の作成・共有を実行中」「リサーチ中」「承認の依頼 2 件」など）。 */
  detail: string;
  /** いま使っている業務の名前。無ければ `null`。 */
  agentName: string | null;
  /** 接続の経路（画面・音声・外部アプリ）。LINE は Phase 2。 */
  route: '画面' | '音声' | '外部アプリ' | null;
  /** 端末の種類。 */
  device: 'パソコン' | 'スマートフォン' | null;
  /** 本人だけの状態（第6.7.4.4節）。 */
  self: { state: SelfState; detail: string };
  /**
   * その人に付く秘書の状態（第6.7.4.4節）。本人がオフラインでも出す。
   *
   * @remarks `busy` は秘書が動いているか（アバターを輪で囲むか）。会話の相手をしているときも含む
   */
  secretary: { state: SecretaryState; detail: string; busy: boolean };
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
  /**
   * 直近の音声の対話の監査ログ（`secretary.voice`。`targetId` は `start` か `end`）。
   *
   * @remarks 渡さなければ、音声で会話中とは判定しない
   */
  voiceEvents?: { actorId: string; occurredAt: string; targetId: string }[];
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
 * 音声の対話が開いているか。最後の始まりの後に終わりが無く、始まりが上限の時間の中にある。
 *
 * @param since この時刻より前の始まりは数えない（{@link VOICE_WINDOW_MIN}）
 */
export function voiceOpen(
  events: { actorId: string; occurredAt: string; targetId: string }[], userId: string, since: number,
): boolean {
  const mine = events
    .filter((e) => e.actorId === userId && (e.targetId === 'start' || e.targetId === 'end'))
    .sort((a, b) => a.occurredAt.localeCompare(b.occurredAt));
  const last = mine.at(-1);
  return !!last && last.targetId === 'start' && Date.parse(last.occurredAt) >= since;
}

/** 「〜を実行中（ほか 1 件）」のように、残りの件数を添える。 */
function andMore(text: string, rest: number): string {
  return rest > 0 ? `${text}（ほか ${rest} 件）` : text;
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
  const voiceSince = now.getTime() - VOICE_WINDOW_MIN * 60_000;
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
      const voice = voiceOpen(input.voiceEvents ?? [], user.id, voiceSince);
      const activity = mine
        .map(({ run }) => activityOf(stepsByRun.get(run.id) ?? []))
        .find((a): a is string => !!a) ?? null;
      const agentName = mine[0] ? input.agentName(mine[0].job.agentId) : null;
      const base = {
        userId: user.id,
        name: user.displayName,
        agentName,
        route: voice ? ('音声' as const) : online ? ('画面' as const) : null,
        device: online ? deviceOf(session?.userAgent ?? null) : null,
        self: selfOf({ decidable: decidable.length, voice, talking, online }),
        secretary: secretaryOf({ mine, activity, voice, talking: talking && online }, input.agentName),
      };

      // 強い順に決める。承認待ちは、離席していても知らせる価値があるため最初に見る
      if (decidable.length > 0) return { ...base, state: 'approval', detail: `承認の依頼 ${decidable.length} 件` };
      if (activity) return { ...base, state: 'activity', detail: activity };
      if (mine.length > 0) return { ...base, state: 'running', detail: `${agentName ?? '業務'}を実行中` };
      if (voice) return { ...base, state: 'voice', detail: PRESENCE_LABELS.voice };
      if (talking && online) return { ...base, state: 'talking', detail: PRESENCE_LABELS.talking };
      if (online) return { ...base, state: 'idle', detail: PRESENCE_LABELS.idle };
      return { ...base, state: 'offline', detail: PRESENCE_LABELS.offline, route: null, device: null };
    });
}

/** 本人だけの状態（第6.7.4.4節）。業務の進み具合は含めない。 */
function selfOf(x: { decidable: number; voice: boolean; talking: boolean; online: boolean }): Presence['self'] {
  if (x.decidable > 0) return { state: 'approval', detail: `承認の依頼 ${x.decidable} 件` };
  if (x.voice) return { state: 'voice', detail: PRESENCE_LABELS.voice };
  if (x.talking && x.online) return { state: 'talking', detail: PRESENCE_LABELS.talking };
  if (x.online) return { state: 'idle', detail: 'ログイン中' };
  return { state: 'offline', detail: PRESENCE_LABELS.offline };
}

/**
 * 秘書の状態（第6.7.4.4節）。本人の業務の進み具合と、本人との会話から決める。
 *
 * @remarks 本人がオフラインでも、定時実行などで業務が動いていれば「業務を実行中」と出す
 */
function secretaryOf(
  x: { mine: { run: Run; job: Job }[]; activity: string | null; voice: boolean; talking: boolean },
  agentName: (agentId: string) => string,
): Presence['secretary'] {
  const running = x.mine.filter(({ run }) => run.status === 'running');
  const awaiting = x.mine.filter(({ run }) => run.status === 'awaiting_approval');
  const queued = x.mine.filter(({ run }) => run.status === 'queued');
  const name = (list: { job: Job }[]) => agentName(list[0]!.job.agentId);

  if (x.activity) return { state: 'activity', detail: andMore(x.activity, x.mine.length - 1), busy: true };
  if (running.length > 0) {
    return { state: 'running', detail: andMore(`${name(running)}を実行中`, x.mine.length - 1), busy: true };
  }
  if (awaiting.length > 0) {
    return { state: 'awaiting', detail: andMore(`${name(awaiting)}の承認を待っています`, x.mine.length - 1), busy: true };
  }
  if (queued.length > 0) {
    return { state: 'queued', detail: andMore(`${name(queued)}の順番待ち`, x.mine.length - 1), busy: true };
  }
  if (x.voice) return { state: 'voice', detail: SECRETARY_LABELS.voice, busy: true };
  if (x.talking) return { state: 'talking', detail: SECRETARY_LABELS.talking, busy: true };
  return { state: 'idle', detail: SECRETARY_LABELS.idle, busy: false };
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
  const states: PresenceState[] = ['approval', 'activity', 'running', 'voice', 'talking', 'idle', 'offline'];
  return {
    counts: states.map((state) => ({
      state,
      label: PRESENCE_LABELS[state],
      n: people.filter((p) => p.state === state).length,
    })),
    agents: [...new Set(people.map((p) => p.agentName).filter((a): a is string => !!a))],
  };
}
