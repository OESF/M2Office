/**
 * @file 会社ごとの拡張機能の見え方をまとめる。公式の配布元と、その会社が取り込んだファイルを合わせる。
 *
 * 会社で使えるのは、公式の業務エージェントと、**導入済み・有効・再同意が不要**な拡張機能の
 * 業務エージェントとコネクタのツールだけである（仕様書 第12.10.4節）。
 * ファイルから取り込んだ拡張機能（自社専用）は、取り込んだ会社にだけ見える（第12.10.3節）。
 *
 * @see 仕様書 第12.10節 持ち運べる拡張機能
 */

import { RISK_ORDER, type AgentDefinition, type RiskLevel } from '@m2office/shared';
import type { InstalledExtension, Repository } from '../repository/types.js';
import type { ToolRegistry } from '../tools/registry.js';
import type { McpClient } from '../connectors/mcp.js';
import { silentLogger, type Logger } from '../log/logger.js';
import { connectorToolName, connectorTools, type ConnectorDeclaration } from './connectors.js';
import { loadExtensionFiles, type ExtensionFiles, type ExtensionPackage } from './loader.js';

/** 会社から見た拡張機能 1 つ分。 */
export interface ExtensionEntry {
  pkg: ExtensionPackage;
  /** 公式の配布元か、その会社がファイルから取り込んだもの（自社専用）か。 */
  origin: 'official' | 'private';
  /** 導入の記録。未導入なら `null`。 */
  installed: InstalledExtension | null;
  /** 導入したときより権限が増えている。スイッチを入れる前に再同意が要る（第12.6節）。 */
  needsReconsent: boolean;
  /** その会社で使える（導入済み・有効・再同意が不要）。 */
  active: boolean;
}

/** 会社から見た拡張機能の全体。 */
export interface TenantExtensions {
  entries: ExtensionEntry[];
  /** その会社で使える業務エージェント（公式と、使える拡張機能）。 */
  agents: AgentDefinition[];
  /** 名前を引くための、知っているすべての業務エージェント（使えないものを含む）。 */
  allAgents: AgentDefinition[];
  /** その会社で使えるツール（内蔵と、使える拡張機能のコネクタのツール）。 */
  registry: ToolRegistry;
  /** ID と版で業務エージェントを引く。使えるかどうかは {@link isAvailable} で確かめる。 */
  resolve(agentId: string, version: number): AgentDefinition | undefined;
  isAvailable(agentId: string): boolean;
  /** 業務エージェントがどの拡張機能のものか。公式なら `null`。 */
  entryOf(agentId: string): ExtensionEntry | null;
  /** 管理者が個別に止めたコネクタのツール（`<コネクタの ID>.<ツールの名前>`。第6.6.3.1節）。 */
  disabledTools: Set<string>;
}

/**
 * その業務エージェントが、止められたツールを使うか（仕様書 第6.6.3.1節）。
 *
 * @remarks
 * 業務の定義はツールを名前で指しており、1 つ欠けると最後まで進めない。
 * そのため、1 つでも止まっていれば、その業務は使えないものとして扱う。
 */
export function blockedByDisabledTool(def: AgentDefinition, disabled: ReadonlySet<string>): boolean {
  return def.tools.some((name) => disabled.has(name));
}

/** 導入の同意で記録する権限（仕様書 第12.10.5節、第12.11.2節）。 */
export interface ConsentSnapshot {
  tools: string[];
  max_risk_level: RiskLevel;
  connectors: { id: string; url: string; auth: string; tools: { name: string; risk: RiskLevel }[] }[];
}

export interface ExtensionHubDeps {
  repo: Repository;
  /** 内蔵のツールの登録簿。 */
  registry: ToolRegistry;
  /** 公式の業務エージェント。 */
  official: AgentDefinition[];
  /** 公式の配布元から読み込んだ拡張機能。 */
  packages: ExtensionPackage[];
  /** コネクタの MCP サーバへの接続口。省略するとコネクタのツールは「接続されていません」を返す。 */
  mcp?: McpClient;
  logger?: Logger;
}

