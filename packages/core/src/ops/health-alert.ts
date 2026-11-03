/**
 * @file 警戒のときの知らせ（仕様書 第23.8.7節「警戒のときの知らせ」）。全体の状態（`opsHealth`・`machineHealth`）から、
 * いつ・何を送るかを決め、Google Chat か Slack の受け口へ送る。
 *
 * 送るのは、平常・注意から警戒になったとき・警戒のあいだに新しい警戒が増えたとき（すぐ）、警戒が続くあいだ（6 時間ごと）、
 * 平常か注意に戻ったとき（回復）。注意だけのときは送らない。中身は数と種類だけで、会社の名前・IP アドレス・利用者の情報は入れない。
 * 最後に送った状態は、送る側のプロセスが覚える（送れたものだけを覚え、送れなければ次の回で試し直す）。
 */

import type { OpsHealthView } from './health.js';

/** 警戒が続くあいだに送り直す間隔（6 時間）。 */
export const HEALTH_ALERT_REMIND_MS = 6 * 3_600_000;
/** 判断する間隔（5 分）。 */
export const HEALTH_ALERT_INTERVAL_MS = 5 * 60_000;

/** 送る知らせの種類。`alert` 警戒になった（増えた）・`remind` 警戒が続いている・`recover` 回復した。 */
export type HealthAlertKind = 'alert' | 'remind' | 'recover';

/** 最後に送った状態。 */
export interface HealthAlertState {
  /** 警戒を知らせている最中か。 */
  alerting: boolean;
  /** 最後に知らせた警戒の見出し。 */
  titles: string[];
  /** 最後に送った時刻（ミリ秒）。 */
  sentAt: number | null;
}

/** 最初の状態（まだ何も送っていない）。 */
export const INITIAL_HEALTH_ALERT_STATE: HealthAlertState = { alerting: false, titles: [], sentAt: null };

/**
 * いま送るべき知らせを決める。
 *
 * @returns 送る種類（送らなければ `null`）と、送れたときの次の状態
 */
export function nextHealthAlert(state: HealthAlertState, view: OpsHealthView, now: number): { kind: HealthAlertKind | null; next: HealthAlertState } {
  const titles = view.items.filter((i) => i.level === 'alert').map((i) => i.title);
  if (view.level !== 'alert') {
    return state.alerting ? { kind: 'recover', next: { alerting: false, titles: [], sentAt: now } } : { kind: null, next: state };
  }
  const added = titles.some((t) => !state.titles.includes(t));
  if (!state.alerting || added) return { kind: 'alert', next: { alerting: true, titles, sentAt: now } };
  if (state.sentAt === null || now - state.sentAt >= HEALTH_ALERT_REMIND_MS) return { kind: 'remind', next: { alerting: true, titles, sentAt: now } };
  return { kind: null, next: state };
}

/**
 * 知らせの文を作る。
 *
 * @param place 見る画面の場所（「マスター管理画面の「稼働状況」」など）
 */
export function healthAlertText(kind: HealthAlertKind, view: OpsHealthView, place: string): { title: string; body: string } {
  if (kind === 'recover') {
    const rest = view.items.length ? `注意が ${view.items.length} 件残っています。` : '対応が要るものはありません。';
    return { title: '【回復】M2Office の警戒が解けました', body: `${rest}${place}で確かめてください。` };
  }
  const alerts = view.items.filter((i) => i.level === 'alert');
  const lines = alerts.map((i) => `・${i.title}${i.detail ? `（${i.detail}）` : ''}\n　すること: ${i.action}`);
  const head = kind === 'remind' ? '【警戒が続いています】' : '【警戒】';
  return { title: `${head}M2Office で対応が要るものが ${alerts.length} 件あります`, body: `${lines.join('\n')}\n${place}で詳しく見られます。` };
}

/**
 * Google Chat か Slack の受け口へ送る（どちらも `{"text": …}` を受け付ける）。
 *
 * @param url 運営者が用意した受け口（Webhook の URL）
 * @param fetchFn 送る口（テストで差し替える）
 * @throws 送れなかったとき（答えが 2xx でない・10 秒で答えがない）
 * @remarks 危険度: 外へ送る。送り先は運営者が `setup.sh` で決めた先だけで、中身に会社のデータを含まない（第23.8.7節「警戒のときの知らせ」）
 */
export async function postHealthAlert(url: string, text: string, fetchFn: typeof fetch = fetch): Promise<void> {
  const res = await fetchFn(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json; charset=utf-8' },
    body: JSON.stringify({ text }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new Error(`受け口が ${res.status} を返しました`);
}

/**
 * 判断と送ることをまとめ、最後に送った状態を覚える。5 分ごとに `check` を呼ぶ。
 *
 * @example
 * const alerter = new HealthAlerter((t) => postHealthAlert(url, `${t.title}\n${t.body}`), 'マスター管理画面の「稼働状況」');
 * setInterval(async () => alerter.check(await readHealth()), HEALTH_ALERT_INTERVAL_MS);
 */
export class HealthAlerter {
  private state: HealthAlertState = INITIAL_HEALTH_ALERT_STATE;

  /**
   * @param send 送る（失敗なら投げる。投げたら状態を変えず、次の回で試し直す）
   * @param place 見る画面の場所
   */
  constructor(private readonly send: (text: { title: string; body: string }, kind: HealthAlertKind) => Promise<void>, private readonly place: string) {}

  /**
   * いまの全体の状態で判断し、要れば送る。
   *
   * @returns 送った種類（送らなかったときは `null`）
   * @throws 送れなかったとき（状態は変えないので、次の回で試し直す）
   */
  async check(view: OpsHealthView, now: number = Date.now()): Promise<HealthAlertKind | null> {
    const { kind, next } = nextHealthAlert(this.state, view, now);
    if (!kind) return null;
    await this.send(healthAlertText(kind, view, this.place), kind);
    this.state = next;
    return kind;
  }
}
