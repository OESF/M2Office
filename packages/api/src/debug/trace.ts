/**
 * @file 秘書の振り分けの経過を、デバッグモードの記録の 1 行にする（仕様書 第20.4.1節「デバッグモード」）。
 */

import { DIRECT_QUERIES } from '@m2office/core';

/** 監査ログの操作の名前から、振り分けの言葉へ。 */
const ACTIONS: Record<string, string> = {
  'secretary.direct': '定型の答え',
  'secretary.inventory': '在庫の答え',
  'secretary.schedule': '定時実行の操作',
  'secretary.chat': '推論で答える',
  'secretary.promise': '約束した調べもの',
  'secretary.lookup': '調べものを起こした',
  'secretary.delegate': '業務を頼んだ',
  'secretary.brief': 'ブリーフの設定',
  'secretary.correct': '記憶を直す',
  'secretary.file': '渡したファイル',
  'secretary.help': 'ヘルプの記事で答える',
  'secretary.notice': '社内のお知らせ',
  'secretary.plan.answer': '段取りへの答え',
  'secretary.todo': 'ToDo',
  'secretary.mail': 'メールを確認して振り分けた',
  'secretary.attendance': '勤怠と有給',
  'secretary.payslip': '本人の給与明細',
  'secretary.hr': '人事の担当者の依頼',
  'secretary.reservation': '予約',
};

/**
 * 記録に残さない経過。業務への取次（`secretary.route`）は、すぐ後の「〇〇へ回す（理由）」と重なるため。
 */
export const QUIET_TRACES = new Set(['secretary.route']);

/**
 * 振り分けの経過の 1 行（「振り分け: 定型の答え「未読メールの確認」」）。
 *
 * @param detail 業務へ回したときの業務の名前と理由
 */
export function traceTitle(action: string, target: string, detail?: Record<string, unknown>): string {
  if (action === 'secretary.handoff') {
    return `振り分け: ${String(detail?.['agent'] ?? target)}へ回す（${String(detail?.['reason'] ?? '')}）`;
  }
  if (action === 'secretary.direct') {
    const q = DIRECT_QUERIES.find((x) => x.id === target);
    return `振り分け: 定型の答え「${q?.label ?? target}」`;
  }
  return `振り分け: ${ACTIONS[action] ?? action}（${target}）`;
}
