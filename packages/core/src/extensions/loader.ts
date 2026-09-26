/**
 * @file 拡張機能の読み込みと検証。業務エージェント（L1）とコネクタ（L2）の宣言を読む。
 *
 * 拡張機能は「ファイルの集まり」として検証する。ディレクトリ（公式の配布元）から読んでも、
 * `.m2ext` ファイル（管理者の取り込み）から読んでも、同じ検証を通る。
 * 第三者のコードは読み込まない。読むのは宣言的な定義（JSON）と説明（Markdown・画像）だけである（不変則 I-7）。
 *
 * @see 仕様書 第12.9節 拡張機能の読み込みと導入
 * @see 仕様書 第12.10節 持ち運べる拡張機能
 * @see 開発者マニュアル docs/developer/
 */

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { RISK_LEVELS, RISK_ORDER, type AgentDefinition, type EvalCase, type RiskLevel } from '@m2office/shared';
import type { ToolRegistry } from '../tools/registry.js';
import { validateDefinition } from '../engine/validate.js';
import { buildSkillPackage, type SkillPackage } from './skill.js';
import {
  checkConnector, connectorToolName, connectorTools, type ConnectorDeclaration,
} from './connectors.js';

/** 拡張機能のマニフェスト（仕様書 第12.3節）。 */
export interface ExtensionManifest {
  /** 拡張機能の ID。逆ドメイン名の形を推奨する（例: `jp.example.hello-world`）。 */
  id: string;
  name: string;
  /** セマンティックバージョニング（例: `1.0.0`）。 */
  version: string;
  description?: string;
  publisher: { name: string; verified?: boolean };
  /** 対応するエージェント定義スキーマの版の範囲（例: `>=1 <2`）。 */
  platform_schema: string;
  permissions: {
    /** 使ってよいツール。定義はこの中のツールだけを使える。コネクタのツールは `<コネクタの ID>.<名前>`。 */
    tools: string[];
    /** 扱う最大の危険度。定義のツールもコネクタのツールもこれを超えられない。 */
    max_risk_level: RiskLevel;
  };
}

/** 拡張機能を構成するファイル。キーはパッケージの中のパス（`/` 区切り）。 */
export type ExtensionFiles = Map<string, Uint8Array>;

/** 読み込んだ拡張機能。 */
export interface ExtensionPackage {
  manifest: ExtensionManifest;
  /** 業務エージェント。ID は `<拡張機能の ID>:<定義の ID>` に置き換え済み。 */
  agents: AgentDefinition[];
  /** コネクタの宣言（仕様書 第12.11節）。 */
  connectors: ConnectorDeclaration[];
  /** 管理者向けの説明（`README.md`）。 */
  readme: string | null;
  /** アイコン（`icon.png`）。`data:` URL。 */
  icon: string | null;
  /** 読み込んだディレクトリ。ファイルから取り込んだものは `null`。 */
  dir: string | null;
}

/** 読み込みの結果。検証を通らなかった拡張機能は `errors` に入る。 */
export interface LoadResult {
  packages: ExtensionPackage[];
  errors: { dir: string; problems: string[] }[];
}

/** 読み込みの条件。 */
export interface LoadOptions {
  /** すでに使われている業務エージェントの ID（公式の業務エージェントと、ほかの拡張機能）。 */
  takenAgents?: Iterable<string>;
  /** すでに使われているコネクタの ID（ほかの拡張機能）。 */
  takenConnectors?: Iterable<string>;
}

/** パッケージに入れてよいファイル（仕様書 第12.10.2節）。これ以外は拒否する。 */
const ALLOWED_FILES = [
  // スキルの形式（第12.12節）。資料は Markdown・テキストだけ（プログラムの置き場所の scripts/ は除く）
  /^SKILL\.md$/,
  /^(?!scripts\/)[^.][^]*\.(md|markdown|txt)$/i,
  /^manifest\.json$/,
  /^agents\/[^/]+\.json$/,
  /^connectors\/[^/]+\.json$/,
  /^evals\/[^/]+\.json$/,
  /^help\/[^/]+\.md$/,
  /^README\.md$/,
  /^icon\.png$/,
];

