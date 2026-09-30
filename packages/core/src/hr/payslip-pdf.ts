/**
 * @file 給与明細の PDF（仕様書 第30.10.3節・第30.17節）。画面で受け取る同意の無い人・アカウントの無い人に渡す。
 *
 * A4 の縦 1 枚に、支給と控除を左右に並べ、総支給・控除の計・差引支給と勤怠の集計を出す。根拠は載せない（画面で見られる）。
 * 書体は帳票と同じ同梱の日本語の書体を使う。
 */

import { PDFDocument, rgb } from 'pdf-lib';
import type { PayRun, PaySlip } from '@m2office/shared';
import { embedJapaneseFonts } from '../files/pdf-render.js';

const PAGE = { width: 595.28, height: 841.89 };
const MARGIN = 48;

/** 明細の PDF に載せる会社の名前など。 */
export interface PayslipPdfInput {
  run: Pick<PayRun, 'payMonth' | 'payDate' | 'periodStart' | 'periodEnd' | 'kind'>;
  slip: PaySlip;
  employeeName: string;
  employeeCode?: string;
  company: string;
  /** 題名（給与明細・賞与明細・給与の訂正明細）。無ければ給与明細。 */
  title?: string;
}

const yen = (n: number) => n.toLocaleString('ja-JP');
const hours = (m?: number) => (m === undefined ? '' : `${Math.round((m / 60) * 100) / 100}`);

/**
 * 給与明細の PDF を作る。
 *
 * @returns PDF の中身
 */
export async function renderPayslipPdf(input: PayslipPdfInput): Promise<Uint8Array> {
  const pdf = await PDFDocument.create();
  const { font, fit } = await embedJapaneseFonts(pdf, 'regular');
  const [y0, m0] = input.run.payMonth.split('-');
  const title = input.title ?? '給与明細';
  pdf.setTitle(`${title} ${y0}年${Number(m0)}月支給`);
  const page = pdf.addPage([PAGE.width, PAGE.height]);
  const ink = rgb(0.1, 0.1, 0.1);
  const write = (t: string, x: number, y: number, size = 10, right?: number) => {
    const s = fit(t);
    page.drawText(s, { x: right === undefined ? x : right - font.widthOfTextAtSize(s, size), y, size, font, color: ink });
  };
  const rule = (y: number, x1 = MARGIN, x2 = PAGE.width - MARGIN) => page.drawLine({ start: { x: x1, y }, end: { x: x2, y }, thickness: 0.6, color: rgb(0.6, 0.6, 0.6) });
  const right = PAGE.width - MARGIN;
  let y = PAGE.height - MARGIN;

  write(`${title}　${y0}年${Number(m0)}月支給`, MARGIN, y, 18);
  write(input.company, 0, y, 10, right);
  y -= 30;
  write(`${input.employeeName}　様${input.employeeCode ? `（${input.employeeCode}）` : ''}`, MARGIN, y, 13);
  y -= 18;
  write(input.run.kind === 'bonus' ? `支払日 ${input.run.payDate}` : `支払日 ${input.run.payDate}　計算期間 ${input.run.periodStart} 〜 ${input.run.periodEnd}`, MARGIN, y, 9);
  y -= 22;

  // 勤怠
  const a = input.slip.attendance ?? {};
  const att: [string, string][] = [
    ['出勤日数', a.workDays === undefined ? '' : `${a.workDays} 日`], ['労働時間', a.workMinutes === undefined ? '' : `${hours(a.workMinutes)} 時間`],
    ['時間外', a.overtimeMinutes === undefined ? '' : `${hours(a.overtimeMinutes)} 時間`], ['深夜', a.nightMinutes === undefined ? '' : `${hours(a.nightMinutes)} 時間`],
    ['休日', a.holidayMinutes === undefined ? '' : `${hours(a.holidayMinutes)} 時間`], ['有給', a.leaveDays === undefined ? '' : `${a.leaveDays} 日`],
  ];
  const cw = (right - MARGIN) / att.length;
  rule(y + 12);
  att.forEach(([k, v], i) => { write(k, MARGIN + cw * i + 4, y, 8); write(v, MARGIN + cw * i + 4, y - 14, 10); });
  y -= 24;
  rule(y);
  y -= 22;

  // 支給と控除を左右に
  const half = (right - MARGIN) / 2;
  const pays = input.slip.lines.filter((l) => l.kind === 'pay');
  const deds = input.slip.lines.filter((l) => l.kind === 'deduct');
  write('支給', MARGIN, y, 11);
  write('控除', MARGIN + half + 12, y, 11);
  y -= 6;
  rule(y);
  y -= 16;
  const rows = Math.max(pays.length, deds.length);
  for (let i = 0; i < rows; i++) {
    const p = pays[i];
    const d = deds[i];
    if (p) { write(p.label, MARGIN, y); write(yen(p.amount), 0, y, 10, MARGIN + half - 8); }
    if (d) { write(d.label, MARGIN + half + 12, y); write(yen(d.amount), 0, y, 10, right); }
    y -= 16;
  }
  rule(y + 6);
  y -= 12;
  write('総支給', MARGIN, y, 11);
  write(yen(input.slip.gross), 0, y, 11, MARGIN + half - 8);
  write('控除の計', MARGIN + half + 12, y, 11);
  write(yen(input.slip.deductions), 0, y, 11, right);
  y -= 34;
  page.drawRectangle({ x: MARGIN + half + 4, y: y - 10, width: half - 4, height: 30, borderColor: rgb(0.3, 0.3, 0.3), borderWidth: 0.8 });
  write('差引支給', MARGIN + half + 12, y, 13);
  write(`${yen(input.slip.net)} 円`, 0, y, 14, right - 8);
  return pdf.save();
}
