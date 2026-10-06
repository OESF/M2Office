/**
 * @file 契約の管理（内蔵の拡張。仕様書 第38章）の入口。
 *
 * 日付の足し算（`addDays`・`addMonths`）はほかの拡張と名前が重なるため、ここからは出さない。
 */

export { readContract, readContractByRule, noticeDeadline, noticeDaysOf, renewMonthsOf, kindOf, type ContractReading } from './extract.js';
export * from './store.js';
export * from './service.js';
export * from './tools.js';
export * from './agents.js';