/** アイコンの大きさの上限。 */
const ICON_MAX_BYTES = 256 * 1024;

/** パッケージに入れてよいファイルか。 */
export function isAllowedExtensionFile(path: string): boolean {
  return ALLOWED_FILES.some((re) => re.test(path));
}

/**
 * ディレクトリの下の拡張機能をすべて読み込む。
 *
 * @param root 拡張機能を置くディレクトリ（例: リポジトリ直下の `extensions`）
 * @param registry 内蔵のツールの登録簿。定義のツールの存在と危険度を確かめる
 * @param takenIds すでに使われている業務エージェントの ID（公式の業務エージェント）
 */
export function loadExtensions(root: string, registry: ToolRegistry, takenIds: Iterable<string>): LoadResult {
  const result: LoadResult = { packages: [], errors: [] };
  if (!existsSync(root)) return result;
  const takenAgents = new Set(takenIds);
  const takenConnectors = new Set<string>();
  for (const name of readdirSync(root).sort()) {
    const dir = join(root, name);
    if (!statSync(dir).isDirectory() || name.startsWith('.')) continue;
    const { pkg, problems } = loadExtension(dir, registry, { takenAgents, takenConnectors });
    if (pkg && problems.length === 0) {
      result.packages.push(pkg);
      for (const a of pkg.agents) takenAgents.add(a.id);
      for (const c of pkg.connectors) takenConnectors.add(c.id);
    } else {
      result.errors.push({ dir, problems });
    }
  }
  return result;
}

/** ディレクトリの中のファイルを読み集める。`.` で始まるものは飛ばす。 */
export function readExtensionDir(dir: string): ExtensionFiles {
  const files: ExtensionFiles = new Map();
  const walk = (d: string) => {
    for (const name of readdirSync(d).sort()) {
      if (name.startsWith('.')) continue;
      const full = join(d, name);
      if (statSync(full).isDirectory()) walk(full);
      else files.set(relative(dir, full).split(sep).join('/'), readFileSync(full));
    }
  };
  walk(dir);
  return files;
}

/**
 * 1 つの拡張機能をディレクトリから読み込み、検証する。
 *
 * @returns 読み込んだ拡張機能と、検証で見つかった問題。問題があれば使ってはならない
 */
export function loadExtension(
  dir: string,
  registry: ToolRegistry,
  options: LoadOptions | Set<string> = {},
): { pkg: ExtensionPackage | null; problems: string[]; notices?: string[] } {
  if (!existsSync(join(dir, 'manifest.json')) && !existsSync(join(dir, 'SKILL.md'))) {
    return { pkg: null, problems: ['SKILL.md（または manifest.json）がありません'] };
  }
  const opts = options instanceof Set ? { takenAgents: options } : options;
  const res = loadExtensionFiles(readExtensionDir(dir), registry, opts);
  return { pkg: res.pkg ? { ...res.pkg, dir } : null, problems: res.problems, ...(res.notices ? { notices: res.notices } : {}) };
}

/**
 * ファイルの集まりから拡張機能を読み込み、検証する（仕様書 第12.9.2節、第12.10.2節）。
 *
 * @remarks ディレクトリからも `.m2ext` からも、この関数で同じ検証を行う。
 */
export function loadExtensionFiles(
  source: ExtensionFiles,
  registry: ToolRegistry,
  options: LoadOptions = {},
): { pkg: ExtensionPackage | null; problems: string[]; notices?: string[]; keep?: ExtensionFiles } {
  // スキルの形式（SKILL.md）なら、拡張機能のファイルに組み立ててから同じ検証を通す（第12.12節）
  let files = source;
  let skill: SkillPackage | null = null;
  if (source.has('SKILL.md') && !source.has('manifest.json')) {
    skill = buildSkillPackage(source, registry);
    if (skill.problems.length > 0) return { pkg: null, problems: skill.problems, notices: skill.notices };
    files = skill.files;
  }
  const res = loadPackageFiles(files, registry, options);
  return skill ? { ...res, notices: skill.notices, keep: skill.keep } : res;
}