export class ExtensionHub {
  private readonly log: Logger;

  constructor(private readonly deps: ExtensionHubDeps) {
    this.log = deps.logger ?? silentLogger;
  }

  /** 公式の配布元の拡張機能。 */
  officialPackages(): ExtensionPackage[] {
    return this.deps.packages;
  }

  /** 公式の業務エージェントと、公式の配布元の拡張機能の業務エージェント（見本の応答を引くなどに使う）。 */
  officialAgents(): AgentDefinition[] {
    return [...this.deps.official, ...this.deps.packages.flatMap((p) => p.agents)];
  }

  /**
   * 会社から見た拡張機能の全体を組み立てる。
   *
   * @remarks
   * テナント境界: 自社専用の拡張機能と導入の記録は、その会社の分だけを読む（不変則 I-2）。
   * 取り込んだファイルは読み込むたびに検証し直す。通らなくなったものは使わない。
   */
  async forTenant(tenantId: string): Promise<TenantExtensions> {
    const { repo, registry, official, mcp } = this.deps;
    const [installed, privates, disabledRows] = await Promise.all([
      repo.listInstalledExtensions(tenantId), repo.listPrivateExtensions(tenantId),
      repo.listDisabledConnectorTools(tenantId),
    ]);
    const disabledTools = new Set(disabledRows.map((d) => connectorToolName(d.connectorId, d.toolName)));
    const packages: { pkg: ExtensionPackage; origin: 'official' | 'private' }[] =
      this.deps.packages.map((pkg) => ({ pkg, origin: 'official' }));
    const takenAgents = new Set(this.officialAgents().map((a) => a.id));
    const takenConnectors = new Set(this.deps.packages.flatMap((p) => p.connectors.map((c) => c.id)));
    for (const rec of privates) {
      if (this.deps.packages.some((p) => p.manifest.id === rec.extensionId)) continue;
      const { pkg, problems } = loadExtensionFiles(decodeFiles(rec.files), registry, { takenAgents, takenConnectors });
      if (!pkg || problems.length > 0) {
        this.log.warn('取り込んだ拡張機能が検証を通りません', { tenantId, extensionId: rec.extensionId, problems });
        continue;
      }
      for (const a of pkg.agents) takenAgents.add(a.id);
      for (const c of pkg.connectors) takenConnectors.add(c.id);
      packages.push({ pkg, origin: 'private' });
    }

    const entries: ExtensionEntry[] = packages.map(({ pkg, origin }) => {
      const rec = installed.find((i) => i.extensionId === pkg.manifest.id) ?? null;
      const needsReconsent = rec !== null && !covers(rec.consentedPermissions, consentSnapshot(pkg));
      return { pkg, origin, installed: rec, needsReconsent, active: rec !== null && rec.enabled && !needsReconsent };
    });
    const active = entries.filter((e) => e.active);
    // 止めたツールを使う業務は、メニュー・秘書・定時実行・API から消す（第6.6.3.1節）
    const agents = [...official, ...active.flatMap((e) => e.pkg.agents)]
      .filter((a) => !blockedByDisabledTool(a, disabledTools));
    const allAgents = [...official, ...entries.flatMap((e) => e.pkg.agents)];
    // 止めたツールは、その会社のツールの一覧から外す。業務からも接続の確認からも見えない
    const tenantRegistry = registry.extend(
      active.flatMap((e) => e.pkg.connectors.flatMap((c) => connectorTools(c, mcp)))
        .filter((t) => !disabledTools.has(t.name)),
    );
    const entryOf = (agentId: string) => {
      if (!agentId.includes(':')) return null;
      const extId = agentId.slice(0, agentId.indexOf(':'));
      return entries.find((e) => e.pkg.manifest.id === extId) ?? null;
    };
    return {
      entries, agents, allAgents, registry: tenantRegistry, disabledTools,
      resolve: (agentId, version) => allAgents.find((a) => a.id === agentId && a.version === version),
      isAvailable: (agentId) => agents.some((a) => a.id === agentId),
      entryOf,
    };
  }

