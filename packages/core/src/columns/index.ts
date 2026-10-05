/**
 * @file Web のコラム（内蔵の拡張）の入口。置き場・書く・赤入れ・WordPress・操作・ツール・付属の業務をまとめて出す。
 *
 * @see 仕様書 第32章 Web のコラム
 */

export { PostgresColumnStore, MemoryColumnStore, type ColumnStore, type NewColumnVersion } from './store.js';
export { ruleReview, aiReview, mergeReview } from './review.js';
export { inferRuleSets, guessRuleSets, type RuleClues } from './rules.js';
export { writeColumn, rewriteColumn, parseDraft, selfReferenceRule, ColumnWriteError, type ColumnBrief, type ColumnDraft } from './writer.js';
export { checkWordPress, createWordPressDraft, uploadWordPressMedia, columnHtml, normalizeSiteUrl, setWordPressStatus, getWordPressPost, type WordPressAuth } from './wordpress.js';
export {
  renderCover, coverSvg, wrapTitle, pickPattern, fallbackColor, readableColor, tint, brightness, wantsDark, imageWish, brandColor, illustrationPrompt, checkIllustration, describePhoto, choosePhoto,
  COVER_WIDTH, COVER_HEIGHT, COVER_AI_MODEL, COVER_AI_TRIES, COVER_AI_MONTHLY_LIMIT, COVER_MIN_BRIGHTNESS, COVER_MIN_PHOTO_BRIGHTNESS, COVER_PATTERNS, type CoverInput, type CoverPattern,
} from './cover.js';
export { ColumnService, webColumnsAccess, finalMarkdown, COLUMN_PHOTO_MAX_BYTES, type CoverRequest, type ColumnServiceDeps, type ColumnViewer, type ColumnDetail, type ColumnPreview } from './service.js';
export { COLUMN_TOOLS, type ColumnToolContext } from './tools.js';
export { monthSlots, slotTime, plainThemes, writeThemes, normalizeTheme, overlapRatio, similarityReview, type ThemeMaterials } from './plan.js';
export { ColumnPlanner, columnPublicUrl, type ColumnPlannerDeps, type ColumnThemeMaterials, type PastePageColumn } from './planner.js';
export { WEB_COLUMN_AGENTS, WEB_COLUMN_DRAFT, WEB_COLUMN_PLACE, WEB_COLUMN_COVER, WEB_COLUMN_RULES, WEB_COLUMN_SIGNAGE, WEB_COLUMN_SIGNAGE_PUBLISH, WEB_COLUMNS_PACKAGE, WEB_COLUMNS_EXTENSION_VERSION } from './agents.js';
export { columnMaterialsFrom } from './materials.js';
export { PostgresColumnSignageStore, MemoryColumnSignageStore, type ColumnSignageStore, type StoredColumnSignage, type ColumnSignagePatch } from './signage-store.js';
export {
  ColumnSignageService, signageForColumns, planScenes, scenePrompt, slideSvg, signageDigest, cleanCaption, SIGNAGE_SIZE,
  type ColumnSignageDeps, type ColumnSignageOutlet, type ColumnSignageViewer, type SlideInput, type SignageSide,
} from './signage.js';