/** 拡張機能のファイル（manifest.json の形）を読み込み、検証する。 */
function loadPackageFiles(
  files: ExtensionFiles,
  registry: ToolRegistry,
  options: LoadOptions,
): { pkg: ExtensionPackage | null; problems: string[] } {
  const problems: string[] = [];
  const text = (path: string) => new TextDecoder().decode(files.get(path));
  const json = <T>(path: string): T | null => {
    try {
      return JSON.parse(text(path)) as T;
    } catch (err) {
      problems.push(`${path}: JSON として読めません: ${(err as Error).message}`);
      return null;
    }
  };
  const under = (folder: string, ext: string) =>
    [...files.keys()].filter((k) => k.startsWith(`${folder}/`) && k.endsWith(ext)).sort();

  const disallowed = [...files.keys()].filter((k) => !isAllowedExtensionFile(k));
  if (disallowed.length > 0) {
    problems.push(`入れてはならないファイルがあります（プログラムなどは入れられません）: ${disallowed.join(', ')}`);
  }
  if (!files.has('manifest.json')) return { pkg: null, problems: [...problems, 'manifest.json がありません'] };
  const manifest = json<ExtensionManifest>('manifest.json');
  if (!manifest) return { pkg: null, problems };
  problems.push(...checkManifest(manifest));
  if (problems.length > 0) return { pkg: null, problems };

  // コネクタ。ID は内蔵のツールの名前の頭の部分や、ほかの拡張機能のコネクタと重なってはならない
  const reserved = new Set([...registry.names().map((n) => n.split('.')[0]!), ...(options.takenConnectors ?? [])]);
  const connectors: ConnectorDeclaration[] = [];
  for (const f of under('connectors', '.json')) {
    const c = json<ConnectorDeclaration>(f);
    if (!c) continue;
    const p = checkConnector(c, reserved);
    problems.push(...p.map((x) => `${f}: ${x}`));
    if (p.length > 0) continue;
    reserved.add(c.id);
    connectors.push(c);
    for (const t of c.tools) {
      const name = connectorToolName(c.id, t.name);
      if (RISK_ORDER[t.risk] > RISK_ORDER[manifest.permissions.max_risk_level]) {
        problems.push(`${f}: ${name} の危険度（${t.risk}）が max_risk_level（${manifest.permissions.max_risk_level}）を超えています`);
      }
    }
  }
  // この拡張機能の中で使えるツール = 内蔵のツール + この拡張機能のコネクタのツール
  const local = registry.extend(connectors.flatMap((c) => connectorTools(c)));
  const unknown = manifest.permissions.tools.filter((t) => !local.get(t));
  if (unknown.length > 0) {
    problems.push(`manifest.json: permissions.tools に、内蔵のツールにもこの拡張機能のコネクタにも無いツールがあります: ${unknown.join(', ')}`);
  }

  // 評価のケース（見本の応答を含む）を、業務エージェントごとに集める
  const evals = new Map<string, EvalCase[]>();
  for (const f of under('evals', '.json')) {
    const e = json<{ agent?: string; cases?: EvalCase[] }>(f);
    if (!e) continue;
    if (!e.agent || !Array.isArray(e.cases)) { problems.push(`${f}: agent と cases が必要です`); continue; }
    evals.set(e.agent, [...(evals.get(e.agent) ?? []), ...e.cases]);
  }

  const agents: AgentDefinition[] = [];
  const localIds = new Set<string>();
  const takenAgents = new Set(options.takenAgents ?? []);
  const agentFiles = under('agents', '.json');
  if (agentFiles.length === 0 && connectors.length === 0) {
    problems.push('業務エージェント（agents/*.json）かコネクタ（connectors/*.json）が 1 つ以上必要です');
  }
  for (const f of agentFiles) {
    const raw = json<AgentDefinition>(f);
    if (!raw) continue;
    const localId = raw.id;
    if (typeof localId !== 'string' || !/^[a-z0-9][a-z0-9-]*$/.test(localId)) {
      problems.push(`${f}: id は英小文字・数字・ハイフンで書いてください（例: hello）`);
      continue;
    }
    localIds.add(localId);
    const def: AgentDefinition = {
      ...raw,
      id: `${manifest.id}:${localId}`,
      evals: [...(raw.evals ?? []), ...(evals.get(localId) ?? [])],
    };
    problems.push(...checkAgent(def, manifest, local, takenAgents).map((p) => `${f}: ${p}`));
    agents.push(def);
  }
  for (const agentId of evals.keys()) {
    if (!localIds.has(agentId)) problems.push(`evals: 業務エージェント ${agentId} の定義がありません`);
  }

  let icon: string | null = null;
  const png = files.get('icon.png');
  if (png) {
    const isPng = png.length > 8 && png[0] === 0x89 && png[1] === 0x50 && png[2] === 0x4e && png[3] === 0x47;
    if (!isPng) problems.push('icon.png が PNG の画像ではありません');
    else if (png.length > ICON_MAX_BYTES) problems.push('icon.png は 256 KB までです');
    else icon = `data:image/png;base64,${Buffer.from(png).toString('base64')}`;
  }
  const readme = files.has('README.md') ? text('README.md') : null;
  return { pkg: { manifest, agents, connectors, readme, icon, dir: null }, problems };
}

