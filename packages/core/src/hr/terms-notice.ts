/**
 * @file 労働条件通知書（仕様書 第30.5.3節）。雇用条件と会社の設定から、労働基準法の明示事項を満たす通知書を決まったプログラムで作る。
 *
 * 推論に書かせない。台帳と設定に無い事項は「足りない事項」として返し、PDF では手で書けるよう空欄の行にする。
 * パートと有期の人には、昇給・賞与・退職手当の有無と相談の窓口（パートタイム・有期雇用労働法）も求める。
 */

import { PDFDocument, rgb } from 'pdf-lib';
import type { HrEmployee, HrNoticeSettings, HrSettings, HrTerms } from '@m2office/shared';
import { embedJapaneseFonts } from '../files/pdf-render.js';

/** 通知書の 1 事項。 */
export interface NoticeItem {
  label: string;
  /** 載せる文（無ければ空。空なら手で書く欄にする）。 */
  value: string;
  /** 法で明示が要るのに、台帳と設定に無い。 */
  missing: boolean;
}

/** 通知書の中身。 */
export interface TermsNoticeDoc {
  company: string;
  address: string;
  employeeName: string;
  issuedOn: string;
  items: NoticeItem[];
  /** 足りない事項の名前。 */
  missing: string[];
  /** 気をつけること（無期転換など）。 */
  notes: string[];
}

/** 作るのに要るもの。 */
export interface TermsNoticeInput {
  employee: HrEmployee;
  terms: HrTerms;
  settings: HrSettings;
  /** 会社の定め（担当者がこの場で書いたものを優先する）。 */
  notice: HrNoticeSettings;
  company: string;
  issuedOn: string;
}

const WEEK = '日月火水木金土';
const yen = (n: number) => `${n.toLocaleString('ja-JP')} 円`;
const WAGE: Record<HrTerms['wageType'], string> = { monthly: '月給', daily: '日給', hourly: '時給' };

/** 5 年を超えるか（無期転換の申込みの機会が生まれうる）。 */
function overFiveYears(from: string | null, to: string | null): boolean {
  if (!from || !to) return false;
  const [y, m, d] = from.split('-').map(Number) as [number, number, number];
  return to > new Date(Date.UTC(y + 5, m - 1, d)).toISOString().slice(0, 10);
}

/**
 * 労働条件通知書の中身を作る。
 */
export function buildTermsNotice(input: TermsNoticeInput): TermsNoticeDoc {
  const { employee: e, terms: t, settings: s, notice: n } = input;
  const items: NoticeItem[] = [];
  const add = (label: string, value: string, required: boolean) => items.push({ label, value: value.trim(), missing: required && !value.trim() });
  const fixedTerm = !!t.contractEnd;
  const partOrFixed = fixedTerm || e.employment === 'part' || e.employment === 'arbeit';

  add('契約期間', fixedTerm ? `期間の定めあり（${t.contractStart ?? e.hiredOn ?? ''} 〜 ${t.contractEnd}）` : '期間の定めなし', true);
  if (fixedTerm) {
    add('契約の更新の有無と判断の基準', t.renewal, true);
    add('更新の上限（通算の契約期間か更新の回数）', t.renewalLimit, true);
  }
  if (t.probationUntil) add('試用期間', `${e.hiredOn ?? ''} 〜 ${t.probationUntil}`, false);
  add('就業の場所（雇入れ直後）', t.workplace, true);
  add('就業の場所の変更の範囲', t.workplaceScope, true);
  add('従事すべき業務（雇入れ直後）', t.work, true);
  add('従事すべき業務の変更の範囲', t.workScope, true);
  add('始業・終業の時刻', t.startTime && t.endTime ? `${t.startTime} 〜 ${t.endTime}` : '', true);
  add('休憩時間', t.breakMinutes !== null ? `${t.breakMinutes} 分` : '', true);
  add('所定時間外労働の有無', s.agreement.enabled ? '有（時間外労働・休日労働に関する協定の範囲内）' : '無', true);
  const off = [0, 1, 2, 3, 4, 5, 6].filter((d) => !s.work.weekdays.includes(d)).map((d) => WEEK[d]).join('・');
  add('休日', [off ? `毎週 ${off}曜日` : '', s.work.nationalHolidays ? '国民の祝日' : '', `法定休日は ${WEEK[s.work.legalHoliday]}曜日`].filter(Boolean).join('、'), true);
  add('休暇', `年次有給休暇（6 か月継続して勤務し、全労働日の 8 割以上出勤したときに付与。付与の日数は法定どおり${t.weeklyDays !== null && t.weeklyDays < 5 && (t.weeklyHours ?? 40) < 30 ? '・所定労働日数に応じた比例付与' : ''}）${s.leave.halfDay ? '。半日単位で取得できる' : ''}`, true);
  const wage = t.wageAmount !== null ? `${WAGE[t.wageType]} ${yen(t.wageAmount)}` : '';
  add('基本の賃金', wage, true);
  add('諸手当', t.allowances.map((a) => `${a.name} ${yen(a.amount)}`).join('、') || 'なし', false);
  const p = s.payroll.premiums;
  add('所定時間外・休日・深夜の割増賃金率', `法定時間外 ${p.overtime}%（月 60 時間を超える分 ${p.over60}%）、法定休日 ${p.holiday}%、深夜 ${p.night}%`, true);
  const closing = s.pay.closingDay >= 31 ? '末日' : `${s.pay.closingDay} 日`;
  const payDay = s.pay.payDay >= 31 ? '末日' : `${s.pay.payDay} 日`;
  add('賃金の締切日・支払日', `毎月 ${closing}締め、${s.pay.payMonth === 'next' ? '翌月' : '当月'} ${payDay}支払`, true);
  add('賃金の支払方法', '本人の同意を得て、本人名義の預金口座への振込', false);
  add('賃金からの控除', '所得税・住民税・社会保険料・雇用保険料（法令に定めるもの）', false);
  add('昇給', n.raise, partOrFixed);
  add('賞与', n.bonus, partOrFixed);
  add('退職手当', n.severance, partOrFixed);
  add('退職に関する事項（解雇の事由を含む）', n.retirement, true);
  if (partOrFixed) add('雇用管理の改善等に関する相談窓口', n.consultation, true);
  const ins = [t.socialInsurance ? '健康保険・厚生年金保険' : '', t.employmentInsurance ? '雇用保険' : ''].filter(Boolean).join('・');
  add('社会保険・雇用保険の加入', ins || '加入しない', false);
  if (n.other.trim()) add('その他', n.other, false);

  const notes: string[] = [];
  if (fixedTerm && overFiveYears(e.hiredOn, t.contractEnd)) {
    notes.push('入社から契約の終わりまでが 5 年を超えます。無期転換の申込みの機会と、転換後の労働条件も明示が要ります');
  }
  return {
    company: input.company, address: s.office.address, employeeName: e.name, issuedOn: input.issuedOn, items,
    missing: items.filter((i) => i.missing).map((i) => i.label), notes,
  };
}

