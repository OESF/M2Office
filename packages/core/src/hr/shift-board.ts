/**
 * @file 日ごとのシフト（時間の帯）と、張り出し用の PDF（仕様書 第30.6.2節「日ごとの表示」「張り出し用の PDF」）。
 *
 * 行が人・横の軸が時刻の表にし、1 時間ごとの人数と要る人数を並べる。時刻の軸は並べたすべての日でそろえ、
 * 印刷したときに日ごとの紙を見比べやすくする。PDF は A4 横で 1 日 1 枚（人が多ければ続きの紙に分ける）。
 */

import { PDFDocument, rgb, type PDFFont, type PDFPage } from 'pdf-lib';
import type { HrShift, HrShiftPlan, HrShiftSettings, ShiftBoard, ShiftBoardDay } from '@m2office/shared';
import { embedJapaneseFonts } from '../files/pdf-render.js';
import { needsOn } from './shift-plan.js';

/** 1 日分の材料（その日を含む期間のシフトと決まり）。 */
export interface ShiftBoardInput {
  date: string;
  status: HrShiftPlan['status'];
  shifts: HrShift[];
  members: { employeeId: string; name: string }[];
  settings: HrShiftSettings;
}

const WEEK = ['日', '月', '火', '水', '木', '金', '土'];

/** 「7:30」を分に。形が違えば `null`。 */
function minutesOf(t: string): number | null {
  const m = /^(\d{1,2}):(\d{2})$/.exec(t);
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
}

/** 始業と終業を分に（終業が始業より前なら翌日の時刻とみなす）。 */
function spanOf(start: string, end: string): { from: number; to: number } | null {
  const from = minutesOf(start);
  let to = minutesOf(end);
  if (from === null || to === null) return null;
  if (to <= from) to += 24 * 60;
  return { from, to };
}

/**
 * 日ごとのシフトを、時間の帯の形にそろえる。
 *
 * 人数と要る人数は、その時間の真ん中（h 時 30 分）にかかる勤務で数える。要る人数は、その時刻にかかる勤務の型の要る人数の和。
 *
 * @param days 並べる日（古い順）
 */
export function buildShiftBoard(days: ShiftBoardInput[]): ShiftBoard {
  let lo = Infinity;
  let hi = -Infinity;
  for (const d of days) {
    for (const s of d.shifts) {
      const sp = s.patternId ? spanOf(s.start, s.end) : null;
      if (sp) { lo = Math.min(lo, sp.from); hi = Math.max(hi, sp.to); }
    }
    for (const n of needsOn(d.date, d.settings)) {
      const p = d.settings.patterns.find((x) => x.id === n.patternId);
      const sp = p ? spanOf(p.start, p.end) : null;
      if (sp) { lo = Math.min(lo, sp.from); hi = Math.max(hi, sp.to); }
    }
  }
  // 勤務が無ければ、ふつうの勤務の時間を軸にする
  const fromHour = Number.isFinite(lo) ? Math.floor(lo / 60) : 9;
  const toHour = Number.isFinite(hi) ? Math.max(Math.ceil(hi / 60), fromHour + 1) : 18;
  return {
    fromHour, toHour,
    days: days.map((d): ShiftBoardDay => {
      const pattern = new Map(d.settings.patterns.map((p) => [p.id, p]));
      const working = d.shifts.filter((s) => s.patternId);
      const name = new Map(d.members.map((m) => [m.employeeId, m.name]));
      const rows = working
        .map((s) => ({ employeeId: s.employeeId, name: name.get(s.employeeId) ?? '', patternName: pattern.get(s.patternId!)?.name ?? null, start: s.start, end: s.end, breakMinutes: s.breakMinutes }))
        .sort((a, b) => (spanOf(a.start, a.end)?.from ?? 0) - (spanOf(b.start, b.end)?.from ?? 0) || a.name.localeCompare(b.name, 'ja'));
      const on = new Set(working.map((s) => s.employeeId));
      const needs = needsOn(d.date, d.settings);
      const hours = [];
      for (let h = fromHour; h < toHour; h++) {
        const at = h * 60 + 30;
        const covers = (start: string, end: string) => { const sp = spanOf(start, end); return !!sp && sp.from <= at && at < sp.to; };
        hours.push({
          hour: h,
          count: rows.filter((r) => covers(r.start, r.end)).length,
          need: needs.reduce((sum, n) => { const p = pattern.get(n.patternId); return sum + (p && covers(p.start, p.end) ? n.count : 0); }, 0),
        });
      }
      return { date: d.date, status: d.status, rows, off: d.members.filter((m) => !on.has(m.employeeId)).map((m) => m.name), hours };
    }),
  };
}

