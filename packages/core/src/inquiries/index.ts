/**
 * @file 問い合わせの記録（内蔵の拡張）の入口。置き場・項目の取り出し・処理・連絡先のつなぎ・見張り・ツール・付属の業務をまとめて出す。
 *
 * @see 仕様書 第33章 問い合わせの記録
 */

export { PostgresInquiryStore, MemoryInquiryStore, type InquiryStore, type InquiryQuery, type InquiryPatch, type NewInquiry, type DueTask, type MailLog, type StoredReply } from './store.js';
export { readInquiry, guessInquiry, dueFrom, hasSensitive, stripSensitive, type InquiryDraft } from './extract.js';
export { InquiryService, inquiriesAccess, sameParty, MAILBOX_ACTOR, LINE_ACTOR, INQUIRY_TEXT_MAX, type InquiryViewer, type InquiryServiceDeps, type RecordResult } from './service.js';
export { contactBookFrom, type InquiryContactBook } from './contacts.js';
export { InquiryWatch, businessDaysAgo, INQUIRY_IDLE_BUSINESS_DAYS, INQUIRY_BODY_DAYS, INQUIRY_REVIEW_HOUR } from './watch.js';
export { INQUIRY_TOOLS, inquiryPath, type InquiryToolContext } from './tools.js';
export { INQUIRY_AGENTS, INQUIRY_RECORD, INQUIRY_LOOKUP, INQUIRY_REPLY_DRAFT, INQUIRY_REPLY_SEND, INQUIRIES_PACKAGE, INQUIRIES_EXTENSION_VERSION } from './agents.js';
export { openMailbox, GoogleMailbox, MockMailbox, MailboxUnavailableError, parseAddress, MAILBOX_KIND, MAILBOX_SCOPES, type Mailbox, type MailItem, type MailboxDeps } from './mailbox.js';
export { readMail, guessMail, sentSummary, type MailReading } from './mail.js';
export { monthStats, monthRange, previousMonth, reviewText } from './review.js';
export { openLine, LineApiClient, MockLineClient, LineUnavailableError, verifyLineSignature, readLine, guessLine, LINE_KIND, LINE_THREAD_DAYS, type LineClient, type LineDeps, type LineReading } from './line.js';
