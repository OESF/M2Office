/**
 * @file 秘書の決め打ちの決まりの表（仕様書 第10.7.4.2節・第10.7.4.6節 段 3、ADR-0147）。
 *
 * 秘書は、推論に選ばせずに言い回しで決める決まりを、応答の本体（`Secretary.reply`）の中で上から順に見る。
 * 業務が増えて決まりの数も増え、ある決まりが別の決まりの頼みを奪うこと（2026-11-14 の「〇〇のメールを探して」に
 * 未読の件数を答えたこと）が起きた。ここに **応答の本体と同じ順番で** 決まりを 1 か所に並べ、
 * なぜ決め打ちにするかと頼みの例を持たせ、テスト（`fixed-rules.test.ts`）で「例はその決まりに当たり、前の決まりに奪われない」ことを守る。
 *
 * 決め打ちにするのは、次の 3 つに絞る。それ以外は、話の流れを見て推論が選ぶ（層 2）。
 * - `safety`: 間違えると困るもの（社外への送信・お金・人事・権限）
 * - `speed`: 推論を使わずに速く答えたいもの（件数・予定・在庫の数）
 * - `setting`: 本人や会社の設定を、会話でそのまま変えるもの
 *
 * @remarks
 * 会社の接続の名前・在庫の品目の名前など、会社のデータを見て決める決まりはここに入れない（言い回しだけでは決まらない）。
 * 応答の本体の順番を変えたら、この表も同じに直す。
 */

import { attendanceRequest, payslipRequest } from './attendance.js';
import { autoMinutesRequest } from '../meetings/auto-minutes.js';
import { bulkMailRequest, contactRequest } from './contacts.js';
import { CORRECTION } from './correct.js';
import { DIRECT_QUERIES } from './catalog.js';
import { hrStaffRequest } from './hr-staff.js';
import { inventoryRequest } from './inventory.js';
import { mailCheckRequest, mailSearchRequest } from './mail.js';
import { mailCommand } from '../mail/secretary.js';
import { maybeReservation } from './reservations.js';
import { notifyPreferenceRequest } from '../notify/preferences.js';
import { securityRequest } from './security.js';
import { signageRequest } from './signage.js';
import { AI_SHARE_SET, GROUP_SPACE_FORGET, GROUP_SPACE_SET, HOW_TO, NOTE_REQUEST } from './secretary.js';

/** 決め打ちにする理由。 */
export type FixedRuleReason = 'safety' | 'speed' | 'setting';

/** 決め打ちの決まり 1 つ。 */
export interface FixedRule {
  /** 決まりの ID（照会は `direct:<照会の ID>`）。 */
  id: string;
  /** 何をするか。 */
  label: string;
  /** なぜ決め打ちにするか。 */
  reason: FixedRuleReason;
  /** 言い回しが当たるか（文の頭だけを見る）。 */
  test(cmd: string): boolean;
  /** この決まりに当たるべき頼みの例。前の決まりに奪われないことをテストで確かめる。 */
  samples: string[];
}

const today = () => new Date().toISOString().slice(0, 10);

/** 層 1 の照会の、頼みの例（照会の ID ごと）。 */
const DIRECT_SAMPLES: Record<string, string[]> = {
  'calendar-range': ['今日の予定は？', '今週のスケジュールを見せて'],
  'mail-unread': ['未読のメールは何件？'],
  'tasks-today': ['今日のタスクは？'],
  'conversation-forget': ['さっきの会話は残さないで'],
  'pending-approvals': ['承認待ちはある？'],
  'text-size': ['文字を大きくして'],
};

/**
 * 決め打ちの決まり。**応答の本体と同じ順番**（上から先に見る）。
 *
 * @remarks 層 1 の照会（`direct:*`）は、続きの頼みのときは当てないものがある（`FOLLOW_UP_SKIPS`。第10.7.4.2節）
 */
