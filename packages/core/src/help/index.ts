/**
 * @file ヘルプの部品の公開窓口。
 *
 * @see 仕様書 第6.10節 ヘルプと案内
 */

export { buildAgentHelp, agentHelpMarkdown, type AgentHelpView } from './agent-help.js';
export {
  HelpCatalog, parseArticle, parseManual, audiencesFor, helpTerms, helpConcepts, HELP_CATEGORIES,
  type HelpArticle, type HelpAudience, type HelpCategory, type HelpHit, type HelpContext, type HelpScope, type ManualMeta,
} from './articles.js';
export {
  HelpFeedback, PostgresHelpFeedbackStore, MemoryHelpFeedbackStore, HELP_FEEDBACK_LIMITS, missKey, summarizeMisses, summarizeRatings,
  type HelpFeedbackStore, type HelpMissSummary, type HelpRatingSummary, type HelpRatingSource,
} from './feedback.js';
export { PostgresHelpNoteStore, MemoryHelpNoteStore, HELP_NOTE_MAX, noteText, type HelpNote, type HelpNoteStore } from './notes.js';
export { suggestHelpNote, NOTE_BLANK, type NoteCandidate, type NoteSuggestion } from './suggest.js';