/** マニフェストの必須項目を確かめる（仕様書 第12.9.2節 検証 1）。 */
function checkManifest(m: ExtensionManifest): string[] {
  const p: string[] = [];
  if (!m.id || !/^[a-z0-9]+(\.[a-z0-9-]+)+$/.test(m.id)) p.push('id は逆ドメイン名の形で書いてください（例: jp.example.hello-world）');
  if (!m.name) p.push('name がありません');
  if (!m.version || !/^\d+\.\d+\.\d+$/.test(m.version)) p.push('version はセマンティックバージョニング（例: 1.0.0）で書いてください');
  if (!m.publisher?.name) p.push('publisher.name がありません');
  if (!m.platform_schema) p.push('platform_schema がありません（例: ">=1 <2"）');
  else if (!/>=\s*1\b/.test(m.platform_schema)) p.push(`platform_schema が対応していない版を指しています: ${m.platform_schema}`);
  if (!Array.isArray(m.permissions?.tools)) p.push('permissions.tools がありません');
  if (!RISK_LEVELS.includes(m.permissions?.max_risk_level)) {
    p.push(`permissions.max_risk_level は ${RISK_LEVELS.join('・')} のいずれかです`);
  }
  return p;
}

/** 業務エージェントの定義を確かめる（仕様書 第12.9.2節 検証 2〜6）。 */
function checkAgent(
  def: AgentDefinition, m: ExtensionManifest, registry: ToolRegistry, taken: Set<string>,
): string[] {
  const p: string[] = [];
  try {
    validateDefinition(def, registry);
  } catch (err) {
    p.push((err as Error).message);
  }
  const undeclared = def.tools.filter((t) => !m.permissions.tools.includes(t));
  if (undeclared.length > 0) p.push(`マニフェストの permissions.tools に無いツールを使っています: ${undeclared.join(', ')}`);
  const tooRisky = registry.allowed(def.tools)
    .filter((t) => RISK_ORDER[t.risk] > RISK_ORDER[m.permissions.max_risk_level]);
  if (tooRisky.length > 0) {
    p.push(`max_risk_level（${m.permissions.max_risk_level}）を超えるツールを使っています: ${tooRisky.map((t) => `${t.name}（${t.risk}）`).join(', ')}`);
  }
  if (!def.help?.summary) p.push('help.summary がありません。拡張機能の業務エージェントには必須です');
  if (taken.has(def.id)) p.push(`ID ${def.id} はすでに使われています`);
  return p;
}
