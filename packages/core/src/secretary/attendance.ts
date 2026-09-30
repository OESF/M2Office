/**
 * @file 勤怠と有給の依頼の見分けと、その場の答え（仕様書 第30.20節・第30.6.1節・第30.7.1節）。
 *
 * 「出勤」「退勤」「休憩」「休憩終わり」は打刻、「有給あと何日？」は残り、「来週の金曜、有給で休みます」は申請。
 * 推論に選ばせずに見分け、本人の分だけを扱う（H-3。他人の分は答えない）。日付も決まった規則で読む（推測で埋めない）。
 */

import type { AttPunchKind, HrEmployee } from '@m2office/shared';
import type { AttendanceService } from '../hr/attendance-service.js';
import { jstDate, jstTime, shiftDate, weekday } from '../hr/attendance.js';

/** 勤怠の依頼の種類。 */
export type AttendanceRequest =
  | { kind: 'punch'; punch: AttPunchKind }
  | { kind: 'balance' }
  | { kind: 'leave'; cancel: boolean };

/** 打刻の言い回し（短い文だけ。「出勤簿を出して」「出勤時間は？」は打刻にしない）。 */
const PUNCHES: [AttPunchKind, RegExp][] = [
  ['break_end', /^(休憩(終わり|終了|おわり|明け)|休憩から戻り(ました)?|戻りました)/],
  ['break_start', /^(休憩(します|に入ります|入ります|開始|とります|取ります|入り)?)$/],
  ['in', /^(出勤|出社)(します|しました|です)?$|^おはようございます.{0,6}(出勤|出社)(します|しました)?$/],
  ['out', /^(退勤|退社)(します|しました|です)?$|^(お先に失礼します|上がります|帰ります)$/],
];

/**
 * 勤怠・有給の依頼を見分ける。
 *
 * @returns 勤怠・有給の依頼でなければ `null`
 */
export function attendanceRequest(message: string): AttendanceRequest | null {
  const m = message.normalize('NFKC').trim().replace(/[。!！、\s]+$/g, '').replace(/\s+/g, '');
  if (m.length <= 20 && !/[?？]/.test(m)) {
    for (const [punch, re] of PUNCHES) if (re.test(m)) return { kind: 'punch', punch };
  }
  const leaveWord = /(有給|有休|年休|年次有給)/.test(m);
  // 決まりや手順の問い（「有給の申請方法を教えて」）は、会社の規程の問いとして秘書がふつうに答える
  if (leaveWord && /(方法|やり方|どうやって|どうすれば|教えて|規程|規則|ルール|とは|付与され|何日もらえ)/.test(m)) return null;
  if (leaveWord && /(残り|あと何日|何日残|残日数|何日ある|いくつ残)/.test(m)) return { kind: 'balance' };
  if (leaveWord && /(取り消|キャンセル|やめ(ます|る|て)|取りやめ)/.test(m) && parseLeaveDate(m, '2000-01-01') !== null) return { kind: 'leave', cancel: true };
  if (leaveWord && /(休み|休みます|休む|取ります|取りたい|取得|申請|使います|使いたい)/.test(m) && !/[?？]$/.test(m)) return { kind: 'leave', cancel: false };
  return null;
}

/**
 * 本人の給与明細の問いかを見分ける（「今月の給与明細」「手取りが減ったのはなぜ？」）。
 * 計算や締めの依頼（担当者の仕事）・決まりの問い（「給与の締め日は？」）は当てない。
 */
export function payslipRequest(message: string): boolean {
  const m = message.normalize('NFKC').replace(/\s+/g, '');
  if (/(計算|締め|設定|方法|規程|規則|とは|振込データ|台帳)/.test(m)) return false;
  return /(給与|給料|賞与)明細|明細を?(見|出|教)|手取り|(今月|先月|前回|直近|この前)の?(給与|給料)(は|って|を|いくら|見|教|確)/.test(m);
}

const WEEKDAYS = '日月火水木金土';

/**
 * 依頼の文から日付を読む（今日・明日・明後日・今週／来週／再来週の〇曜・〇曜・M月D日・M/D）。
 *
 * @param today 今日（YYYY-MM-DD）
 * @returns 読めなければ `null`（推測で埋めない）
 */
