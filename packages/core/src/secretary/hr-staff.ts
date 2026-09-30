/**
 * @file 秘書から人事の担当者の仕事を頼む（仕様書 第30.20.1節）。給与の計算・労働条件通知書・労務の期限。
 *
 * 推論に選ばせずに決まった言い方で見分け、人事区画の人の依頼にだけその場で答える（H-3）。区画の外の人の依頼は、ふつうの会話に回す。
 * 額は給与の処理（決まったプログラム）が出す。確定は給与の画面で管理者が行う（ADR-0053）。
 */

import type { HrService } from '../hr/service.js';
import type { PayrollService } from '../hr/payroll-service.js';
import type { LaborCalendar } from '../hr/calendar-service.js';

/** 担当者の依頼。 */
export type HrStaffRequest =
  | { kind: 'calculate'; month: string }
  | { kind: 'notice'; name: string }
  | { kind: 'deadlines' };

/** 秘書が担当者の依頼に答えるのに要るもの。 */
export interface HrStaffDeps {
  service: HrService;
  payroll: PayrollService;
  calendar: LaborCalendar;
  /** 人事・給与を使っていて、人事区画に入っているか。 */
  access(tenantId: string, userId: string): Promise<unknown>;
}

const shift = (ym: string, n: number) => {
  const [y, m] = ym.split('-').map(Number) as [number, number];
  const t = y * 12 + (m - 1) + n;
  return `${Math.floor(t / 12)}-${String((t % 12) + 1).padStart(2, '0')}`;
};

/**
 * 担当者の依頼を見分ける。
 *
 * @param today 日本時間の今日（YYYY-MM-DD）
 * @returns 担当者の依頼でなければ `null`
 */
export function hrStaffRequest(message: string, today: string): HrStaffRequest | null {
  const m = message.normalize('NFKC').replace(/\s+/g, '');
  if (/(方法|やり方|どうやって|とは|仕組み)/.test(m)) return null;
  if (/(給与|給料)を?(計算|出して|作って)/.test(m) && !/明細/.test(m)) {
    const ym = today.slice(0, 7);
    const n = m.match(/(\d{1,2})月/);
    const month = /来月/.test(m) ? shift(ym, 1) : /先月/.test(m) ? shift(ym, -1)
      : n && Number(n[1]) >= 1 && Number(n[1]) <= 12 ? `${ym.slice(0, 4)}-${String(Number(n[1])).padStart(2, '0')}` : ym;
    return { kind: 'calculate', month };
  }
  const notice = m.match(/^(.*?)(?:さん|くん|君|氏|様)?の?労働条件通知書/);
  if (notice) return { kind: 'notice', name: (notice[1] ?? '').replace(/^(新しく入る|来月入社の|今度入る)/, '') };
  if (/労務(の期限|カレンダー)|(人事|労務|社会保険|源泉|住民税|年度更新|算定基礎)の?(期限|締切|いつまで)|(納付|届出)の期限/.test(m)) return { kind: 'deadlines' };
  return null;
}

const yen = (n: number) => `${n.toLocaleString('ja-JP')} 円`;
const label = (ym: string) => `${Number(ym.slice(0, 4))} 年 ${Number(ym.slice(5, 7))} 月支給`;
const WEEK = '日月火水木金土';
const day = (d: string) => `${Number(d.slice(5, 7))}/${Number(d.slice(8, 10))}（${WEEK[new Date(`${d}T00:00:00Z`).getUTCDay()]}）`;

/**
 * 担当者の依頼に答える。
 *
 * @remarks 危険度: write-internal（給与の下書きを作る。確定はしない）
 */
export async function answerHrStaff(deps: HrStaffDeps, tenantId: string, userId: string, req: HrStaffRequest): Promise<string> {
  if (req.kind === 'calculate') {
    const r = await deps.payroll.calculate(tenantId, userId, req.month);
    if ('error' in r) return `${label(req.month)}の給与は計算できませんでした（${r.error}）。`;
    const net = r.slips.reduce((s, x) => s + x.net, 0);
    const stops = r.run.checks.filter((c) => c.level === 'stop');
    const checks = r.run.checks.length - stops.length;
    const head = `${label(req.month)}の給与を計算しました（下書き）。${r.slips.length} 人・差引支給の計 ${yen(net)}です。`;
    const stopText = stops.length
      ? `止まっているものが ${stops.length} 件あります: ${stops.slice(0, 3).map((c) => `${c.employeeName ? `${c.employeeName} ` : ''}${c.text}`).join('／')}${stops.length > 3 ? ' ほか' : ''}。`
      : '止まっているものはありません。';
    return `${head}${stopText}確かめることは ${checks} 件です。「人事・給与」の「給与」で点検を見て、管理者が確定します。`;
  }
  if (req.kind === 'notice') {
    if (!req.name) return 'どなたの労働条件通知書を作りますか。お名前を添えて頼んでください。';
    const key = req.name.normalize('NFKC').replace(/\s/g, '');
    const list = (await deps.service.list(tenantId, userId)).filter((e) => e.name.normalize('NFKC').replace(/\s/g, '').includes(key) || (e.kana && e.kana.normalize('NFKC').replace(/\s/g, '').includes(key)));
    if (list.length === 0) return `人事の台帳に「${req.name}」さんが見つかりません。`;
    if (list.length > 1) return `「${req.name}」に当たる人が ${list.length} 人います（${list.slice(0, 5).map((e) => e.name).join('、')}）。フルネームで頼んでください。`;
    const e = list[0]!;
    const doc = await deps.service.termsNotice(tenantId, userId, e.id);
    if (!doc) return `${e.name}さんの雇用条件がまだありません。台帳で雇用条件を入れてから作れます。`;
    const place = `「人事・給与」で${e.name}さんを開き、「労働条件通知書」から PDF を作れます。`;
    const notes = doc.notes.length ? `${doc.notes.join('。')}。` : '';
    return doc.missing.length
      ? `${e.name}さんの労働条件通知書は、足りない事項が ${doc.missing.length} 個あります（${doc.missing.join('、')}）。足りない事項は空欄で出ます。${notes}${place}`
      : `${e.name}さんの労働条件通知書は、明示が要る事項がそろっています。${notes}${place}`;
  }
  const items = await deps.calendar.list(tenantId, 30);
  if (items.length === 0) return '30 日以内の労務の期限はありません。';
  const lines = items.slice(0, 12).map((d) => `- ${day(d.date)} ${d.title}${d.overdue ? '（過ぎています）' : ''}`);
  return `30 日以内の労務の期限です。\n${lines.join('\n')}${items.length > 12 ? `\nほか ${items.length - 12} 件は「人事・給与」の「期限」で見られます。` : ''}`;
}
