/**
 * @file Web の分析（内蔵の拡張。仕様書 第34章）の入口。
 */

export { WebReviewService, webReviewAccess, plainReport as plainWebReport, writeReport as writeWebReport, accessRequestDraft, type WebReviewServiceDeps, type WebReviewViewer, type ReportText } from './service.js';
export { PostgresWebReviewStore, MemoryWebReviewStore, type WebReviewStore, type NewWebReviewReport } from './store.js';
export { GoogleWebData, MockWebData, WebDataError, openWebData, WEB_REVIEW_KIND, type WebData, type WebDataDeps, type WebProperty, type WebSite } from './data.js';
export { monthFigures, answerAsk, checkAsk, periodRange, pickSite, hostOf, shiftMonth, lastMonthOf, changeRate, type WebAsk, type WebAnswer } from './figures.js';
export { WEB_REVIEW_TOOLS, type WebReviewToolContext } from './tools.js';
export { WEB_REVIEW_AGENTS, WEB_REVIEW_PACKAGE, WEB_REVIEW_ASK, WEB_REVIEW_REQUEST } from './agents.js';
export { findIssues, writeSuggestions, requestDraftFor, rankBand, pathOf, type FindingDraft, type FindTarget } from './findings.js';
export { webReviewColumnsFrom, type WebReviewColumns } from './columns.js';
