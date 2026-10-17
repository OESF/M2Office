/**
 * @file 障害・計画停止の知らせと、月ごとの稼働の報告（仕様書 第16.11.3節 G-9）。
 *
 * 運営者がマスター管理画面で起こした障害（`down`）・一部の不具合（`degraded`）・計画停止（`maintenance`）から、
 * 会社の管理者ページの「稼働の報告」を組み立てる。稼働率は、障害（止まった）の時間だけを数え、計画停止を除く（第17章）。
 */

/** 影響の種類。 */
export type IncidentImpact = 'down' | 'degraded' | 'maintenance';

/** 影響の言い方。 */
export const INCIDENT_IMPACT_LABEL: Record<IncidentImpact, string> = { down: '障害（止まった）', degraded: '一部の不具合', maintenance: '計画停止' };

/** 障害・計画停止 1 つ（会社の側に渡す形。対象の会社の一覧は持たない）。 */
export interface ServiceIncident {
  id: string;
  title: string;
  impact: IncidentImpact;
  /** いまの状態の文。 */
  body: string;
  /** 経過（知らせた文）。 */
  updates: { at: string; body: string; ended: boolean }[];
  startedAt: string;
  /** 終わった時刻。続いていれば `null`。 */
  endedAt: string | null;
}

/** 月ごとの稼働の報告。 */
export interface ServiceReport {
  /** 月（`YYYY-MM`。日本時間）。 */
  month: string;
  /** 数えた時間（分。その月の始まりから、月の終わりかいまの早いほうまで）。 */
  minutes: number;
  /** 止まった時間（分。障害の重なりは 1 つに数える）。 */
  downMinutes: number;
  /** 稼働率（%。小数第 2 位まで）。数えた時間が無ければ `null`。 */
  uptime: number | null;
  /** 計画停止の時間（分。稼働率には数えない）。 */
  maintenanceMinutes: number;
  incidents: ServiceIncident[];
}

/** その月（日本時間）の始まりと終わり。 */
export function monthRange(month: string): { from: Date; to: Date } {
  const [y, m] = month.split('-').map(Number) as [number, number];
  return { from: new Date(Date.UTC(y, m - 1, 1) - 9 * 3_600_000), to: new Date(Date.UTC(y, m, 1) - 9 * 3_600_000) };
}

/** 区間の重なりを 1 つにまとめた長さ（ミリ秒）。 */
function unionMs(spans: [number, number][]): number {
  let total = 0;
  let cur: [number, number] | null = null;
  for (const [s, e] of [...spans].sort((a, b) => a[0] - b[0])) {
    if (!cur || s > cur[1]) { if (cur) total += cur[1] - cur[0]; cur = [s, e]; } else cur[1] = Math.max(cur[1], e);
  }
  return total + (cur ? cur[1] - cur[0] : 0);
}

/**
 * 月ごとの稼働の報告を組み立てる。
 *
 * @param month 月（`YYYY-MM`。日本時間）
 * @param incidents その月に重なる障害・計画停止（会社に関わるもの）
 * @remarks 続いている障害は、いままでを数える。まだ来ていない月は、数えた時間を 0 とし稼働率を出さない
 */
export function serviceReport(month: string, incidents: ServiceIncident[], now: Date = new Date()): ServiceReport {
  const { from, to } = monthRange(month);
  const end = Math.min(to.getTime(), now.getTime());
  const clip = (i: ServiceIncident): [number, number] | null => {
    const s = Math.max(Date.parse(i.startedAt), from.getTime());
    const e = Math.min(i.endedAt ? Date.parse(i.endedAt) : now.getTime(), end);
    return e > s ? [s, e] : null;
  };
  const spans = (impact: IncidentImpact) => incidents.filter((i) => i.impact === impact).map(clip).filter((x): x is [number, number] => !!x);
  const total = Math.max(0, end - from.getTime());
  const down = unionMs(spans('down'));
  const min = (ms: number) => Math.round(ms / 60_000);
  return {
    month, minutes: min(total), downMinutes: min(down), maintenanceMinutes: min(unionMs(spans('maintenance'))),
    uptime: total > 0 ? Math.floor((1 - down / total) * 10_000) / 100 : null,
    incidents: [...incidents].sort((a, b) => b.startedAt.localeCompare(a.startedAt)),
  };
}