/** 「2026年10月31日（土）」。 */
export function boardDateLabel(date: string): string {
  const [y, m, d] = date.split('-').map(Number) as [number, number, number];
  return `${y}年${m}月${d}日（${WEEK[new Date(`${date}T00:00:00Z`).getUTCDay()]}）`;
}

/** 時刻の目盛りの書き方（24 時を超えたら翌日の時刻に戻す）。 */
const hourLabel = (h: number) => String(h % 24);

/** 張り出し用の PDF に載せるもの。 */
export interface ShiftBoardPdfInput {
  board: ShiftBoard;
  company: string;
  /** 作った日時（紙の下に小さく入れる）。 */
  createdAt: string;
}

const PAGE = { width: 841.89, height: 595.28 };
const MARGIN = 32;
const NAME_W = 110;
const TIME_W = 150;
// 勤務の型ごとの帯の色（印刷して見分けやすい淡い色）
const BAR = [rgb(0.62, 0.8, 0.93), rgb(0.98, 0.78, 0.55), rgb(0.7, 0.87, 0.66), rgb(0.85, 0.76, 0.93), rgb(0.96, 0.7, 0.72), rgb(0.8, 0.8, 0.8)];

/**
 * 日ごとのシフトを、A4 横の PDF にする（1 日 1 枚。人が多ければ続きの紙に分ける）。
 *
 * @returns PDF の中身
 */