export function parseLeaveDate(message: string, today: string): string | null {
  const m = message.normalize('NFKC');
  if (/(今日|本日)/.test(m)) return today;
  if (/(明後日|あさって)/.test(m)) return shiftDate(today, 2);
  if (/(明日|あした|あす)/.test(m)) return shiftDate(today, 1);
  const md = m.match(/(\d{1,2})月(\d{1,2})日/) ?? m.match(/(?<![\d/])(\d{1,2})\/(\d{1,2})(?![\d/])/);
  if (md) {
    const [mo, d] = [Number(md[1]), Number(md[2])];
    if (mo < 1 || mo > 12 || d < 1 || d > 31) return null;
    let y = Number(today.slice(0, 4));
    let date = `${y}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
    if (new Date(`${date}T00:00:00Z`).getUTCDate() !== d) return null;
    // 過ぎた日なら来年（1 か月より前に過ぎた日だけ。先月の申請の取り消しを来年にしないため）
    if (date < shiftDate(today, -31)) { y += 1; date = `${y}-${date.slice(5)}`; }
    return date;
  }
  const wd = m.match(/(今週|来週|再来週)?の?([日月火水木金土])曜/);
  if (wd) {
    const target = WEEKDAYS.indexOf(wd[2]!);
    const w = weekday(today);
    // 週は月曜から日曜（ふだんの言い方の「来週」）
    const monday = shiftDate(today, -((w + 6) % 7));
    const offset = (target + 6) % 7;
    if (wd[1] === '今週') return shiftDate(monday, offset);
    if (wd[1] === '来週') return shiftDate(monday, 7 + offset);
    if (wd[1] === '再来週') return shiftDate(monday, 14 + offset);
    // 「金曜」だけなら、今日より後の最も近い日
    const ahead = (target - w + 7) % 7 || 7;
    return shiftDate(today, ahead);
  }
  return null;
}

/** 半日の申請か（午前休・午後休・半休・半日）。 */
export const isHalfDay = (message: string) => /(半日|半休|午前休|午後休|午前半休|午後半休)/.test(message);

const md = (d: string) => `${Number(d.slice(5, 7))}月${Number(d.slice(8, 10))}日（${WEEKDAYS[weekday(d)]}）`;

/**
 * 勤怠・有給の依頼にその場で答える（本人の分だけ）。
 *
 * @returns 答えの文。本人が台帳に載っていなければ、そう答える
 */
export async function answerAttendance(
  service: AttendanceService, tenantId: string, userId: string, employee: HrEmployee | null, req: AttendanceRequest, message: string,
): Promise<string> {
  if (!employee) return '人事の台帳にあなたが載っていないため、打刻と有給は扱えません。人事の担当者に、台帳への登録と結び付けを頼んでください。';
  const today = jstDate(new Date());
  if (req.kind === 'punch') {
    const r = await service.punch(tenantId, userId, employee, req.punch, 'secretary');
    if ('error' in r) return r.error;
    const t = jstTime(r.punch.at);
    return req.punch === 'in' ? `${t} に出勤を記録しました。` : req.punch === 'out' ? `${t} に退勤を記録しました。お疲れさまでした。`
      : req.punch === 'break_start' ? `${t} から休憩を記録しました。` : `${t} に休憩の終わりを記録しました。`;
  }
  if (req.kind === 'balance') {
    const b = await service.balance(tenantId, employee);
    const soon = b.grants.find((g) => g.left > 0 && g.expiresOn > today && g.expiresOn <= shiftDate(today, 92));
    const parts = [`有給の残りは ${b.remaining} 日です。`];
    if (soon) parts.push(`うち ${soon.left} 日は ${md(shiftDate(soon.expiresOn, -1))} で時効になります。`);
    if (b.obligation && b.obligation.taken < b.obligation.required) parts.push(`${md(b.obligation.deadline)} までに、あと ${b.obligation.required - b.obligation.taken} 日取る必要があります。`);
    return parts.join('');
  }
  const date = parseLeaveDate(message, today);
  if (!date) return 'いつ休むかが分かりませんでした。「10月3日に有給で休みます」「来週の金曜、有給で休みます」のように日付を入れてください。';
  if (req.cancel) {
    const b = await service.balance(tenantId, employee);
    const take = b.takes.find((t) => t.status === 'taken' && t.date === date);
    if (!take) return `${md(date)} には有給を取っていません。`;
    const r = await service.cancelLeave(tenantId, userId, employee, take.id, false);
    return 'error' in r ? r.error : `${md(date)} の有給を取り消しました。`;
  }
  const r = await service.requestLeave(tenantId, userId, employee, date, isHalfDay(message) ? 0.5 : 1, 'secretary');
  if ('error' in r) return r.error;
  return `${md(date)} に有給${r.take.days === 0.5 ? '（半日）' : ''}を入れました。残りは ${r.remaining} 日です。人事の担当者に知らせました。`;
}
