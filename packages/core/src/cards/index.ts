/**
 * @file 名刺管理（内蔵の拡張）の入口。置き場・読み取り・同じ人の見分け・操作・道具・付属の業務をまとめて出す。
 *
 * @see 仕様書 第27章 名刺管理
 */

export { PostgresContactStore } from './store.js';
export type {
  CardViewer, ContactStore, ContactSummary, ContactQuery, NewCard, BatchProgress, ExpiredCard, CardPatch, ContactPatch,
} from './store.js';
export { CardService, CARD_FILE_MAX_BYTES, MULTIPLE_NOTE, canManage, cardsAccess, dateIn } from './service.js';
export type { CardServiceDeps, CardUpload, AcceptResult, ContactDetail } from './service.js';
export { CARD_PROMPT, CARD_MAX_PER_IMAGE, readCard, parseCardReading, orderCorners, flowRotation, parseLocations, LOCATE_PROMPT, type CardReading, type CardSide, type CardLocation } from './read.js';
export { resolveContact, judgeSamePerson, mergeFields, type IdentityMatch } from './identity.js';
export { detectCardKind, splitCardPdf, CARD_BATCH_MAX, CARD_MIME, type CardFileKind, type CardPage } from './formats.js';
export { toVCard } from './vcard.js';
export { draftThanksMail, templateThanks, type ThanksMail, type ThanksMailInput } from './mail.js';
export { CARD_TOOLS, type CardToolContext } from './tools.js';
export { CARD_AGENTS, CARD_IMPORT, CARD_UPDATE, CARDS_PACKAGE, CARDS_EXTENSION_VERSION } from './agents.js';