  /**
   * コネクタの接続を確かめる（仕様書 第12.11.3節「接続の確認」）。
   *
   * @returns 宣言したツールごとに、MCP サーバが提供しているか。接続できなければ理由
   */
  async checkConnector(c: ConnectorDeclaration): Promise<
    { ok: true; tools: { name: string; provided: boolean }[] } | { ok: false; error: string }
  > {
    if (!this.deps.mcp) return { ok: false, error: 'コネクタへの接続口が用意されていません' };
    const res = await this.deps.mcp.listTools(c.url);
    if (!res.ok) return res;
    return { ok: true, tools: c.tools.map((t) => ({ name: t.name, provided: res.tools.some((x) => x.name === t.name) })) };
  }

  /**
   * 取り込もうとするファイルを検証する（仕様書 第12.10.2節）。
   *
   * @remarks
   * 公式の拡張機能と同じ ID は取り込めない。同じ ID の自社専用の拡張機能があれば、それを置き換える前提で検証する。
   */
  async validateImport(tenantId: string, files: ExtensionFiles) {
    const { repo, registry } = this.deps;
    const first = loadExtensionFiles(files, registry, {});
    const extId = first.pkg?.manifest.id;
    if (!first.pkg || !extId) return first;
    if (this.deps.packages.some((p) => p.manifest.id === extId)) {
      return { pkg: first.pkg, problems: [`公式の拡張機能と同じ ID（${extId}）です。ID を変えてください`] };
    }
    const others = (await repo.listPrivateExtensions(tenantId)).filter((r) => r.extensionId !== extId);
    const takenAgents = new Set(this.officialAgents().map((a) => a.id));
    const takenConnectors = new Set(this.deps.packages.flatMap((p) => p.connectors.map((c) => c.id)));
    for (const rec of others) {
      const { pkg } = loadExtensionFiles(decodeFiles(rec.files), registry, {});
      for (const a of pkg?.agents ?? []) takenAgents.add(a.id);
      for (const c of pkg?.connectors ?? []) takenConnectors.add(c.id);
    }
    return loadExtensionFiles(files, registry, { takenAgents, takenConnectors });
  }
}

/** 拡張機能が求める権限を、同意の記録の形にする。 */
export function consentSnapshot(pkg: ExtensionPackage): ConsentSnapshot {
  return {
    tools: [...pkg.manifest.permissions.tools],
    max_risk_level: pkg.manifest.permissions.max_risk_level,
    connectors: pkg.connectors.map((c) => ({
      id: c.id, url: c.url, auth: c.auth.type, tools: c.tools.map((t) => ({ name: t.name, risk: t.risk })),
    })),
  };
}

/** 同意した権限が、求める権限をすべて含むか。含まなければ再同意が要る。 */
function covers(consented: InstalledExtension['consentedPermissions'], wanted: ConsentSnapshot): boolean {
  const had = consented as Partial<ConsentSnapshot>;
  if (!wanted.tools.every((t) => had.tools?.includes(t))) return false;
  if (RISK_ORDER[wanted.max_risk_level] > (RISK_ORDER[had.max_risk_level as RiskLevel] ?? -1)) return false;
  return wanted.connectors.every((w) => {
    const c = had.connectors?.find((x) => x.id === w.id);
    return !!c && c.url === w.url && c.auth === w.auth &&
      w.tools.every((t) => c.tools.some((x) => x.name === t.name && RISK_ORDER[x.risk] >= RISK_ORDER[t.risk]));
  });
}

/** 保存の形（パス→Base64）から、ファイルの集まりに戻す。 */
export function decodeFiles(files: Record<string, string>): ExtensionFiles {
  return new Map(Object.entries(files).map(([k, v]) => [k, new Uint8Array(Buffer.from(v, 'base64'))]));
}

/** ファイルの集まりを、保存の形（パス→Base64）にする。 */
export function encodeFiles(files: ExtensionFiles): Record<string, string> {
  return Object.fromEntries([...files.entries()].map(([k, v]) => [k, Buffer.from(v).toString('base64')]));
}
