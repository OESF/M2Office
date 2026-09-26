/**
 * @file 秘書が本人の定時実行を確かめ、止め、再開し、今すぐ実行する。推論を使わない。
 *
 * @see 仕様書 第10.9.8節 定時実行の確認と制御
 * @see 仕様書 第6.1.7節 定時実行の画面
 */

import { randomUUID } from 'node:crypto';
import type { Schedule } from '@m2office/shared';
import type { Repository } from '../repository/types.js';
import { describeRule } from '../scheduler/rule.js';
import { triggeredNow, withEnabled } from '../scheduler/control.js';
import type { EvidenceItem } from './catalog.js';

/** 定時実行そのものを指す言い回し。予定（カレンダー）の「スケジュール」とは分ける。 */
const TOPIC = /定時実行|定期実行|定期的に(実行|動)|自動で(実行|動)/;
/** 今すぐ実行。 */
const RUN_NOW = /今すぐ|いますぐ|今から(実行|動か)|すぐ(に)?(実行|動かして)/;
/** 再開。「止めていたのを再開して」を停止と取り違えないよう、停止より先に見る。 */
const RESUME = /再開|戻して|また動かして|動かし直|オンに/;
/** 停止。 */
const PAUSE = /止めて|止める|止めたい|停止|やめて|やめる|やめたい|休止|オフに/;
/** 登録・変更・削除。秘書は行わず、画面を案内する。 */
const EDIT = /登録|追加|作って|作りたい|入れて|変えて|変えたい|変更|編集|消して|削除|時刻を|時間を/;
/** 状態を尋ねる言い回し。業務の名前だけで当たったときは、取り違えにくいものに絞る。 */
const STATUS = /状態|一覧|どうなって|何が(ある|入って)|確認|設定され|次(は|回|の実行)|いつ|ある[？?]|教えて|見せて/;
const STATUS_BY_NAME = /次(は|回|の実行)|いつ(届|動|実行)|止まって|動いて(いる|る|ます)[？?]?/;

/** 秘書の答え。層 1 と同じく、推論を使わない。 */
export interface ScheduleAnswer {
  text: string;
  evidence: EvidenceItem[];
  /** 行った操作。監査ログと画面の表示に使う。 */
  action: 'status' | 'pause' | 'resume' | 'run' | 'edit' | 'ask';
}

type Action = 'status' | 'pause' | 'resume' | 'run' | 'edit';

/**
 * 定時実行の確認・停止・再開・今すぐ実行の依頼なら応え、そうでなければ `null` を返す（仕様書 第10.9.8節）。
 *
 * @param agents 業務の名前を引くための一覧（本人が使える業務）
 * @returns 秘書の答え。定時実行の依頼でなければ `null`
 *
 * @remarks
 * 「定時実行」の語か、本人の定時実行の業務の名前（「朝のブリーフ」など）があるときだけ当たる。
 * 本人の定時実行だけを扱う（不変則 I-9）。どれか決められなければ実行せず、一覧を示して聞く。
 * 停止・再開・今すぐ実行は確かめずに行う（社外にもお金にも関わらない。ADR-0028）。
 * 監査ログには画面の操作と同じ名前で、行った者を秘書として残す（不変則 I-4）。
 */