export async function renderShiftBoardPdf(input: ShiftBoardPdfInput): Promise<Uint8Array> {
  const pdf = await PDFDocument.create();
  const { font, fit } = await embedJapaneseFonts(pdf, 'regular');
  const { board } = input;
  const first = board.days[0]?.date ?? '';
  const last = board.days[board.days.length - 1]?.date ?? '';
  pdf.setTitle(first === last ? `シフト表 ${boardDateLabel(first)}` : `シフト表 ${boardDateLabel(first)}〜${boardDateLabel(last)}`);
  const ink = rgb(0.1, 0.1, 0.1);
  const muted = rgb(0.42, 0.42, 0.42);
  const warn = rgb(0.72, 0.12, 0.1);
  const span = board.toHour - board.fromHour;
  const gridX = MARGIN + NAME_W;
  const gridW = PAGE.width - MARGIN * 2 - NAME_W - TIME_W;
  const xOf = (minutes: number) => gridX + ((minutes - board.fromHour * 60) / (span * 60)) * gridW;
  const patternIndex = new Map<string, number>();

  const write = (page: PDFPage, t: string, x: number, y: number, size: number, color = ink, right?: number) => {
    const s = fit(t);
    page.drawText(s, { x: right === undefined ? x : right - font.widthOfTextAtSize(s, size), y, size, font, color });
  };
  const clip = (f: PDFFont, t: string, size: number, width: number) => {
    let s = fit(t);
    while (s.length > 1 && f.widthOfTextAtSize(s, size) > width) s = s.slice(0, -1);
    return s;
  };

  for (const day of board.days) {
    const draft = day.status !== 'published';
    // 1 枚に入る行の数（下の人数・要る人数・休みの欄の分を残す）。人が少なければ行を高くして、張り出して読みやすくする
    const room = PAGE.height - MARGIN * 2 - 70 - 90;
    const rowH = Math.min(34, Math.max(20, Math.floor(room / (Math.max(day.rows.length, 1) + 2))));
    const perPage = Math.max(1, Math.floor(room / rowH) - 2);
    const chunks: (typeof day.rows)[] = [];
    for (let i = 0; i < Math.max(day.rows.length, 1); i += perPage) chunks.push(day.rows.slice(i, i + perPage));
    chunks.forEach((rows: ShiftBoardDay['rows'], ci: number) => {
      const page = pdf.addPage([PAGE.width, PAGE.height]);
      const right = PAGE.width - MARGIN;
      let y = PAGE.height - MARGIN - 14;
      write(page, `シフト表　${boardDateLabel(day.date)}${chunks.length > 1 ? `（${ci + 1}/${chunks.length}）` : ''}`, MARGIN, y, 18);
      write(page, input.company, 0, y + 4, 10, muted, right);
      if (draft) write(page, '案（未公開）', 0, y - 12, 11, warn, right);
      y -= 34;

      // 時刻の目盛りと縦の線
      const top = y;
      const bottom = top - rowH * (rows.length || 1) - rowH * 2;
      for (let h = board.fromHour; h <= board.toHour; h++) {
        const x = xOf(h * 60);
        page.drawLine({ start: { x, y: top }, end: { x, y: bottom }, thickness: h % 3 === 0 ? 0.6 : 0.3, color: rgb(0.78, 0.78, 0.78) });
        if (h < board.toHour) write(page, hourLabel(h), x + 2, top + 4, 8, muted);
      }
      page.drawLine({ start: { x: MARGIN, y: top }, end: { x: right, y: top }, thickness: 0.6, color: rgb(0.6, 0.6, 0.6) });

      if (rows.length === 0) {
        write(page, 'この日にシフトに入る人はいません', MARGIN, top - 15, 10, muted);
      }
      rows.forEach((r, i) => {
        const rowTop = top - rowH * i;
        const mid = rowTop - rowH / 2 - 3.5;
        write(page, clip(font, r.name, 10, NAME_W - 8), MARGIN, mid, 10);
        const sp = spanOf(r.start, r.end);
        if (sp) {
          const key = r.patternName ?? '';
          if (!patternIndex.has(key)) patternIndex.set(key, patternIndex.size);
          const x1 = xOf(sp.from);
          const x2 = xOf(sp.to);
          page.drawRectangle({ x: x1, y: rowTop - rowH + 4, width: Math.max(x2 - x1, 1), height: rowH - 8, color: BAR[patternIndex.get(key)! % BAR.length], borderColor: rgb(0.45, 0.45, 0.45), borderWidth: 0.4 });
        }
        const text = `${r.patternName ? `${r.patternName} ` : ''}${r.start}〜${r.end}${r.breakMinutes ? `（休憩 ${r.breakMinutes} 分）` : ''}`;
        write(page, clip(font, text, 9, TIME_W - 8), right - TIME_W + 8, mid, 9);
        page.drawLine({ start: { x: MARGIN, y: rowTop - rowH }, end: { x: right, y: rowTop - rowH }, thickness: 0.3, color: rgb(0.85, 0.85, 0.85) });
      });

      // 1 時間ごとの人数と要る人数（最後の紙だけ）
      const sumTop = top - rowH * (rows.length || 1);
      if (ci === chunks.length - 1) {
        const cell = gridW / span;
        const showNeed = day.hours.some((h) => h.need > 0);
        write(page, '人数', MARGIN, sumTop - rowH / 2 - 3.5, 10);
        if (showNeed) write(page, '要る人数', MARGIN, sumTop - rowH - rowH / 2 - 3.5, 10, muted);
        day.hours.forEach((h) => {
          const x = xOf(h.hour * 60);
          const short = h.count < h.need;
          if (short) page.drawRectangle({ x, y: sumTop - rowH, width: cell, height: rowH, color: rgb(0.99, 0.88, 0.87) });
          write(page, String(h.count), 0, sumTop - rowH / 2 - 3.5, 10, short ? warn : ink, x + cell / 2 + font.widthOfTextAtSize(String(h.count), 10) / 2);
          if (showNeed) write(page, String(h.need), 0, sumTop - rowH - rowH / 2 - 3.5, 9, muted, x + cell / 2 + font.widthOfTextAtSize(String(h.need), 9) / 2);
        });
        page.drawLine({ start: { x: MARGIN, y: sumTop }, end: { x: right, y: sumTop }, thickness: 0.6, color: rgb(0.6, 0.6, 0.6) });
        page.drawLine({ start: { x: MARGIN, y: bottom }, end: { x: right, y: bottom }, thickness: 0.6, color: rgb(0.6, 0.6, 0.6) });
        if (day.hours.some((h) => h.count < h.need)) write(page, '赤い数字は、要る人数に足りない時間です', MARGIN, bottom - 14, 8, warn);

        // 休みの人
        let oy = bottom - 34;
        if (day.off.length) {
          const words = `休み: ${day.off.join('、')}`;
          let line = '';
          for (const ch of words) {
            if (font.widthOfTextAtSize(fit(line + ch), 10) > right - MARGIN) { write(page, line, MARGIN, oy, 10); oy -= 14; line = ''; }
            line += ch;
          }
          if (line) write(page, line, MARGIN, oy, 10);
        }
      }
      write(page, `作成 ${input.createdAt}`, 0, MARGIN - 14, 7, muted, right);
    });
  }
  return pdf.save();
}
