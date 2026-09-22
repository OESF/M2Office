/**
 * @file 拡張機能（L1: 業務エージェント）の読み込みと検証。
 *
 * `extensions/<名前>/` のディレクトリを 1 つの拡張機能として読み、検証を通ったものだけを返す。
 * 第三者のコードは読み込まない。読むのは宣言的な定義（JSON）だけである（不変則 I-7）。
 *
 * @see 仕様書 第12.9節 拡張機能の読み込みと導入
 * @see 開発者マニュアル docs/developer/
 */

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { RISK_LEVELS, RISK_ORDER, type AgentDefinition, type EvalCase, type RiskLevel } from '@m2office/shared';
import type { ToolRegistry } from '../tools/registry.js';
import { validateDefinition } from '../engine/validate.js';

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
    /** 使ってよいツール。定義はこの中のツールだけを使える。 */
    tools: string[];
    /** 扱う最大の危険度。定義のツールはこれを超えられない。 */
    max_risk_level: RiskLevel;
  };
}

/** 読み込んだ拡張機能。 */
export interface ExtensionPackage {
  manifest: ExtensionManifest;
  /** 業務エージェント。ID は `<拡張機能の ID>:<定義の ID>` に置き換え済み。 */
  agents: AgentDefinition[];
  /** 読み込んだディレクトリ。 */
  dir: string;
}

/** 読み込みの結果。検証を通らなかった拡張機能は `errors` に入る。 */
export interface LoadResult {
  packages: ExtensionPackage[];
  errors: { dir: string; problems: string[] }[];
}

/**
 * ディレクトリの下の拡張機能をすべて読み込む。
 *
 * @param root 拡張機能を置くディレクトリ（例: リポジトリ直下の `extensions`）
 * @param registry ツールの登録簿。定義のツールの存在と危険度を確かめる
 * @param takenIds すでに使われている業務エージェントの ID（公式の業務エージェント）
 */
export function loadExtensions(root: string, registry: ToolRegistry, takenIds: Iterable<string>): LoadResult {
  const result: LoadResult = { packages: [], errors: [] };
  if (!existsSync(root)) return result;
  const taken = new Set(takenIds);
  for (const name of readdirSync(root).sort()) {
    const dir = join(root, name);
    if (!statSync(dir).isDirectory() || name.startsWith('.')) continue;
    const { pkg, problems } = loadExtension(dir, registry, taken);
    if (pkg && problems.length === 0) {
      result.packages.push(pkg);
      for (const a of pkg.agents) taken.add(a.id);
    } else {
      result.errors.push({ dir, problems });
    }
  }
  return result;
}

/**
 * 1 つの拡張機能を読み込み、検証する。
 *
 * @returns 読み込んだ拡張機能と、検証で見つかった問題。問題があれば使ってはならない
 */
export function loadExtension(
  dir: string,
  registry: ToolRegistry,
  taken: Set<string> = new Set(),
): { pkg: ExtensionPackage | null; problems: string[] } {
  const problems: string[] = [];
  const manifestPath = join(dir, 'manifest.json');
  if (!existsSync(manifestPath)) return { pkg: null, problems: ['manifest.json がありません'] };

  let manifest: ExtensionManifest;
  try {
    manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as ExtensionManifest;
  } catch (err) {
    return { pkg: null, problems: [`manifest.json を JSON として読めません: ${(err as Error).message}`] };
  }
  problems.push(...checkManifest(manifest));
  if (problems.length > 0) return { pkg: null, problems };

  // 評価のケース（見本の応答を含む）を、業務エージェントごとに集める
  const evals = new Map<string, EvalCase[]>();
  const evalsDir = join(dir, 'evals');
  if (existsSync(evalsDir)) {
    for (const f of readdirSync(evalsDir).filter((f) => f.endsWith('.json'))) {
      try {
        const e = JSON.parse(readFileSync(join(evalsDir, f), 'utf8')) as { agent?: string; cases?: EvalCase[] };
        if (!e.agent || !Array.isArray(e.cases)) { problems.push(`evals/${f}: agent と cases が必要です`); continue; }
        evals.set(e.agent, [...(evals.get(e.agent) ?? []), ...e.cases]);
      } catch (err) {
        problems.push(`evals/${f}: JSON として読めません: ${(err as Error).message}`);
      }
    }
  }

  const agents: AgentDefinition[] = [];
  const agentsDir = join(dir, 'agents');
  const files = existsSync(agentsDir) ? readdirSync(agentsDir).filter((f) => f.endsWith('.json')) : [];
  if (files.length === 0) problems.push('agents/ に業務エージェントの定義（.json）が 1 つもありません');
  for (const f of files) {
    let raw: AgentDefinition;
    try {
      raw = JSON.parse(readFileSync(join(agentsDir, f), 'utf8')) as AgentDefinition;
    } catch (err) {
      problems.push(`agents/${f}: JSON として読めません: ${(err as Error).message}`);
      continue;
    }
    const localId = raw.id;
    if (typeof localId !== 'string' || !/^[a-z0-9][a-z0-9-]*$/.test(localId)) {
      problems.push(`agents/${f}: id は英小文字・数字・ハイフンで書いてください（例: hello）`);
      continue;
    }
    const def: AgentDefinition = {
      ...raw,
      id: `${manifest.id}:${localId}`,
      evals: [...(raw.evals ?? []), ...(evals.get(localId) ?? [])],
    };
    problems.push(...checkAgent(def, manifest, registry, taken).map((p) => `agents/${f}: ${p}`));
    agents.push(def);
  }
  for (const agentId of evals.keys()) {
    if (!files.some((f) => JSON.parse(readFileSync(join(agentsDir, f), 'utf8')).id === agentId)) {
      problems.push(`evals: 業務エージェント ${agentId} の定義がありません`);
    }
  }
  return { pkg: { manifest, agents, dir }, problems };
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
