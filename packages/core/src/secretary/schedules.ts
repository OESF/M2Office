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


/** 秘書の答え。層 1 と同じく、推論を使わない。 */
export interface ScheduleAnswer {
  text: string;
  evidence: EvidenceItem[];
  /** 行った操作。監査ログと画面の表示に使う。 */
  action: 'status' | 'pause' | 'resume' | 'run' | 'edit' | 'ask';
}

/** 定時実行の頼みの種類（層 2 の読み取りが決める。第10.9.8節・第49.5節）。 */
export type ScheduleAction = 'status' | 'pause' | 'resume' | 'run' | 'edit';
type Action = ScheduleAction;

/** 定時実行の頼みの種類と、読み取りに見せる説明。 */
export const SCHEDULE_ACTIONS: { kind: ScheduleAction; text: string }[] = [
  { kind: 'status', text: '自分の定時実行（朝のブリーフなど決まった時刻に自動で動く業務）の一覧・次の実行・状態を知りたい' },
  { kind: 'pause', text: '定時実行を止めたい' },
  { kind: 'resume', text: '止めている定時実行を再開したい' },
  { kind: 'run', text: '定時実行の業務を今すぐ動かしたい' },
  { kind: 'edit', text: '定時実行を登録・変更・削除したい（画面を案内する）' },
];

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
  agents: { id: string; name: string }[], action: ScheduleAction, now: Date = new Date(),
): Promise<ScheduleAnswer | null> {
  const schedules = await repo.listSchedules(tenantId, userId);
  const nameOf = (s: Schedule) => agents.find((a) => a.id === s.agentId)?.name ?? s.agentId;
  // どの定時実行かは、頼みに出てくる業務の名前で決める（会社のデータで照らす）
  const named = schedules.filter((s) => message.includes(nameOf(s)));

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
