/**
 * @file 給与所得の源泉徴収票（本人交付用）の PDF（仕様書 第30.15.1節）。
 *
 * 法定の記載事項（支払を受ける者・種別・支払金額・給与所得控除後の金額・所得控除の額の合計額・源泉徴収税額・控除対象配偶者の有無と
 * 配偶者（特別）控除の額・扶養親族の数・障害者の数・社会保険料等の金額・生命保険料と地震保険料の控除額・住宅借入金等特別控除の額・支払者）を、
 * 表の形で載せる。公式の様式と同じ配置かは監修で確かめる。マイナンバーは載せない（持たない。第30.26.2節）。
 */

import { PDFDocument, rgb } from 'pdf-lib';
import type { HrEmployee, YeaResult } from '@m2office/shared';
import { embedJapaneseFonts } from '../files/pdf-render.js';

/** 源泉徴収票に載せるもの。年末調整をしなかった人は `result` が無く、年の集計だけを載せる。 */
export interface WithholdingPdfInput {
  year: number;
  employee: Pick<HrEmployee, 'name' | 'kana' | 'address' | 'birthDate' | 'hiredOn' | 'leftOn'>;
  result: YeaResult | null;
  totals: { pay: number; social: number; tax: number } | null;
  payer: { name: string; address: string };
}

const PAGE = { width: 595.28, height: 841.89 };
const MARGIN = 48;
const yen = (n: number | null | undefined) => (n === null || n === undefined ? '' : `${n.toLocaleString('ja-JP')} 円`);

/**
 * 源泉徴収票（本人交付用）の PDF を作る。
 */
export async function renderWithholdingPdf(input: WithholdingPdfInput): Promise<Uint8Array> {
  const pdf = await PDFDocument.create();
  const { font, fit } = await embedJapaneseFonts(pdf, 'regular');
  pdf.setTitle(`${input.year} 年分 給与所得の源泉徴収票`);
  const page = pdf.addPage([PAGE.width, PAGE.height]);
  const ink = rgb(0.1, 0.1, 0.1);
  const right = PAGE.width - MARGIN;
  let y = PAGE.height - MARGIN;
  const write = (t: string, x: number, size = 10, alignRight?: number) => {
    const s = fit(t);
    page.drawText(s, { x: alignRight === undefined ? x : alignRight - font.widthOfTextAtSize(s, size), y, size, font, color: ink });
  };
  const r = input.result;
  write(`${input.year} 年分　給与所得の源泉徴収票`, MARGIN, 16);
  y -= 16;
  write('（受給者交付用）', MARGIN, 9);
  y -= 24;

  const rows: [string, string][] = [
    ['支払を受ける者（住所）', input.employee.address || ''],
    ['支払を受ける者（氏名）', `${input.employee.name}${input.employee.kana ? `（${input.employee.kana}）` : ''}`],
    ['種別', '給料・賞与'],
    ['支払金額', yen(r ? r.pay : input.totals?.pay)],
    ['給与所得控除後の金額（調整控除後）', r ? yen(r.afterDeduction) : ''],
    ['所得控除の額の合計額', r ? yen(r.deductionTotal) : ''],
    ['源泉徴収税額', yen(r ? r.annualTax : input.totals?.tax)],
    ['控除対象配偶者の有無等', r ? { none: '無', general: '有', elderly: '有（老人）', special: '配偶者特別控除' }[r.counts.spouse] : ''],
    ['配偶者（特別）控除の額', r ? yen(r.deductions.spouse + r.deductions.spouseSpecial) : ''],
    ['控除対象扶養親族の数', r ? `特定 ${r.counts.specific} 人・老人 ${r.counts.elderly} 人（うち同居 ${r.counts.elderlyCohabiting} 人）・その他 ${r.counts.general} 人` : ''],
    ['16 歳未満の扶養親族の数', r ? `${r.counts.under16} 人` : ''],
    ['障害者の数（本人を除く）', r ? `特別 ${r.counts.disabilitySpecial} 人（うち同居 ${r.counts.disabilitySpecialCohabiting} 人）・その他 ${r.counts.disabilityGeneral} 人` : ''],
    ['社会保険料等の金額', yen(r ? r.deductions.social + r.deductions.smallBusiness : input.totals?.social)],
    ['生命保険料の控除額', r ? yen(r.deductions.life) : ''],
    ['地震保険料の控除額', r ? yen(r.deductions.earthquake) : ''],
    ['住宅借入金等特別控除の額', r ? yen(r.housingCredit) : ''],
    ['特定親族特別控除の額', r ? yen(r.deductions.specificRelative) : ''],
    ['所得金額調整控除額', r ? yen(r.incomeAdjustment) : ''],
    ['中途就職・退職', [input.employee.hiredOn?.startsWith(String(input.year)) ? `就職 ${input.employee.hiredOn}` : '', input.employee.leftOn?.startsWith(String(input.year)) ? `退職 ${input.employee.leftOn}` : ''].filter(Boolean).join('・')],
    ['摘要', r ? (r.payPrevious > 0 ? `前職分を含む（前職の支払金額 ${yen(r.payPrevious)}）` : '') : '年末調整をしていません'],
    ['受給者の生年月日', input.employee.birthDate ?? ''],
    ['支払者（住所）', input.payer.address],
    ['支払者（氏名又は名称）', input.payer.name],
  ];
  const labelW = 200;
  for (const [k, v] of rows) {
    page.drawLine({ start: { x: MARGIN, y: y + 13 }, end: { x: right, y: y + 13 }, thickness: 0.5, color: rgb(0.7, 0.7, 0.7) });
    write(k, MARGIN, 9);
    write(v, MARGIN + labelW, 10);
    y -= 20;
  }
  page.drawLine({ start: { x: MARGIN, y: y + 13 }, end: { x: right, y: y + 13 }, thickness: 0.5, color: rgb(0.7, 0.7, 0.7) });
  y -= 10;
  write('個人番号は記載していません（M2Office は個人番号を扱いません）。', MARGIN, 8);
  return pdf.save();
}