const PAGE = { width: 595.28, height: 841.89 };
const MARGIN = 48;

/**
 * 労働条件通知書の PDF を作る。足りない事項は手で書ける空欄にする。
 *
 * @returns PDF の中身
 */
export async function renderTermsNoticePdf(doc: TermsNoticeDoc): Promise<Uint8Array> {
  const pdf = await PDFDocument.create();
  const { font, fit } = await embedJapaneseFonts(pdf, 'regular');
  pdf.setTitle('労働条件通知書');
  let page = pdf.addPage([PAGE.width, PAGE.height]);
  const ink = rgb(0.1, 0.1, 0.1);
  const right = PAGE.width - MARGIN;
  const labelW = 170;
  let y = PAGE.height - MARGIN;
  const write = (t: string, x: number, size = 10, alignRight?: number) => {
    const s = fit(t);
    page.drawText(s, { x: alignRight === undefined ? x : alignRight - font.widthOfTextAtSize(s, size), y, size, font, color: ink });
  };
  /** 幅に収まるように折り返す（字ごと）。 */
  const wrap = (t: string, width: number, size: number) => {
    const out: string[] = [];
    let line = '';
    for (const ch of fit(t)) {
      if (font.widthOfTextAtSize(line + ch, size) > width) { out.push(line); line = ''; }
      line += ch;
    }
    if (line) out.push(line);
    return out.length ? out : [''];
  };
  const feed = (need: number) => {
    if (y - need >= MARGIN) return;
    page = pdf.addPage([PAGE.width, PAGE.height]);
    y = PAGE.height - MARGIN;
  };

  write('労働条件通知書', MARGIN, 18);
  write(`${doc.issuedOn.slice(0, 4)} 年 ${Number(doc.issuedOn.slice(5, 7))} 月 ${Number(doc.issuedOn.slice(8, 10))} 日`, 0, 10, right);
  y -= 28;
  write(`${doc.employeeName}　殿`, MARGIN, 13);
  y -= 18;
  write(`事業場の名称 ${doc.company}`, MARGIN, 10);
  y -= 14;
  if (doc.address) { write(`所在地 ${doc.address}`, MARGIN, 10); y -= 14; }
  y -= 8;
  for (const it of doc.items) {
    const lines = it.value ? wrap(it.value, right - MARGIN - labelW - 8, 10) : ['', ''];
    const h = Math.max(lines.length, 1) * 14 + 8;
    feed(h);
    page.drawLine({ start: { x: MARGIN, y: y + 12 }, end: { x: right, y: y + 12 }, thickness: 0.5, color: rgb(0.7, 0.7, 0.7) });
    wrap(it.label, labelW - 6, 9).forEach((l, i) => { const keep = y; y -= i * 12; write(l, MARGIN, 9); y = keep; });
    lines.forEach((l, i) => {
      const keep = y;
      y -= i * 14;
      if (it.value) write(l, MARGIN + labelW, 10);
      else page.drawLine({ start: { x: MARGIN + labelW, y: y - 2 }, end: { x: right, y: y - 2 }, thickness: 0.4, color: rgb(0.5, 0.5, 0.5) });
      y = keep;
    });
    y -= h;
  }
  // 就業規則の有無は会社ごとに違う（10 人未満は作る義務が無い）ため、「就業規則による」とは書かない。要れば「その他」に書く
  page.drawLine({ start: { x: MARGIN, y: y + 12 }, end: { x: right, y: y + 12 }, thickness: 0.5, color: rgb(0.7, 0.7, 0.7) });
  return pdf.save();
}