export const FIXED_RULES: FixedRule[] = [
  { id: 'ai-share', label: '1 人の AI の上限の割合を変える（管理者）', reason: 'setting', test: (c) => AI_SHARE_SET.test(c.normalize('NFKC')), samples: ['1人の上限を5割にして', '1人のAIの上限を30%にして'] },
  { id: 'auto-minutes', label: '会議の後の議事録の入り切り・作らない会議', reason: 'setting', test: (c) => autoMinutesRequest(c) !== null, samples: ['会議の後に議事録を作らないで', '定例会の会議は議事録を作らないで'] },
  { id: 'notify', label: 'Chat への通知の届け方', reason: 'setting', test: (c) => notifyPreferenceRequest(c) !== null, samples: ['夜10時から朝8時はChatに送らないで'] },
  { id: 'group-space', label: 'グループの共有先の Chat のスペース', reason: 'setting', test: (c) => GROUP_SPACE_SET.test(c) || GROUP_SPACE_FORGET.test(c), samples: ['技術部の共有は技術チームのスペースにして'] },
  { id: 'help-note', label: 'ヘルプの会社の補足を書く・消す（管理者）', reason: 'setting', test: (c) => NOTE_REQUEST.test(c), samples: ['議事録の説明に、社外の人には共有しないと補足して'] },
  { id: 'how-to', label: '使い方の質問（ヘルプと社内の規程から答える）', reason: 'speed', test: (c) => HOW_TO.test(c), samples: ['承認はどうやるの？', '議事録のやり方を教えて'] },
  { id: 'correction', label: '記憶の直し（「それは違う」「〇〇は忘れて」）', reason: 'setting', test: (c) => CORRECTION.test(c), samples: ['それは違う、担当は佐藤さん'] },
  { id: 'attendance', label: '本人の勤怠と有給', reason: 'safety', test: (c) => attendanceRequest(c) !== null, samples: ['出勤', '有給あと何日？'] },
  { id: 'security', label: '不正の兆しの見張り（管理者）', reason: 'safety', test: (c) => securityRequest(c) !== null, samples: ['山田さんのアカウントを止めて'] },
  { id: 'hr-staff', label: '人事の担当者の依頼（人事区画の人だけ）', reason: 'safety', test: (c) => hrStaffRequest(c, today()) !== null, samples: ['来月の給与を計算して', '社会保険の届出の期限はいつ？'] },
  { id: 'signage', label: 'サイネージ', reason: 'safety', test: (c) => signageRequest(c) !== null, samples: ['サイネージに「本日休診」を出して'] },
  { id: 'reservation', label: '会議室・社用車・備品の予約', reason: 'speed', test: (c) => maybeReservation(c), samples: ['明日の10時から会議室を予約して'] },
  { id: 'payslip', label: '本人の給与明細', reason: 'safety', test: (c) => payslipRequest(c), samples: ['今月の給与明細を見せて'] },
  ...DIRECT_QUERIES.map((q): FixedRule => ({
    id: `direct:${q.id}`, label: `定型の照会（${q.id}）`, reason: ['conversation-forget', 'memory-remember', 'memory-forget', 'text-size'].includes(q.id) ? 'setting' : 'speed',
    test: (c) => !mailCommand(c) && q.patterns.some((p) => p.test(c)) && !q.excludes?.some((p) => p.test(c)),
    samples: DIRECT_SAMPLES[q.id] ?? [],
  })),
  { id: 'mail-search', label: 'メールを探す（Gmail とナレッジの整理）', reason: 'speed', test: (c) => mailSearchRequest(c), samples: ['見本商事のメールを探して', '先月の青空建設とのメールはどこ？'] },
  { id: 'inventory', label: '在庫（数の問い・記録・発注）', reason: 'safety', test: (c) => inventoryRequest(c) !== null, samples: ['コピー用紙の在庫は？'] },
  { id: 'bulk-mail', label: '名刺の相手へのまとめてのメール', reason: 'safety', test: (c) => bulkMailRequest(c), samples: ['名刺の相手に年末のご挨拶をまとめて送って'] },
  { id: 'contact', label: '名刺を探す・直す', reason: 'speed', test: (c) => contactRequest(c) !== null, samples: ['山田さんの電話番号は？'] },
  { id: 'mail-command', label: 'メールの画面への頼み（止める・済んだ・返事待ち）', reason: 'setting', test: (c) => mailCommand(c) !== null, samples: ['このメールは済んだ'] },
  { id: 'mail-check', label: 'メールの確認（未読を読んで振り分けて案内）', reason: 'speed', test: (c) => mailCheckRequest(c), samples: ['メールを確認して'] },
];


/**
 * 頼みに最初に当たる決め打ちの決まり（応答の本体と同じ順番で見る）。
 *
 * @returns 当たらなければ `null`（推論が選ぶ）
 */
export function firstFixedRule(cmd: string): FixedRule | null {
  return FIXED_RULES.find((r) => r.test(cmd)) ?? null;
}
