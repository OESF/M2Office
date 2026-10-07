/**
 * @file 名刺管理（内蔵の拡張）の入口。置き場・読み取り・同じ人の見分け・操作・ツール・付属の業務をまとめて出す。
 *
 * @see 仕様書 第27章 名刺管理
 */

export { PostgresContactStore } from './store.js';
export type {
  CardViewer, ContactStore, ContactSummary, ContactQuery, NewCard, BatchProgress, ExpiredCard, CardPatch, ContactPatch,
  SignatureState, SignatureTarget, NewContactChange, ContactChangeQuery,
} from './store.js';
export { CardService, CARD_FILE_MAX_BYTES, CARD_TABLE_MAX_ROWS, MULTIPLE_NOTE, canManage, cardsAccess, dateIn } from './service.js';
export type { CardServiceDeps, CardUpload, AcceptResult, ContactDetail, TableImportResult } from './service.js';
export { mapCardHeaders, mapCardHeadersByWords, cardFromRow, tableDate, exportRow, CARD_EXPORT_COLUMNS, type CardTableField, type CardTableRow, type TableCell } from './table.js';
export { backMatches, backPatch, pairByContentThenPosition, cornersCenter, ORPHAN_BACK_REASON } from './back.js';
export { CARD_PROMPT, CARD_MAX_PER_IMAGE, readCard, parseCardReading, orderCorners, flowRotation, parseLocations, LOCATE_PROMPT, type CardReading, type CardSide, type CardLocation } from './read.js';
export { resolveContact, judgeSamePerson, mergeFields, type IdentityMatch } from './identity.js';
export { detectCardKind, splitCardPdf, CARD_BATCH_MAX, CARD_MIME, type CardFileKind, type CardPage } from './formats.js';
export { toVCard } from './vcard.js';
export { draftThanksMail, templateThanks, type ThanksMail, type ThanksMailInput } from './mail.js';
export { CARD_TOOLS, type CardToolContext } from './tools.js';
export { CARD_AGENTS, CARD_IMPORT, CARD_UPDATE, CARD_BULK_MAIL, CARDS_PACKAGE, CARDS_EXTENSION_VERSION } from './agents.js';
export {
  SignatureWatcher, SIGNATURE_PROMPT, SIGNATURE_RECHECK_MS, SIGNATURE_DAILY_LIMIT, SIGNATURE_BACKFILL_DAYS, SIGNATURE_MAIL_BATCH,
  ownPart, signatureLooksSame, nameMatches, parseSignature, readSignature, signatureChanges, revertPatch, phonesKey, senderAddress,
  type SignatureReading, type SignatureChanges, type SignatureWatcherDeps,
} from './signature.js';
export {
  BulkMailService, PostgresBulkMailStore, BULK_MAX_RECIPIENTS, BULK_DAILY_LIMIT, BULK_GAP_SECONDS, BULK_PLACEHOLDERS,
  renderBulk, adFooter, judgeAdvertising,
  type BulkMail, type BulkMailStatus, type BulkRecipient, type OptOutRecord, type BulkPreview, type BulkPreviewRecipient, type BulkMailStore, type BulkMailServiceDeps,
} from './bulk.js';
