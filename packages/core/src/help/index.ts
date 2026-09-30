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