export async function answerSchedule(
  repo: Repository, tenantId: string, userId: string, message: string,
  agents: { id: string; name: string }[], now: Date = new Date(),
): Promise<ScheduleAnswer | null> {
  const topic = TOPIC.test(message);
  // ほとんどの依頼は定時実行の話ではない。語も業務の名前も無ければ、定時実行を引かずに抜ける
  if (!topic && !agents.some((a) => message.includes(a.name))) return null;
  const schedules = await repo.listSchedules(tenantId, userId);
  const nameOf = (s: Schedule) => agents.find((a) => a.id === s.agentId)?.name ?? s.agentId;
  const named = schedules.filter((s) => message.includes(nameOf(s)));
  if (!topic && named.length === 0) return null;

  const action = actionOf(message, topic);
  if (!action) return null;

  if (action === 'edit') {
    return {
      action,
      text: '定時実行の登録・変更・削除は、左のメニューの「定時実行」の画面で行えます。止める・再開する・今すぐ実行するのは、こちらで承ります。',
      evidence: [],
    };
  }

  if (schedules.length === 0) {
    return { action: 'status', text: '定時実行はありません。左のメニューの「定時実行」から追加できます。', evidence: [] };
  }

  if (action === 'status') {
    const shown = named.length > 0 ? named : schedules;
    return {
      action,
      text: [`定時実行は ${shown.length} 件です。`, ...shown.map((s) => `- ${line(s, nameOf(s))}`)].join('\n'),
      evidence: shown.map((s) => ({ label: nameOf(s), value: describeRule(s.rule) })),
    };
  }

  // 対象は名前が当たったもの。無ければ、定時実行が 1 つだけのときだけそれ
  const targets = named.length > 0 ? named : schedules.length === 1 ? schedules : [];
  const verb = { pause: '止め', resume: '再開し', run: '今すぐ実行し' }[action];
  if (targets.length === 0) {
    return {
      action: 'ask',
      text: [`どの定時実行を${verb}ますか。`, ...schedules.map((s) => `- ${line(s, nameOf(s))}`)].join('\n'),
      evidence: [],
    };
  }

  const results: string[] = [];
  for (const s of targets) {
    const name = `「${nameOf(s)}」（${describeRule(s.rule)}）`;
    if (action === 'run') {
      await repo.updateSchedule(triggeredNow(s, now));
      await audit(repo, tenantId, userId, 'schedule.trigger', s.id, {});
      results.push(`${name}を今すぐ実行します。結果はお知らせに届きます。`);
      continue;
    }
    const enabled = action === 'resume';
    if (s.enabled === enabled) {
      results.push(`${name}は、もう${enabled ? '動いています' : '止まっています'}。`);
      continue;
    }
    const next = withEnabled(s, enabled, now);
    await repo.updateSchedule(next);
    await audit(repo, tenantId, userId, 'schedule.update', s.id, { enabled, rule: s.rule });
    results.push(enabled ? `${name}を再開しました。次回は ${when(next.nextRunAt, s.timezone)} です。` : `${name}を止めました。`);
  }
  return {
    action,
    text: results.join('\n'),
    evidence: targets.map((s) => ({ label: nameOf(s), value: describeRule(s.rule) })),
  };
}

/** 言い回しから操作を決める。業務の名前だけで当たったときは、状態の問いを狭く取る。 */
function actionOf(message: string, topic: boolean): Action | null {
  if (RUN_NOW.test(message)) return 'run';
  if (RESUME.test(message)) return 'resume';
  if (PAUSE.test(message)) return 'pause';
  if (topic && EDIT.test(message)) return 'edit';
  if (topic) return 'status';
  return STATUS_BY_NAME.test(message) || (STATUS.test(message) && /定時/.test(message)) ? 'status' : null;
}

/** 一覧の 1 行。業務の名前・繰り返し・状態・次回・前回。 */
function line(s: Schedule, name: string): string {
  const state = s.enabled ? `有効・次回 ${when(s.nextRunAt, s.timezone)}` : '停止中';
  const last = s.lastRunAt ? `・前回 ${when(s.lastRunAt, s.timezone)}` : '';
  return `${name}: ${describeRule(s.rule)}・${state}${last}`;
}

/** 本人の地域の時刻で「9/29（月）7:30」の形にする。 */
function when(iso: string, timezone: string): string {
  const parts = new Intl.DateTimeFormat('ja-JP', {
    timeZone: timezone, month: 'numeric', day: 'numeric', weekday: 'short', hour: 'numeric', minute: '2-digit',
  }).formatToParts(new Date(iso));
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '';
  return `${get('month')}/${get('day')}（${get('weekday')}）${get('hour')}:${get('minute')}`;
}

async function audit(
  repo: Repository, tenantId: string, userId: string, action: string, id: string, detail: Record<string, unknown>,
): Promise<void> {
  await repo.appendAudit({
    id: randomUUID(), tenantId, actorType: 'secretary', actorId: userId, action,
    targetType: 'schedule', targetId: id, detail, occurredAt: new Date().toISOString(),
  });
}
