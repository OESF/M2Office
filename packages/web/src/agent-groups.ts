/**
 * @file ダッシュボードの「業務の状態」を、拡張機能と業務の分野ごとのまとまりに分ける（仕様書 第6.7.4.2.1節、ADR-0061）。
 *
 * まとまりは API が業務ごとに返す `group` で決まる。ここでは数を合わせ、忙しい順に並べるだけを行う。
 */

import type { DashboardLive } from './api.js';

/** 業務 1 つ分の受け持ち。 */
export type AgentLoad = DashboardLive['agents'][number];

/** まとまり 1 つ分。 */
export interface AgentGroupView {
  id: string;
  name: string;
  /** まとまりの絵（中の業務のうち、定義の順で最初の業務の絵。第6.7.4.3節）。 */
  face: number;
  running: number;
  awaiting: number;
  queued: number;
  todayRuns: number;
  todayFailed: number;
  /** 中の業務（忙しい順）。 */
  items: AgentLoad[];
  /** 受け持ちのある業務と、今日失敗した業務。囲みを開かなくても出す。 */
  active: AgentLoad[];
}

/** いま受け持っている件数（実行中・承認待ち・待ち行列の合計）。 */
export function busyOf(a: { running: number; awaiting: number; queued: number }): number {
  return a.running + a.awaiting + a.queued;
}

/** 忙しい順。同じなら今日の件数の多い順（第6.7.4.2節）。 */
function byLoad(x: { running: number; awaiting: number; queued: number; todayRuns: number }, y: typeof x): number {
  return busyOf(y) - busyOf(x) || y.todayRuns - x.todayRuns;
}

/**
 * 業務をまとまりに分ける。
 *
 * @param agents API が返す業務（定義の順）。`group` が無い業務は、その業務だけのまとまりにする
 * @returns まとまり（忙しい順）。中の業務が 1 つだけのものは、画面が業務 1 つの囲みで出す
 */
export function groupAgents(agents: AgentLoad[]): AgentGroupView[] {
  const groups = new Map<string, AgentGroupView>();
  for (const a of agents) {
    const key = a.group?.id ?? `agent:${a.agentId}`;
    const g = groups.get(key) ?? {
      id: key, name: a.group?.name ?? a.name, face: a.face,
      running: 0, awaiting: 0, queued: 0, todayRuns: 0, todayFailed: 0, items: [], active: [],
    };
    g.running += a.running;
    g.awaiting += a.awaiting;
    g.queued += a.queued;
    g.todayRuns += a.todayRuns;
    g.todayFailed += a.todayFailed;
    g.items.push(a);
    groups.set(key, g);
  }
  return [...groups.values()]
    .map((g) => {
      const items = [...g.items].sort(byLoad);
      return { ...g, items, active: items.filter((a) => busyOf(a) > 0 || a.todayFailed > 0) };
    })
    .sort(byLoad);
}
