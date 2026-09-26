/**
 * @file 拡張機能の部品の公開窓口。
 *
 * @see 仕様書 第12.9節 拡張機能の読み込みと導入
 * @see 仕様書 第12.10節 持ち運べる拡張機能
 * @see 仕様書 第12.11節 コネクタ（L2）の実装
 */

export {
  loadExtensions, loadExtension, loadExtensionFiles, readExtensionDir, isAllowedExtensionFile,
  type ExtensionManifest, type ExtensionPackage, type ExtensionFiles, type LoadResult, type LoadOptions,
} from './loader.js';
export {
  checkConnector, connectorTools, connectorToolName, CONNECTOR_AUTH_TYPES,
  type ConnectorDeclaration, type ConnectorToolDeclaration, type ConnectorAuthType,
} from './connectors.js';
export { packExtension, unpackExtension, EXTENSION_FILE_MAX_BYTES } from './package-file.js';
export {
  buildSkillPackage, compileSkill, parseInputs, parseSkill, SKILL_DEFAULT_TOOLS, SKILL_REFERENCE_MAX_CHARS,
  type Frontmatter, type SkillPackage,
} from './skill.js';
export {
  ExtensionHub, consentSnapshot, decodeFiles, encodeFiles, blockedByDisabledTool,
  type TenantExtensions, type ExtensionEntry, type ConsentSnapshot, type ExtensionHubDeps,
} from './hub.js';
