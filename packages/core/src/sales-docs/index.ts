/**
 * @file 販売の書類と受注（内蔵の拡張。仕様書 第42章）の入口。
 *
 * 日付の足し算（`addDays`）はほかの拡張と名前が重なるため、ここからは出さない。
 */

export { docTotals, dueDateFrom, closingDayFrom, closingCutoff, jstToday as salesToday } from './calc.js';
export { readOrder, readOrderByRule, itemsFrom, type OrderReading } from './extract.js';
export { renderSalesDoc, docMarkdown, docTitle, docFileName, numberText, DOC_WORDS } from './render.js';
export * from './store.js';
export * from './service.js';
export * from './tools.js';
export * from './agents.js';
