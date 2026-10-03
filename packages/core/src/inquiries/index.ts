/**
 * @file 問い合わせの記録（内蔵の拡張）の入口。置き場・項目の取り出し・処理・連絡先のつなぎ・見張り・ツール・付属の業務をまとめて出す。
 *
 * @see 仕様書 第33章 問い合わせの記録
 */

export { PostgresInquiryStore, MemoryInquiryStore, type InquiryStore, type InquiryQuery, type InquiryPatch, type NewInquiry, type DueTask } from './store.js';
export { readInquiry, guessInquiry, dueFrom, hasSensitive, stripSensitive, type InquiryDraft } from './extract.js';
export { InquiryService, inquiriesAccess, INQUIRY_TEXT_MAX, type InquiryViewer, type InquiryServiceDeps, type RecordResult } from './service.js';
export { contactBookFrom, type InquiryContactBook } from './contacts.js';
export { InquiryWatch, businessDaysAgo, INQUIRY_IDLE_BUSINESS_DAYS, INQUIRY_BODY_DAYS } from './watch.js';
export { INQUIRY_TOOLS, inquiryPath, type InquiryToolContext } from './tools.js';
export { INQUIRY_AGENTS, INQUIRY_RECORD, INQUIRY_LOOKUP, INQUIRIES_PACKAGE, INQUIRIES_EXTENSION_VERSION } from './agents.js';
